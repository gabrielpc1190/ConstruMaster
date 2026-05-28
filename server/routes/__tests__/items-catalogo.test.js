/**
 * Tests del controller de ItemCatalogo.
 *
 * Corre con: `node --test server/routes/__tests__/items-catalogo.test.js`
 *
 * Mocks: `prisma.itemCatalogo.*` vía `mock.method`. Para `uniqueSlug` mockeamos
 * `prisma.$queryRawUnsafe` ya que el helper consulta vía raw SQL para la tabla
 * `items_catalogo`.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import prisma from '../../db.js';
import {
  createItem,
  approveItem,
  autocompleteItems,
  __testables,
} from '../../controllers/items-catalogo.controller.js';

const { createSchema } = __testables;

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
 * Mock manual de métodos Prisma. El cliente real usa Proxies; `mock.method`
 * de node:test no encuentra los descriptors. Asignamos directo y restauramos.
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

let stubs = [];

beforeEach(() => { stubs = []; });
afterEach(() => {
  for (const s of stubs) s.restore();
  stubs = [];
});

// --- schema ----------------------------------------------------------------

test('createSchema valida campos obligatorios', () => {
  const r = createSchema.safeParse({});
  assert.equal(r.success, false);
});

test('createSchema rechaza tipo inválido', () => {
  const r = createSchema.safeParse({ tipo: 'foobar', nombreCanonico: 'X', unidad: 'kg' });
  assert.equal(r.success, false);
});

test('createSchema rechaza unidad inválida', () => {
  const r = createSchema.safeParse({ tipo: 'material', nombreCanonico: 'X', unidad: 'kilogramos' });
  assert.equal(r.success, false);
});

test('createSchema acepta payload válido', () => {
  const r = createSchema.safeParse({ tipo: 'material', nombreCanonico: 'Cemento Holcim 50kg', unidad: 'saco' });
  assert.equal(r.success, true);
});

// --- lazy creation ---------------------------------------------------------

test('createItem: operativo crea con estado=pendiente y sugeridoPorId seteado', async () => {
  // uniqueSlug consulta vía raw SQL → devolvemos array vacío para que el slug se acepte tal cual.
  const sRaw = stub(prisma, '$queryRawUnsafe', async () => []);
  stubs.push(sRaw);

  const sCreate = stub(prisma.itemCatalogo, 'create', async ({ data }) => ({
    id: 99n,
    activo: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    alias: null,
    categoriaSugeridaId: null,
    sugeridoPorId: null,
    ...data,
  }));
  stubs.push(sCreate);

  const req = {
    body: { tipo: 'material', nombreCanonico: 'Varilla #4', unidad: 'varilla' },
    user: { id: 7, role: 'operativo' },
  };
  const res = mockRes();
  await createItem(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.estado, 'pendiente');
  assert.equal(res.body.sugeridoPorId, 7);
  assert.equal(res.body.slug, 'varilla-4');
  assert.equal(res.body.nombreCanonico, 'Varilla #4');
});

test('createItem: admin crea con estado=aprobado y sin sugeridoPorId', async () => {
  const sRaw = stub(prisma, '$queryRawUnsafe', async () => []);
  stubs.push(sRaw);

  const sCreate = stub(prisma.itemCatalogo, 'create', async ({ data }) => ({
    id: 100n,
    activo: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    alias: null,
    categoriaSugeridaId: null,
    sugeridoPorId: null,
    ...data,
  }));
  stubs.push(sCreate);

  const req = {
    body: { tipo: 'servicio', nombreCanonico: 'Acarreo arena', unidad: 'm3' },
    user: { id: 1, role: 'admin' },
  };
  const res = mockRes();
  await createItem(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.estado, 'aprobado');
  assert.equal(res.body.sugeridoPorId, null);
});

// --- aprobar ---------------------------------------------------------------

test('approveItem: pendiente → aprobado', async () => {
  const sFind = stub(prisma.itemCatalogo, 'findUnique', async () => ({
    id: 5n,
    estado: 'pendiente',
    activo: true,
    tipo: 'material',
    nombreCanonico: 'Foo',
    unidad: 'unidad',
    slug: 'foo',
    alias: null,
    sugeridoPorId: null,
    categoriaSugeridaId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  stubs.push(sFind);
  const sUpdate = stub(prisma.itemCatalogo, 'update', async ({ data }) => ({
    id: 5n,
    estado: data.estado,
    activo: true,
    tipo: 'material',
    nombreCanonico: 'Foo',
    unidad: 'unidad',
    slug: 'foo',
    alias: null,
    sugeridoPorId: null,
    categoriaSugeridaId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  stubs.push(sUpdate);

  const req = { params: { id: '5' }, user: { id: 1, role: 'admin' } };
  const res = mockRes();
  await approveItem(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.estado, 'aprobado');
  assert.equal(sUpdate.calls[0].arguments[0].data.estado, 'aprobado');
});

test('approveItem: rechaza items que no están en pendiente', async () => {
  const sFind = stub(prisma.itemCatalogo, 'findUnique', async () => ({
    id: 5n,
    estado: 'aprobado',
    activo: true,
  }));
  stubs.push(sFind);

  const req = { params: { id: '5' }, user: { id: 1, role: 'admin' } };
  const res = mockRes();
  await approveItem(req, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /pendiente/);
});

test('approveItem: 404 si no existe', async () => {
  const sFind = stub(prisma.itemCatalogo, 'findUnique', async () => null);
  stubs.push(sFind);

  const req = { params: { id: '999' }, user: { id: 1, role: 'admin' } };
  const res = mockRes();
  await approveItem(req, res);

  assert.equal(res.statusCode, 404);
});

// --- autocomplete ----------------------------------------------------------

test('autocomplete: where fuerza estado=aprobado y activo=true', async () => {
  const sFind = stub(prisma.itemCatalogo, 'findMany', async () => [
    { id: 1n, nombreCanonico: 'Cemento', unidad: 'saco', tipo: 'material' },
    { id: 2n, nombreCanonico: 'Cemex', unidad: 'saco', tipo: 'material' },
  ]);
  stubs.push(sFind);

  const req = { query: { q: 'cem' }, user: { id: 1, role: 'lector' } };
  const res = mockRes();
  await autocompleteItems(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 2);
  assert.deepEqual(res.body[0], { id: 1, nombreCanonico: 'Cemento', unidad: 'saco', tipo: 'material' });

  const callArgs = sFind.calls[0].arguments[0];
  assert.equal(callArgs.where.activo, true);
  assert.equal(callArgs.where.estado, 'aprobado');
  assert.equal(callArgs.take, 10);
});

test('autocomplete: q vacío devuelve [] sin tocar DB', async () => {
  const sFind = stub(prisma.itemCatalogo, 'findMany', async () => {
    throw new Error('should not be called');
  });
  stubs.push(sFind);

  const req = { query: { q: '   ' }, user: { id: 1, role: 'lector' } };
  const res = mockRes();
  await autocompleteItems(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, []);
  assert.equal(sFind.callCount(), 0);
});
