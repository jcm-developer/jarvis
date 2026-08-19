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
