/**
 * Contrato común a todos los proveedores de LLM.
 *
 * Nada fuera de `src/llm/` debe saber qué proveedor está en uso. Cuando el free
 * tier de NVIDIA se agote, cambiar a Groq o Gemini debe ser una variable de
 * entorno, no una refactorización del agente.
 */

export interface ToolCall {
  id: string;
  name: string;
  /** Argumentos sin parsear, tal cual los emite el modelo. Puede ser JSON inválido. */
  arguments: string;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Solo en role='assistant', cuando el modelo pide herramientas. */
  toolCalls?: ToolCall[];
  /** Solo en role='tool', enlaza con la llamada que originó el resultado. */
  toolCallId?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema de los argumentos. */
  parameters: Record<string, unknown>;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'other';

export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: { promptTokens: number; completionTokens: number };
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  chat(messages: LLMMessage[], tools?: ToolSchema[]): Promise<LLMResponse>;
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

  /** Mensaje apto para enviar al usuario por Telegram. */
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
