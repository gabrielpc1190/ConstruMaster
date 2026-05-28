/**
 * Cron diario: tipo de cambio BCCR.
 *
 * Estrategia:
 *   - Schedule: `'30 9 * * 1-5'` (lun-vie 9:30 hora Costa Rica).
 *     - El BCCR publica el TC vigente alrededor de las 9 AM CR. Damos
 *       margen para evitar pegarle antes de que actualicen.
 *   - TZ: hardcodeada a `'America/Costa_Rica'` en `cron.schedule({timezone})`.
 *     NO usamos `process.env.TZ` porque el server puede correr con TZ del
 *     host (UTC en contenedor) y queremos no-sorpresas en producción.
 *
 * Robustez:
 *   - Si `BCCR_TOKEN` no está seteado, NO registramos el cron — solo logueamos
 *     warning. Esto permite levantar el server en dev sin tokens.
 *   - Cada tick va en try/catch para no tirar el process. Mantenemos un
 *     contador de fallos consecutivos para escalar el log a `error` después
 *     de 5 fallas seguidas, sin dejar de intentar.
 *
 * Montar en `server/index.js`:
 *   import { startBccrCron } from './cron/bccr-daily.js';
 *   startBccrCron(prisma);
 */

import cron from 'node-cron';
import { fetchTodayBccr } from '../services/exchange-rates.js';

const CRON_EXPR = '30 9 * * 1-5';
const TIMEZONE = 'America/Costa_Rica';

let consecutiveFailures = 0;
const FAILURE_THRESHOLD = 5;

/**
 * Ejecuta un fetch de "hoy" y maneja errores sin propagar.
 * Exportado para tests (mockear `node-cron` es complejo y opcional).
 */
export async function runBccrDailyTick(prisma) {
  try {
    console.log('[cron-bccr] tick start');
    const stats = await fetchTodayBccr(prisma, { currency: 'USD' });
    consecutiveFailures = 0;
    console.log(
      '[cron-bccr] ok created=%d updated=%d skipped=%d total=%d',
      stats.created, stats.updated, stats.skipped, stats.total,
    );
    return { ok: true, ...stats };
  } catch (err) {
    consecutiveFailures += 1;
    const level = consecutiveFailures >= FAILURE_THRESHOLD ? 'error' : 'warn';
    const logger = level === 'error' ? console.error : console.warn;
    logger(
      '[cron-bccr] FAIL #%d: %s',
      consecutiveFailures,
      err.message,
    );
    return { ok: false, error: err.message, consecutiveFailures };
  }
}

/**
 * Registra el cron. Devuelve el task handle o `null` si no se arrancó.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {ReturnType<typeof cron.schedule> | null}
 */
export function startBccrCron(prisma) {
  if (!process.env.BCCR_TOKEN) {
    console.warn('[cron-bccr] BCCR_TOKEN not set — cron NOT started');
    return null;
  }

  const task = cron.schedule(
    CRON_EXPR,
    () => { runBccrDailyTick(prisma); },
    { timezone: TIMEZONE },
  );
  console.log('[cron-bccr] scheduled "%s" tz=%s', CRON_EXPR, TIMEZONE);
  return task;
}

export const __internals = { CRON_EXPR, TIMEZONE, FAILURE_THRESHOLD };
