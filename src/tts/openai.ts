import type { Speech, Synthesizer, SynthesizeOptions } from './provider';
import { TtsError } from './provider';

const ENDPOINT = 'https://api.openai.com/v1/audio/speech';
const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * Synthesis with OpenAI's API.
 *
 * The default, and for the same reason the STT default is OpenAI: Spanish. The free
 * alternative inside Cloudflare is `workers-ai`, and it is a real alternative —see
 * src/tts/workers-ai.ts— but `melotts` has unresolved reports of rejecting `lang: "es"`
 * and `aura-2-es`, which is genuinely good, burns the free Neuron quota in about two
 * dozen replies a day. This one costs $15 per million characters, which at a few hundred
 * characters a reply is a rounding error, and reuses OPENAI_API_KEY.
 */
export class OpenAISynthesizer implements Synthesizer {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly voice: string,
  ) {}

  async synthesize(text: string, options?: SynthesizeOptions): Promise<Speech> {
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: text,
          voice: this.voice,
          response_format: 'mp3',
        }),
        signal: AbortSignal.timeout(Math.max(1_000, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new TtsError('upstream', `openai tts: ${detail}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new TtsError('auth', 'openai tts: clave rechazada');
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new TtsError('upstream', `openai tts ${response.status}: ${detail.slice(0, 300)}`);
    }

    const audio = await response.arrayBuffer();
    if (audio.byteLength === 0) {
      throw new TtsError('empty', 'openai tts devolvió un audio vacío');
    }
    return { audio, mimeType: 'audio/mpeg' };
  }
}
