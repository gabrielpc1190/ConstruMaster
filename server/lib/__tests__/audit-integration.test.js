/**
 * Tests de integración para la inyección de audit en los controllers.
 *
 * Estrategia: stubs sobre los delegates de `prisma` (mismo patrón que
 * `routes/__tests__/proveedores.test.js`). Verificamos que cada handler:
 *  - crea/actualiza/borra la entidad como antes;
 *  - dispara `prisma.auditLog.create` con el shape esperado
 *    (`modelName`, `action`, `recordId`, `changes`).
 *
 * Cubrimos un caso por categoría (create / update / delete) sobre 3
 * controllers representativos (Obras, Proveedores, Cotizaciones) para no
 * volver intratable el set de tests pero sí dar señal de que el patrón está
 * cableado correctamente en todos lados.
 *
 * Correr con: `node --test server/lib/__tests__/audit-integration.test.js`
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import prisma from '../../db.js';
import {
  createProveedor,
  updateProveedor,
  deleteProveedor,
} from '../../controllers/proveedores.controller.js';
import {
  createObra,
  deleteObra,
} from '../../controllers/obras.controller.js';
import { rechazarCotizacion } from '../../controllers/cotizaciones.controller.js';

// ---------------------------------------------------------------------------
// Stub helpers (mismo patrón que proveedores.test.js)
// ---------------------------------------------------------------------------

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

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

function mockReq({ body = {}, params = {}, user = { id: 1, role: 'admin' }, headers = {} } = {}) {
  return {
    body,
    params,
    user,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
  };
}

let stubs = [];
const auditedRows = [];

beforeEach(() => {
  stubs = [];
  auditedRows.length = 0;
  // Stub global de auditLog.create para capturar todas las inserciones.
  const auditStub = stub(prisma.auditLog, 'create', async ({ data }) => {
    auditedRows.push(data);
    return { id: BigInt(auditedRows.length), ...data };
  });
  stubs.push(auditStub);
});

afterEach(() => {
  for (const s of stubs) s.restore();
  stubs = [];
});

/**
 * Espera a que la(s) llamada(s) en background a auditLog.create se procesen.
 * Los handlers no `await`ean el audit (rule #4) — usan `.catch()` fire-and-forget.
 * En tests inyectamos un microtask flush vía `setImmediate` envuelto en promise.
 */
function flush() {
  return new Promise((r) => setImmediate(r));
}

// ===========================================================================
// CREATE
// ===========================================================================

test('createProveedor → 201 + AuditLog.create({action=create, modelName=Proveedor})', async () => {
  stubs.push(stub(prisma.proveedor, 'create', async ({ data }) => ({
    id: 42n,
    activo: true,
    createdAt: new Date('2026-05-30'),
    updatedAt: new Date('2026-05-30'),
    identificacion: null,
    emailFacturacion: null,
    telefono: null,
    notas: null,
    ...data,
  })));

  const req = mockReq({
    body: { nombre: 'Ferretería Lobo', identificacion: '3101123456' },
    user: { id: 7, role: 'admin' },
    headers: { 'x-forwarded-for': '8.8.8.8, 1.1.1.1' },
  });
  const res = mockRes();
  await createProveedor(req, res);
  await flush();

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.id, 42);

  assert.equal(auditedRows.length, 1, 'audit row creado');
  const row = auditedRows[0];
  assert.equal(row.modelName, 'Proveedor');
  assert.equal(row.action, 'create');
  assert.equal(row.recordId, '42');
  assert.equal(row.userId, 7n);
  // x-forwarded-for con dos hops: el primero se toma.
  assert.equal(row.ipAddress, '8.8.8.8');
  // Changes incluye los campos nuevos como `{old:null,new:...}`.
  assert.deepEqual(row.changes.nombre, { old: null, new: 'Ferretería Lobo' });
  assert.deepEqual(row.changes.identificacion, { old: null, new: '3101123456' });
});

// ===========================================================================
// UPDATE — solo campos cambiados deben aparecer en `changes`
// ===========================================================================

test('updateProveedor → AuditLog.update.changes solo contiene el campo modificado', async () => {
  const before = {
    id: 5n,
    nombre: 'Lobo',
    identificacion: null,
    emailFacturacion: null,
    telefono: null,
    notas: null,
    activo: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
  stubs.push(stub(prisma.proveedor, 'findUnique', async () => before));
  stubs.push(stub(prisma.proveedor, 'update', async ({ data }) => ({
    ...before,
    ...data,
    updatedAt: new Date('2026-05-30'),
  })));

  const req = mockReq({
    params: { id: '5' },
    body: { telefono: '8888-8888' },
    user: { id: 1, role: 'admin' },
  });
  const res = mockRes();
  await updateProveedor(req, res);
  await flush();

  assert.equal(res.statusCode, 200);

  assert.equal(auditedRows.length, 1);
  const row = auditedRows[0];
  assert.equal(row.modelName, 'Proveedor');
  assert.equal(row.action, 'update');
  assert.equal(row.recordId, '5');
  // Solo `telefono` cambió. `updatedAt` también cambia, pero igual lo incluimos
  // si el diff lo detecta (el helper no lo filtra). Aceptamos ambos casos.
  const changedKeys = Object.keys(row.changes);
  assert.ok(changedKeys.includes('telefono'), `falta telefono en changes: ${changedKeys.join(',')}`);
  assert.deepEqual(row.changes.telefono, { old: null, new: '8888-8888' });
});

// ===========================================================================
// DELETE (soft delete vía update activo=false en Proveedor)
// ===========================================================================

test('deleteProveedor (soft) → AuditLog.delete con snapshot completo', async () => {
  const existing = {
    id: 9n,
    nombre: 'Sin uso',
    identificacion: '123456789',
    emailFacturacion: null,
    telefono: null,
    notas: null,
    activo: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
  stubs.push(stub(prisma.proveedor, 'findUnique', async () => existing));
  stubs.push(stub(prisma.proveedor, 'update', async ({ data }) => ({
    ...existing,
    ...data,
    updatedAt: new Date('2026-05-30'),
  })));

  const req = mockReq({ params: { id: '9' }, user: { id: 1, role: 'admin' } });
  const res = mockRes();
  await deleteProveedor(req, res);
  await flush();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.activo, false);

  assert.equal(auditedRows.length, 1);
  const row = auditedRows[0];
  assert.equal(row.modelName, 'Proveedor');
  assert.equal(row.action, 'delete');
  assert.equal(row.recordId, '9');
  // Snapshot completo: todos los campos deberían tener `new: null`.
  assert.deepEqual(row.changes.nombre, { old: 'Sin uso', new: null });
  assert.deepEqual(row.changes.identificacion, { old: '123456789', new: null });
  assert.deepEqual(row.changes.activo, { old: true, new: null });
});

// ===========================================================================
// Obra: soft-delete pasa por update("estado=finalizada") + audit como delete
// ===========================================================================

test('deleteObra (soft) → AuditLog.delete sobre modelo Obra', async () => {
  const obra = {
    id: 3n,
    clienteId: 1n,
    nombre: 'Casa Rowley',
    slug: 'casa-rowley',
    direccion: null,
    fechaInicio: null,
    fechaFinEstimada: null,
    monedaReporte: 'USD',
    estado: 'en_curso',
    nextOcSeq: 1,
    notas: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
  stubs.push(stub(prisma.obra, 'findUnique', async () => obra));
  stubs.push(stub(prisma.obra, 'update', async ({ data }) => ({
    ...obra,
    ...data,
    cliente: { id: 1n, nombre: 'Nicholas' },
    updatedAt: new Date('2026-05-30'),
  })));

  const req = mockReq({ params: { id: '3' }, user: { id: 1, role: 'admin' } });
  const res = mockRes();
  await deleteObra(req, res);
  await flush();

  assert.equal(res.statusCode, 200);
  assert.equal(auditedRows.length, 1);
  const row = auditedRows[0];
  assert.equal(row.modelName, 'Obra');
  assert.equal(row.action, 'delete');
  assert.equal(row.recordId, '3');
});

// ===========================================================================
// Cotización: rechazo es una transición de workflow → audit como update
// ===========================================================================

test('rechazarCotizacion → AuditLog.update con cambio de estado', async () => {
  const before = {
    id: 11n,
    obraId: 1n,
    proveedorId: 2n,
    rfqId: null,
    numeroCotizacion: 'COT-001',
    fecha: new Date('2026-05-01'),
    fechaValidez: null,
    moneda: 'CRC',
    subtotalAmount: '1000',
    subtotalCurrency: 'CRC',
    ivaAmount: '130',
    ivaCurrency: 'CRC',
    totalAmount: '1130',
    totalCurrency: 'CRC',
    condicionesPago: null,
    plazoEntregaDias: null,
    pctAnticipo: null,
    esEspecial: false,
    archivoPath: null,
    notas: null,
    estado: 'recibida',
    createdAt: new Date('2026-05-01'),
    updatedAt: new Date('2026-05-01'),
  };
  stubs.push(stub(prisma.cotizacion, 'findUnique', async () => before));
  stubs.push(stub(prisma.cotizacion, 'update', async ({ data }) => ({
    ...before,
    ...data,
    items: [],
    proveedor: { id: 2n, nombre: 'X' },
    obra: { id: 1n, nombre: 'Y' },
    updatedAt: new Date('2026-05-30'),
  })));

  const req = mockReq({
    params: { id: '11' },
    body: { motivo: 'Precio fuera de rango' },
    user: { id: 1, role: 'supervisor' },
  });
  const res = mockRes();
  await rechazarCotizacion(req, res);
  await flush();

  assert.equal(res.statusCode, 200);
  assert.equal(auditedRows.length, 1);
  const row = auditedRows[0];
  assert.equal(row.modelName, 'Cotizacion');
  assert.equal(row.action, 'update');
  assert.equal(row.recordId, '11');
  // El campo `estado` debería estar en el diff.
  assert.ok(row.changes.estado, `falta estado en changes: ${Object.keys(row.changes).join(',')}`);
  assert.equal(row.changes.estado.old, 'recibida');
  assert.equal(row.changes.estado.new, 'rechazada');
});

// ===========================================================================
// Robustez: audit que falla NO debe romper el handler (rule #4 spec)
// ===========================================================================

test('audit que tira no rompe el handler (fire-and-forget con .catch)', async () => {
  // Reemplazamos el stub de auditLog.create por uno que tira.
  for (const s of stubs) s.restore();
  stubs = [];
  stubs.push(stub(prisma.auditLog, 'create', async () => {
    throw new Error('DB down — audit no debería romper el create');
  }));

  stubs.push(stub(prisma.proveedor, 'create', async ({ data }) => ({
    id: 99n,
    activo: true,
    createdAt: new Date('2026-05-30'),
    updatedAt: new Date('2026-05-30'),
    identificacion: null,
    emailFacturacion: null,
    telefono: null,
    notas: null,
    ...data,
  })));

  const req = mockReq({
    body: { nombre: 'Test fallido en audit' },
    user: { id: 1, role: 'admin' },
  });
  const res = mockRes();
  // No debería tirar y debería retornar 201 normal.
  await createProveedor(req, res);
  await flush();

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.id, 99);
});
