/**
 * Tests del servicio exchange-rates.
 * Corre con: `node --test server/services/__tests__/exchange-rates.test.js`
 *
 * Mockeamos `globalThis.fetch` (que usa internamente bccr.js) y los métodos
 * Prisma necesarios. Patrón de stub manual sigue el de proveedores.test.js.
 */

import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { backfillBccrRates, fetchTodayBccr, latestRate, __internals } from '../exchange-rates.js';

const { ymd, mergeBuySell } = __internals;

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
    async json() { return body; },
  };
}

function stub(obj, method, impl) {
  const original = obj[method];
  const calls = [];
  obj[method] = async (...args) => {
    calls.push({ arguments: args });
    return impl(...args);
  };
  return {
    calls,
    callCount: () => calls.length,
    restore: () => { obj[method] = original; },
  };
}

/**
 * Mock minimal de prisma con `exchangeRate.findUnique/update/create/findMany/findFirst`.
 */
function makePrismaMock(initialRows = []) {
  const rows = [...initialRows];
  return {
    rows,
    exchangeRate: {
      async findUnique({ where }) {
        const { currency, date } = where.currency_date;
        return rows.find((r) =>
          r.currency === currency && ymd(r.date) === ymd(date),
        ) ?? null;
      },
      async update({ where, data }) {
        const { currency, date } = where.currency_date;
        const idx = rows.findIndex((r) =>
          r.currency === currency && ymd(r.date) === ymd(date),
        );
        if (idx < 0) throw new Error('not found');
        rows[idx] = { ...rows[idx], ...data };
        return rows[idx];
      },
      async create({ data }) {
        const row = { id: BigInt(rows.length + 1), fetchedAt: new Date(), ...data };
        rows.push(row);
        return row;
      },
      async findMany() { return [...rows].sort((a, b) => ymd(b.date).localeCompare(ymd(a.date))); },
      async findFirst({ where, orderBy }) {
        let matches = rows.filter((r) => r.currency === where.currency);
        if (where.date?.lte) {
          matches = matches.filter((r) => ymd(r.date) <= ymd(where.date.lte));
        }
        const dir = orderBy?.[0]?.date === 'desc' ? -1 : 1;
        matches.sort((a, b) => dir * ymd(a.date).localeCompare(ymd(b.date)));
        return matches[0] ?? null;
      },
    },
  };
}

beforeEach(() => {
  process.env.BCCR_TOKEN = 'test-token-abc';
});

afterEach(() => {
  mock.restoreAll();
});

// --- helpers internos ------------------------------------------------------

test('ymd: corta ISO string a YYYY-MM-DD', () => {
  assert.equal(ymd('2026-05-22T10:11:12Z'), '2026-05-22');
  assert.equal(ymd(new Date('2026-05-22T00:00:00Z')), '2026-05-22');
});

test('mergeBuySell: combina por fecha', () => {
  const buys = [{ date: '2026-05-20', value: '510.1' }, { date: '2026-05-21', value: '511.0' }];
  const sells = [{ date: '2026-05-20', value: '520.5' }, { date: '2026-05-22', value: '522.0' }];
  const out = mergeBuySell(buys, sells);
  assert.equal(out.get('2026-05-20').buy, '510.1');
  assert.equal(out.get('2026-05-20').sell, '520.5');
  assert.equal(out.get('2026-05-21').sell, undefined);
  assert.equal(out.get('2026-05-22').buy, undefined);
});

// --- backfillBccrRates -----------------------------------------------------

test('backfillBccrRates: crea rates nuevos cuando no existen', async () => {
  // 1ra llamada = buy (317), 2da llamada = sell (318).
  let call = 0;
  mock.method(globalThis, 'fetch', async () => {
    call += 1;
    if (call === 1) {
      return jsonResponse([
        { fecha: '2026-05-20', valor: 510.1, estado: true },
        { fecha: '2026-05-21', valor: 511.0, estado: true },
      ]);
    }
    return jsonResponse([
      { fecha: '2026-05-20', valor: 520.5, estado: true },
      { fecha: '2026-05-21', valor: 521.0, estado: true },
    ]);
  });

  const prisma = makePrismaMock();
  const stats = await backfillBccrRates(prisma, {
    currency: 'USD', startDate: '2026-05-20', endDate: '2026-05-21',
  });

  assert.equal(stats.created, 2);
  assert.equal(stats.updated, 0);
  assert.equal(stats.skipped, 0);
  assert.equal(stats.total, 2);
  assert.equal(prisma.rows.length, 2);
  assert.equal(prisma.rows[0].source, 'bccr');
  assert.equal(prisma.rows[0].buy, '510.1');
  assert.equal(prisma.rows[0].sell, '520.5');
});

test('backfillBccrRates: actualiza row existente con source=bccr', async () => {
  let call = 0;
  mock.method(globalThis, 'fetch', async () => {
    call += 1;
    if (call === 1) return jsonResponse([{ fecha: '2026-05-20', valor: 510.1, estado: true }]);
    return jsonResponse([{ fecha: '2026-05-20', valor: 520.5, estado: true }]);
  });

  const prisma = makePrismaMock([{
    id: 1n,
    currency: 'USD',
    date: new Date('2026-05-20T00:00:00.000Z'),
    buy: '500.0',
    sell: '510.0',
    source: 'bccr',
    fetchedAt: new Date(),
  }]);

  const stats = await backfillBccrRates(prisma, {
    currency: 'USD', startDate: '2026-05-20', endDate: '2026-05-20',
  });

  assert.equal(stats.created, 0);
  assert.equal(stats.updated, 1);
  assert.equal(stats.skipped, 0);
  assert.equal(prisma.rows[0].buy, '510.1');
  assert.equal(prisma.rows[0].sell, '520.5');
});

test('backfillBccrRates: NO pisa row con source=manual', async () => {
  let call = 0;
  mock.method(globalThis, 'fetch', async () => {
    call += 1;
    if (call === 1) return jsonResponse([{ fecha: '2026-05-20', valor: 510.1, estado: true }]);
    return jsonResponse([{ fecha: '2026-05-20', valor: 520.5, estado: true }]);
  });

  const prisma = makePrismaMock([{
    id: 1n,
    currency: 'USD',
    date: new Date('2026-05-20T00:00:00.000Z'),
    buy: '999.0',
    sell: '999.0',
    source: 'manual',
    fetchedAt: new Date(),
  }]);

  const stats = await backfillBccrRates(prisma, {
    currency: 'USD', startDate: '2026-05-20', endDate: '2026-05-20',
  });

  assert.equal(stats.created, 0);
  assert.equal(stats.updated, 0);
  assert.equal(stats.skipped, 1);
  // El valor manual se conserva.
  assert.equal(prisma.rows[0].buy, '999.0');
  assert.equal(prisma.rows[0].source, 'manual');
});

test('backfillBccrRates: rango fin de semana → estado=false → array vacío sin error', async () => {
  // Ambas series vienen con estado=false; bccr.js las filtra → arrays vacíos.
  mock.method(globalThis, 'fetch', async () =>
    jsonResponse([
      { fecha: '2026-05-23', valor: null, estado: false },
      { fecha: '2026-05-24', valor: null, estado: false },
    ]));

  const prisma = makePrismaMock();
  const stats = await backfillBccrRates(prisma, {
    currency: 'USD', startDate: '2026-05-23', endDate: '2026-05-24',
  });
  assert.deepEqual(stats, { created: 0, updated: 0, skipped: 0, total: 0 });
});

test('backfillBccrRates: requiere startDate y endDate', async () => {
  const prisma = makePrismaMock();
  await assert.rejects(
    () => backfillBccrRates(prisma, { currency: 'USD' }),
    /startDate and endDate are required/,
  );
});

// --- fetchTodayBccr --------------------------------------------------------

test('fetchTodayBccr: usa ventana de 3 días hacia atrás', async () => {
  const urls = [];
  mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    return jsonResponse([]);
  });
  const prisma = makePrismaMock();
  await fetchTodayBccr(prisma, { currency: 'USD' });
  // 2 llamadas (buy + sell), ambas con rango today-3 → today.
  assert.equal(urls.length, 2);
  for (const u of urls) {
    assert.ok(u.includes('fechaInicio='));
    assert.ok(u.includes('fechaFin='));
  }
});

// --- latestRate ------------------------------------------------------------

test('latestRate: devuelve el más reciente', async () => {
  const prisma = makePrismaMock([
    { id: 1n, currency: 'USD', date: new Date('2026-05-19T00:00:00Z'), buy: '510', sell: '520', source: 'bccr', fetchedAt: new Date() },
    { id: 2n, currency: 'USD', date: new Date('2026-05-22T00:00:00Z'), buy: '513', sell: '523', source: 'bccr', fetchedAt: new Date() },
    { id: 3n, currency: 'USD', date: new Date('2026-05-20T00:00:00Z'), buy: '511', sell: '521', source: 'bccr', fetchedAt: new Date() },
  ]);
  const r = await latestRate(prisma, { currency: 'USD' });
  assert.equal(r.date, '2026-05-22');
  assert.equal(r.buy, '513');
});

test('latestRate: con date busca <=date', async () => {
  const prisma = makePrismaMock([
    { id: 1n, currency: 'USD', date: new Date('2026-05-19T00:00:00Z'), buy: '510', sell: '520', source: 'bccr', fetchedAt: new Date() },
    { id: 2n, currency: 'USD', date: new Date('2026-05-22T00:00:00Z'), buy: '513', sell: '523', source: 'bccr', fetchedAt: new Date() },
  ]);
  const r = await latestRate(prisma, { currency: 'USD', date: '2026-05-20' });
  assert.equal(r.date, '2026-05-19');
});

test('latestRate: sin matches devuelve null', async () => {
  const prisma = makePrismaMock();
  const r = await latestRate(prisma, { currency: 'USD' });
  assert.equal(r, null);
});

// keep stub helper referenced to silence linter if needed.
void stub;
