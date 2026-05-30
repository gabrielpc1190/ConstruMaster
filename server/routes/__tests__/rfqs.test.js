/**
 * Tests del controller de Solicitudes de Cotización (rfqs).
 *
 * Corre con: `node --test server/routes/__tests__/rfqs.test.js`
 *
 * Mismo patrón que `cotizaciones.test.js`: handlers se invocan directo con
 * `req`/`res` mockeados. Los fixtures crean cliente/obra/categoria/proveedor
 * reales en la DB de tests y se limpian al final.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

BigInt.prototype.toJSON = function () { return Number(this); };

import prisma from '../../db.js';
import {
  listRfqs,
  getRfq,
  createRfq,
  updateRfq,
  cancelRfq,
} from '../../controllers/rfqs.controller.js';

// ---------------------------------------------------------------------------
// req / res mocks
// ---------------------------------------------------------------------------

function mockRes() {
  const out = { statusCode: 200, body: null };
  return {
    status(code) { out.statusCode = code; return this; },
    json(payload) { out.body = payload; return this; },
    get _out() { return out; },
  };
}

function mockReq({ user = { role: 'admin', id: 1, username: 'gabriel' }, params = {}, body = {}, query = {} } = {}) {
  return { user, params, body, query };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const createdClienteIds = [];
const createdUserIds = [];

function tag() { return crypto.randomBytes(4).toString('hex'); }

async function makeUser(role = 'operativo') {
  const u = await prisma.user.create({
    data: {
      username: `u-${tag()}`,
      passwordHash: 'x',
      role,
      fullName: 'Tester',
    },
  });
  createdUserIds.push(u.id);
  return u;
}

async function makeCliente() {
  const c = await prisma.cliente.create({ data: { nombre: `Test-${tag()}` } });
  createdClienteIds.push(c.id);
  return c;
}

async function makeObra(clienteId) {
  return prisma.obra.create({
    data: {
      clienteId,
      nombre: `Obra-${tag()}`,
      slug: `obra-${tag()}`,
      estado: 'en_curso',
    },
  });
}

async function makeCategoria(obraId) {
  return prisma.categoriaPresupuesto.create({
    data: { obraId, nombre: `Cat-${tag()}`, orden: 0 },
  });
}

async function makeProveedor() {
  return prisma.proveedor.create({
    data: { nombre: `Prov-${tag()}`, activo: true },
  });
}

after(async () => {
  for (const cid of createdClienteIds) {
    try {
      const obras = await prisma.obra.findMany({ where: { clienteId: cid }, select: { id: true } });
      const obraIds = obras.map(o => o.id);
      if (obraIds.length > 0) {
        await prisma.ordenCompra.deleteMany({ where: { obraId: { in: obraIds } } });
        await prisma.cotizacion.deleteMany({ where: { obraId: { in: obraIds } } });
        await prisma.solicitudCotizacion.deleteMany({ where: { obraId: { in: obraIds } } });
        await prisma.categoriaPresupuesto.deleteMany({ where: { obraId: { in: obraIds } } });
        await prisma.obra.deleteMany({ where: { id: { in: obraIds } } });
      }
      await prisma.bodega.deleteMany({ where: { clienteId: cid } });
      await prisma.cliente.delete({ where: { id: cid } });
    } catch (e) {
      console.warn(`[cleanup] cliente ${cid}:`, e.message);
    }
  }
  for (const uid of createdUserIds) {
    try { await prisma.user.delete({ where: { id: uid } }); } catch { /* noop */ }
  }
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Tests: create
// ---------------------------------------------------------------------------

test('createRfq: happy path crea con estado abierta', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const cat = await makeCategoria(obra.id);
  const user = await makeUser('operativo');

  const req = mockReq({
    user: { role: 'operativo', id: Number(user.id), username: user.username },
    body: {
      obraId: Number(obra.id),
      categoriaId: Number(cat.id),
      descripcion: '100 sacos cemento UGC 50kg',
      fechaRequerida: '2026-06-15',
      notas: 'Urgente para fundir losa',
    },
  });
  const res = mockRes();
  await createRfq(req, res);

  assert.equal(res._out.statusCode, 201, `body=${JSON.stringify(res._out.body)}`);
  assert.ok(res._out.body.id, 'debe retornar id');
  assert.equal(res._out.body.estado, 'abierta');
  assert.equal(res._out.body.descripcion, '100 sacos cemento UGC 50kg');
  assert.equal(Number(res._out.body.obraId), Number(obra.id));
  assert.equal(Number(res._out.body.categoriaId), Number(cat.id));
  assert.equal(Number(res._out.body.creadaPorId), Number(user.id));
});

test('createRfq: estado default es abierta aun si body trae otro', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const cat = await makeCategoria(obra.id);
  const user = await makeUser('operativo');

  const req = mockReq({
    user: { role: 'operativo', id: Number(user.id), username: user.username },
    body: {
      obraId: Number(obra.id),
      categoriaId: Number(cat.id),
      descripcion: 'Solicitud sin fecha',
      estado: 'cerrada', // payload tramposo — debe ignorarse
    },
  });
  const res = mockRes();
  await createRfq(req, res);

  assert.equal(res._out.statusCode, 201);
  assert.equal(res._out.body.estado, 'abierta');
});

test('createRfq: rechaza si falta descripcion', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const cat = await makeCategoria(obra.id);

  const req = mockReq({
    body: {
      obraId: Number(obra.id),
      categoriaId: Number(cat.id),
    },
  });
  const res = mockRes();
  await createRfq(req, res);

  assert.equal(res._out.statusCode, 400);
});

test('createRfq: 403 para role lector', async () => {
  const req = mockReq({
    user: { role: 'lector', id: 99 },
    body: {
      obraId: 1,
      categoriaId: 1,
      descripcion: 'X',
    },
  });
  const res = mockRes();
  await createRfq(req, res);
  assert.equal(res._out.statusCode, 403);
});

test('createRfq: 404 si obra no existe', async () => {
  const req = mockReq({
    body: {
      obraId: 99999999,
      categoriaId: 1,
      descripcion: 'X',
    },
  });
  const res = mockRes();
  await createRfq(req, res);
  assert.equal(res._out.statusCode, 404);
  assert.match(res._out.body.error, /obra/i);
});

// ---------------------------------------------------------------------------
// Tests: list
// ---------------------------------------------------------------------------

test('listRfqs: filtra por obraId', async () => {
  const cliente = await makeCliente();
  const obra1 = await makeObra(cliente.id);
  const obra2 = await makeObra(cliente.id);
  const cat1 = await makeCategoria(obra1.id);
  const cat2 = await makeCategoria(obra2.id);
  const user = await makeUser('admin');

  await prisma.solicitudCotizacion.create({
    data: { obraId: obra1.id, categoriaId: cat1.id, descripcion: 'A', creadaPorId: user.id },
  });
  await prisma.solicitudCotizacion.create({
    data: { obraId: obra2.id, categoriaId: cat2.id, descripcion: 'B', creadaPorId: user.id },
  });

  const req = mockReq({ query: { obraId: String(obra1.id) } });
  const res = mockRes();
  await listRfqs(req, res);

  assert.equal(res._out.statusCode, 200);
  assert.ok(Array.isArray(res._out.body));
  assert.ok(res._out.body.every(r => Number(r.obraId) === Number(obra1.id)));
  assert.ok(res._out.body.length >= 1);
});

test('listRfqs: filtra por estado=cancelada', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const cat = await makeCategoria(obra.id);
  const user = await makeUser('admin');

  await prisma.solicitudCotizacion.create({
    data: { obraId: obra.id, categoriaId: cat.id, descripcion: 'Abierta', creadaPorId: user.id, estado: 'abierta' },
  });
  await prisma.solicitudCotizacion.create({
    data: { obraId: obra.id, categoriaId: cat.id, descripcion: 'Cancelada', creadaPorId: user.id, estado: 'cancelada' },
  });

  const req = mockReq({ query: { obraId: String(obra.id), estado: 'cancelada' } });
  const res = mockRes();
  await listRfqs(req, res);

  assert.equal(res._out.statusCode, 200);
  assert.ok(res._out.body.every(r => r.estado === 'cancelada'));
});

test('listRfqs: search por descripcion (case-insensitive)', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const cat = await makeCategoria(obra.id);
  const user = await makeUser('admin');
  const uniq = tag();

  await prisma.solicitudCotizacion.create({
    data: { obraId: obra.id, categoriaId: cat.id, descripcion: `100 SACOS CEMENTO ${uniq}`, creadaPorId: user.id },
  });

  const req = mockReq({ query: { search: `cemento ${uniq}` } });
  const res = mockRes();
  await listRfqs(req, res);

  assert.equal(res._out.statusCode, 200);
  assert.ok(res._out.body.length >= 1);
});

test('listRfqs: incluye _count.cotizaciones', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const cat = await makeCategoria(obra.id);
  const user = await makeUser('admin');
  const proveedor = await makeProveedor();

  const rfq = await prisma.solicitudCotizacion.create({
    data: { obraId: obra.id, categoriaId: cat.id, descripcion: 'Con cot', creadaPorId: user.id },
  });

  await prisma.cotizacion.create({
    data: {
      obraId: obra.id,
      proveedorId: proveedor.id,
      rfqId: rfq.id,
      numeroCotizacion: `COT-${tag()}`,
      fecha: new Date(),
      moneda: 'CRC',
      subtotalAmount: '100', subtotalCurrency: 'CRC',
      ivaAmount: '13', ivaCurrency: 'CRC',
      totalAmount: '113', totalCurrency: 'CRC',
    },
  });

  const req = mockReq({ query: { obraId: String(obra.id) } });
  const res = mockRes();
  await listRfqs(req, res);

  assert.equal(res._out.statusCode, 200);
  const found = res._out.body.find(r => Number(r.id) === Number(rfq.id));
  assert.ok(found, 'la rfq creada debe estar en la lista');
  assert.equal(found._count?.cotizaciones, 1);
});

// ---------------------------------------------------------------------------
// Tests: get
// ---------------------------------------------------------------------------

test('getRfq: 404 si no existe', async () => {
  const req = mockReq({ params: { id: '999999999' } });
  const res = mockRes();
  await getRfq(req, res);
  assert.equal(res._out.statusCode, 404);
});

test('getRfq: incluye cotizaciones embebidas con proveedor', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const cat = await makeCategoria(obra.id);
  const user = await makeUser('admin');
  const proveedor = await makeProveedor();

  const rfq = await prisma.solicitudCotizacion.create({
    data: { obraId: obra.id, categoriaId: cat.id, descripcion: 'RFQ con cot', creadaPorId: user.id },
  });
  await prisma.cotizacion.create({
    data: {
      obraId: obra.id,
      proveedorId: proveedor.id,
      rfqId: rfq.id,
      numeroCotizacion: `COT-${tag()}`,
      fecha: new Date(),
      moneda: 'CRC',
      subtotalAmount: '500', subtotalCurrency: 'CRC',
      ivaAmount: '65', ivaCurrency: 'CRC',
      totalAmount: '565', totalCurrency: 'CRC',
    },
  });

  const req = mockReq({ params: { id: String(rfq.id) } });
  const res = mockRes();
  await getRfq(req, res);

  assert.equal(res._out.statusCode, 200);
  assert.equal(Number(res._out.body.id), Number(rfq.id));
  assert.ok(Array.isArray(res._out.body.cotizaciones));
  assert.equal(res._out.body.cotizaciones.length, 1);
  assert.ok(res._out.body.cotizaciones[0].proveedor, 'cotizacion debe traer proveedor');
});

// ---------------------------------------------------------------------------
// Tests: update
// ---------------------------------------------------------------------------

test('updateRfq: actualiza descripcion + notas en estado abierta', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const cat = await makeCategoria(obra.id);
  const user = await makeUser('admin');

  const rfq = await prisma.solicitudCotizacion.create({
    data: { obraId: obra.id, categoriaId: cat.id, descripcion: 'Original', creadaPorId: user.id },
  });

  const req = mockReq({
    params: { id: String(rfq.id) },
    body: { descripcion: 'Modificado', notas: 'Cambió alcance' },
  });
  const res = mockRes();
  await updateRfq(req, res);

  assert.equal(res._out.statusCode, 200);
  assert.equal(res._out.body.descripcion, 'Modificado');
  assert.equal(res._out.body.notas, 'Cambió alcance');
});

test('updateRfq: 409 si estado=cerrada', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const cat = await makeCategoria(obra.id);
  const user = await makeUser('admin');

  const rfq = await prisma.solicitudCotizacion.create({
    data: { obraId: obra.id, categoriaId: cat.id, descripcion: 'Cerrada', creadaPorId: user.id, estado: 'cerrada' },
  });

  const req = mockReq({
    params: { id: String(rfq.id) },
    body: { descripcion: 'No debería pasar' },
  });
  const res = mockRes();
  await updateRfq(req, res);

  assert.equal(res._out.statusCode, 409);
});

test('updateRfq: 409 si estado=cancelada', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const cat = await makeCategoria(obra.id);
  const user = await makeUser('admin');

  const rfq = await prisma.solicitudCotizacion.create({
    data: { obraId: obra.id, categoriaId: cat.id, descripcion: 'Cancelada', creadaPorId: user.id, estado: 'cancelada' },
  });

  const req = mockReq({
    params: { id: String(rfq.id) },
    body: { descripcion: 'No' },
  });
  const res = mockRes();
  await updateRfq(req, res);
  assert.equal(res._out.statusCode, 409);
});

// ---------------------------------------------------------------------------
// Tests: cancel
// ---------------------------------------------------------------------------

test('cancelRfq: 403 para role operativo', async () => {
  const req = mockReq({
    user: { role: 'operativo', id: 99 },
    params: { id: '1' },
    body: { motivo: 'X' },
  });
  const res = mockRes();
  await cancelRfq(req, res);
  assert.equal(res._out.statusCode, 403);
});

test('cancelRfq: admin cancela RFQ abierta y aporta motivo en notas', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const cat = await makeCategoria(obra.id);
  const user = await makeUser('admin');

  const rfq = await prisma.solicitudCotizacion.create({
    data: { obraId: obra.id, categoriaId: cat.id, descripcion: 'Por cancelar', creadaPorId: user.id },
  });

  const req = mockReq({
    user: { role: 'admin', id: Number(user.id) },
    params: { id: String(rfq.id) },
    body: { motivo: 'Ya no se necesita el material' },
  });
  const res = mockRes();
  await cancelRfq(req, res);

  assert.equal(res._out.statusCode, 200, `body=${JSON.stringify(res._out.body)}`);
  assert.equal(res._out.body.estado, 'cancelada');
  assert.match(res._out.body.notas, /\[CANCELADA \d{4}-\d{2}-\d{2}\]/);
  assert.match(res._out.body.notas, /Ya no se necesita/);
});

test('cancelRfq: 409 si ya estaba cerrada', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const cat = await makeCategoria(obra.id);
  const user = await makeUser('admin');

  const rfq = await prisma.solicitudCotizacion.create({
    data: { obraId: obra.id, categoriaId: cat.id, descripcion: 'Cerrada', creadaPorId: user.id, estado: 'cerrada' },
  });

  const req = mockReq({
    params: { id: String(rfq.id) },
    body: { motivo: 'X' },
  });
  const res = mockRes();
  await cancelRfq(req, res);
  assert.equal(res._out.statusCode, 409);
});

test('cancelRfq: 409 si tiene cotización aprobada', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const cat = await makeCategoria(obra.id);
  const user = await makeUser('admin');
  const proveedor = await makeProveedor();

  const rfq = await prisma.solicitudCotizacion.create({
    data: { obraId: obra.id, categoriaId: cat.id, descripcion: 'Con aprobada', creadaPorId: user.id },
  });
  await prisma.cotizacion.create({
    data: {
      obraId: obra.id,
      proveedorId: proveedor.id,
      rfqId: rfq.id,
      numeroCotizacion: `COT-${tag()}`,
      fecha: new Date(),
      moneda: 'CRC',
      subtotalAmount: '100', subtotalCurrency: 'CRC',
      ivaAmount: '13', ivaCurrency: 'CRC',
      totalAmount: '113', totalCurrency: 'CRC',
      estado: 'aprobada',
    },
  });

  const req = mockReq({
    params: { id: String(rfq.id) },
    body: { motivo: 'X' },
  });
  const res = mockRes();
  await cancelRfq(req, res);

  assert.equal(res._out.statusCode, 409);
});

test('cancelRfq: 404 si no existe', async () => {
  const req = mockReq({ params: { id: '999999999' }, body: { motivo: 'X' } });
  const res = mockRes();
  await cancelRfq(req, res);
  assert.equal(res._out.statusCode, 404);
});
