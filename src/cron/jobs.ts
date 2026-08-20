import type { Config } from '../config';
import type { Db } from '../db/client';
import type { CronTarget } from '../db/identity';
import { claimJobs, failJob, finishJob, killJob, recoverStaleJobs } from '../db/jobs';
import { saveTurns } from '../db/messages';
import type { JobRow } from '../db/types';
import type { Deadline } from '../lib/deadline';
import { createProvider } from '../llm';
import { LLMError } from '../llm/provider';
import { createPageReader } from '../reader';
import { ReaderError } from '../reader/provider';
import type { TelegramClient } from '../telegram/client';
import type { Env } from '../types';

/**
 * Deferred jobs (phase 17).
 *
 * This runs LAST in the tick, and that order is the design rather than an accident.
 * Reminders and appointment alerts are time-critical to the minute —an appointment
 * announced late is not an appointment announced (§12)— while a job is the only thing in
 * this project nobody is waiting on. So it takes whatever budget is left over and leaves
 * the rest for the next tick, five minutes later.
 *
 * It is also the first cron job that calls the model. Until now the tick composed every
 * message in code, on purpose: zero tokens, nothing to invent, and no dependency on the
 * provider being up when the alarm goes off. That does not survive contact with "tell me
 * what this page says", which is a summary and nothing else. The trade is contained by
 * the same rule as everywhere else: if the call does not fit the budget, the job stays
 * pending instead of the message going out half-written.
 */

/**
 * Below this, do not start a job at all.
 *
 * It is the sum of what one job actually costs: fetching the page, summarising it and
 * sending the message. Starting with less means paying for the fetch and getting
 * cancelled before the summary, which spends the attempt and delivers nothing.
 */
const MIN_ROOM_MS = 14_000;

const MAX_READ_MS = 10_000;
const MAX_SUMMARY_MS = 9_000;

/**
 * Jobs attempted per tick.
 *
 * Two rather than one because a tick where the reminders did nothing has room for it, and
 * the loop re-checks the budget before each. Not more: 288 ticks a day is plenty of
 * throughput for a personal link inbox, and a long queue draining in one tick is how the
 * briefing ends up behind it.
 */
const MAX_PER_TICK = 2;

/** Cap on the extracted text handed to the model. Bytes, because tokens follow bytes. */
const MAX_PAGE_BYTES = 16_000;

export interface JobRunDeps {
  env: Env;
  config: Config;
  db: Db;
  telegram: TelegramClient;
  target: CronTarget;
  now: Date;
  deadline: Deadline;
}

/** Returns how many jobs were finished, dead ones included: both end the promise. */
export async function runDueJobs(deps: JobRunDeps): Promise<number> {
  const { db, target, now, deadline } = deps;

  if (!deadline.hasRoomFor(MIN_ROOM_MS)) return 0;

  // Before claiming anything: a row left 'running' by a cancelled tick is invisible to
  // the claim query, so without this it would sit there for ever.
  await recoverStaleJobs(db, target.userId, now);

  let handled = 0;
  // One at a time, re-checking the budget before each claim. The batch version of this
  // had a real bug: `attempts` is spent at claim time (see db/jobs.ts), so a job that got
  // claimed and then skipped for lack of tick burned a try without ever being attempted
  // —three unlucky ticks and it was dead having never been fetched. Claiming only what
  // there is room to run removes the case instead of compensating for it.
  for (let taken = 0; taken < MAX_PER_TICK; taken++) {
    if (!deadline.hasRoomFor(MIN_ROOM_MS)) break;

    const [job] = await claimJobs(db, target.userId, now, 1);
    if (!job) break;

    try {
      await runJob(job, deps);
      await finishJob(db, job.id);
      handled++;
    } catch (error) {
      handled += (await reportFailure(job, error, deps)) ? 1 : 0;
    }
  }

  return handled;
}

/** One job, dispatched by kind. New kinds land here and nowhere else. */
async function runJob(job: JobRow, deps: JobRunDeps): Promise<void> {
  switch (job.kind) {
    case 'read_url':
      return runReadUrl(job, deps);
  }
}

async function runReadUrl(job: JobRow, deps: JobRunDeps): Promise<void> {
  const { env, config, db, telegram, target, deadline } = deps;

  const url = typeof job.payload['url'] === 'string' ? job.payload['url'] : null;
  if (!url) {
    // A payload with no url cannot be retried into working. Thrown as non-retryable so
    // it dies on the spot instead of burning three ticks.
    throw new ReaderError('not_found', 'el trabajo no llevaba url');
  }
  const question = typeof job.payload['question'] === 'string' ? job.payload['question'] : null;

  const page = await createPageReader(env).read(url, {
    timeoutMs: deadline.budgetFor(MAX_READ_MS),
    maxBytes: MAX_PAGE_BYTES,
  });

  const summary = await summarise(page, question, url, deps);

  const text = buildMessage(summary, page.title, url);
  await telegram.sendMessage(target.chatId, text);

  // Into the history, like the reminders: without it the model has no idea what the user
  // is answering when they reply "and what did it say about the price?".
  await saveTurns(db, target.conversationId, [{ role: 'assistant', content: text }]);

  console.info(
    JSON.stringify({
      event: 'job_read_url',
      job_id: job.id,
      url,
      truncated: page.truncated,
      llm: config.llmModel,
    }),
  );
}

/**
 * The summary itself.
 *
 * The prompt is short and almost entirely about what NOT to do, because the failure mode
 * here is not a bad summary: it is a confident one about a page it only half read. Hence
 * the truncation being stated in words —a model that does not know the text is cut will
 * fill in the ending— and hence the instruction to say when the answer is not in there.
 */
async function summarise(
  page: { text: string; truncated: boolean },
  question: string | null,
  url: string,
  deps: JobRunDeps,
): Promise<string> {
  const { env, config, deadline } = deps;

  const rules = [
    'Te paso el texto de una página web. Resúmelo para el usuario que pidió leerla.',
    '',
    question
      ? `Lo que quiere saber es: "${question}". Contesta a eso primero. Si el texto no lo dice, dilo en una frase y cuenta de qué va la página.`
      : 'No ha preguntado nada concreto: cuéntale de qué va y lo que le pueda interesar.',
    '',
    'Cómo:',
    '- Cuatro o cinco frases como mucho. Está leyéndolo en el móvil.',
    '- Texto plano, sin markdown: nada de negritas, ni listas con asteriscos, ni títulos.',
    '- Solo lo que diga el texto. Si algo no está, no lo rellenes con lo que creas saber.',
    '- No describas la página ("este artículo habla de..."): cuenta lo que dice.',
    page.truncated
      ? '- OJO: el texto está CORTADO, es solo el principio de la página. No te inventes el final ni des por hecho que has visto las conclusiones. Si se corta a medias, dilo.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const provider = createProvider(env, config);
  const response = await provider.chat(
    [
      { role: 'system', content: rules },
      { role: 'user', content: `Página: ${url}\n\n${page.text}` },
    ],
    // No tools on purpose: this is a summary, not a turn. Offering them here would let a
    // job create tasks nobody confirmed, on a path with no user watching.
    undefined,
    { timeoutMs: deadline.budgetFor(MAX_SUMMARY_MS) },
  );

  const summary = response.content?.trim();
  if (!summary) throw new LLMError('malformed', 'el resumen volvió vacío');
  return summary;
}

/** The message as it lands in the chat. The url goes last so it can be tapped. */
function buildMessage(summary: string, title: string | null, url: string): string {
  const opener = title ? `Ya he leído ${title}.` : 'Ya he leído el enlace.';
  return [opener, '', summary, '', url].join('\n');
}

/**
 * A failed job, and whether the promise is now closed.
 *
 * The message only goes out when the job is DEAD. A retry still has ticks left, and
 * announcing every attempt would turn one link into three messages saying nothing. But
 * when it gives up the user has to be told: they were promised a summary, and silence
 * here is the whole failure mode this table exists to prevent.
 */
async function reportFailure(job: JobRow, error: unknown, deps: JobRunDeps): Promise<boolean> {
  const { db, telegram, target, now } = deps;

  const detail =
    error instanceof ReaderError
      ? error.userMessage
      : error instanceof LLMError
        ? 'el modelo no ha podido resumirla'
        : error instanceof Error
          ? error.message
          : String(error);

  // Only what another tick could plausibly fix gets another tick. The reader knows which
  // of its own failures those are; anything else —an LLM hiccup, a bug of ours— is given
  // the benefit of the doubt.
  const retryable = error instanceof ReaderError ? error.retryable : true;

  let outcome: 'retry' | 'dead' = 'dead';
  if (retryable) {
    outcome = await failJob(db, job, detail, now);
  } else {
    await killJob(db, job.id, detail);
  }

  console.error(`job ${job.kind} ${job.id} falló (${outcome}): ${detail}`);

  if (outcome !== 'dead') return false;

  const url = typeof job.payload['url'] === 'string' ? job.payload['url'] : 'ese enlace';
  const text = `No he podido leer ${url}: ${detail}.`;
  try {
    await telegram.sendMessage(target.chatId, text);
    await saveTurns(db, target.conversationId, [{ role: 'assistant', content: text }]);
  } catch (sendError) {
    console.error('no se pudo avisar de un job muerto:', sendError);
  }
  return true;
}
