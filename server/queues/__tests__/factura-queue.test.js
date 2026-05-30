/**
 * Tests del módulo `factura-queue`.
 *
 * Run: `node --test server/queues/__tests__/factura-queue.test.js`
 *
 * El test principal verifica el modo backwards-compat:
 *  - Sin `REDIS_URL` → `enqueueFacturaParse` retorna null sin abrir socket.
 *  - `isQueueReady` retorna false.
 *
 * El test con Redis real (`describe.skip`) está documentado para correr a mano
 * con `docker compose up -d redis` y `REDIS_URL=redis://localhost:6379`. NO
 * lo corremos en CI por la dependencia externa.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  enqueueFacturaParse,
  isQueueReady,
  getQueue,
  shutdownQueue,
} from '../factura-queue.js';

const ORIGINAL_REDIS_URL = process.env.REDIS_URL;

beforeEach(async () => {
  // Asegurar estado limpio del singleton entre tests.
  await shutdownQueue();
});

afterEach(async () => {
  await shutdownQueue();
  if (ORIGINAL_REDIS_URL == null) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = ORIGINAL_REDIS_URL;
});

test('sin REDIS_URL → enqueueFacturaParse retorna null (no-op)', async () => {
  delete process.env.REDIS_URL;

  const result = await enqueueFacturaParse({ facturaId: 1n, kind: 'xml' });
  assert.equal(result, null);

  assert.equal(isQueueReady(), false);
  assert.equal(getQueue(), null);
});

test('REDIS_URL vacío string → enqueueFacturaParse retorna null', async () => {
  process.env.REDIS_URL = '';

  const result = await enqueueFacturaParse({ facturaId: 2n, kind: 'imagen' });
  assert.equal(result, null);
  assert.equal(isQueueReady(), false);
});

test('REDIS_URL solo whitespace → enqueueFacturaParse retorna null', async () => {
  process.env.REDIS_URL = '   ';

  const result = await enqueueFacturaParse({ facturaId: 3n, kind: 'xml' });
  assert.equal(result, null);
});

test('validación: kind inválido tira (cuando REDIS_URL está)', async () => {
  // Necesitamos REDIS_URL seteado para que la validación corra (sin Redis URL
  // el guard temprano devuelve null antes de validar).
  // Como NO queremos conectar a Redis real, este test solo verifica el path
  // de validación cuando init() crea la queue. Usamos un URL inválido que
  // ioredis no podrá conectar — pero `enqueue` valida el payload ANTES de
  // hablar con Redis.
  process.env.REDIS_URL = 'redis://localhost:1';

  await assert.rejects(
    () => enqueueFacturaParse({ facturaId: 1n, kind: 'pdf' }),
    /kind inválido/,
  );

  await assert.rejects(
    () => enqueueFacturaParse({ kind: 'xml' }),
    /facturaId y kind son requeridos/,
  );
});

// ---------------------------------------------------------------------------
// Tests que REQUIEREN REDIS REAL — saltados por default.
// Para correrlos:
//   docker compose up -d redis
//   REDIS_URL=redis://localhost:6379 node --test server/queues/__tests__/factura-queue.test.js
// ---------------------------------------------------------------------------

const HAS_REDIS = process.env.REDIS_URL && process.env.REDIS_TEST === 'true';

test('con Redis real: enqueue funciona', { skip: !HAS_REDIS }, async () => {
  const result = await enqueueFacturaParse({ facturaId: 999n, kind: 'xml' });
  assert.ok(result);
  assert.ok(result.id);

  // Cleanup
  const q = getQueue();
  if (q) await q.obliterate({ force: true });
});
