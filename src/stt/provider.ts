/**
 * Contrato de transcripción. Mismo criterio que en la capa de LLM: el resto del
 * código no sabe quién transcribe.
 */
export interface TranscribeOptions {
  /** Tope para esta llamada. Lo fija el presupuesto global del mensaje. */
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
