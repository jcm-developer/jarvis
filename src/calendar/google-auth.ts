import type { Env } from '../types';
import { CalendarError } from './provider';

/**
 * Access token de Google a partir de una service account.
 *
 * Se firma un JWT RS256 con WebCrypto y se canjea por un token de una hora. Es el
 * precio de haber descartado el OAuth de usuario, y se paga a gusto: una app de
 * Google Cloud en estado *Testing* emite refresh tokens que caducan a los siete
 * días, así que el bot se habría quedado muerto cada semana. Con la service
 * account no caduca nada.
 *
 * El token se cachea en KV: una escritura cada 55 minutos son ~26 al día, nada
 * frente al límite de 1.000 del plan free, y ahorra un viaje de red a Google en
 * cada cita que se crea.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** El mínimo que necesitamos: crear y editar eventos, no administrar calendarios. */
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

const CACHE_KEY = 'google:access_token';

/**
 * 55 min y no 60: un token recién sacado de la caché tiene que sobrevivir a la
 * petición que va a hacer con él.
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
    // El cuerpo de Google trae el motivo real ('invalid_grant' cuando la clave
    // está mal pegada, que es el fallo más probable la primera vez). Va al log
    // porque es lo único que permite distinguirlo sin adivinar.
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
 * Saca el DER de la clave del PEM que viene en el JSON de la service account.
 *
 * Tolera las tres formas en que esa clave acaba en un secret de Cloudflare: con
 * saltos de línea reales, con `\n` literales tal como están en el JSON, y con las
 * comillas de alrededor pegadas por error. Las tres pasan por aquí porque el
 * copiar-pegar de una cadena de 1.700 caracteres se hace una vez y a mano.
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

/** Base64 en su variante URL-safe y sin relleno, que es la que exige el JWT. */
function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
