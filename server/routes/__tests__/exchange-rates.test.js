/**
 * Tests del controller de Exchange Rates.
 *
 * Patrón: idem a proveedores.test.js. Sin supertest; llamamos handlers con
 * `req`/`res` mock. Para handlers que tocan Prisma, stubeamos los métodos.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import prisma from '../../db.js';
import {
  listExchangeRates,
  createManualExchangeRate,
  getLatestExchangeRate,
  __testables,
} from '../../controllers/exchange-rates.controller.js';

const { backfillSchema, createManualSchema, parseLimit } = __testables;

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

function stub(obj, method, impl) {
  const original = obj[method];
  const calls = [];
  obj[method] = async (...args) => {
    calls.push({ arguments: args });
    return impl(...args);
  };
  return { calls, callCount: () => calls.length, restore: () => { obj[method] = original; } };
}

let stubs = [];
beforeEach(() => { stubs = []; });
afterEach(() => { for (const s of stubs) s.restore(); stubs = []; });

// --- schemas ---------------------------------------------------------------

test('createManualSchema: acepta payload válido', () => {
  const r = createManualSchema.safeParse({ date: '2026-05-22', buy: '510.12345', sell: '520.5' });
  assert.equal(r.success, true);
  assert.equal(r.data.currency, 'USD');
  assert.equal(r.data.buy, '510.12345');
  assert.equal(r.data.sell, '520.5');
});

test('createManualSchema: rechaza fecha mal formada', () => {
  const r = createManualSchema.safeParse({ date: '22/05/2026', buy: '510', sell: '520' });
  assert.equal(r.success, false);
});

test('createManualSchema: rechaza buy negativo o no decimal', () => {
  const r = createManualSchema.safeParse({ date: '2026-05-22', buy: '-1', sell: '520' });
  assert.equal(r.success, false);
});

test('createManualSchema: convierte currency a uppercase', () => {
  const r = createManualSchema.safeParse({ currency: 'usd', date: '2026-05-22', buy: '510', sell: '520' });
  assert.equal(r.success, true);
  assert.equal(r.data.currency, 'USD');
});

test('backfillSchema: requiere from y to', () => {
  const r = backfillSchema.safeParse({ from: '2026-05-20' });
  assert.equal(r.success, false);
});

test('parseLimit: default 90, cap a max', () => {
  assert.equal(parseLimit(undefined), 90);
  assert.equal(parseLimit('abc'), 90);
  assert.equal(parseLimit('-5'), 90);
  assert.equal(parseLimit('50'), 50);
  assert.equal(parseLimit('99999', 90, 1000), 1000);
});

// --- list ------------------------------------------------------------------

test('listExchangeRates: default currency=USD limit=90 orderBy date desc', async () => {
  const s = stub(prisma.exchangeRate, 'findMany', async () => ([{
    id: 1n,
    currency: 'USD',
    date: new Date('2026-05-22T00:00:00Z'),
    buy: '510.0',
    sell: '520.0',
    source: 'bccr',
    fetchedAt: new Date(),
  }]));
  stubs.push(s);

  const req = { query: {}, user: { id: 1, role: 'lector' } };
  const res = mockRes();
  await listExchangeRates(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].date, '2026-05-22');
  assert.equal(res.body[0].currency, 'USD');
  assert.deepEqual(s.calls[0].arguments[0].orderBy, [{ date: 'desc' }]);
  assert.equal(s.calls[0].arguments[0].take, 90);
  assert.equal(s.calls[0].arguments[0].where.currency, 'USD');
});

test('listExchangeRates: filtra por from/to', async () => {
  const s = stub(prisma.exchangeRate, 'findMany', async () => []);
  stubs.push(s);

  const req = {
    query: { currency: 'usd', from: '2026-05-01', to: '2026-05-22', limit: '10' },
    user: { id: 1, role: 'admin' },
  };
  const res = mockRes();
  await listExchangeRates(req, res);

  const where = s.calls[0].arguments[0].where;
  assert.equal(where.currency, 'USD');
  assert.ok(where.date.gte instanceof Date);
  assert.ok(where.date.lte instanceof Date);
  assert.equal(s.calls[0].arguments[0].take, 10);
});

// --- createManual ----------------------------------------------------------

test('createManualExchangeRate: 400 si payload inválido', async () => {
  const req = { body: { date: 'bad' }, user: { id: 1, role: 'admin' } };
  const res = mockRes();
  await createManualExchangeRate(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Validation error');
});

test('createManualExchangeRate: upsert con source=manual', async () => {
  const s = stub(prisma.exchangeRate, 'upsert', async ({ create, update, where }) => ({
    id: 7n,
    currency: where.currency_date.currency,
    date: where.currency_date.date,
    buy: create.buy,
    sell: create.sell,
    source: 'manual',
    fetchedAt: new Date(),
    _create: create,
    _update: update,
  }));
  stubs.push(s);

  const req = {
    body: { date: '2026-05-22', buy: '510.5', sell: '520.5' },
    user: { id: 1, role: 'admin' },
  };
  const res = mockRes();
  await createManualExchangeRate(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.source, 'manual');
  assert.equal(res.body.buy, '510.5');
  assert.equal(s.calls[0].arguments[0].create.source, 'manual');
  assert.equal(s.calls[0].arguments[0].update.source, 'manual');
});

// --- latest ----------------------------------------------------------------

test('getLatestExchangeRate: 404 cuando no hay rates', async () => {
  const s = stub(prisma.exchangeRate, 'findFirst', async () => null);
  stubs.push(s);
  const req = { query: {}, user: { id: 1, role: 'lector' } };
  const res = mockRes();
  await getLatestExchangeRate(req, res);
  assert.equal(res.statusCode, 404);
});

test('getLatestExchangeRate: devuelve serializado cuando hay match', async () => {
  const s = stub(prisma.exchangeRate, 'findFirst', async () => ({
    id: 1n,
    currency: 'USD',
    date: new Date('2026-05-22T00:00:00Z'),
    buy: '513.0',
    sell: '523.0',
    source: 'bccr',
    fetchedAt: new Date(),
  }));
  stubs.push(s);
  const req = { query: {}, user: { id: 1, role: 'lector' } };
  const res = mockRes();
  await getLatestExchangeRate(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.currency, 'USD');
  assert.equal(res.body.date, '2026-05-22');
});
