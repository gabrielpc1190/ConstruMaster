/**
 * Tests de unidad para Bodegas.
 *
 * Correr con: `node --test server/routes/__tests__/bodegas.test.js`
 *
 * Sin `supertest` (no instalado). Cubrimos el serializer y el middleware de
 * permisos en su uso típico para Bodegas (writes admin+supervisor, delete admin).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { requireRole, WRITE_ROLES } from '../../lib/permissions.js';
import { __internals as bodegaInternals } from '../../controllers/bodegas.controller.js';

function runMiddleware(middleware, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; resolve({ res: this, called: false }); return this; },
    };
    const next = () => resolve({ res, called: true });
    middleware(req, res, next);
  });
}

// --- serializer ------------------------------------------------------------

test('serializeBodega convierte BigInt y aplana cliente + responsable', () => {
  const out = bodegaInternals.serializeBodega({
    id: 7n,
    clienteId: 3n,
    cliente: { id: 3n, nombre: 'Nicholas Rowley' },
    nombre: 'Bodega Central',
    direccion: 'San José',
    responsableId: 11n,
    responsable: { id: 11n, username: 'gabriel', fullName: 'Gabriel Mora' },
    activo: true,
    notas: null,
    createdAt: new Date('2026-05-01'),
    updatedAt: new Date('2026-05-27'),
  });
  assert.equal(out.id, 7);
  assert.equal(out.clienteId, 3);
  assert.deepEqual(out.cliente, { id: 3, nombre: 'Nicholas Rowley' });
  assert.equal(out.responsableId, 11);
  assert.deepEqual(out.responsable, { id: 11, username: 'gabriel', fullName: 'Gabriel Mora' });
  assert.equal(out.activo, true);
});

test('serializeBodega maneja responsable null', () => {
  const out = bodegaInternals.serializeBodega({
    id: 1n,
    clienteId: 1n,
    cliente: { id: 1n, nombre: 'X' },
    nombre: 'b',
    direccion: null,
    responsableId: null,
    responsable: null,
    activo: false,
    notas: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  assert.equal(out.responsableId, null);
  assert.equal(out.responsable, null);
  assert.equal(out.activo, false);
});

// --- permisos típicos de Bodegas -------------------------------------------

test('admin puede crear bodega (write)', async () => {
  const mw = requireRole(...WRITE_ROLES);
  const { called, res } = await runMiddleware(mw, { user: { role: 'admin' } });
  assert.equal(called, true);
  assert.equal(res.statusCode, 200);
});

test('supervisor puede crear bodega (write)', async () => {
  const mw = requireRole(...WRITE_ROLES);
  const { called } = await runMiddleware(mw, { user: { role: 'supervisor' } });
  assert.equal(called, true);
});

test('operativo no puede crear bodega → 403', async () => {
  const mw = requireRole(...WRITE_ROLES);
  const { called, res } = await runMiddleware(mw, { user: { role: 'operativo' } });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test('supervisor no puede DELETE bodega (admin-only) → 403', async () => {
  const mw = requireRole('admin');
  const { called, res } = await runMiddleware(mw, { user: { role: 'supervisor' } });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test('lector no puede crear ni borrar', async () => {
  const writeMw = requireRole(...WRITE_ROLES);
  const deleteMw = requireRole('admin');
  const a = await runMiddleware(writeMw, { user: { role: 'lector' } });
  const b = await runMiddleware(deleteMw, { user: { role: 'lector' } });
  assert.equal(a.called, false);
  assert.equal(a.res.statusCode, 403);
  assert.equal(b.called, false);
  assert.equal(b.res.statusCode, 403);
});
