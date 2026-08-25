import {
  decodeEntities,
  findControl,
  findRadio,
  formState,
  parseForm,
  scriptAssignedText,
  textOf,
  type ParsedForm,
} from './html';
import {
  PUNCH_ACTIONS,
  TimeclockError,
  type LastMovement,
  type PunchAction,
  type PunchClient,
  type PunchResult,
  type PunchState,
  type TimeclockOptions,
} from './provider';

/**
 * ficharweb over plain HTTP, from the Worker (phase 22).
 *
 * There is no browser in this runtime and Browser Rendering is on the paid plan, so the
 * three requests a punch needs are made by hand: load the page, log in, submit the form.
 *
 * The page is `registro.asp` and it works like this, which is what everything below is
 * shaped around:
 *
 * - There is **one submit button**, and its wording is the phase: "Registrar entrada"
 *   while you are out, "Registrar salida" while you are in. Never both.
 * - Above it, a radio group ("Motivo registro") holds the reasons for that phase, with
 *   the ordinary one already selected.
 * - Below it, "Último movimiento" states what the portal last recorded and at what time,
 *   to the second.
 *
 * So a punch is: check the button says the right phase, pick the radio when the action
 * needs one, submit, and confirm against "Último movimiento". That last step is why this
 * can report honestly: the portal itself says what it wrote down.
 */

const DEFAULT_BASE_URL = 'https://ficharweb.ccbosco.org';

/**
 * Where the punching happens, and the only path this code knows.
 *
 * The login page is NOT a constant here, and that was learned the hard way: asking for
 * `/CCB/` first came back with something that was not the login form, so nothing was ever
 * filled in and the run ended with "I do not understand this page". Asking for the register
 * page while logged out makes the site bounce us to its own login, wherever that is — which
 * is what a browser does and one guess fewer for us.
 */
const REGISTER_PATH = '/CCB/registro.asp';

/** Cap per request. The caller's budget is split across three of them at most. */
const PER_REQUEST_MAX_MS = 8_000;

/** Under this there is no point starting another request. */
const MIN_REQUEST_MS = 1_500;

const MAX_REDIRECTS = 5;

/**
 * How many self-posting bridge pages to follow.
 *
 * Two, because one is what the login uses and a second is cheap insurance; more than that
 * and something is looping, which is worth reporting rather than chasing.
 */
const MAX_BRIDGES = 2;

/**
 * Which button each action needs on screen.
 *
 * This is the phase check and the idempotence in one: if the entry button is not there,
 * the entry is already registered, whoever registered it.
 */
const PHASE_BUTTON: Record<PunchAction, string> = {
  clock_in: 'registrar entrada',
  break_end: 'registrar entrada',
  break_start: 'registrar salida',
  clock_out: 'registrar salida',
};

/**
 * The reason to select in "Motivo registro" for each action.
 *
 * Full wordings only, with no loose fallback: "entrada" on its own would also match
 * "Entrada del descanso" and register the wrong reason, and on an attendance record a
 * wrong punch is worse than no punch. Both prepositions are listed for the break because
 * neither collides with anything else, and which one the portal uses is not worth a
 * redeploy to find out.
 */
const REASON_RADIO: Record<PunchAction, string[]> = {
  clock_in: ['entrada ordinaria'],
  clock_out: ['salida ordinaria'],
  break_start: ['salida al descanso', 'salida del descanso'],
  break_end: ['entrada del descanso', 'entrada al descanso'],
};

/**
 * The actions that go through without touching the radio group.
 *
 * Manually, starting and ending the day is just pressing the button: the ordinary reason
 * is the one already selected. So if the radio cannot be found for these two, the punch
 * still goes ahead with whatever the page had selected — which is exactly what a person
 * does. For the two break actions the opposite holds: no radio, no punch.
 */
const ORDINARY: ReadonlySet<PunchAction> = new Set<PunchAction>(['clock_in', 'clock_out']);

/** What "Último movimiento" says after each action landed. The confirmation to look for. */
const MOVEMENT_LABEL: Record<PunchAction, string[]> = REASON_RADIO;

/**
 * What we say we are, and it is not honesty that decides this one.
 *
 * The portal classifies the client into PC, MOBILE or UNKNOWN and gates punching on it. Its
 * own script does it like this, and there is no reason to think the server does it
 * differently, since it is the server that hands the script the two permissions it checks:
 *
 *     const movilRegex = /android|iphone|ipad|huawei|blackberry|opera mini|windows phone|ipod|webos/i;
 *     const pcRegex = /windows|linux|macintosh|cros/i;
 *
 * `Mozilla/5.0 (compatible; jarvis)` matches neither, which lands on UNKNOWN — a case
 * nothing on the page handles and the likeliest reason `registro.asp` answers 500 to a POST
 * it answers perfectly well to a GET. So we present as the desktop this actually punches
 * from. It is also what the Playwright version of this that does work presents as: a real
 * Chromium on Windows.
 */
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/150.0.0.0 Safari/537.36';

/**
 * Everything else Chrome sends, because the body is no longer a suspect.
 *
 * The successful punch was captured from the browser and compared with ours: the same 212
 * bytes, field for field, in the same order. So whatever `registro.asp` objects to is not in
 * the body, and the only other thing that travels is the headers. These are Chrome's, taken
 * from that capture — the `Sec-Fetch-*` set in particular says "a form on this same site
 * navigated here", which is exactly the sentence a filter in front of an attendance portal
 * would want to hear, and the one our request was not saying.
 *
 * `Accept-Encoding` is deliberately absent: the runtime sets it and decompresses for us.
 */
const BROWSER_HEADERS: Record<string, string> = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9',
  'Cache-Control': 'max-age=0',
  'User-Agent': DESKTOP_UA,
  'Sec-Ch-Ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

/** Words on the login button, in the order they are worth trying. */
const LOGIN_LABELS = ['entrar', 'acceder', 'iniciar sesion', 'login', 'enviar'];

export class HttpPunchClient implements PunchClient {
  readonly name = 'ficharweb-http';

  constructor(
    private readonly baseUrl: string,
    private readonly user: string,
    private readonly pass: string,
  ) {}

  /**
   * What the portal offers right now. One read, and it writes nothing.
   *
   * The automation gets this for free —`punch()` does the same read on its way in— but a
   * user asking "have I clocked in?" gets only this, so nothing can be submitted by
   * accident on a path that was only ever a question.
   */
  async readState(options: TimeclockOptions = {}): Promise<PunchState> {
    const { page } = await this.open(options);
    return stateOf(page);
  }

  async readPage(options: TimeclockOptions = {}): Promise<{ url: string; html: string }> {
    const { page } = await this.open(options);
    return { url: page.url, html: page.html };
  }

  async punch(action: PunchAction, options: TimeclockOptions = {}): Promise<PunchResult> {
    const { page, jar, clock } = await this.open(options);
    const state = stateOf(page);

    const button = findControl(page.form, [PHASE_BUTTON[action]]);
    if (!button) {
      // Not a failure of ours. The page shows one phase at a time, so a missing "Registrar
      // entrada" means the entry is already in — whether the automation or the user put it
      // there. The only worrying case is a page we do not understand at all, and that is
      // told apart by whether anything was recognised.
      if (state.available.length === 0) {
        throw new TimeclockError('parse', `no encuentro los botones de fichaje. ${describe(state)}`);
      }
      throw new TimeclockError(
        'not_available',
        `la página no ofrece "${PHASE_BUTTON[action]}" sino ${state.available.join(', ')}`,
      );
    }

    const radio = findRadio(page.form.radios, REASON_RADIO[action]);
    if (!radio && !ORDINARY.has(action)) {
      // 'refused' and not 'not_available': the phase button IS on screen, so this is not
      // "another stage's turn" —which is worth waiting for— but a reason we cannot find on
      // a page that is otherwise the right one. Tomorrow it will be missing too.
      throw new TimeclockError(
        'refused',
        `no encuentro el motivo "${REASON_RADIO[action][0]}" entre ` +
          `${page.form.radios.map((option) => option.label).join(' / ') || 'ninguna opción'}`,
      );
    }

    // A reason that demands a written justification is not one this can register: there is
    // nobody here to write it, and an empty justification on an attendance record is worse
    // than a missing punch. Its own kind, because unlike "the page does not offer this
    // stage" there is nothing to wait for: it will refuse the same way tomorrow.
    if (radio?.requiresComment) {
      throw new TimeclockError(
        'refused',
        `"${radio.label}" pide un comentario escrito y yo no tengo ninguno que dar`,
      );
    }

    const before = state.lastMovement;
    const after = await this.submit(
      page,
      { ...reasonFields(radio), ...phaseFields(action, button), ...button.fields },
      jar,
      clock,
    );

    return { action, registeredAt: confirm(action, stateOf(after), before) };
  }

  /**
   * The register page, logged in. The shared first half of both operations.
   *
   * The login page is asked for first rather than the register page: it is the entry point
   * of the site and it is what a browser is given, so following the site's own redirect is
   * more robust than guessing that an unauthenticated hit on `registro.asp` bounces.
   */
  private async open(
    options: TimeclockOptions,
  ): Promise<{ page: Page; jar: Jar; clock: Clock }> {
    const clock = new Clock(options.timeoutMs ?? 20_000);
    const jar = new Jar();
    const trail: string[] = [];

    try {
      // Straight at the register page. Logged out, the site redirects to its own login, so
      // there is no login URL to guess and no page of ours to be wrong about.
      let page = await this.request(this.url(REGISTER_PATH), { method: 'GET' }, jar, clock);
      trail.push(describePage(page));

      if (hasPassword(page.form)) {
        page = await this.login(page, jar, clock);
        trail.push(describePage(page));
      }

      // The login does not end at the login: it lands on a bridge, a page whose only job is
      // to move you along. Not following it means never getting a session, and the symptom
      // is identical to a wrong password — which is exactly the wrong turn this cost.
      for (let bounce = 0; bounce < MAX_BRIDGES; bounce++) {
        const step = bridgeStep(page);
        if (!step) break;
        page =
          step.kind === 'go'
            ? await this.request(
                new URL(step.url, page.url).toString(),
                { method: 'GET' },
                jar,
                clock,
              )
            : await this.submit(page, {}, jar, clock);
        trail.push(`${step.kind === 'go' ? 'refresh' : 'puente'} -> ${describePage(page)}`);
      }

      // The login lands wherever it wants; the punching happens on one page only.
      if (!isRegisterPage(page.form)) {
        page = await this.request(this.url(REGISTER_PATH), { method: 'GET' }, jar, clock);
        trail.push(describePage(page));
      }

      return { page: { ...page, trail }, jar, clock };
    } catch (error) {
      // The trail is worth more than the message: "the portal does not respond" is equally
      // true of a 500 on the third hop and of a redirect loop on the first, and those are
      // not the same problem.
      if (error instanceof TimeclockError) error.trail = trail;
      throw error;
    }
  }

  /**
   * The login form, filled without knowing its field names.
   *
   * The password input is unambiguous —there is one and it announces its type— and the
   * username is the text input just before it. That rule survives both fields being
   * renamed, which is more than a hardcoded name would.
   */
  private async login(page: Page, jar: Jar, clock: Clock): Promise<Page> {
    const passwordIndex = page.form.inputs.findIndex((input) => input.type === 'password');
    const password = page.form.inputs[passwordIndex];
    const username = [...page.form.inputs.slice(0, passwordIndex)]
      .reverse()
      .find((input) => input.type === 'text' || input.type === 'email');

    if (!password || !username) {
      throw new TimeclockError(
        'parse',
        'no encuentro los campos de usuario y contraseña en la página de login',
      );
    }

    // "Entrar" and not "Cambiar Contraseña": the labels are tried in order and the first
    // one is the orange button. Pressing the other would land on a password change form.
    const control = findControl(page.form, LOGIN_LABELS);
    const after = await this.submit(
      page,
      {
        [username.name]: this.user,
        [password.name]: this.pass,
        ...(control?.fields ?? {}),
      },
      jar,
      clock,
    );

    if (hasPassword(after.form)) {
      // Still on the login form. A snippet goes to the log and not to the user: it is the
      // only way to tell a wrong password from a page we failed to fill in.
      console.warn(`timeclock: login rejected, page text: ${textOf(after.html).slice(0, 200)}`);
      throw new TimeclockError('auth', 'el portal ha devuelto el formulario de login otra vez');
    }
    return after;
  }

  /** Posts the form back with its own state plus whatever is being pressed or picked. */
  private async submit(
    page: Page,
    fields: Record<string, string>,
    jar: Jar,
    clock: Clock,
  ): Promise<Page> {
    const target = new URL(page.form.action || page.url, page.url).toString();
    const body = new URLSearchParams({ ...formState(page.form), ...fields });

    // What we sent, on the way out of a failure. Field names only and never their values:
    // this string reaches a chat, and one of these fields is the comment box. It exists
    // because "the portal answered 500" is a symptom of our request that says nothing about
    // our request, and the difference between it and what a browser sends is the whole bug.
    try {
      return await this.postAndRead(target, body, jar, clock, page);
    } catch (error) {
      if (error instanceof TimeclockError) {
        error.trail.push(
          `POST ${new URL(target).pathname} [${[...body.keys()].join(',')}] cookies: ${jar.summary()}`,
        );
      }
      throw error;
    }
  }

  private async postAndRead(
    target: string,
    body: URLSearchParams,
    jar: Jar,
    clock: Clock,
    page: Page,
  ): Promise<Page> {
    return this.request(
      target,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Where the form was: a browser always sends these two on a form post, and this
          // one goes to a page whose own script decides what it is allowed to do by looking
          // at the client. Cheap to send, and the absence of them is a difference from a
          // real browser that we cannot see from outside.
          Referer: page.url,
          Origin: new URL(page.url).origin,
        },
        body: body.toString(),
      },
      jar,
      clock,
    );
  }

  private url(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }

  /**
   * One request, redirects followed by hand.
   *
   * By hand because `fetch` keeps no cookie jar: letting it follow a 302 would drop the
   * session cookie the login had just set, and that is precisely the redirect that
   * matters here.
   */
  private async request(url: string, init: RequestInit, jar: Jar, clock: Clock): Promise<Page> {
    let current = url;
    let request = init;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const budget = clock.next();
      let response: Response;
      try {
        response = await fetch(current, {
          ...request,
          redirect: 'manual',
          headers: {
            ...BROWSER_HEADERS,
            ...jar.header(),
            ...(request.headers as Record<string, string> | undefined),
          },
          signal: AbortSignal.timeout(budget),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new TimeclockError('upstream', `el portal no responde: ${detail}`);
      }

      jar.absorb(response.headers);

      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        current = new URL(location, current).toString();
        // A redirect is always followed with a GET and no body. Re-posting the form to
        // wherever the site points is how the same punch gets submitted twice.
        request = { method: 'GET' };
        continue;
      }

      if (!response.ok) {
        // The body, not just the number. A 500 from an ASP.NET site normally carries the
        // exception —or at least its type— in the page it returns, and throwing that away
        // is what left "el portal ha respondido 500" as the entire diagnosis of a punch
        // that has never once landed. Only the first line of text, because the alternative
        // is a stack trace in a chat window.
        throw new TimeclockError(
          'upstream',
          `el portal ha respondido ${response.status}${await says(response)}`,
        );
      }

      const html = await response.text();
      return { url: current, html, form: parseForm(html) };
    }

    throw new TimeclockError('upstream', 'el portal encadena demasiadas redirecciones');
  }
}

/**
 * What an error page says, in one line and never more.
 *
 * Reading the body of a failed response can itself fail —a truncated stream, a timeout that
 * fired between the headers and the body— and that must not replace the status code, which
 * is the one thing we already know.
 */
async function says(response: Response): Promise<string> {
  try {
    const text = (await response.text()).slice(0, 4000);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1];
    const line = (title ?? text.replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    return line ? `: ${line}` : '';
  } catch {
    return '';
  }
}

interface Page {
  url: string;
  html: string;
  form: ParsedForm;
  /**
   * Where this run has been, one entry per page.
   *
   * It exists because the first production run reported only the LAST page it saw, and the
   * question that mattered —which of the three hops went wrong— was unanswerable. A page
   * that cannot be understood is worth a breadcrumb trail; one that works costs nothing.
   */
  trail?: string[];
}

/**
 * One hop of the trail: where we were, what was on it, and what it said.
 *
 * The snippet is the part that was missing. A hop reported as "nada reconocible" says the
 * page was not understood but not what it was, and a page nobody can name is a page nobody
 * can fix.
 */
function describePage(page: Page): string {
  const marks = [
    hasPassword(page.form) ? 'login' : '',
    isRegisterPage(page.form) ? 'fichaje' : '',
    bridgeStep(page) ? 'puente' : '',
    page.form.radios.length > 0 ? `${page.form.radios.length} motivos` : '',
    // The count that was missing: a page reported as "nada reconocible" while carrying
    // hidden fields is a form waiting to be posted, not a dead end.
    page.form.inputs.length > 0 ? `${page.form.inputs.length} campos` : '',
    page.form.controls.length > 0 ? `${page.form.controls.length} botones` : '',
  ].filter(Boolean);

  const text = textOf(page.html).slice(0, 60);
  const said = marks.length === 0 && text ? ` "${text}"` : '';
  return `${new URL(page.url).pathname} [${marks.join(', ') || 'nada reconocible'}]${said}`;
}

function hasPassword(form: ParsedForm): boolean {
  return form.inputs.some((input) => input.type === 'password');
}

/**
 * How to get off a page that only exists to move you along, if it is one.
 *
 * Two mechanisms, and the meta refresh goes first because it needs no guessing at all: the
 * page states where it is going. A form with nothing to press is the other one — there is no
 * JavaScript here to run its script with, and there does not need to be, because a form
 * nobody can press is a form meant to be posted as it stands.
 */
function bridgeStep(page: Page): { kind: 'go'; url: string } | { kind: 'post' } | null {
  if (hasPassword(page.form) || isRegisterPage(page.form)) return null;

  const refresh = metaRefresh(page.html);
  if (refresh) return { kind: 'go', url: refresh };

  // A radio group is a choice, and a choice means the form is meant for a person. Posting
  // one blind is how the register page —whose button had gone unrecognised— got submitted
  // as if it were a bridge, and the portal answered 500. Deserved.
  if (page.form.radios.length > 0) return null;

  if (page.form.hasForm && page.form.controls.length === 0) return { kind: 'post' };
  return null;
}

/** `<meta http-equiv="refresh" content="0;url=algo">`, the honest half of a bridge page. */
function metaRefresh(html: string): string | null {
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/http-equiv\s*=\s*['"]?refresh/i.test(tag[0])) continue;
    const content = /content\s*=\s*['"]([^'"]+)['"]/i.exec(tag[0]);
    const url = content ? /url\s*=\s*(.+)$/i.exec(content[1]!.trim()) : null;
    if (url) return decodeEntities(url[1]!.trim().replace(/^['"]|['"]$/g, ''));
  }
  return null;
}

/** Whether this is the page that can punch, i.e. it carries one of the two buttons. */
function isRegisterPage(form: ParsedForm): boolean {
  return findControl(form, ['registrar entrada']) !== null || findControl(form, ['registrar salida']) !== null;
}

/**
 * What can be punched right now, read off the page.
 *
 * The button decides the phase and the radios decide which reasons that phase accepts, so
 * the two together are the answer to "have I clocked in?" without keeping any state of our
 * own. The ordinary actions do not require their radio to be found: pressing the button is
 * how a person does it.
 */
function stateOf(page: Page): PunchState {
  const { form } = page;

  // Exactly the checks `punch()` makes, in the same order, and that is the point: this list
  // is what the report and the model are told they can do, and it once said "I can punch the
  // break" about a stage `punch()` went on to refuse. A diagnosis that promises more than the
  // action delivers is worse than no diagnosis.
  const reachable = PUNCH_ACTIONS.filter((action) => Boolean(findControl(form, [PHASE_BUTTON[action]])));
  const available: PunchAction[] = [];
  const blocked: PunchAction[] = [];
  for (const action of reachable) {
    const radio = findRadio(form.radios, REASON_RADIO[action]);
    if (!radio) {
      if (ORDINARY.has(action)) available.push(action);
      else blocked.push(action);
      continue;
    }
    if (radio.requiresComment) blocked.push(action);
    else available.push(action);
  }

  return {
    available,
    blocked,
    labels: form.controls.map((control) => control.label).filter((label) => label.length > 2),
    reasons: form.radios
      .filter((radio) => radio.label.length > 2)
      .map(
        (radio) =>
          `${radio.label}${radio.requiresComment ? ' [pide comentario]' : ''}` +
          `${radio.showsComment ? ' [con caja de texto]' : ''}`,
      ),
    lastMovement: lastMovement(page.html),
    diagnosis: {
      url: page.url,
      sawLoginForm: hasPassword(form),
      inputs: form.inputs.length,
      controls: form.controls.length,
      snippet: textOf(page.html).slice(0, 160),
      trail: page.trail ?? [],
    },
  };
}

/** The empty-handed case in one line, for the error the model reads. */
function describe(state: PunchState): string {
  const { url, sawLoginForm, inputs, controls } = state.diagnosis;
  if (sawLoginForm) return `sigue en el login (${url})`;
  if (inputs === 0 && controls === 0) return `${url} no parece la aplicación`;
  return `en ${url} veo ${controls} botones: ${state.labels.slice(0, 6).join(' / ') || 'ninguno'}`;
}

/**
 * "Último movimiento": `24/08/2026 9:20:03 - Entrada ordinaria`.
 *
 * This is the portal stating what it recorded, which makes it worth more than anything we
 * could infer: it is both the confirmation that a punch landed and the answer to what time
 * it landed at, to the second.
 */
const MOVEMENT_LINE =
  /(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*-\s*([a-z][a-z ]{4,40})/;

function lastMovement(html: string): LastMovement | null {
  // The visible text first, for the day the portal decides to render this server-side, and
  // the script second, which is where it actually lives today:
  //
  //     function fVerResultado(){
  //       $("#presultado .panel-body").html("24/08/2026 14:07:08 - Salida al descanso");
  //     }
  //
  // For five deploys this was reported as "the portal paints it with JavaScript, so we
  // cannot read it". The string was in the html the whole time; what dropped it was our own
  // script stripping.
  for (const text of [textOf(html), ...scriptAssignedText(html)]) {
    const match = MOVEMENT_LINE.exec(text);
    if (match) return { date: match[1]!, time: match[2]!, label: match[3]!.trim() };
  }
  return null;
}

/**
 * Whether the punch landed, according to the portal.
 *
 * Two signals, and which one is available is not up to us. "Último movimiento" is the good
 * one —it names the reason and the time to the second— but the real portal paints that
 * panel with JavaScript, so it is usually not in the html at all. The fallback is the phase
 * flipping: the button we pressed must be gone, because the page only ever offers the phase
 * that comes next.
 *
 * What matters is the third outcome. If the movement line IS there and does not say what we
 * just sent, we do NOT know whether it was written, and the caller must never retry on that
 * — clocking in twice on an attendance record is worse than not clocking in.
 */
function confirm(
  action: PunchAction,
  after: PunchState,
  before: LastMovement | null,
): string | null {
  const movement = after.lastMovement;
  const expected = MOVEMENT_LABEL[action].map((label) => label);
  const matches = movement ? expected.some((label) => movement.label.includes(label)) : false;

  if (matches && (!before || before.time !== movement!.time)) return movement!.time;

  // No "Último movimiento" on the page at all: fall back to the phase flipping, which is
  // weaker but still real evidence — the button we pressed must be gone.
  if (!movement && !after.available.includes(action)) return null;

  console.warn(
    `timeclock: unconfirmed ${action}; last movement: ${
      movement ? `${movement.time} ${movement.label}` : 'none'
    }`,
  );
  throw new TimeclockError(
    'unverified',
    movement
      ? `el portal sigue diciendo que lo último fue "${movement.label}" a las ${movement.time}`
      : 'el portal no dice cuál fue el último movimiento',
  );
}

/**
 * The chosen reason, in the two places the page puts it.
 *
 * The visible radio group is the interface; what the server reads are the hidden fields,
 * and `fEnviar()` is what copies one into the other. With no JavaScript to run, that copy
 * is done here: the reason travels in the radio's own field, `subtipo` stays empty because
 * only a sub-reason fills it, and `comentario` is cleared because the automation never
 * writes one.
 *
 * `tipo` is NOT here, and that was the bug that made every punch vanish without a trace:
 * see `phaseFields`.
 *
 * The names are the page's own, so a portal that renames them stops being understood rather
 * than being written to wrongly — which is the right way round.
 */
function reasonFields(radio: { name: string; value: string } | null): Record<string, string> {
  if (!radio) return {};
  return {
    [radio.name]: radio.value,
    subtipo: '',
    comentario: '',
  };
}

/**
 * The hidden `tipo` field: "S" for a salida, "E" for an entrada.
 *
 * This is the whole reason no punch of ours ever landed. `tipo` looks like it names the kind
 * of punch and it does not — it names the **phase**, and the page's own script sets it from
 * the button that was pressed:
 *
 *     if (tipo == "send"){ $("#tipo").val("S"); } else { $("#tipo").val("E"); }
 *
 * We were writing the reason's code into it instead, so every POST told the server a phase
 * that did not exist. The server answered a page, wrote nothing, and there was no error to
 * find anywhere: the punch simply did not happen.
 *
 * Taken from the control's own `onclick` when the page offers one, because the button on
 * screen already IS the phase. The map is only the fallback for a page that renders its
 * buttons some other way, and it agrees with `PHASE_BUTTON` by construction.
 */
const PHASE_CODE: Record<PunchAction, 'S' | 'E'> = {
  clock_in: 'E',
  break_end: 'E',
  break_start: 'S',
  clock_out: 'S',
};

function phaseFields(action: PunchAction, button: { phase?: 'S' | 'E' }): Record<string, string> {
  return { tipo: button.phase ?? PHASE_CODE[action] };
}

/** The caller's budget, spent across the requests one operation needs. */
class Clock {
  private readonly endsAt: number;

  constructor(totalMs: number) {
    this.endsAt = Date.now() + totalMs;
  }

  next(): number {
    const remaining = this.endsAt - Date.now();
    if (remaining < MIN_REQUEST_MS) {
      throw new TimeclockError('upstream', 'se ha agotado el tiempo antes de terminar');
    }
    return Math.min(PER_REQUEST_MAX_MS, remaining);
  }
}

/**
 * A cookie jar for the length of one operation.
 *
 * Name and value only: expiry, domain and path would matter for a jar outliving a single
 * flow against a single host, and this one does not.
 */
class Jar {
  private readonly cookies = new Map<string, string>();

  absorb(headers: Headers): void {
    for (const cookie of readSetCookie(headers)) {
      const [pair] = cookie.split(';');
      const separator = pair?.indexOf('=') ?? -1;
      if (!pair || separator <= 0) continue;

      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();

      // An empty value is a deletion, and it must not overwrite a good cookie. Sites clear
      // their auth cookie on the way through the login —a `SignOut()` before the sign in—
      // and this jar used to keep the last thing it saw, whatever it was. The result would
      // be a request that carries `.ASPXAUTH=` and looks, to the far end, like somebody who
      // was logged in a moment ago and is not any more.
      if (!value) {
        this.cookies.delete(name);
        continue;
      }
      this.cookies.set(name, value);
    }
  }

  header(): Record<string, string> {
    if (this.cookies.size === 0) return {};
    return { Cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') };
  }

  /** Names and value lengths, for a failure report. Never the values: these are sessions. */
  summary(): string {
    if (this.cookies.size === 0) return 'sin cookies';
    return [...this.cookies].map(([name, value]) => `${name}(${value.length})`).join(' ');
  }
}

/**
 * Every Set-Cookie of a response.
 *
 * `getSetCookie()` is the only correct way: several cookies arrive as several headers and
 * `get()` joins them with a comma, which is ambiguous because the dates inside a cookie
 * carry commas too. The fallback is for runtimes predating it and gets one cookie right,
 * which is the usual case anyway.
 */
function readSetCookie(headers: Headers): string[] {
  const getter = (headers as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getter === 'function') return getter.call(headers);
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

export { DEFAULT_BASE_URL };
