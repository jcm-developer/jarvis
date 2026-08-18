import type { Env } from '../types';
import type { Transcriber } from './provider';
import { SttError } from './provider';

/**
 * Transcripción con Workers AI, dentro de la propia red de Cloudflare.
 *
 * Alternativa gratuita a OpenAI: entra en la cuota diaria de Neurons del plan
 * free y no sale del Worker, así que no añade latencia de red externa.
 */
export class WorkersAiTranscriber implements Transcriber {
  readonly name = 'workers-ai';

  constructor(
    private readonly ai: Env['AI'],
    private readonly model: string,
    private readonly language: string,
  ) {}

  async transcribe(audio: ArrayBuffer): Promise<string> {
    try {
      // whisper-large-v3-turbo espera el audio en base64, no como array de bytes
      // (eso era el @cf/openai/whisper antiguo). El tipado del binding es laxo,
      // de ahí el cast.
      const result = (await (this.ai as unknown as AiRunner).run(this.model, {
        audio: toBase64(audio),
        language: this.language,
        task: 'transcribe',
      })) as { text?: string } | undefined;

      return result?.text?.trim() ?? '';
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SttError('upstream', `workers-ai stt: ${detail}`);
    }
  }
}

interface AiRunner {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/** Por trozos: un spread de cientos de miles de bytes revienta la pila. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
