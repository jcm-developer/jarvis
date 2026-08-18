import type { Transcriber } from './provider';
import { SttError } from './provider';

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const TIMEOUT_MS = 30_000;

/**
 * Transcripción con la API de OpenAI.
 *
 * Se eligió como predeterminado porque acepta OGG/Opus sin conversión, que es
 * justo el formato en que Telegram envía las notas de voz, y porque su precisión
 * en español con audio de móvil es notablemente mejor.
 *
 * Cuesta unos céntimos por hora de audio. Para uso personal es irrelevante, pero
 * si prefieres coste cero está `workers-ai`, que corre dentro de Cloudflare.
 */
export class OpenAITranscriber implements Transcriber {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    /** Fijar el idioma mejora bastante la precisión frente a autodetectarlo. */
    private readonly language: string,
  ) {}

  async transcribe(audio: ArrayBuffer, mimeType: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mimeType }), fileNameFor(mimeType));
    form.append('model', this.model);
    form.append('language', this.language);
    form.append('response_format', 'json');

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        // Sin Content-Type a propósito: fetch debe generar el boundary del multipart.
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
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

/** La API de OpenAI decide el decodificador por la extensión del nombre de fichero. */
function fileNameFor(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'audio.ogg';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'audio.mp3';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'audio.m4a';
  if (mimeType.includes('wav')) return 'audio.wav';
  if (mimeType.includes('webm')) return 'audio.webm';
  return 'audio.ogg';
}
