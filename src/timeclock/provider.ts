/**
 * The contract with ficharweb (phase 22).
 *
 * Two portals, not one: clocking in lives on ficharweb/CCB and imputing hours lives on
 * cbGesPro, with separate credentials. They are kept as two interfaces because a change
 * on one has no reason to touch the other, and because the punch half has to work when
 * the imputation half is not configured at all.
 *
 * The reason there is an interface here rather than plain functions is the same one as in
 * the LLM and STT layers, and here it is not ceremony: the site is somebody else's
 * ASP.NET form and it will break. Today the adapter talks HTTP from the Worker; the
 * fallback is a Playwright runner outside Cloudflare, and that swap has to be a variable
 * and not a rewrite.
 */

/**
 * The four actions the site accepts.
 *
 * Spanish because they are the site's own words and the model reads them: translating
 * them would add a mapping table whose only job is to be kept in sync.
 */
export const PUNCH_ACTIONS = ['clock_in', 'clock_out', 'break_start', 'break_end'] as const;
export type PunchAction = (typeof PUNCH_ACTIONS)[number];

export function isPunchAction(value: string): value is PunchAction {
  return (PUNCH_ACTIONS as readonly string[]).includes(value);
}

/**
 * What each action is called in front of a person.
 *
 * Here and not in each caller because there were already two copies drifting apart, and
 * the wording is chosen so an article can be put in front of it: "la salida a comer".
 */
export const ACTION_NAMES: Record<PunchAction, string> = {
  clock_in: 'entrada al trabajo',
  clock_out: 'salida del trabajo',
  break_start: 'salida a comer',
  break_end: 'vuelta de comer',
};

export interface TimeclockOptions {
  /** Cap for this call. Set by the message's or the tick's global budget, never here. */
  timeoutMs?: number;
}

export interface PunchResult {
  action: PunchAction;
  /**
   * What the site says it registered, verbatim and unparsed.
   *
   * The clock that matters is the server's, not ours: a punch is a legal record and the
   * only honest thing to report back is the time the other end wrote down.
   */
  registeredAt: string | null;
}

/** One row of the day's task table on cbGesPro. */
export interface Project {
  /**
   * Position in the day's table, 1-based, as shown to the user.
   *
   * It is the site's index and not an id of ours: the table is regenerated per day, so
   * this is only meaningful together with the day it was scraped on. That is why the
   * cache in `db/timeclock.ts` is keyed by day.
   */
  index: number;
  project: string;
  task: string;
  /** Hours already imputed on this row, when the table shows them. */
  done: number | null;
  /** Hours planned for this row, when the table shows them. */
  total: number | null;
}

export interface ProjectList {
  /** The working day the table belongs to, as the site reports it (YYYY-MM-DD). */
  date: string;
  projects: Project[];
}

export interface ImputeResult {
  /** The site's own confirmation text, for the message that goes back to the user. */
  message: string;
  /**
   * True when the submission filled the day and the site rolled over to the next one.
   *
   * It has to be surfaced: the next imputation would silently land on another date, and
   * a day of work written on the wrong day is worse than a refusal.
   */
  dayAdvanced: boolean;
  /** The date the site is on after submitting (YYYY-MM-DD). */
  currentDate: string;
}

/**
 * What the portal is showing right now.
 *
 * This is the honest answer to "have I clocked in today?", and it comes from the site
 * rather than from our own log because the user can always punch from the web themselves.
 * The site only offers the action that comes next, so the set of available buttons IS the
 * state of the day.
 */
export interface PunchState {
  /** The actions the page is offering, i.e. what could be punched right now. */
  available: PunchAction[];
  /**
   * Actions whose turn it is and that we still cannot register.
   *
   * The one that happens is a reason demanding a written comment. Separate from `available`
   * because the difference is not academic: this list is the honest answer to "why did it not
   * punch", and while these two were merged the report cheerfully announced a stage that
   * `punch()` was refusing.
   */
  blocked: PunchAction[];
  /**
   * Every button label the page showed, normalised.
   *
   * Kept for the case that matters on the first run against a reworded portal: no
   * recognised action and a list of labels is a diagnosis, while an empty answer is a
   * mystery.
   */
  labels: string[];
  /**
   * The reasons the "Motivo registro" group offers, as printed.
   *
   * Kept for the same reason as `labels`: when nothing is recognised, what the page did
   * offer is the diagnosis.
   */
  reasons: string[];
  /** What the portal says it last recorded, which is the truth about today. */
  lastMovement: LastMovement | null;
  /**
   * Where it ended up and what it saw there.
   *
   * This is not decoration and it was paid for: the first real run answered "no recognised
   * button, the page offers nothing" in 0.4 s, which is too fast to have logged in — and
   * with only that sentence there was no way to tell a wrong path from a login form we
   * cannot fill from a portal that had simply been reworded. Those three have three
   * different fixes.
   */
  diagnosis: {
    /** The URL the last response actually came from, redirects included. */
    url: string;
    /** Whether a password field was seen, i.e. whether logging in was even attempted. */
    sawLoginForm: boolean;
    /** How many inputs and controls the page had at all. Zero of both means it is not the app. */
    inputs: number;
    controls: number;
    /** The page's visible text, cut short. What a human needs to recognise the page. */
    snippet: string;
    /**
     * Every page this run went through, in order.
     *
     * The first production attempt reported only the last one, which left the actual
     * question —which hop went wrong— unanswerable.
     */
    trail: string[];
  };
}

/**
 * The "Último movimiento" line of the register page.
 *
 * Its own type because it does two jobs: it confirms that a punch landed, and it is the
 * only place the portal states a time —to the second— which is what gets reported back
 * instead of our own clock.
 */
export interface LastMovement {
  /** As printed, dd/mm/yyyy. Not parsed: it goes back out the way it came in. */
  date: string;
  time: string;
  /** The reason, normalised: "entrada ordinaria", "salida al descanso". */
  label: string;
}

/** Clocking in and out. Credentials: TIMECLOCK_USER / TIMECLOCK_PASS. */
export interface PunchClient {
  readonly name: string;
  /** One read, no writes. What the automation checks before punching and what the user asks for. */
  readState(options?: TimeclockOptions): Promise<PunchState>;
  /**
   * The register page's raw html, for when the parsing is what is wrong.
   *
   * It exists because five deploys were spent inferring a page's structure from what the
   * parser failed to find in it. A diagnosis that can show the page itself ends that loop,
   * and it costs nothing: the page is already being fetched.
   */
  readPage(options?: TimeclockOptions): Promise<{ url: string; html: string }>;
  punch(action: PunchAction, options?: TimeclockOptions): Promise<PunchResult>;
}

/** Imputing hours against the day's projects. Credentials: IMPUTE_USR / IMPUTE_PASS. */
export interface ImputeClient {
  readonly name: string;
  listProjects(options?: TimeclockOptions): Promise<ProjectList>;
  submitHours(
    projectIndex: number,
    hours: number,
    comment: string,
    options?: TimeclockOptions,
  ): Promise<ImputeResult>;
}

export type TimeclockErrorKind =
  /** Credentials missing from the environment. Nothing was attempted. */
  | 'config'
  /** The portal rejected the login. */
  | 'auth'
  /**
   * The site is not showing the form this action needs.
   *
   * It shows entrada or salida, never both, depending on the last punch. Asking for a
   * salida before an entrada is a legitimate state and not a failure of ours, so it gets
   * its own kind and never a retry.
   */
  | 'not_available'
  /**
   * The stage's turn HAS come and we still will not punch it.
   *
   * Split from `not_available` because they deserve opposite treatment and sharing one kind
   * cost a working day. "Another stage's turn" is a normal state and staying quiet about it
   * is right. This one —a reason that demands a written justification, or a reason that is no
   * longer on the page— will refuse identically on the next tick and on tomorrow's, so
   * silence just means the day ends with a hole in it and nobody warned.
   */
  | 'refused'
  /** The row asked for is not in the day's table. */
  | 'unknown_project'
  /** The HTML did not look like what the adapter expects. The site changed. */
  | 'parse'
  /** The portal answered with an error, or did not answer in time. */
  | 'upstream'
  /**
   * The request went out and we cannot tell whether it registered.
   *
   * Its own kind because of what must NOT happen next: retrying. Clocking in twice on a
   * legal record is worse than not clocking in, so this one closes the day and asks the
   * user to check, instead of trying again on the following tick.
   */
  | 'unverified';

export class TimeclockError extends Error {
  /**
   * The pages this run went through before failing.
   *
   * Attached on the way out rather than passed in, because the useful trail is the one the
   * whole operation walked while the throw happens three levels down. Twice now a failure
   * has been reported with a message that was true and useless —"the portal does not
   * respond"— while the answer was in the hop before it.
   */
  trail: string[] = [];

  constructor(
    readonly kind: TimeclockErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'TimeclockError';
  }

  /**
   * What the user reads. Tool errors go back to the model as `{ok:false,error}` (§7), so
   * these strings are also what the model has to work with to correct itself; hence they
   * say what to do next and not just what broke.
   */
  get userMessage(): string {
    switch (this.kind) {
      case 'config':
        return 'No tengo las credenciales de ficharweb configuradas.';
      case 'auth':
        return 'Ficharweb rechaza el usuario o la contraseña. Habrá que actualizarlos.';
      case 'not_available':
        return 'Ficharweb no ofrece ahora esa acción: revisa cuál fue el último fichaje.';
      case 'refused':
        return 'Le toca a ese fichaje pero no puedo hacerlo yo: el motivo exige escribir un comentario. Fíchalo tú.';
      case 'unknown_project':
        return 'Ese proyecto no está en la tabla de hoy.';
      case 'parse':
        return 'No encuentro los botones de fichaje en ficharweb: o la jornada ya está cerrada o la página ha cambiado.';
      case 'upstream':
        return 'Ficharweb no responde. Lo reintento luego.';
      case 'unverified':
        return 'He mandado el fichaje pero el portal no lo confirma. Míralo tú, no lo repito por si acaso.';
    }
  }

  /**
   * Whether a later tick could plausibly do better.
   *
   * Only the deferred-job path reads it: a portal that is down is worth another go in
   * five minutes, while wrong credentials or a form that is not on screen would burn the
   * three attempts to reach the same conclusion (§16).
   */
  get retryable(): boolean {
    return this.kind === 'upstream';
  }
}
