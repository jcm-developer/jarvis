import type { Env } from '../types';
import { CalendarError } from './provider';

/**
 * A Google access token from a service account.
 *
 * An RS256 JWT is signed with WebCrypto and exchanged for a one-hour token. That is
 * the price of having ruled out user OAuth, and it is gladly paid: a Google Cloud app
 * in *Testing* state issues refresh tokens that expire after seven days, so the bot
 * would have gone dead every week. With the service account nothing expires.
 *
 * The token is cached in KV: one write every 55 minutes is ~26 a day, nothing against
 * the free plan's 1,000 limit, and it saves a network round trip to Google on every
 * appointment created.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The minimum we need: creating and editing events, not administering calendars. */
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

const CACHE_KEY = 'google:access_token';

/**
 * 55 min and not 60: a token just pulled from the cache has to outlive the request it
 * is about to make with it.
 */
const CACHE_TTL_SECONDS = 3_300;

export async function getAccessToken(env: Env, timeoutMs: number): Promise<string> {
  const cached = await env.STATE.get(CACHE_KEY);
  if (cached) return cached;

  const email = env.GOOGLE_SA_EMAIL?.trim();
  const privateKey = env.GOOGLE_SA_PRIVATE_KEY;
  if (!email || !privateKey) {
    throw new CalendarError(
      'El calendario no está configurado: faltan los secrets GOOGLE_SA_EMAIL y ' +
        'GOOGLE_SA_PRIVATE_KEY en el Worker.',
    );
  }

  const assertion = await signAssertion(email, privateKey);
  const token = await exchange(assertion, timeoutMs);

  await env.STATE.put(CACHE_KEY, token, { expirationTtl: CACHE_TTL_SECONDS });
  return token;
}

async function exchange(assertion: string, timeoutMs: number): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CalendarError(`no se pudo pedir el token a Google: ${detail}`);
  }

  const text = await response.text();

  if (!response.ok) {
    // Google's body carries the real reason ('invalid_grant' when the key was pasted
    // badly, which is the likeliest first-time failure). It goes to the log because it
    // is the only thing that tells them apart without guessing.
    console.error(
      JSON.stringify({
        event: 'google_token_failed',
        status: response.status,
        body: text.slice(0, 300),
      }),
    );
    throw new CalendarError(`Google rechazó las credenciales (${response.status})`, response.status);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CalendarError('Google devolvió algo que no era JSON al pedir el token');
  }

  const token = (parsed as { access_token?: unknown }).access_token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new CalendarError('Google no devolvió access_token');
  }
  return token;
}

async function signAssertion(email: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${b64url(encode(JSON.stringify(header)))}.${b64url(encode(JSON.stringify(claims)))}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8FromPem(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(signature))}`;
}

/**
 * Pulls the key's DER out of the PEM that comes in the service account JSON.
 *
 * It tolerates the three shapes that key ends up in inside a Cloudflare secret: with
 * real newlines, with literal `\n` exactly as they sit in the JSON, and with the
 * surrounding quotes pasted in by mistake. All three go through here because copying a
 * 1,700-character string is done once, by hand.
 */
function pkcs8FromPem(pem: string): ArrayBuffer {
  const base64 = pem
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\n/g, '\n')
    .replace(/-----(?:BEGIN|END) PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  if (base64.length === 0) {
    throw new CalendarError(
      'GOOGLE_SA_PRIVATE_KEY está vacío o no tiene el formato PEM del JSON de la service account.',
    );
  }

  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new CalendarError(
      'GOOGLE_SA_PRIVATE_KEY no es base64 válido: pega el valor del campo private_key ' +
        'del JSON tal cual, incluidas las líneas BEGIN/END.',
    );
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Base64 in its URL-safe, unpadded variant, which is what the JWT requires. */
function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
