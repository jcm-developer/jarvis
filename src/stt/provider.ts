/**
 * The transcription contract. Same criterion as in the LLM layer: the rest of the code
 * does not know who transcribes.
 */
export interface TranscribeOptions {
  /** Cap for this call. Set by the message's global budget. */
  timeoutMs?: number;
}

export interface Transcriber {
  readonly name: string;
  transcribe(audio: ArrayBuffer, mimeType: string, options?: TranscribeOptions): Promise<string>;
}

/**
 * The canned sentences Whisper produces when it is handed silence.
 *
 * Not a guess: a dead microphone sends seven seconds of near-empty Opus, and what comes
 * back is "Subtítulos realizados por la comunidad de Amara.org" — the model was trained on
 * subtitle files and that is the credit line at the end of thousands of them. It is
 * confident, well-formed text, so nothing downstream can tell it from a real sentence: the
 * agent reads it, finds no task in it, and answers that there is nothing to note down. The
 * user is left with a working-looking system that ignores them.
 *
 * The list is deliberately narrow —whole-transcript matches of subtitle credits and
 * sign-offs— because the failure modes are not symmetrical. Missing one costs a wasted
 * turn; matching a real sentence swallows something the user actually said.
 */
const SILENCE_ARTEFACTS = [
  'subtitulos realizados por la comunidad de amara org',
  'subtitulos por la comunidad de amara org',
  'subtitulado por la comunidad de amara org',
  'subtitulos realizados por la comunidad de amara',
  'mas informacion en www amara org',
  'gracias por ver el video',
  'gracias por ver el video hasta el final',
  'suscribete al canal',
  'subtitles by the amara org community',
  'thanks for watching',
  'thank you for watching',
  'subscribe to my channel',
  'you',
];

/**
 * The transcript, or an empty string when it is one of Whisper's silence artefacts.
 *
 * Returning '' and not throwing is the point: every caller already handles an empty
 * transcript —Telegram asks the user to repeat, /voice says it heard nothing— and that is
 * exactly the right answer here, because nothing was said.
 */
export function stripSilenceArtefact(text: string): string {
  const normalised = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalised) return '';
  // Amara never comes up in dictation to a personal assistant, and it is in most of them.
  if (normalised.includes('amara org')) return '';
  return SILENCE_ARTEFACTS.includes(normalised) ? '' : text;
}

export type SttErrorKind = 'auth' | 'too_large' | 'empty' | 'upstream';

export class SttError extends Error {
  constructor(
    readonly kind: SttErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'SttError';
  }

  get userMessage(): string {
    switch (this.kind) {
      case 'auth':
        return 'No puedo transcribir: falta la clave del servicio de transcripción.';
      case 'too_large':
        return 'Ese audio es demasiado largo. Mándamelo en trozos más cortos.';
      case 'empty':
        return 'No he entendido nada en ese audio. ¿Puedes repetirlo?';
      case 'upstream':
        return 'El servicio de transcripción está fallando. Prueba otra vez.';
    }
  }
}
