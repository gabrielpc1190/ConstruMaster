/**
 * Tests del controller de Pagos + Hitos.
 *
 * Corre con: `node --test server/routes/__tests__/pagos.test.js`
 *
 * Mismo patrón que `ocs.test.js`: invocamos los handlers directamente con
 * req/res mocks. DB real.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Polyfill BigInt → Number en JSON (igual que server/index.js).
BigInt.prototype.toJSON = function () { return Number(this); };

import prisma from '../../db.js';
import { approveCotizacion } from '../../services/oc-flow.js';
import {
  listPagos,
  getPago,
  createPago,
  updatePago,
  deletePago,
  marcarPagado,
  desmarcarPagado,
  listHitosByOc,
  createHito,
  updateHito,
  completarHito,
} from '../../controllers/pagos.controller.js';

function mockRes() {
  const out = { statusCode: 200, body: null, ended: false };
  return {
    status(code) { out.statusCode = code; return this; },
    json(payload) { out.body = payload; return this; },
    end() { out.ended = true; return this; },
    get _out() { return out; },
  };
}

function mockReq({ user = { role: 'admin', id: 1 }, params = {}, body = {}, query = {} } = {}) {
  return { user, params, body, query };
}

const createdClienteIds = [];
function tag() { return crypto.randomBytes(4).toString('hex'); }

async function setupOc({ moneda = 'CRC', total = '1000' } = {}) {
  const cliente = await prisma.cliente.create({ data: { nombre: `PagoCtrl-${tag()}` } });
  createdClienteIds.push(cliente.id);
  const obra = await prisma.obra.create({
    data: {
      clienteId: cliente.id,
      nombre: `Obra-${tag()}`,
      slug: `pago-ctrl-${tag()}`,
      estado: 'en_curso',
    },
  });
  const cat = await prisma.categoriaPresupuesto.create({
    data: { obraId: obra.id, nombre: `Cat-${tag()}` },
  });
  const prov = await prisma.proveedor.create({
    data: { nombre: `Prov-${tag()}`, activo: true },
  });
  // Crear material servicio para luego probar hitos.
  const matServ = await prisma.itemCatalogo.create({
    data: {
      tipo: 'servicio',
      nombreCanonico: `Servicio-${tag()}`,
      unidad: 'global',
      slug: `serv-${tag()}`,
      estado: 'aprobado',
      activo: true,
    },
  });
  const cot = await prisma.cotizacion.create({
    data: {
      obraId: obra.id,
      proveedorId: prov.id,
      numeroCotizacion: `COT-${tag()}`,
      fecha: new Date(),
      moneda,
      subtotalAmount: total, subtotalCurrency: moneda,
      ivaAmount: '0', ivaCurrency: moneda,
      totalAmount: total, totalCurrency: moneda,
      estado: 'recibida',
      items: {
        create: [
          {
            materialId: matServ.id,
            descripcion: 'Servicio test', cantidad: '1', unidad: 'global',
            precioUnitario: total, subtotal: total, ivaMonto: '0', orden: 0,
          },
        ],
      },
    },
  });
  const { oc } = await approveCotizacion(prisma, {
    cotizacionId: cot.id, categoriaId: cat.id,
  });
  const ocFull = await prisma.ordenCompra.findUnique({
    where: { id: oc.id },
    include: { items: true },
  });
  return { cliente, obra, cat, prov, matServ, oc: ocFull };
}

after(async () => {
  for (const cid of createdClienteIds) {
    try {
      const obras = await prisma.obra.findMany({ where: { clienteId: cid }, select: { id: true } });
      const obraIds = obras.map((o) => o.id);
      if (obraIds.length > 0) {
        const ocs = await prisma.ordenCompra.findMany({ where: { obraId: { in: obraIds } }, select: { id: true } });
        const ocIds = ocs.map((o) => o.id);
        if (ocIds.length > 0) {
          const pagos = await prisma.pago.findMany({ where: { ocId: { in: ocIds } }, select: { id: true } });
          const pagoIds = pagos.map((p) => p.id);
          if (pagoIds.length > 0) {
            await prisma.pagoHito.deleteMany({ where: { pagoId: { in: pagoIds } } });
            await prisma.pago.deleteMany({ where: { id: { in: pagoIds } } });
          }
          const items = await prisma.ordenCompraItem.findMany({ where: { ocId: { in: ocIds } }, select: { id: true } });
          const itemIds = items.map((i) => i.id);
          if (itemIds.length > 0) {
            await prisma.hito.deleteMany({ where: { ocItemId: { in: itemIds } } });
          }
          await prisma.ordenCompra.deleteMany({ where: { id: { in: ocIds } } });
        }
        await prisma.cotizacion.deleteMany({ where: { obraId: { in: obraIds } } });
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
// PAGOS
// ---------------------------------------------------------------------------

test('createPago: happy path con role operativo', async () => {
  const { oc } = await setupOc();
  // Necesitamos un user real para el FK `registrado_por_id`. Usamos cualquier
  // user del seed (gabriel/diana/etc).
  const someUser = await prisma.user.findFirst();
  assert.ok(someUser, 'seed debe tener al menos un user');
  const req = mockReq({
    user: { role: 'operativo', id: String(someUser.id) },
    params: { ocId: String(oc.id) },
    body: {
      fechaProgramada: '2026-06-01',
      monto: { amount: '500', currency: 'CRC' },
      metodo: 'transferencia',
      referencia: 'tx-123',
    },
  });
  const res = mockRes();
  await createPago(req, res);
  assert.equal(res._out.statusCode, 201);
  assert.equal(res._out.body.ocId, oc.id);
  assert.equal(String(res._out.body.montoAmount), '500');
  assert.equal(res._out.body.metodo, 'transferencia');
});

test('createPago: 403 para role lector', async () => {
  const { oc } = await setupOc();
  const req = mockReq({
    user: { role: 'lector', id: 50 },
    params: { ocId: String(oc.id) },
    body: {
      fechaProgramada: '2026-06-01',
      monto: { amount: '500', currency: 'CRC' },
      metodo: 'transferencia',
    },
  });
  const res = mockRes();
  await createPago(req, res);
  assert.equal(res._out.statusCode, 403);
});

test('createPago: 404 si OC no existe', async () => {
  const req = mockReq({
    params: { ocId: '999999999' },
    body: {
      fechaProgramada: '2026-06-01',
      monto: { amount: '100', currency: 'CRC' },
      metodo: 'efectivo',
    },
  });
  const res = mockRes();
  await createPago(req, res);
  assert.equal(res._out.statusCode, 404);
});

test('marcarPagado: admin marca y OC pasa a pagada', async () => {
  const { oc } = await setupOc({ total: '1000' });
  const pago = await prisma.pago.create({
    data: {
      ocId: oc.id,
      fechaProgramada: new Date(),
      montoAmount: '1000', montoCurrency: 'CRC',
      metodo: 'transferencia',
    },
  });
  const req = mockReq({
    params: { id: String(pago.id) },
    body: { fechaRealizada: '2026-05-29' },
  });
  const res = mockRes();
  await marcarPagado(req, res);
  assert.equal(res._out.statusCode, 200);
  assert.equal(res._out.body.oc.estado, 'pagada');
  assert.equal(res._out.body.transitionedTo, 'pagada');
});

test('marcarPagado: 403 para operativo', async () => {
  const { oc } = await setupOc();
  const pago = await prisma.pago.create({
    data: {
      ocId: oc.id,
      fechaProgramada: new Date(),
      montoAmount: '100', montoCurrency: 'CRC',
      metodo: 'efectivo',
    },
  });
  const req = mockReq({
    user: { role: 'operativo', id: 88 },
    params: { id: String(pago.id) },
    body: {},
  });
  const res = mockRes();
  await marcarPagado(req, res);
  assert.equal(res._out.statusCode, 403);
});

test('marcarPagado: doble call → 409 PAGO_ALREADY_PAID', async () => {
  const { oc } = await setupOc();
  const pago = await prisma.pago.create({
    data: {
      ocId: oc.id,
      fechaProgramada: new Date(),
      montoAmount: '100', montoCurrency: 'CRC',
      metodo: 'efectivo',
    },
  });
  await marcarPagado(mockReq({ params: { id: String(pago.id) }, body: {} }), mockRes());
  const res = mockRes();
  await marcarPagado(mockReq({ params: { id: String(pago.id) }, body: {} }), res);
  assert.equal(res._out.statusCode, 409);
  assert.equal(res._out.body.code, 'PAGO_ALREADY_PAID');
});

test('desmarcarPagado: solo admin', async () => {
  const { oc } = await setupOc();
  const pago = await prisma.pago.create({
    data: {
      ocId: oc.id,
      fechaProgramada: new Date(),
      montoAmount: '100', montoCurrency: 'CRC',
      metodo: 'efectivo',
    },
  });
  await marcarPagado(mockReq({ params: { id: String(pago.id) }, body: {} }), mockRes());

  // supervisor → 403
  const supRes = mockRes();
  await desmarcarPagado(mockReq({
    user: { role: 'supervisor', id: 2 },
    params: { id: String(pago.id) },
  }), supRes);
  assert.equal(supRes._out.statusCode, 403);

  // admin → 200
  const okRes = mockRes();
  await desmarcarPagado(mockReq({ params: { id: String(pago.id) } }), okRes);
  assert.equal(okRes._out.statusCode, 200);
  assert.equal(okRes._out.body.pago.fechaRealizada, null);
});

test('updatePago: 409 si pago ya pagado', async () => {
  const { oc } = await setupOc();
  const pago = await prisma.pago.create({
    data: {
      ocId: oc.id,
      fechaProgramada: new Date(),
      montoAmount: '100', montoCurrency: 'CRC',
      metodo: 'efectivo',
    },
  });
  await marcarPagado(mockReq({ params: { id: String(pago.id) }, body: {} }), mockRes());

  const res = mockRes();
  await updatePago(mockReq({
    params: { id: String(pago.id) },
    body: { notas: 'cambio' },
  }), res);
  assert.equal(res._out.statusCode, 409);
});

test('deletePago: admin borra pago no pagado', async () => {
  const { oc } = await setupOc();
  const pago = await prisma.pago.create({
    data: {
      ocId: oc.id,
      fechaProgramada: new Date(),
      montoAmount: '100', montoCurrency: 'CRC',
      metodo: 'efectivo',
    },
  });
  const res = mockRes();
  await deletePago(mockReq({ params: { id: String(pago.id) } }), res);
  assert.equal(res._out.statusCode, 204);
  const gone = await prisma.pago.findUnique({ where: { id: pago.id } });
  assert.equal(gone, null);
});

test('listPagos: filtra por ocId', async () => {
  const { oc } = await setupOc();
  await prisma.pago.create({
    data: {
      ocId: oc.id,
      fechaProgramada: new Date(),
      montoAmount: '100', montoCurrency: 'CRC',
      metodo: 'efectivo',
    },
  });
  const res = mockRes();
  await listPagos(mockReq({ query: { ocId: String(oc.id) } }), res);
  assert.equal(res._out.statusCode, 200);
  assert.ok(Array.isArray(res._out.body));
  assert.ok(res._out.body.length >= 1);
  assert.ok(res._out.body.every((p) => p.ocId === oc.id));
});

test('getPago: detail con OC + hitosRelacionados', async () => {
  const { oc } = await setupOc();
  const pago = await prisma.pago.create({
    data: {
      ocId: oc.id,
      fechaProgramada: new Date(),
      montoAmount: '100', montoCurrency: 'CRC',
      metodo: 'efectivo',
    },
  });
  const res = mockRes();
  await getPago(mockReq({ params: { id: String(pago.id) } }), res);
  assert.equal(res._out.statusCode, 200);
  assert.equal(res._out.body.id, pago.id);
  assert.ok(res._out.body.oc);
  assert.equal(res._out.body.oc.id, oc.id);
});

// ---------------------------------------------------------------------------
// HITOS
// ---------------------------------------------------------------------------

test('createHito: admin/supervisor sobre item servicio OK', async () => {
  const { oc } = await setupOc();
  const item = oc.items[0];
  const res = mockRes();
  await createHito(mockReq({
    params: { ocId: String(oc.id), itemId: String(item.id) },
    body: { nombre: 'Hito 1', monto: '500', orden: 0 },
  }), res);
  assert.equal(res._out.statusCode, 201);
  assert.equal(res._out.body.nombre, 'Hito 1');
  assert.equal(res._out.body.ocItemId, item.id);
});

test('createHito: 403 operativo', async () => {
  const { oc } = await setupOc();
  const item = oc.items[0];
  const res = mockRes();
  await createHito(mockReq({
    user: { role: 'operativo', id: 77 },
    params: { ocId: String(oc.id), itemId: String(item.id) },
    body: { nombre: 'no debería' },
  }), res);
  assert.equal(res._out.statusCode, 403);
});

test('completarHito: marca completado=true + fechaCompletado', async () => {
  const { oc } = await setupOc();
  const item = oc.items[0];
  const created = await prisma.hito.create({
    data: { ocItemId: item.id, nombre: 'Hito X' },
  });
  const res = mockRes();
  await completarHito(mockReq({ params: { hitoId: String(created.id) } }), res);
  assert.equal(res._out.statusCode, 200);
  assert.equal(res._out.body.completado, true);
  assert.ok(res._out.body.fechaCompletado);
});

test('updateHito: actualiza nombre y monto', async () => {
  const { oc } = await setupOc();
  const item = oc.items[0];
  const created = await prisma.hito.create({
    data: { ocItemId: item.id, nombre: 'Original' },
  });
  const res = mockRes();
  await updateHito(mockReq({
    params: { hitoId: String(created.id) },
    body: { nombre: 'Renombrado', monto: '777' },
  }), res);
  assert.equal(res._out.statusCode, 200);
  assert.equal(res._out.body.nombre, 'Renombrado');
  assert.equal(String(res._out.body.monto), '777');
});

test('listHitosByOc: agrupa por items', async () => {
  const { oc } = await setupOc();
  const item = oc.items[0];
  await prisma.hito.create({ data: { ocItemId: item.id, nombre: 'H1', orden: 0 } });
  await prisma.hito.create({ data: { ocItemId: item.id, nombre: 'H2', orden: 1 } });
  const res = mockRes();
  await listHitosByOc(mockReq({ params: { ocId: String(oc.id) } }), res);
  assert.equal(res._out.statusCode, 200);
  assert.ok(Array.isArray(res._out.body));
  assert.equal(res._out.body.length, 1);
  assert.equal(res._out.body[0].hitos.length, 2);
});

test('createPago: vincula hitos correctamente', async () => {
  const { oc } = await setupOc();
  const item = oc.items[0];
  const h1 = await prisma.hito.create({ data: { ocItemId: item.id, nombre: 'PaymentTarget1', orden: 0 } });
  const h2 = await prisma.hito.create({ data: { ocItemId: item.id, nombre: 'PaymentTarget2', orden: 1 } });

  const res = mockRes();
  await createPago(mockReq({
    params: { ocId: String(oc.id) },
    body: {
      fechaProgramada: '2026-06-15',
      monto: { amount: '300', currency: 'CRC' },
      metodo: 'cheque',
      hitoIds: [String(h1.id), String(h2.id)],
    },
  }), res);
  assert.equal(res._out.statusCode, 201);
  assert.equal(res._out.body.hitosRelacionados.length, 2);
});
