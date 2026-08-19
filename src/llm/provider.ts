/**
 * The contract shared by every LLM provider.
 *
 * Nothing outside `src/llm/` should know which provider is in use. When NVIDIA's free
 * tier runs out, switching to Groq or Gemini must be an environment variable, not a
 * refactor of the agent.
 */

export interface ToolCall {
  id: string;
  name: string;
  /** Unparsed arguments, exactly as the model emits them. May be invalid JSON. */
  arguments: string;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Only on role='assistant', when the model asks for tools. */
  toolCalls?: ToolCall[];
  /** Only on role='tool', links back to the call that produced the result. */
  toolCallId?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'other';

export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: { promptTokens: number; completionTokens: number };
}

export interface ChatOptions {
  /** Cap for this particular call. Set by the message's global budget. */
  timeoutMs?: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  chat(
    messages: LLMMessage[],
    tools?: ToolSchema[],
    options?: ChatOptions,
  ): Promise<LLMResponse>;
}

export type LLMErrorKind =
  | 'auth' // clave ausente o inválida
  | 'rate_limit' // cuota o límite por minuto
  | 'timeout'
  | 'upstream' // el proveedor falló
  | 'malformed'; // respondió algo que no sabemos leer

export class LLMError extends Error {
  constructor(
    readonly kind: LLMErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LLMError';
  }

  /** A message fit to send to the user over Telegram. */
  get userMessage(): string {
    switch (this.kind) {
      case 'auth':
        return 'No puedo hablar con el modelo: la API key falta o no es válida.';
      case 'rate_limit':
        return 'He llegado al límite de peticiones del proveedor. Prueba en un minuto.';
      case 'timeout':
        return 'El modelo ha tardado demasiado. Inténtalo otra vez.';
      case 'upstream':
        return 'El proveedor del modelo está fallando. No es cosa tuya.';
      case 'malformed':
        return 'El modelo ha respondido algo que no he sabido interpretar.';
    }
  }
}
