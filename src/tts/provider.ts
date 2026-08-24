/**
 * The synthesis contract. Same criterion as the STT layer: whoever asks for a voice does
 * not know who produces it.
 *
 * Only `/voice` consumes this. It is NOT wired into the Telegram reply path, not even
 * behind a flag: answering a voice note with a voice note is phase 11 of the roadmap and
 * it has its own decisions to make (Opus so Telegram takes it as a voice note, text always
 * alongside the audio, what happens when the budget runs out). Reaching for this module
 * from `telegram/` would ship half of that phase by accident.
 */
export interface SynthesizeOptions {
  /** Cap for this call. Set by the request's global budget. */
  timeoutMs?: number;
}

export interface Speech {
  audio: ArrayBuffer;
  /** What the client has to play. Decided by the provider, not assumed by the caller. */
  mimeType: string;
}

export interface Synthesizer {
  readonly name: string;
  readonly model: string;
  synthesize(text: string, options?: SynthesizeOptions): Promise<Speech>;
}

export type TtsErrorKind = 'auth' | 'empty' | 'upstream';

export class TtsError extends Error {
  constructor(
    readonly kind: TtsErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'TtsError';
  }

  /**
   * What the user gets told. Written to be *read* and not spoken: when synthesis is what
   * failed there is no voice left to say it with, so this ends up on screen.
   */
  get userMessage(): string {
    switch (this.kind) {
      case 'auth':
        return 'No puedo hablar: falta la clave del servicio de voz. La respuesta la tienes escrita.';
      case 'empty':
        return 'No he podido generar el audio. La respuesta la tienes escrita.';
      case 'upstream':
        return 'El servicio de voz está fallando. La respuesta la tienes escrita.';
    }
  }
}

/**
 * How much of a reply gets read out loud.
 *
 * A cap and not "read everything", for two reasons pointing the same way: TTS is billed
 * per character —the most expensive tramo of the turn at OpenAI prices— and a reply
 * listing nine tasks is unbearable read aloud even when it is free. Nothing is lost: the
 * full text travels in the response for the client to show.
 */
export const MAX_SPEAKABLE_CHARS = 600;

/**
 * Trims a reply down to something worth listening to.
 *
 * It cuts at the last sentence end before the cap rather than mid-word, and it says out
 * loud that it cut. Staying quiet about the cut is how "tienes tres citas" becomes a
 * complete-sounding answer that left two out.
 */
export function speakable(text: string): string {
  const clean = text.trim();
  if (clean.length <= MAX_SPEAKABLE_CHARS) return clean;

  const window = clean.slice(0, MAX_SPEAKABLE_CHARS);
  const lastStop = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('.\n'),
    window.lastIndexOf('? '),
    window.lastIndexOf('! '),
  );
  const head = lastStop > MAX_SPEAKABLE_CHARS / 2 ? window.slice(0, lastStop + 1) : window;
  return `${head.trim()} Te lo dejo entero por escrito, que era largo.`;
}
