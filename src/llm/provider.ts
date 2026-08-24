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

/**
 * An image attached to a user message.
 *
 * It travels as raw bytes on purpose. How an image is written on the wire —base64
 * inside a data URL, split into `image_url` parts, with its `detail` level— is the
 * adapter's business, and the moment that shape appears in this interface it starts
 * leaking into `agent.ts`, which must not learn how a photo is sent.
 */
export interface LLMImage {
  mimeType: string;
  data: ArrayBuffer;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Only on role='assistant', when the model asks for tools. */
  toolCalls?: ToolCall[];
  /** Only on role='tool', links back to the call that produced the result. */
  toolCallId?: string;
  /**
   * Only on role='user': what came attached to this message.
   *
   * Never persisted and never replayed from the history. One photo per turn would fill
   * the whole window on its own, so `messages` keeps the reference and the bytes live
   * for exactly one request.
   */
  images?: LLMImage[];
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
  /**
   * Cap on what the model may write back, overriding the provider's default.
   *
   * It exists for `/test`, and it exists because of a measurement that lied: comparing a
   * bare call against one carrying the system prompt compares two different things if the
   * model is free to answer at length in one and not the other. At ~100 tokens a second,
   * an 800-token default IS the eight seconds being measured. Bounding it turns the number
   * back into latency.
   */
  maxTokens?: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  /**
   * Whether this model reads images.
   *
   * Asked BEFORE downloading the photo. With a text-only model the alternative is
   * spending the budget on a download and getting a 400 back from the provider halfway
   * through the turn, which reaches the user as "algo ha fallado por dentro".
   */
  readonly supportsImages: boolean;
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
