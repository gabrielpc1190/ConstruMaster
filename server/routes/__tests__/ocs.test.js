/**
 * Tests del controller de OrdenesCompra.
 *
 * Corre con: `node --test server/routes/__tests__/ocs.test.js`
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Polyfill BigInt → Number en JSON, igual que `server/index.js`.
BigInt.prototype.toJSON = function () { return Number(this); };

import prisma from '../../db.js';
import { approveCotizacion } from '../../services/oc-flow.js';
import {
  listOcs,
  getOc,
  updateOc,
  cancelarOc,
} from '../../controllers/ocs.controller.js';

function mockRes() {
  const out = { statusCode: 200, body: null };
  return {
    status(code) { out.statusCode = code; return this; },
    json(payload) { out.body = payload; return this; },
    get _out() { return out; },
  };
}

function mockReq({ user = { role: 'admin', id: 1 }, params = {}, body = {}, query = {} } = {}) {
  return { user, params, body, query };
}

const createdClienteIds = [];
function tag() { return crypto.randomBytes(4).toString('hex'); }

async function setupScenario() {
  const cliente = await prisma.cliente.create({ data: { nombre: `Test-${tag()}` } });
  createdClienteIds.push(cliente.id);
  const obra = await prisma.obra.create({
    data: {
      clienteId: cliente.id,
      nombre: `Obra-${tag()}`,
      slug: `oc-test-${tag()}`,
      estado: 'en_curso',
    },
  });
  const categoria = await prisma.categoriaPresupuesto.create({
    data: { obraId: obra.id, nombre: `Cat-${tag()}` },
  });
  const proveedor = await prisma.proveedor.create({
    data: { nombre: `Prov-${tag()}`, activo: true },
  });
  const cot = await prisma.cotizacion.create({
    data: {
      obraId: obra.id,
      proveedorId: proveedor.id,
      numeroCotizacion: `COT-${tag()}`,
      fecha: new Date(),
      moneda: 'CRC',
      subtotalAmount: '100', subtotalCurrency: 'CRC',
      ivaAmount: '13', ivaCurrency: 'CRC',
      totalAmount: '113', totalCurrency: 'CRC',
      estado: 'recibida',
      items: { create: [{
        descripcion: 'x', cantidad: '1', unidad: 'unidad',
        precioUnitario: '100', subtotal: '100', ivaMonto: '13', orden: 0,
      }] },
    },
  });
  const { oc } = await approveCotizacion(prisma, {
    cotizacionId: cot.id,
    categoriaId: categoria.id,
  });
  return { cliente, obra, categoria, proveedor, cot, oc };
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
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('listOcs: incluye counts', async () => {
  const { oc, obra } = await setupScenario();
  const req = mockReq({ query: { obraId: String(obra.id) } });
  const res = mockRes();
  await listOcs(req, res);
  assert.equal(res._out.statusCode, 200);
  assert.ok(Array.isArray(res._out.body));
  const found = res._out.body.find(r => r.id === oc.id);
  assert.ok(found, 'debe retornar la OC creada');
  assert.equal(found._count.items, 1);
  assert.equal(found._count.pagos, 0);
  assert.equal(found._count.entregas, 0);
});

test('getOc: detail con items y proveedor', async () => {
  const { oc } = await setupScenario();
  const req = mockReq({ params: { id: String(oc.id) } });
  const res = mockRes();
  await getOc(req, res);
  assert.equal(res._out.statusCode, 200);
  assert.equal(res._out.body.id, oc.id);
  assert.equal(res._out.body.items.length, 1);
  assert.ok(res._out.body.proveedor);
  assert.ok(res._out.body.obra);
});

test('getOc: 404 si no existe', async () => {
  const req = mockReq({ params: { id: '999999999' } });
  const res = mockRes();
  await getOc(req, res);
  assert.equal(res._out.statusCode, 404);
});

test('updateOc: solo notas/pctAnticipo/tiempoEstimadoDias permitidos', async () => {
  const { oc } = await setupScenario();
  const req = mockReq({
    params: { id: String(oc.id) },
    body: { notas: 'actualizada', pctAnticipo: 30, tiempoEstimadoDias: 5 },
  });
  const res = mockRes();
  await updateOc(req, res);
  assert.equal(res._out.statusCode, 200);
  assert.equal(res._out.body.notas, 'actualizada');
  assert.equal(res._out.body.pctAnticipo.toString(), '30');
  assert.equal(res._out.body.tiempoEstimadoDias, 5);
});

test('updateOc: 403 para role operativo', async () => {
  const { oc } = await setupScenario();
  const req = mockReq({
    user: { role: 'operativo', id: 99 },
    params: { id: String(oc.id) },
    body: { notas: 'x' },
  });
  const res = mockRes();
  await updateOc(req, res);
  assert.equal(res._out.statusCode, 403);
});

test('cancelarOc: solo admin', async () => {
  const { oc } = await setupScenario();
  const req = mockReq({
    user: { role: 'supervisor', id: 2 },
    params: { id: String(oc.id) },
    body: { motivo: 'test' },
  });
  const res = mockRes();
  await cancelarOc(req, res);
  assert.equal(res._out.statusCode, 403);
});

test('cancelarOc: admin marca cancelada cuando no hay pagos/entregas', async () => {
  const { oc } = await setupScenario();
  const req = mockReq({
    params: { id: String(oc.id) },
    body: { motivo: 'duplicado' },
  });
  const res = mockRes();
  await cancelarOc(req, res);
  assert.equal(res._out.statusCode, 200);
  assert.equal(res._out.body.estado, 'cancelada');
  assert.match(res._out.body.notas, /CANCELACION/);
});

test('cancelarOc: 409 si OC tiene pagos', async () => {
  const { oc } = await setupScenario();
  // Crear un pago dummy.
  await prisma.pago.create({
    data: {
      ocId: oc.id,
      fechaProgramada: new Date(),
      montoAmount: '113',
      montoCurrency: 'CRC',
      metodo: 'transferencia',
    },
  });

  const req = mockReq({
    params: { id: String(oc.id) },
    body: { motivo: 'no se puede' },
  });
  const res = mockRes();
  await cancelarOc(req, res);
  assert.equal(res._out.statusCode, 409);

  // Limpiar pago para que el cleanup pueda borrar la OC.
  await prisma.pago.deleteMany({ where: { ocId: oc.id } });
});
