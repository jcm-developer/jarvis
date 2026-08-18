/**
 * Presupuesto de tiempo compartido por todos los pasos de un mensaje.
 *
 * Existe porque el procesamiento vive en `ctx.waitUntil()`, y Cloudflare cancela
 * esas tareas sin avisar pasado un margen tras devolver la respuesta. Poner un
 * timeout por llamada no basta: tres pasos de 20 s cada uno cumplen sus timeouts
 * individuales y aun así se pasan del presupuesto conjunto.
 *
 * Cada paso pide lo que le queda al reloj en vez de asumir un tope fijo, y si se
 * agota preferimos un mensaje honesto al silencio.
 */
export class Deadline {
  private constructor(private readonly endsAt: number) {}

  static in(ms: number): Deadline {
    return new Deadline(Date.now() + ms);
  }

  remainingMs(): number {
    return Math.max(0, this.endsAt - Date.now());
  }

  /** Lo que queda, acotado por el máximo que ese paso admite de por sí. */
  budgetFor(maxMs: number): number {
    return Math.min(maxMs, this.remainingMs());
  }

  /** Deja margen para enviar la respuesta a Telegram antes de que nos corten. */
  hasRoomFor(minimumMs: number): boolean {
    return this.remainingMs() >= minimumMs;
  }
}

export class DeadlineExceededError extends Error {
  constructor() {
    super('se agotó el presupuesto de tiempo del mensaje');
    this.name = 'DeadlineExceededError';
  }

  readonly userMessage =
    'Me ha llevado demasiado y he tenido que cortar. Prueba a pedírmelo más simple.';
}
