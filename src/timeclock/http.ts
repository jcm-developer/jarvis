import {
  decodeEntities,
  findControl,
  findRadio,
  formState,
  parseForm,
  textOf,
  type ParsedForm,
} from './html';
import {
  PUNCH_ACTIONS,
  TimeclockError,
  type LastMovement,
  type PunchAction,
  type PunchClient,
  type PunchResult,
  type PunchState,
  type TimeclockOptions,
} from './provider';

/**
 * ficharweb over plain HTTP, from the Worker (phase 22).
 *
 * There is no browser in this runtime and Browser Rendering is on the paid plan, so the
 * three requests a punch needs are made by hand: load the page, log in, submit the form.
 *
 * The page is `registro.asp` and it works like this, which is what everything below is
 * shaped around:
 *
 * - There is **one submit button**, and its wording is the phase: "Registrar entrada"
 *   while you are out, "Registrar salida" while you are in. Never both.
 * - Above it, a radio group ("Motivo registro") holds the reasons for that phase, with
 *   the ordinary one already selected.
 * - Below it, "Último movimiento" states what the portal last recorded and at what time,
 *   to the second.
 *
 * So a punch is: check the button says the right phase, pick the radio when the action
 * needs one, submit, and confirm against "Último movimiento". That last step is why this
 * can report honestly: the portal itself says what it wrote down.
 */

const DEFAULT_BASE_URL = 'https://ficharweb.ccbosco.org';

/**
 * Where the punching happens, and the only path this code knows.
 *
 * The login page is NOT a constant here, and that was learned the hard way: asking for
 * `/CCB/` first came back with something that was not the login form, so nothing was ever
 * filled in and the run ended with "I do not understand this page". Asking for the register
 * page while logged out makes the site bounce us to its own login, wherever that is — which
 * is what a browser does and one guess fewer for us.
 */
const REGISTER_PATH = '/CCB/registro.asp';

/** Cap per request. The caller's budget is split across three of them at most. */
const PER_REQUEST_MAX_MS = 8_000;

/** Under this there is no point starting another request. */
const MIN_REQUEST_MS = 1_500;

const MAX_REDIRECTS = 5;

/**
 * How many self-posting bridge pages to follow.
 *
 * Two, because one is what the login uses and a second is cheap insurance; more than that
 * and something is looping, which is worth reporting rather than chasing.
 */
const MAX_BRIDGES = 2;

/**
 * Which button each action needs on screen.
 *
 * This is the phase check and the idempotence in one: if the entry button is not there,
 * the entry is already registered, whoever registered it.
 */
const PHASE_BUTTON: Record<PunchAction, string> = {
  clock_in: 'registrar entrada',
  break_end: 'registrar entrada',
  break_start: 'registrar salida',
  clock_out: 'registrar salida',
};

/**
 * The reason to select in "Motivo registro" for each action.
 *
 * Full wordings only, with no loose fallback: "entrada" on its own would also match
 * "Entrada del descanso" and register the wrong reason, and on an attendance record a
 * wrong punch is worse than no punch. Both prepositions are listed for the break because
 * neither collides with anything else, and which one the portal uses is not worth a
 * redeploy to find out.
 */
const REASON_RADIO: Record<PunchAction, string[]> = {
  clock_in: ['entrada ordinaria'],
  clock_out: ['salida ordinaria'],
  break_start: ['salida al descanso', 'salida del descanso'],
  break_end: ['entrada del descanso', 'entrada al descanso'],
};

/**
 * The actions that go through without touching the radio group.
 *
 * Manually, starting and ending the day is just pressing the button: the ordinary reason
 * is the one already selected. So if the radio cannot be found for these two, the punch
 * still goes ahead with whatever the page had selected — which is exactly what a person
 * does. For the two break actions the opposite holds: no radio, no punch.
 */
const ORDINARY: ReadonlySet<PunchAction> = new Set<PunchAction>(['clock_in', 'clock_out']);

/** What "Último movimiento" says after each action landed. The confirmation to look for. */
const MOVEMENT_LABEL: Record<PunchAction, string[]> = REASON_RADIO;

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
   * The automation gets this for free —`punch()` does the same read on its way in— but a
   * user asking "have I clocked in?" gets only this, so nothing can be submitted by
   * accident on a path that was only ever a question.
   */
  async readState(options: TimeclockOptions = {}): Promise<PunchState> {
    const { page } = await this.open(options);
    return stateOf(page);
  }

  async readPage(options: TimeclockOptions = {}): Promise<{ url: string; html: string }> {
    const { page } = await this.open(options);
    return { url: page.url, html: page.html };
  }

  async punch(action: PunchAction, options: TimeclockOptions = {}): Promise<PunchResult> {
    const { page, jar, clock } = await this.open(options);
    const state = stateOf(page);

    const button = findControl(page.form, [PHASE_BUTTON[action]]);
    if (!button) {
      // Not a failure of ours. The page shows one phase at a time, so a missing "Registrar
      // entrada" means the entry is already in — whether the automation or the user put it
      // there. The only worrying case is a page we do not understand at all, and that is
      // told apart by whether anything was recognised.
      if (state.available.length === 0) {
        throw new TimeclockError('parse', `no encuentro los botones de fichaje. ${describe(state)}`);
      }
      throw new TimeclockError(
        'not_available',
        `la página no ofrece "${PHASE_BUTTON[action]}" sino ${state.available.join(', ')}`,
      );
    }

    const radio = findRadio(page.form.radios, REASON_RADIO[action]);
    if (!radio && !ORDINARY.has(action)) {
      throw new TimeclockError(
        'not_available',
        `no encuentro el motivo "${REASON_RADIO[action][0]}" entre ` +
          `${page.form.radios.map((option) => option.label).join(' / ') || 'ninguna opción'}`,
      );
    }

    const before = state.lastMovement;
    const after = await this.submit(
      page,
      { ...(radio ? { [radio.name]: radio.value } : {}), ...button.fields },
      jar,
      clock,
    );

    return { action, registeredAt: confirm(action, stateOf(after), before) };
  }

  /**
   * The register page, logged in. The shared first half of both operations.
   *
   * The login page is asked for first rather than the register page: it is the entry point
   * of the site and it is what a browser is given, so following the site's own redirect is
   * more robust than guessing that an unauthenticated hit on `registro.asp` bounces.
   */
  private async open(
    options: TimeclockOptions,
  ): Promise<{ page: Page; jar: Jar; clock: Clock }> {
    const clock = new Clock(options.timeoutMs ?? 20_000);
    const jar = new Jar();
    const trail: string[] = [];

    try {
      // Straight at the register page. Logged out, the site redirects to its own login, so
      // there is no login URL to guess and no page of ours to be wrong about.
      let page = await this.request(this.url(REGISTER_PATH), { method: 'GET' }, jar, clock);
      trail.push(describePage(page));

      if (hasPassword(page.form)) {
        page = await this.login(page, jar, clock);
        trail.push(describePage(page));
      }

      // The login does not end at the login: it lands on a bridge, a page whose only job is
      // to move you along. Not following it means never getting a session, and the symptom
      // is identical to a wrong password — which is exactly the wrong turn this cost.
      for (let bounce = 0; bounce < MAX_BRIDGES; bounce++) {
        const step = bridgeStep(page);
        if (!step) break;
        page =
          step.kind === 'go'
            ? await this.request(
                new URL(step.url, page.url).toString(),
                { method: 'GET' },
                jar,
                clock,
              )
            : await this.submit(page, {}, jar, clock);
        trail.push(`${step.kind === 'go' ? 'refresh' : 'puente'} -> ${describePage(page)}`);
      }

      // The login lands wherever it wants; the punching happens on one page only.
      if (!isRegisterPage(page.form)) {
        page = await this.request(this.url(REGISTER_PATH), { method: 'GET' }, jar, clock);
        trail.push(describePage(page));
      }

      return { page: { ...page, trail }, jar, clock };
    } catch (error) {
      // The trail is worth more than the message: "the portal does not respond" is equally
      // true of a 500 on the third hop and of a redirect loop on the first, and those are
      // not the same problem.
      if (error instanceof TimeclockError) error.trail = trail;
      throw error;
    }
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

    // "Entrar" and not "Cambiar Contraseña": the labels are tried in order and the first
    // one is the orange button. Pressing the other would land on a password change form.
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

  /** Posts the form back with its own state plus whatever is being pressed or picked. */
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

  private url(path: string): string {
    return new URL(path, this.baseUrl).toString();
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
  /**
   * Where this run has been, one entry per page.
   *
   * It exists because the first production run reported only the LAST page it saw, and the
   * question that mattered —which of the three hops went wrong— was unanswerable. A page
   * that cannot be understood is worth a breadcrumb trail; one that works costs nothing.
   */
  trail?: string[];
}

/**
 * One hop of the trail: where we were, what was on it, and what it said.
 *
 * The snippet is the part that was missing. A hop reported as "nada reconocible" says the
 * page was not understood but not what it was, and a page nobody can name is a page nobody
 * can fix.
 */
function describePage(page: Page): string {
  const marks = [
    hasPassword(page.form) ? 'login' : '',
    isRegisterPage(page.form) ? 'fichaje' : '',
    bridgeStep(page) ? 'puente' : '',
    page.form.radios.length > 0 ? `${page.form.radios.length} motivos` : '',
    // The count that was missing: a page reported as "nada reconocible" while carrying
    // hidden fields is a form waiting to be posted, not a dead end.
    page.form.inputs.length > 0 ? `${page.form.inputs.length} campos` : '',
    page.form.controls.length > 0 ? `${page.form.controls.length} botones` : '',
  ].filter(Boolean);

  const text = textOf(page.html).slice(0, 60);
  const said = marks.length === 0 && text ? ` "${text}"` : '';
  return `${new URL(page.url).pathname} [${marks.join(', ') || 'nada reconocible'}]${said}`;
}

function hasPassword(form: ParsedForm): boolean {
  return form.inputs.some((input) => input.type === 'password');
}

/**
 * How to get off a page that only exists to move you along, if it is one.
 *
 * Two mechanisms, and the meta refresh goes first because it needs no guessing at all: the
 * page states where it is going. A form with nothing to press is the other one — there is no
 * JavaScript here to run its script with, and there does not need to be, because a form
 * nobody can press is a form meant to be posted as it stands.
 */
function bridgeStep(page: Page): { kind: 'go'; url: string } | { kind: 'post' } | null {
  if (hasPassword(page.form) || isRegisterPage(page.form)) return null;

  const refresh = metaRefresh(page.html);
  if (refresh) return { kind: 'go', url: refresh };

  // A radio group is a choice, and a choice means the form is meant for a person. Posting
  // one blind is how the register page —whose button had gone unrecognised— got submitted
  // as if it were a bridge, and the portal answered 500. Deserved.
  if (page.form.radios.length > 0) return null;

  if (page.form.hasForm && page.form.controls.length === 0) return { kind: 'post' };
  return null;
}

/** `<meta http-equiv="refresh" content="0;url=algo">`, the honest half of a bridge page. */
function metaRefresh(html: string): string | null {
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/http-equiv\s*=\s*['"]?refresh/i.test(tag[0])) continue;
    const content = /content\s*=\s*['"]([^'"]+)['"]/i.exec(tag[0]);
    const url = content ? /url\s*=\s*(.+)$/i.exec(content[1]!.trim()) : null;
    if (url) return decodeEntities(url[1]!.trim().replace(/^['"]|['"]$/g, ''));
  }
  return null;
}

/** Whether this is the page that can punch, i.e. it carries one of the two buttons. */
function isRegisterPage(form: ParsedForm): boolean {
  return findControl(form, ['registrar entrada']) !== null || findControl(form, ['registrar salida']) !== null;
}

/**
 * What can be punched right now, read off the page.
 *
 * The button decides the phase and the radios decide which reasons that phase accepts, so
 * the two together are the answer to "have I clocked in?" without keeping any state of our
 * own. The ordinary actions do not require their radio to be found: pressing the button is
 * how a person does it.
 */
function stateOf(page: Page): PunchState {
  const { form } = page;
  const available = PUNCH_ACTIONS.filter((action) => {
    if (!findControl(form, [PHASE_BUTTON[action]])) return false;
    if (ORDINARY.has(action)) return true;
    return findRadio(form.radios, REASON_RADIO[action]) !== null;
  });

  return {
    available,
    labels: form.controls.map((control) => control.label).filter((label) => label.length > 2),
    reasons: form.radios.map((radio) => radio.label).filter((label) => label.length > 2),
    lastMovement: lastMovement(page.html),
    diagnosis: {
      url: page.url,
      sawLoginForm: hasPassword(form),
      inputs: form.inputs.length,
      controls: form.controls.length,
      snippet: textOf(page.html).slice(0, 160),
      trail: page.trail ?? [],
    },
  };
}

/** The empty-handed case in one line, for the error the model reads. */
function describe(state: PunchState): string {
  const { url, sawLoginForm, inputs, controls } = state.diagnosis;
  if (sawLoginForm) return `sigue en el login (${url})`;
  if (inputs === 0 && controls === 0) return `${url} no parece la aplicación`;
  return `en ${url} veo ${controls} botones: ${state.labels.slice(0, 6).join(' / ') || 'ninguno'}`;
}

/**
 * "Último movimiento": `24/08/2026 9:20:03 - Entrada ordinaria`.
 *
 * This is the portal stating what it recorded, which makes it worth more than anything we
 * could infer: it is both the confirmation that a punch landed and the answer to what time
 * it landed at, to the second.
 */
function lastMovement(html: string): LastMovement | null {
  const match = /(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*-\s*([a-z][a-z ]{4,40})/.exec(
    textOf(html),
  );
  if (!match) return null;
  return { date: match[1]!, time: match[2]!, label: match[3]!.trim() };
}

/**
 * Whether the punch landed, according to the portal.
 *
 * Three outcomes and only one of them is success. The important one is the middle: if the
 * last movement did not change to what we just asked for, we do NOT know whether it was
 * written, and the caller must never retry on that — clocking in twice on an attendance
 * record is worse than not clocking in.
 */
function confirm(
  action: PunchAction,
  after: PunchState,
  before: LastMovement | null,
): string | null {
  const movement = after.lastMovement;
  const expected = MOVEMENT_LABEL[action].map((label) => label);
  const matches = movement ? expected.some((label) => movement.label.includes(label)) : false;

  if (matches && (!before || before.time !== movement!.time)) return movement!.time;

  // No "Último movimiento" on the page at all: fall back to the phase flipping, which is
  // weaker but still real evidence — the button we pressed must be gone.
  if (!movement && !after.available.includes(action)) return null;

  console.warn(
    `timeclock: unconfirmed ${action}; last movement: ${
      movement ? `${movement.time} ${movement.label}` : 'none'
    }`,
  );
  throw new TimeclockError(
    'unverified',
    movement
      ? `el portal sigue diciendo que lo último fue "${movement.label}" a las ${movement.time}`
      : 'el portal no dice cuál fue el último movimiento',
  );
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
