/**
 * Time budget shared by every step of a single message.
 *
 * It exists because the processing lives in `ctx.waitUntil()`, and Cloudflare kills
 * those tasks without warning once a margin after the response has passed. A timeout
 * per call is not enough: three steps of 20 s each honour their individual timeouts
 * and still blow the combined budget.
 *
 * Every step asks the clock what is left instead of assuming a fixed cap, and when it
 * runs out we prefer an honest message to silence.
 */
export class Deadline {
  private constructor(private readonly endsAt: number) {}

  static in(ms: number): Deadline {
    return new Deadline(Date.now() + ms);
  }

  remainingMs(): number {
    return Math.max(0, this.endsAt - Date.now());
  }

  /** What is left, capped by the maximum that step accepts on its own. */
  budgetFor(maxMs: number): number {
    return Math.min(maxMs, this.remainingMs());
  }

  /** Leaves room to send the reply to Telegram before we get cut off. */
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
