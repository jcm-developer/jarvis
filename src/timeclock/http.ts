import { findControl, formState, parseForm, textOf, type ParsedForm } from './html';
import {
  TimeclockError,
  PUNCH_ACTIONS,
  type TimeclockOptions,
  type PunchAction,
  type PunchClient,
  type PunchResult,
  type PunchState,
} from './provider';

/**
 * ficharweb over plain HTTP, from the Worker (phase 22).
 *
 * There is no browser in this runtime and Browser Rendering is on the paid plan, so the
 * three requests a punch actually needs are made by hand: load the page, log in, press
 * the button. Two things make that viable without knowing the site's internals — the
 * form's hidden fields are copied verbatim, so `__VIEWSTATE` and friends travel through
 * without this code knowing they exist, and the button is found by the words on it.
 *
 * Everything site-specific is ACTION_LABELS and the two paths below. If the portal is
 * reworded that is the block to fix, and the error says so with the labels it did find.
 */

const DEFAULT_BASE_URL = 'https://ficharweb.ccbosco.org';
const HOME_PATH = '/CCB/Home';

/** Cap per request. The caller's budget is split across three of them at most. */
const PER_REQUEST_MAX_MS = 8_000;

/** Under this there is no point starting another request. */
const MIN_REQUEST_MS = 1_500;

const MAX_REDIRECTS = 5;

/**
 * How each action is worded on the page.
 *
 * Only full wordings, with no loose fallback: "entrada" on its own would also match
 * "Entrada del descanso" and clock the wrong thing, and on a legal record a wrong punch
 * is worse than no punch. Both prepositions are listed for the break because neither
 * collides with the other action, and which one the portal uses is not worth a redeploy.
 */
const ACTION_LABELS: Record<PunchAction, string[]> = {
  clock_in: ['entrada ordinaria'],
  clock_out: ['salida ordinaria'],
  break_start: ['salida al descanso', 'salida del descanso'],
  break_end: ['entrada del descanso', 'entrada al descanso'],
};

/** Words on the login button, in the order they are worth trying. */
const LOGIN_LABELS = ['entrar', 'acceder', 'iniciar sesion', 'login', 'enviar'];

export class HttpPunchClient implements PunchClient {
  readonly name = 'ficharweb-http';

  constructor(
    private readonly baseUrl: string,
    private readonly user: string,
    private readonly pass: string,
  ) {}

  /**
   * What the portal offers right now. One read, and it writes nothing.
   *
   * The automation calls it for free —`punch()` does the same read on its way in— but the
   * user asking "have I clocked in?" gets only this, so nothing can be submitted by
   * accident on a path that was only ever a question.
   */
  async readState(options: TimeclockOptions = {}): Promise<PunchState> {
    const { page } = await this.open(options);
    return stateOf(page.form);
  }

  async punch(action: PunchAction, options: TimeclockOptions = {}): Promise<PunchResult> {
    const { page, jar, clock } = await this.open(options);

    const control = findControl(page.form, ACTION_LABELS[action]);
    if (!control) {
      const state = stateOf(page.form);
      // Two very different situations, and telling them apart is the whole point of
      // collecting the labels. Some action recognised means the site is simply on another
      // stage —already punched, or this one's turn has not come— which is a legitimate
      // state and never an error worth retrying. NO action recognised means our wording
      // is wrong and the automation would sit there doing nothing all day believing the
      // day was already handled, which is the silent failure to avoid at all costs.
      if (state.available.length === 0) {
        throw new TimeclockError(
          'parse',
          `no reconozco ningún botón de fichaje. La página ofrece: ${
            state.labels.slice(0, 8).join(' / ') || 'nada con texto'
          }`,
        );
      }
      throw new TimeclockError(
        'not_available',
        `la página no ofrece "${ACTION_LABELS[action][0]}" sino ${state.available.join(', ')}`,
      );
    }

    const after = await this.submit(page, control.fields, jar, clock);

    // The site showing one form at a time is what makes this checkable: if the control we
    // just pressed is still there, the punch did not land. Reported as unverified and NOT
    // as retryable, because the only thing worse than not clocking in is clocking in
    // twice because we assumed the write had failed.
    if (findControl(after.form, ACTION_LABELS[action])) {
      console.warn(`timeclock: after ${action} the page still offers the same control`);
      throw new TimeclockError(
        'unverified',
        `el portal ha respondido pero sigue ofreciendo "${ACTION_LABELS[action][0]}"`,
      );
    }

    return { action, registeredAt: extractTime(after.html) };
  }

  /** Home page, logged in. The shared first half of both operations. */
  private async open(options: TimeclockOptions): Promise<{ page: Page; jar: Jar; clock: Clock }> {
    const clock = new Clock(options.timeoutMs ?? 20_000);
    const jar = new Jar();

    let page = await this.request(
      new URL(HOME_PATH, this.baseUrl).toString(),
      { method: 'GET' },
      jar,
      clock,
    );
    if (hasPassword(page.form)) page = await this.login(page, jar, clock);
    return { page, jar, clock };
  }

  /**
   * The login form, filled without knowing its field names.
   *
   * The password input is unambiguous —there is one and it announces its type— and the
   * username is the text input just before it. That rule survives both fields being
   * renamed, which is more than a hardcoded name would.
   */
  private async login(page: Page, jar: Jar, clock: Clock): Promise<Page> {
    const passwordIndex = page.form.inputs.findIndex((input) => input.type === 'password');
    const password = page.form.inputs[passwordIndex];
    const username = [...page.form.inputs.slice(0, passwordIndex)]
      .reverse()
      .find((input) => input.type === 'text' || input.type === 'email');

    if (!password || !username) {
      throw new TimeclockError(
        'parse',
        'no encuentro los campos de usuario y contraseña en la página de login',
      );
    }

    const control = findControl(page.form, LOGIN_LABELS);
    const after = await this.submit(
      page,
      {
        [username.name]: this.user,
        [password.name]: this.pass,
        ...(control?.fields ?? {}),
      },
      jar,
      clock,
    );

    if (hasPassword(after.form)) {
      // Still on the login form. A snippet goes to the log and not to the user: it is the
      // only way to tell a wrong password from a page we failed to fill in.
      console.warn(`timeclock: login rejected, page text: ${textOf(after.html).slice(0, 200)}`);
      throw new TimeclockError('auth', 'el portal ha devuelto el formulario de login otra vez');
    }
    return after;
  }

  /** Posts the form back with its own state plus whichever control is being pressed. */
  private async submit(
    page: Page,
    fields: Record<string, string>,
    jar: Jar,
    clock: Clock,
  ): Promise<Page> {
    const target = new URL(page.form.action || page.url, page.url).toString();
    const body = new URLSearchParams({ ...formState(page.form), ...fields });
    return this.request(
      target,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
      jar,
      clock,
    );
  }

  /**
   * One request, redirects followed by hand.
   *
   * By hand because `fetch` keeps no cookie jar: letting it follow a 302 would drop the
   * session cookie the login had just set, and that is precisely the redirect that
   * matters here.
   */
  private async request(url: string, init: RequestInit, jar: Jar, clock: Clock): Promise<Page> {
    let current = url;
    let request = init;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const budget = clock.next();
      let response: Response;
      try {
        response = await fetch(current, {
          ...request,
          redirect: 'manual',
          headers: {
            Accept: 'text/html,application/xhtml+xml',
            'User-Agent': 'Mozilla/5.0 (compatible; jarvis)',
            ...jar.header(),
            ...(request.headers as Record<string, string> | undefined),
          },
          signal: AbortSignal.timeout(budget),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new TimeclockError('upstream', `el portal no responde: ${detail}`);
      }

      jar.absorb(response.headers);

      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        current = new URL(location, current).toString();
        // A redirect is always followed with a GET and no body. Re-posting the form to
        // wherever the site points is how the same punch gets submitted twice.
        request = { method: 'GET' };
        continue;
      }

      if (!response.ok) {
        throw new TimeclockError('upstream', `el portal ha respondido ${response.status}`);
      }

      const html = await response.text();
      return { url: current, html, form: parseForm(html) };
    }

    throw new TimeclockError('upstream', 'el portal encadena demasiadas redirecciones');
  }
}

interface Page {
  url: string;
  html: string;
  form: ParsedForm;
}

function hasPassword(form: ParsedForm): boolean {
  return form.inputs.some((input) => input.type === 'password');
}

/** Which of the four actions the page is offering, plus what it says, for diagnosis. */
function stateOf(form: ParsedForm): PunchState {
  return {
    available: PUNCH_ACTIONS.filter((action) => findControl(form, ACTION_LABELS[action]) !== null),
    labels: form.controls.map((control) => control.label).filter((label) => label.length > 2),
    times: extractTimes(form),
  };
}

/**
 * The times the page shows, which on this portal is the list of today's punches.
 *
 * Best effort and clearly labelled as such: they are read from the page's text, so if the
 * layout changes this returns nothing rather than something wrong. Anything the user is
 * told out of here is prefixed by what the portal says, never presented as our record.
 */
function extractTimes(form: ParsedForm): string[] {
  const seen = new Set<string>();
  for (const control of form.controls) {
    for (const match of control.label.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)) {
      seen.add(`${match[1]!.padStart(2, '0')}:${match[2]}`);
    }
  }
  return [...seen];
}

/**
 * The time the site says it registered.
 *
 * Anchored on a nearby word instead of taking the first time on the page, because a
 * footer with the office timetable in it would otherwise become "your punch". When
 * nothing matches it returns null and the caller reports the hour it asked at, hedged.
 */
function extractTime(html: string): string | null {
  const match = /(?:registrad\w*|fichaj\w*|hora)[^0-9]{0,40}(\d{1,2}):(\d{2})/.exec(textOf(html));
  if (!match) return null;
  const hour = Number.parseInt(match[1]!, 10);
  const minute = Number.parseInt(match[2]!, 10);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** The caller's budget, spent across the requests one operation needs. */
class Clock {
  private readonly endsAt: number;

  constructor(totalMs: number) {
    this.endsAt = Date.now() + totalMs;
  }

  next(): number {
    const remaining = this.endsAt - Date.now();
    if (remaining < MIN_REQUEST_MS) {
      throw new TimeclockError('upstream', 'se ha agotado el tiempo antes de terminar');
    }
    return Math.min(PER_REQUEST_MAX_MS, remaining);
  }
}

/**
 * A cookie jar for the length of one operation.
 *
 * Name and value only: expiry, domain and path would matter for a jar outliving a single
 * flow against a single host, and this one does not.
 */
class Jar {
  private readonly cookies = new Map<string, string>();

  absorb(headers: Headers): void {
    for (const cookie of readSetCookie(headers)) {
      const [pair] = cookie.split(';');
      const separator = pair?.indexOf('=') ?? -1;
      if (!pair || separator <= 0) continue;
      this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }

  header(): Record<string, string> {
    if (this.cookies.size === 0) return {};
    return { Cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') };
  }
}

/**
 * Every Set-Cookie of a response.
 *
 * `getSetCookie()` is the only correct way: several cookies arrive as several headers and
 * `get()` joins them with a comma, which is ambiguous because the dates inside a cookie
 * carry commas too. The fallback is for runtimes predating it and gets one cookie right,
 * which is the usual case anyway.
 */
function readSetCookie(headers: Headers): string[] {
  const getter = (headers as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getter === 'function') return getter.call(headers);
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

export { DEFAULT_BASE_URL };
