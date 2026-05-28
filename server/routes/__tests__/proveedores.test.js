/**
 * Tests del controller de Proveedores.
 *
 * Corre con: `node --test server/routes/__tests__/proveedores.test.js`
 *
 * Sin supertest: testeamos la lógica del controller llamándolo con mocks de
 * `req`/`res` planos. Para los handlers que tocan Prisma, mockeamos los
 * delegates relevantes vía `mock.method` sobre el cliente importado.
 *
 * Para validación pura usamos `__testables.createSchema` directamente.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import prisma from '../../db.js';
import {
  listProveedores,
  createProveedor,
  __testables,
} from '../../controllers/proveedores.controller.js';

const { createSchema } = __testables;

// --- helpers ---------------------------------------------------------------

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
  return res;
}

/**
 * Mock manual de un método de Prisma. El cliente real usa Proxies y
 * `mock.method` de node:test falla porque no encuentra el descriptor.
 *
 * Devuelve `{ calls, restore }`. Hay que llamar `restore()` en afterEach.
 */
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

// --- schema: identificación ------------------------------------------------

test('createSchema acepta cédula física (9 dígitos)', () => {
  const r = createSchema.safeParse({ nombre: 'X', identificacion: '123456789' });
  assert.equal(r.success, true);
  assert.equal(r.data.identificacion, '123456789');
});

test('createSchema acepta cédula jurídica (10 dígitos)', () => {
  const r = createSchema.safeParse({ nombre: 'X', identificacion: '3101123456' });
  assert.equal(r.success, true);
});

test('createSchema acepta DIMEX (11 dígitos)', () => {
  const r = createSchema.safeParse({ nombre: 'X', identificacion: '12345678901' });
  assert.equal(r.success, true);
});

test('createSchema acepta DIMEX (12 dígitos)', () => {
  const r = createSchema.safeParse({ nombre: 'X', identificacion: '123456789012' });
  assert.equal(r.success, true);
});

test('createSchema rechaza 8 dígitos (cédula incompleta)', () => {
  const r = createSchema.safeParse({ nombre: 'X', identificacion: '12345678' });
  assert.equal(r.success, false);
  const msg = r.error.issues.map((i) => i.message).join(' ');
  assert.match(msg, /9-12 dígitos/);
});

test('createSchema rechaza identificación alfanumérica', () => {
  const r = createSchema.safeParse({ nombre: 'X', identificacion: '1234ABCDE' });
  assert.equal(r.success, false);
});

test('createSchema requiere nombre', () => {
  const r = createSchema.safeParse({ identificacion: '123456789' });
  assert.equal(r.success, false);
});

test('createSchema permite identificación vacía u omitida', () => {
  const r1 = createSchema.safeParse({ nombre: 'X' });
  assert.equal(r1.success, true);
  assert.equal(r1.data.identificacion, undefined);
  const r2 = createSchema.safeParse({ nombre: 'X', identificacion: '' });
  assert.equal(r2.success, true);
  assert.equal(r2.data.identificacion, undefined);
});

// --- handlers: validation paths -------------------------------------------

test('createProveedor responde 400 si nombre falta', async () => {
  const req = { body: {}, user: { id: 1, role: 'admin' } };
  const res = mockRes();
  await createProveedor(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Validation error');
  assert.ok(Array.isArray(res.body.issues));
});

test('createProveedor responde 400 con cédula inválida', async () => {
  const req = {
    body: { nombre: 'Foo', identificacion: '123' },
    user: { id: 1, role: 'admin' },
  };
  const res = mockRes();
  await createProveedor(req, res);
  assert.equal(res.statusCode, 400);
});

// --- handlers con prisma mockeado -----------------------------------------

let stubs = [];

beforeEach(() => { stubs = []; });
afterEach(() => {
  for (const s of stubs) s.restore();
  stubs = [];
});

test('createProveedor crea registro válido', async () => {
  const s = stub(prisma.proveedor, 'create', async ({ data }) => ({
    id: 42n,
    activo: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    identificacion: null,
    emailFacturacion: null,
    telefono: null,
    notas: null,
    ...data,
  }));
  stubs.push(s);

  const req = {
    body: { nombre: 'Ferretería Lobo', identificacion: '3101123456' },
    user: { id: 1, role: 'admin' },
  };
  const res = mockRes();
  await createProveedor(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.id, 42);
  assert.equal(res.body.nombre, 'Ferretería Lobo');
  assert.equal(res.body.identificacion, '3101123456');
  assert.equal(res.body.activo, true);
  assert.equal(s.callCount(), 1);
});

test('listProveedores filtra por activo=true por defecto', async () => {
  const s = stub(prisma.proveedor, 'findMany', async ({ where }) => ([{
    id: 1n,
    nombre: 'A',
    activo: where?.activo ?? null,
    identificacion: null,
    emailFacturacion: null,
    telefono: null,
    notas: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }]));
  stubs.push(s);

  const req = { query: {}, user: { id: 1, role: 'lector' } };
  const res = mockRes();
  await listProveedores(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 1);
  assert.equal(s.calls[0].arguments[0].where.activo, true);
  assert.deepEqual(s.calls[0].arguments[0].orderBy, { nombre: 'asc' });
});

test('listProveedores con search arma OR insensitive sobre nombre+identificacion', async () => {
  const s = stub(prisma.proveedor, 'findMany', async () => []);
  stubs.push(s);

  const req = { query: { search: 'lobo' }, user: { id: 1, role: 'lector' } };
  const res = mockRes();
  await listProveedores(req, res);

  const where = s.calls[0].arguments[0].where;
  assert.ok(Array.isArray(where.OR));
  assert.equal(where.OR.length, 2);
  assert.deepEqual(where.OR[0], { nombre: { contains: 'lobo', mode: 'insensitive' } });
  assert.deepEqual(where.OR[1], { identificacion: { contains: 'lobo', mode: 'insensitive' } });
});
