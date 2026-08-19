import type { Env } from '../types';
import type { Transcriber } from './provider';
import { SttError } from './provider';

/**
 * Transcription with Workers AI, inside Cloudflare's own network.
 *
 * The free alternative to OpenAI: it comes out of the free plan's daily Neuron quota and
 * never leaves the Worker, so it adds no external network latency.
 */
export class WorkersAiTranscriber implements Transcriber {
  readonly name = 'workers-ai';

  constructor(
    private readonly ai: Env['AI'],
    private readonly model: string,
    private readonly language: string,
  ) {}

  // Workers AI runs inside Cloudflare and does not accept an AbortSignal, so the time
  // budget does not apply here.
  async transcribe(audio: ArrayBuffer): Promise<string> {
    try {
      // whisper-large-v3-turbo expects the audio as base64, not as a byte array (that
      // was the old @cf/openai/whisper). The binding's typing is loose, hence the cast.
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

/** In chunks: spreading hundreds of thousands of bytes blows the stack. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
