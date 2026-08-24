import type { Env } from '../types';
import { DEFAULT_BASE_URL, HttpPunchClient } from './http';
import { TimeclockError, type PunchClient } from './provider';

/**
 * The punch client this deployment can build (phase 22).
 *
 * Same shape as the LLM, STT and search layers: one factory, and asking whether it is
 * configured must not require the credentials to exist. Without them the tools are not
 * offered to the model and the scheduled punches do nothing, which is a working assistant
 * with one feature off rather than a broken one.
 */

export function punchConfigured(env: Env): boolean {
  return Boolean(env.TIMECLOCK_USER && env.TIMECLOCK_PASS);
}

export function createPunchClient(env: Env): PunchClient {
  if (!punchConfigured(env)) {
    throw new TimeclockError(
      'config',
      'faltan los secrets TIMECLOCK_USER y TIMECLOCK_PASS para fichar en ficharweb',
    );
  }
  return new HttpPunchClient(
    env.TIMECLOCK_BASE_URL?.trim() || DEFAULT_BASE_URL,
    env.TIMECLOCK_USER!,
    env.TIMECLOCK_PASS!,
  );
}
