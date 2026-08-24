import type { Env } from '../types';
import type { Speech, Synthesizer } from './provider';
import { TtsError } from './provider';

/**
 * Synthesis with Workers AI, inside Cloudflare's own network.
 *
 * The free alternative, and the accounting is the whole story. Both models are billed in
 * Neurons out of the free plan's 10,000 a day, and they are two orders of magnitude apart:
 *
 *   @cf/myshell-ai/melotts   ~18.6 neurons per audio minute  -> ~3 per reply
 *   @cf/deepgram/aura-2-es   2,727 neurons per 1k characters -> ~409 per reply
 *
 * So melotts never hits the quota and aura-2-es hits it at roughly two dozen replies a
 * day, at which point it needs Workers Paid. aura-2-es is the better Spanish by a distance
 * and melotts has unresolved reports of rejecting `lang: "es"` outright, which is why
 * neither is the default: see src/tts/openai.ts.
 */
export class WorkersAiSynthesizer implements Synthesizer {
  readonly name = 'workers-ai';

  constructor(
    private readonly ai: Env['AI'],
    readonly model: string,
    /** A speaker name for aura, a language code for melotts. See `inputFor`. */
    private readonly voice: string,
    private readonly language: string,
  ) {}

  // Workers AI runs inside Cloudflare and does not accept an AbortSignal, so the time
  // budget does not apply here — the same hole the STT side has.
  async synthesize(text: string): Promise<Speech> {
    let result: unknown;
    try {
      result = await (this.ai as unknown as AiRunner).run(this.model, this.inputFor(text));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new TtsError('upstream', `workers-ai tts: ${detail}`);
    }

    const audio = await toArrayBuffer(result);
    if (!audio || audio.byteLength === 0) {
      throw new TtsError('empty', 'workers-ai tts devolvió un audio vacío');
    }
    // Both models emit MPEG: melotts returns mp3 bytes, and aura is asked for mp3 below.
    return { audio, mimeType: 'audio/mpeg' };
  }

  /**
   * The two models do not share an input schema, and pretending they do is how you get a
   * silent 8002. melotts takes `prompt` plus a language code; aura takes `text` plus a
   * speaker name and an explicit encoding.
   */
  private inputFor(text: string): Record<string, unknown> {
    if (this.model.includes('melotts')) {
      return { prompt: text, lang: this.language };
    }
    return { text, speaker: this.voice, encoding: 'mp3' };
  }
}

interface AiRunner {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/**
 * What `AI.run` hands back, which is not one thing.
 *
 * aura returns a ReadableStream —it is built to start playing before it finishes
 * synthesising— and melotts returns the mp3 bytes directly. The stream is drained here
 * rather than piped through to the client on purpose: piping would mean the response
 * headers go out before synthesis is done, and those headers are where the per-stage
 * timings live. Measuring this phase is the point of it; streaming can come after there
 * are numbers to argue with.
 */
async function toArrayBuffer(result: unknown): Promise<ArrayBuffer | null> {
  if (result instanceof ArrayBuffer) return result;
  if (result instanceof ReadableStream) return new Response(result).arrayBuffer();
  if (result instanceof Uint8Array) return result.buffer as ArrayBuffer;

  // Some bindings wrap the bytes in an object with a base64 `audio` field.
  if (typeof result === 'object' && result !== null) {
    const audio = (result as Record<string, unknown>)['audio'];
    if (typeof audio === 'string') return fromBase64(audio);
    if (audio instanceof ReadableStream) return new Response(audio).arrayBuffer();
  }
  return null;
}

function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
