/**
 * Tests del cron BCCR diario.
 *
 * NO tratamos de mockear `node-cron` (complejo). Verificamos:
 *  - constantes (expr, tz) son las esperadas.
 *  - `startBccrCron` NO arranca cuando falta BCCR_TOKEN.
 *  - `runBccrDailyTick` maneja errores sin lanzar.
 */

import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { startBccrCron, runBccrDailyTick, __internals } from '../bccr-daily.js';

beforeEach(() => {
  process.env.BCCR_TOKEN = 'test-token-abc';
});

afterEach(() => {
  mock.restoreAll();
});

test('cron-bccr: CRON_EXPR es lun-vie 9:30', () => {
  assert.equal(__internals.CRON_EXPR, '30 9 * * 1-5');
});

test('cron-bccr: TIMEZONE = America/Costa_Rica', () => {
  assert.equal(__internals.TIMEZONE, 'America/Costa_Rica');
});

test('startBccrCron: sin BCCR_TOKEN devuelve null sin arrancar', () => {
  delete process.env.BCCR_TOKEN;
  const handle = startBccrCron({});
  assert.equal(handle, null);
});

test('runBccrDailyTick: éxito retorna ok=true', async () => {
  // Mockeamos fetch (que internamente usa bccr.js).
  mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    async text() { return '[]'; },
    async json() { return []; },
  }));

  // Prisma mock minimal: no se debe llamar nada si BCCR devuelve [].
  const prisma = {
    exchangeRate: {
      async findUnique() { return null; },
      async create() { throw new Error('should not be called for empty list'); },
      async update() { throw new Error('should not be called for empty list'); },
    },
  };

  const result = await runBccrDailyTick(prisma);
  assert.equal(result.ok, true);
  assert.equal(result.created, 0);
});

test('runBccrDailyTick: error no se propaga, devuelve ok=false', async () => {
  mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 500,
    async text() { return 'BCCR exploded'; },
    async json() { throw new Error('not json'); },
  }));

  const result = await runBccrDailyTick({});
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.ok(result.consecutiveFailures >= 1);
});

test('startBccrCron: con BCCR_TOKEN registra un task con .stop()', () => {
  const handle = startBccrCron({});
  assert.ok(handle, 'expected a non-null task handle');
  if (handle && typeof handle.stop === 'function') {
    handle.stop();
  }
});
