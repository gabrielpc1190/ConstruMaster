/**
 * Tests del controller de Cotizaciones.
 *
 * Corre con: `node --test server/routes/__tests__/cotizaciones.test.js`
 *
 * NO usamos supertest (no está en deps). Llamamos a los handlers directamente
 * con `req`/`res` mockeados.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Mismo polyfill que `server/index.js`: serializa BigInt como Number en JSON.
// Necesario porque los handlers retornan objetos Prisma con BigInt ids y
// nuestros template literals los pasan por JSON.stringify.
BigInt.prototype.toJSON = function () { return Number(this); };

import prisma from '../../db.js';
import {
  listCotizaciones,
  getCotizacion,
  createCotizacion,
  updateCotizacion,
  aprobarCotizacion,
  rechazarCotizacion,
} from '../../controllers/cotizaciones.controller.js';

// ---------------------------------------------------------------------------
// res / req mocks
// ---------------------------------------------------------------------------

function mockRes() {
  const out = { statusCode: 200, body: null };
  return {
    status(code) {
      out.statusCode = code;
      return this;
    },
    json(payload) {
      out.body = payload;
      return this;
    },
    get _out() {
      return out;
    },
  };
}

function mockReq({ user = { role: 'admin', id: 1, username: 'gabriel' }, params = {}, body = {}, query = {} } = {}) {
  return { user, params, body, query };
}

// ---------------------------------------------------------------------------
// Fixtures helpers (mismo patrón que oc-flow.test.js)
// ---------------------------------------------------------------------------

const createdClienteIds = [];

function tag() {
  return crypto.randomBytes(4).toString('hex');
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
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('createCotizacion: happy path crea con items', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const proveedor = await makeProveedor();

  const req = mockReq({
    body: {
      obraId: Number(obra.id),
      proveedorId: Number(proveedor.id),
      numeroCotizacion: `COT-${tag()}`,
      fecha: '2026-05-27',
      moneda: 'CRC',
      subtotal: { amount: 100, currency: 'CRC' },
      iva: { amount: 13, currency: 'CRC' },
      total: { amount: 113, currency: 'CRC' },
      plazoEntregaDias: 10,
      items: [
        {
          descripcion: 'Cemento UGC 50kg',
          cantidad: 10,
          unidad: 'saco',
          precioUnitario: 10,
          subtotal: 100,
          ivaMonto: 13,
          orden: 0,
        },
      ],
    },
  });
  const res = mockRes();
  await createCotizacion(req, res);

  assert.equal(res._out.statusCode, 201, `status=${res._out.statusCode}, body=${JSON.stringify(res._out.body)}`);
  assert.ok(res._out.body.id, 'debe retornar el id');
  assert.equal(res._out.body.estado, 'recibida');
  assert.equal(res._out.body.items.length, 1);
});

test('createCotizacion: rechaza si suma items ≠ subtotal documento', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const proveedor = await makeProveedor();

  const req = mockReq({
    body: {
      obraId: Number(obra.id),
      proveedorId: Number(proveedor.id),
      numeroCotizacion: `COT-${tag()}`,
      fecha: '2026-05-27',
      moneda: 'CRC',
      subtotal: { amount: 100, currency: 'CRC' },
      iva: { amount: 13, currency: 'CRC' },
      total: { amount: 113, currency: 'CRC' },
      items: [
        {
          descripcion: 'X',
          cantidad: 1,
          unidad: 'unidad',
          precioUnitario: 50,
          subtotal: 50, // ≠ 100 documento
          ivaMonto: 6.5,
          orden: 0,
        },
      ],
    },
  });
  const res = mockRes();
  await createCotizacion(req, res);

  assert.equal(res._out.statusCode, 400);
  assert.match(res._out.body.error, /subtotal/i);
});

test('createCotizacion: 403 para role lector', async () => {
  const req = mockReq({ user: { role: 'lector', id: 99 }, body: {} });
  const res = mockRes();
  await createCotizacion(req, res);
  assert.equal(res._out.statusCode, 403);
});

test('getCotizacion: 404 si no existe', async () => {
  const req = mockReq({ params: { id: '999999999' } });
  const res = mockRes();
  await getCotizacion(req, res);
  assert.equal(res._out.statusCode, 404);
});

test('updateCotizacion: solo permite si estado editable', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const proveedor = await makeProveedor();
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
      estado: 'aprobada', // estado terminal: NO debe ser editable
    },
  });

  const req = mockReq({ params: { id: String(cot.id) }, body: { notas: 'no debe pasar' } });
  const res = mockRes();
  await updateCotizacion(req, res);
  assert.equal(res._out.statusCode, 409);
});

test('updateCotizacion: actualiza notas en estado recibida', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const proveedor = await makeProveedor();
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
    },
  });

  const req = mockReq({ params: { id: String(cot.id) }, body: { notas: 'actualizado' } });
  const res = mockRes();
  await updateCotizacion(req, res);
  assert.equal(res._out.statusCode, 200);
  assert.equal(res._out.body.notas, 'actualizado');
});

test('aprobarCotizacion: 403 para role operativo', async () => {
  const req = mockReq({
    user: { role: 'operativo', id: 3 },
    params: { id: '1' },
    body: { categoriaId: 1 },
  });
  const res = mockRes();
  await aprobarCotizacion(req, res);
  assert.equal(res._out.statusCode, 403);
});

test('aprobarCotizacion: flujo completo crea OC con numeroOc-0001', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const categoria = await makeCategoria(obra.id);
  const proveedor = await makeProveedor();
  const cot = await prisma.cotizacion.create({
    data: {
      obraId: obra.id,
      proveedorId: proveedor.id,
      numeroCotizacion: `COT-${tag()}`,
      fecha: new Date(),
      moneda: 'CRC',
      subtotalAmount: '200', subtotalCurrency: 'CRC',
      ivaAmount: '26', ivaCurrency: 'CRC',
      totalAmount: '226', totalCurrency: 'CRC',
      estado: 'recibida',
      items: {
        create: [{
          descripcion: 'Item X',
          cantidad: '2',
          unidad: 'unidad',
          precioUnitario: '100',
          subtotal: '200',
          ivaMonto: '26',
          orden: 0,
        }],
      },
    },
  });

  const req = mockReq({
    params: { id: String(cot.id) },
    body: { categoriaId: Number(categoria.id) },
  });
  const res = mockRes();
  await aprobarCotizacion(req, res);

  assert.equal(res._out.statusCode, 201, `body=${JSON.stringify(res._out.body)}`);
  assert.equal(res._out.body.cotizacion.estado, 'aprobada');
  assert.equal(res._out.body.oc.numeroOc, `${obra.slug.toUpperCase()}-OC-0001`);
});

test('aprobarCotizacion: doble aprobación devuelve 409', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const categoria = await makeCategoria(obra.id);
  const proveedor = await makeProveedor();
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

  const ok = mockRes();
  await aprobarCotizacion(
    mockReq({ params: { id: String(cot.id) }, body: { categoriaId: Number(categoria.id) } }),
    ok,
  );
  assert.equal(ok._out.statusCode, 201);

  const dup = mockRes();
  await aprobarCotizacion(
    mockReq({ params: { id: String(cot.id) }, body: { categoriaId: Number(categoria.id) } }),
    dup,
  );
  assert.equal(dup._out.statusCode, 409);
  assert.equal(dup._out.body.estado, 'aprobada');
});

test('rechazarCotizacion: marca rechazada con motivo en notas', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const proveedor = await makeProveedor();
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
    },
  });

  const req = mockReq({ params: { id: String(cot.id) }, body: { motivo: 'precio muy alto' } });
  const res = mockRes();
  await rechazarCotizacion(req, res);
  assert.equal(res._out.statusCode, 200);
  assert.equal(res._out.body.estado, 'rechazada');
  assert.match(res._out.body.notas, /RECHAZO/);
  assert.match(res._out.body.notas, /precio muy alto/);
});

test('listCotizaciones: filtra por obraId y estado', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const proveedor = await makeProveedor();
  await prisma.cotizacion.create({
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
    },
  });

  const req = mockReq({ query: { obraId: String(obra.id), estado: 'recibida' } });
  const res = mockRes();
  await listCotizaciones(req, res);
  assert.equal(res._out.statusCode, 200);
  assert.ok(Array.isArray(res._out.body));
  assert.equal(res._out.body.length, 1);
});
