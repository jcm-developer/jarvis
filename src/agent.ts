import type { Config } from './config';
import { createProvider } from './llm';
import type { LLMMessage } from './llm/provider';
import { LLMError } from './llm/provider';
import { appendTurns, loadHistory } from './memory/history';
import { buildSystemPrompt } from './prompts/system';
import type { Env } from './types';

export interface AgentInput {
  chatId: number;
  text: string;
}

export interface AgentDeps {
  env: Env;
  config: Config;
}

/**
 * Fase 1: conversación con memoria de corto plazo, sin herramientas.
 *
 * El bucle agéntico con tool calling entra en la Fase 2; la estructura ya está
 * preparada para ello (el provider acepta `tools` y devuelve `toolCalls`).
 */
export async function runAgent(input: AgentInput, { env, config }: AgentDeps): Promise<string> {
  const history = await loadHistory(env, input.chatId);

  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({ timezone: config.defaultTimezone, now: new Date() }),
    },
    ...history.map((turn) => ({ role: turn.role, content: turn.content }) as LLMMessage),
    { role: 'user', content: input.text },
  ];

  const provider = createProvider(env, config);
  const started = Date.now();
  const response = await provider.chat(messages);

  console.info(
    JSON.stringify({
      event: 'llm_call',
      provider: provider.name,
      model: provider.model,
      finish: response.finishReason,
      prompt_tokens: response.usage.promptTokens,
      completion_tokens: response.usage.completionTokens,
      duration_ms: Date.now() - started,
    }),
  );

  const reply = response.content?.trim();
  if (!reply) {
    // Puede pasar si el modelo devuelve solo razonamiento y nada de contenido.
    throw new LLMError('malformed', 'el modelo devolvió una respuesta vacía');
  }

  // Solo se persiste si hubo respuesta útil: guardar turnos huérfanos degrada
  // el contexto de las siguientes preguntas.
  await appendTurns(
    env,
    input.chatId,
    history,
    [
      { role: 'user', content: input.text },
      { role: 'assistant', content: reply },
    ],
    config.historyWindow,
  );

  return reply;
}
