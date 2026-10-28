import type { Logger } from './logger.js';

// Calls slower than this are logged at warn level; the rest at debug.
export const SLOW_DEPENDENCY_MS = 2000;

// Times one call to an external dependency (Supabase Auth, the database) and
// logs its name, duration and outcome. Arguments and results are never
// logged: they can hold passwords, tokens or personal data.
export async function timed<T>(logger: Logger, operation: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  let outcome: 'ok' | 'error' = 'ok';
  try {
    return await work();
  } catch (err) {
    outcome = 'error';
    throw err;
  } finally {
    const durationMs = Math.round(performance.now() - started);
    const fields = { dependency: operation, durationMs, outcome };
    if (durationMs >= SLOW_DEPENDENCY_MS) logger.warn(fields, 'slow dependency call');
    else logger.debug(fields, 'dependency call');
  }
}
