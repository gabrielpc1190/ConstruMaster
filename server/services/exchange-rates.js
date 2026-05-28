/**
 * Servicio de Tipos de Cambio (`ExchangeRate`).
 *
 * Capa de dominio sobre el cliente BCCR (`server/services/bccr.js`).
 * Maneja:
 *   - Backfill de rangos del BCCR (compra+venta) con upsert en la tabla
 *     `exchange_rates` (unique `(currency, date)`).
 *   - "Fetch hoy" cubriendo viernes→lunes para no perderse rates por
 *     feriados / fines de semana (BCCR retorna `estado=false` esos días y el
 *     cliente bccr.js ya los filtra).
 *   - Lookup del rate más reciente para una fecha (FX snapshot al aprobar OCs).
 *
 * Política `source`:
 *   - Un upsert BCCR NO pisa un rate previo con `source='manual'` (idempotente
 *     y respetuoso del override manual de Gabriel cuando el BCCR está caído).
 *   - El override manual debe hacerse vía endpoint dedicado
 *     (`POST /api/exchange-rates`), no por BCCR.
 *
 * Las cantidades se guardan como `Prisma.Decimal` via string (preserva
 * precisión). Para JSON los serializamos también como string.
 */

import { fetchSeries } from './bccr.js';

/**
 * Convierte un Date a string 'YYYY-MM-DD' en UTC. No usar `toISOString()`
 * crudo porque incluye hora y zona; lo cortamos en 10.
 */
function ymd(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/**
 * Mergea dos listas BCCR (buy + sell) por `date` en un Map.
 *
 * @param {Array<{date: string, value: string}>} buys
 * @param {Array<{date: string, value: string}>} sells
 * @returns {Map<string, {buy?: string, sell?: string}>}
 */
function mergeBuySell(buys, sells) {
  const map = new Map();
  for (const b of buys) {
    const slot = map.get(b.date) ?? {};
    slot.buy = b.value;
    map.set(b.date, slot);
  }
  for (const s of sells) {
    const slot = map.get(s.date) ?? {};
    slot.sell = s.value;
    map.set(s.date, slot);
  }
  return map;
}

/**
 * Hace backfill de tipos de cambio BCCR en un rango.
 *
 * - Solo upserta fechas que tienen AMBOS valores (buy + sell). Si el BCCR
 *   solo retornó una de las dos series para un día, lo skippeamos (rate
 *   "completo" es la unidad atómica para Gabriel).
 * - Si la row existente es `source='manual'`, NO la pisa: respeta el
 *   override manual y la cuenta en `skipped`.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{currency?: string, startDate: Date|string, endDate: Date|string}} opts
 * @returns {Promise<{created: number, updated: number, skipped: number, total: number}>}
 */
export async function backfillBccrRates(prisma, { currency = 'USD', startDate, endDate }) {
  if (!startDate || !endDate) {
    throw new Error('[exchange-rates] backfillBccrRates: startDate and endDate are required');
  }

  const [buys, sells] = await Promise.all([
    fetchSeries(currency, startDate, endDate, 'buy'),
    fetchSeries(currency, startDate, endDate, 'sell'),
  ]);

  const merged = mergeBuySell(buys, sells);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const [date, { buy, sell }] of merged) {
    if (buy == null || sell == null) {
      // Día sin par completo: lo dejamos para no insertar datos parciales.
      skipped += 1;
      continue;
    }
    const dateObj = new Date(`${date}T00:00:00.000Z`);

    const existing = await prisma.exchangeRate.findUnique({
      where: { currency_date: { currency, date: dateObj } },
    });

    if (existing && existing.source === 'manual') {
      // Respetamos override manual; no lo sobrescribe el BCCR.
      skipped += 1;
      continue;
    }

    if (existing) {
      await prisma.exchangeRate.update({
        where: { currency_date: { currency, date: dateObj } },
        data: { buy, sell, source: 'bccr', fetchedAt: new Date() },
      });
      updated += 1;
    } else {
      await prisma.exchangeRate.create({
        data: { currency, date: dateObj, buy, sell, source: 'bccr' },
      });
      created += 1;
    }
  }

  return { created, updated, skipped, total: merged.size };
}

/**
 * Trae el rate de "hoy" del BCCR con ventana de 3 días hacia atrás para
 * cubrir lunes (sábado/domingo BCCR retorna estado=false) y feriados.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{currency?: string}} opts
 */
export async function fetchTodayBccr(prisma, { currency = 'USD' } = {}) {
  const today = new Date();
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - 3);
  return backfillBccrRates(prisma, {
    currency,
    startDate: start,
    endDate: today,
  });
}

/**
 * Busca el rate más reciente para una moneda.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{currency?: string, side?: 'buy'|'sell', date?: Date|string}} opts
 *   - `date`: si se provee, busca el rate más reciente con `date <= date`.
 *   - `side`: filtra el campo a "destacar" pero igual devolvemos buy+sell.
 * @returns {Promise<{date: string, buy: string, sell: string, source: string} | null>}
 */
export async function latestRate(prisma, { currency = 'USD', date } = {}) {
  const where = { currency };
  if (date) {
    const dateObj = typeof date === 'string'
      ? new Date(`${date.slice(0, 10)}T00:00:00.000Z`)
      : date;
    where.date = { lte: dateObj };
  }
  const row = await prisma.exchangeRate.findFirst({
    where,
    orderBy: [{ date: 'desc' }],
  });
  if (!row) return null;
  return serializeRate(row);
}

/**
 * Serializa un ExchangeRate Prisma para respuestas API.
 * Decimals → string. Date → 'YYYY-MM-DD'. BigInt id → number.
 */
export function serializeRate(r) {
  if (!r) return r;
  return {
    id: Number(r.id),
    currency: r.currency,
    date: ymd(r.date),
    buy: r.buy?.toString?.() ?? String(r.buy),
    sell: r.sell?.toString?.() ?? String(r.sell),
    source: r.source,
    fetchedAt: r.fetchedAt,
  };
}

// Helpers exportados para tests.
export const __internals = { ymd, mergeBuySell };
