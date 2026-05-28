/**
 * Controllers de `/api/exchange-rates`.
 *
 * Endpoints:
 *   - GET    /                 list (cualquier auth)
 *   - GET    /latest           último rate (cualquier auth)
 *   - POST   /backfill         backfill rango BCCR (admin/supervisor)
 *   - POST   /fetch-today      actualizar hoy (admin/supervisor)
 *   - POST   /                 crear rate manual (admin/supervisor)
 *   - DELETE /:id              borrar rate (admin)
 *
 * Validación con zod inline (sigue patrón de bodegas/proveedores).
 */

import { z } from 'zod';
import prisma from '../db.js';
import {
  backfillBccrRates,
  fetchTodayBccr,
  latestRate,
  serializeRate,
} from '../services/exchange-rates.js';

// --- Schemas ---------------------------------------------------------------

// String YYYY-MM-DD. Validamos formato y rango razonable.
const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha debe ser YYYY-MM-DD');

// Decimal positivo serializado como string con hasta 5 decimales (matchea Decimal(12,5)).
const decimalString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^\d{1,7}(\.\d{1,5})?$/.test(v), {
    message: 'valor debe ser decimal positivo con hasta 5 decimales',
  });

const currencySchema = z
  .string()
  .trim()
  .min(3)
  .max(3)
  .transform((s) => s.toUpperCase())
  .default('USD');

const backfillSchema = z.object({
  currency: currencySchema.optional(),
  from: dateString,
  to: dateString,
});

const createManualSchema = z.object({
  currency: currencySchema.optional(),
  date: dateString,
  buy: decimalString,
  sell: decimalString,
});

// --- Helpers ---------------------------------------------------------------

function zodError(res, error) {
  return res.status(400).json({
    error: 'Validation error',
    issues: error.issues.map((i) => ({ path: i.path, message: i.message })),
  });
}

function parseLimit(raw, def = 90, max = 1000) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

// --- Handlers --------------------------------------------------------------

/**
 * GET /api/exchange-rates?currency=USD&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=90
 * Default: últimos 90 días USD.
 */
export async function listExchangeRates(req, res) {
  try {
    const currency = typeof req.query.currency === 'string'
      ? req.query.currency.trim().toUpperCase()
      : 'USD';
    const limit = parseLimit(req.query.limit);

    const where = { currency };
    if (typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)) {
      where.date = { ...(where.date || {}), gte: new Date(`${req.query.from}T00:00:00.000Z`) };
    }
    if (typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) {
      where.date = { ...(where.date || {}), lte: new Date(`${req.query.to}T00:00:00.000Z`) };
    }

    const rows = await prisma.exchangeRate.findMany({
      where,
      orderBy: [{ date: 'desc' }],
      take: limit,
    });
    return res.json(rows.map(serializeRate));
  } catch (err) {
    console.error('[exchange-rates.list] unexpected error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

/**
 * GET /api/exchange-rates/latest?currency=USD
 */
export async function getLatestExchangeRate(req, res) {
  try {
    const currency = typeof req.query.currency === 'string'
      ? req.query.currency.trim().toUpperCase()
      : 'USD';
    const row = await latestRate(prisma, { currency });
    if (!row) return res.status(404).json({ error: 'No rates available' });
    return res.json(row);
  } catch (err) {
    console.error('[exchange-rates.latest] unexpected error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

/**
 * POST /api/exchange-rates/backfill  body: { currency?, from, to }
 */
export async function backfillExchangeRates(req, res) {
  try {
    const parsed = backfillSchema.safeParse(req.body || {});
    if (!parsed.success) return zodError(res, parsed.error);

    const currency = parsed.data.currency || 'USD';
    const stats = await backfillBccrRates(prisma, {
      currency,
      startDate: parsed.data.from,
      endDate: parsed.data.to,
    });
    return res.json({ ok: true, currency, ...stats });
  } catch (err) {
    console.error('[exchange-rates.backfill] error:', err);
    return res.status(502).json({ error: 'Backfill failed', message: err.message });
  }
}

/**
 * POST /api/exchange-rates/fetch-today
 */
export async function fetchTodayExchangeRates(req, res) {
  try {
    const currency = typeof req.body?.currency === 'string'
      ? req.body.currency.trim().toUpperCase()
      : 'USD';
    const stats = await fetchTodayBccr(prisma, { currency });
    return res.json({ ok: true, currency, ...stats });
  } catch (err) {
    console.error('[exchange-rates.fetchToday] error:', err);
    return res.status(502).json({ error: 'Fetch today failed', message: err.message });
  }
}

/**
 * POST /api/exchange-rates  body: { currency?, date, buy, sell }
 * Crea (o sobrescribe) un rate manual. Pisa explícitamente cualquier rate
 * previo (incluso source='bccr') porque el caso de uso es "BCCR caído /
 * dato incorrecto".
 */
export async function createManualExchangeRate(req, res) {
  try {
    const parsed = createManualSchema.safeParse(req.body || {});
    if (!parsed.success) return zodError(res, parsed.error);

    const currency = parsed.data.currency || 'USD';
    const dateObj = new Date(`${parsed.data.date}T00:00:00.000Z`);

    const upserted = await prisma.exchangeRate.upsert({
      where: { currency_date: { currency, date: dateObj } },
      create: {
        currency,
        date: dateObj,
        buy: parsed.data.buy,
        sell: parsed.data.sell,
        source: 'manual',
      },
      update: {
        buy: parsed.data.buy,
        sell: parsed.data.sell,
        source: 'manual',
        fetchedAt: new Date(),
      },
    });
    return res.status(201).json(serializeRate(upserted));
  } catch (err) {
    console.error('[exchange-rates.createManual] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

/**
 * DELETE /api/exchange-rates/:id  — admin only.
 */
export async function deleteExchangeRate(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const existing = await prisma.exchangeRate.findUnique({ where: { id: BigInt(id) } });
    if (!existing) return res.status(404).json({ error: 'Rate no encontrado' });

    await prisma.exchangeRate.delete({ where: { id: BigInt(id) } });
    return res.json({ ok: true, id });
  } catch (err) {
    console.error('[exchange-rates.delete] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export const __testables = {
  backfillSchema,
  createManualSchema,
  decimalString,
  parseLimit,
};
