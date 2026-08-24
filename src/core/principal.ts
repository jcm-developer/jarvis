/**
 * Who is talking, with no channel attached.
 *
 * `resolveIdentity` never needed a Telegram user: it reads three fields off it and writes
 * them into `users`. Taking the wire object anyway is what tied the core to one channel —
 * a second entry point had nothing to hand it that was not a forged `TelegramUser`.
 *
 * The conversion lives at the edge that owns the wire format (`telegram/handler.ts`), not
 * here: this file must not know that Telegram exists.
 */
export interface Principal {
  /**
   * Stable id of the person across channels.
   *
   * Today it is their Telegram id, and the column it lands in is still `users.telegram_id`.
   * That is deliberate and not an oversight: renaming the column would migrate the one row
   * that makes the history continuous, and the id is the same number whichever channel it
   * arrives through.
   */
  id: number;
  username?: string;
  firstName?: string;
}
