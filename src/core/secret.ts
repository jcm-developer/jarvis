/**
 * Constant-time comparison of two secrets.
 *
 * It lived in `telegram/guard.ts` and the voice channel needs exactly the same check on
 * its own bearer token. Copying it would have been four lines; the reason not to is that
 * a second copy is a second place to get the comparison subtly wrong, and this is the one
 * function in the project where "works the same" and "is correct" are different claims.
 *
 * The length does leak, and that is acceptable: both tokens are fixed-length secrets we
 * generate ourselves.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) return false;

  let diff = 0;
  for (let i = 0; i < left.byteLength; i++) {
    diff |= left[i]! ^ right[i]!;
  }
  return diff === 0;
}
