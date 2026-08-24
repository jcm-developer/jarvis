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
export const PUNCH_ACTIONS = ['entrada', 'salida', 'salida_descanso', 'entrada_descanso'] as const;
export type PunchAction = (typeof PUNCH_ACTIONS)[number];

export function isPunchAction(value: string): value is PunchAction {
  return (PUNCH_ACTIONS as readonly string[]).includes(value);
}

export interface FichaOptions {
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
   * cache in `db/ficha.ts` is keyed by day.
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

/** Clocking in and out. Credentials: FICHA_USER / FICHA_PASS. */
export interface PunchClient {
  readonly name: string;
  punch(action: PunchAction, options?: FichaOptions): Promise<PunchResult>;
}

/** Imputing hours against the day's projects. Credentials: IMPUTE_USR / IMPUTE_PASS. */
export interface ImputeClient {
  readonly name: string;
  listProjects(options?: FichaOptions): Promise<ProjectList>;
  submitHours(
    projectIndex: number,
    hours: number,
    comment: string,
    options?: FichaOptions,
  ): Promise<ImputeResult>;
}

export type FichaErrorKind =
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
  /** The row asked for is not in the day's table. */
  | 'unknown_project'
  /** The HTML did not look like what the adapter expects. The site changed. */
  | 'parse'
  /** The portal answered with an error, or did not answer in time. */
  | 'upstream';

export class FichaError extends Error {
  constructor(
    readonly kind: FichaErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'FichaError';
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
      case 'unknown_project':
        return 'Ese proyecto no está en la tabla de hoy.';
      case 'parse':
        return 'Ficharweb ha cambiado y ya no entiendo su página. Hay que revisar el adaptador.';
      case 'upstream':
        return 'Ficharweb no responde. Lo reintento luego.';
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
