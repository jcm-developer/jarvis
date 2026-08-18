import type {
  FinishReason,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  ToolCall,
  ToolSchema,
} from '../provider';
import { LLMError } from '../provider';

/**
 * Adaptador para cualquier API que hable el formato de OpenAI.
 *
 * NVIDIA NIM, Groq, Together y varios más exponen exactamente este contrato, así
 * que un solo adaptador los cubre todos: solo cambian `baseUrl`, la clave y el
 * modelo. Se usa `fetch` directo en vez del SDK de OpenAI para no arrastrar una
 * dependencia pesada al bundle del Worker.
 */

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: string;
  content?: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

interface WireResponse {
  choices?: Array<{ message?: WireMessage; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export interface OpenAICompatibleOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 2_000;

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(options: OpenAICompatibleOptions) {
    this.name = options.name;
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.temperature = options.temperature ?? 0.6;
    this.maxTokens = options.maxTokens ?? 1024;
    this.timeoutMs = options.timeoutMs ?? 45_000;
  }

  async chat(messages: LLMMessage[], tools?: ToolSchema[]): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(toWireMessage),
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      stream: false,
    };

    if (tools && tools.length > 0) {
      body['tools'] = tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      body['tool_choice'] = 'auto';
    }

    const response = await this.request(body);
    return this.parse(response);
  }

  private async request(body: unknown): Promise<Response> {
    let lastError: LLMError | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        // AbortSignal.timeout produce un TimeoutError; el resto son fallos de red.
        const isTimeout = error instanceof Error && error.name === 'TimeoutError';
        lastError = new LLMError(
          isTimeout ? 'timeout' : 'upstream',
          `${this.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw lastError;
      }

      if (response.ok) return response;

      const detail = await safeErrorDetail(response);

      if (response.status === 401 || response.status === 403) {
        // Reintentar no arregla una clave inválida.
        throw new LLMError('auth', `${this.name}: ${detail}`, response.status);
      }

      const kind = response.status === 429 ? 'rate_limit' : 'upstream';
      lastError = new LLMError(kind, `${this.name}: ${detail}`, response.status);

      if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw lastError;
    }

    throw lastError ?? new LLMError('upstream', `${this.name}: fallo desconocido`);
  }

  private async parse(response: Response): Promise<LLMResponse> {
    let data: WireResponse;
    try {
      data = (await response.json()) as WireResponse;
    } catch {
      throw new LLMError('malformed', `${this.name}: la respuesta no era JSON`);
    }

    const choice = data.choices?.[0];
    if (!choice?.message) {
      throw new LLMError('malformed', `${this.name}: respuesta sin choices`);
    }

    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    }));

    return {
      content: stripReasoning(choice.message.content ?? null),
      toolCalls,
      finishReason: toFinishReason(choice.finish_reason),
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }
}

function toWireMessage(message: LLMMessage): WireMessage {
  const wire: WireMessage = { role: message.role, content: message.content };

  if (message.toolCalls?.length) {
    wire.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function' as const,
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  if (message.toolCallId) {
    wire.tool_call_id = message.toolCallId;
  }
  return wire;
}

function toFinishReason(raw: string | undefined): FinishReason {
  switch (raw) {
    case 'stop':
    case 'tool_calls':
    case 'length':
      return raw;
    default:
      return 'other';
  }
}

/**
 * Los modelos de razonamiento (Nemotron, DeepSeek-R1) emiten su cadena de
 * pensamiento entre <think></think> dentro del propio contenido. Al usuario no le
 * interesa, y sin esto aparecería íntegra en Telegram.
 */
function stripReasoning(content: string | null): string | null {
  if (!content) return content;
  const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return cleaned.length > 0 ? cleaned : null;
}

async function safeErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as WireResponse & { detail?: string };
      return parsed.error?.message ?? parsed.detail ?? text.slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return `HTTP ${response.status}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
