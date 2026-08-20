import type { TelegramPhotoSize } from '../types';

/**
 * Which of Telegram's versions of a photo gets downloaded.
 *
 * Telegram does the compressing for us: one `sendPhoto` arrives as several sizes, from a
 * 90 px thumbnail to the compressed original, and every one of them has its own
 * `file_id`. Taking the last of the array —the biggest— is the obvious move and the
 * wrong one: it is the slowest to download, the most expensive to send to the model,
 * and past a certain point it adds nothing, because what we are reading is the text on
 * a letter or a poster, not the grain of the paper.
 *
 * So the choice is the biggest one that stays under both caps. Same division of labour
 * as everywhere else in the project: the sizes are Telegram's, the decision is ours.
 */

/**
 * Longest edge we are willing to send.
 *
 * A letter photographed at 1280 px has legible text; at 90 or 320 it does not, which is
 * why the smallest is not simply always taken. It also matches one of the sizes Telegram
 * actually produces (90, 320, 800, 1280), so in practice this picks a real version
 * rather than falling back.
 */
export const MAX_PHOTO_EDGE = 1280;

/**
 * Byte cap for the version we pick.
 *
 * The photo has to come down inside the message's budget and then travel again inside
 * the request to the model, so this is not about storage: it is time spent twice. 700 KB
 * is well above Telegram's 1280 px version of a normal photo (~150-300 KB) and well
 * below the original.
 */
export const MAX_PHOTO_BYTES = 700 * 1024;

/**
 * The version to download, or null when the message carries nothing usable.
 *
 * The array is re-sorted instead of trusted: it does come ordered from smallest to
 * largest, but nothing in the API guarantees it and the whole point of this function is
 * to not depend on the order being what we assume.
 */
export function pickPhotoSize(sizes: TelegramPhotoSize[]): TelegramPhotoSize | null {
  const usable = sizes.filter((size) => typeof size.file_id === 'string' && size.file_id !== '');
  if (usable.length === 0) return null;

  const ordered = [...usable].sort((a, b) => longestEdge(a) - longestEdge(b));
  const fits = ordered.filter(
    (size) => longestEdge(size) <= MAX_PHOTO_EDGE && (size.file_size ?? 0) <= MAX_PHOTO_BYTES,
  );

  // When none fits —a message carrying only the original, or sizes with no dimensions—
  // the smallest goes, not nothing: a photo the model can barely read still beats
  // telling the user their photo is unusable.
  return fits[fits.length - 1] ?? ordered[0]!;
}

/**
 * Telegram compresses photos to JPEG and does not say so in the update: `photo` carries
 * no `mime_type` the way `voice` does. Hardcoded here rather than guessed at the call
 * site, because it is a fact about the API and not about this photo.
 */
export const PHOTO_MIME_TYPE = 'image/jpeg';

function longestEdge(size: TelegramPhotoSize): number {
  const width = Number.isFinite(size.width) ? size.width : 0;
  const height = Number.isFinite(size.height) ? size.height : 0;
  return Math.max(width, height);
}
