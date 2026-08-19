import type { Transcriber, TranscribeOptions } from './provider';
import { SttError } from './provider';

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Transcription with OpenAI's API.
 *
 * Picked as the default because it accepts OGG/Opus without conversion, which is exactly
 * the format Telegram sends voice notes in, and because its accuracy in Spanish with
 * phone audio is noticeably better.
 *
 * It costs a few cents per hour of audio. For personal use that is irrelevant, but if
 * you would rather pay nothing there is `workers-ai`, which runs inside Cloudflare.
 */
export class OpenAITranscriber implements Transcriber {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    /** Pinning the language improves accuracy quite a bit over autodetecting it. */
    private readonly language: string,
  ) {}

  async transcribe(
    audio: ArrayBuffer,
    mimeType: string,
    options?: TranscribeOptions,
  ): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mimeType }), fileNameFor(mimeType));
    form.append('model', this.model);
    form.append('language', this.language);
    form.append('response_format', 'json');

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        // No Content-Type on purpose: fetch must generate the multipart boundary.
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(Math.max(1_000, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SttError('upstream', `openai stt: ${detail}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new SttError('auth', 'openai stt: clave rechazada');
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new SttError('upstream', `openai stt ${response.status}: ${detail.slice(0, 300)}`);
    }

    const body = (await response.json()) as { text?: string };
    return body.text?.trim() ?? '';
  }
}

/** OpenAI's API picks the decoder from the file name's extension. */
function fileNameFor(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'audio.ogg';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'audio.mp3';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'audio.m4a';
  if (mimeType.includes('wav')) return 'audio.wav';
  if (mimeType.includes('webm')) return 'audio.webm';
  return 'audio.ogg';
}
