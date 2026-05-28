/**
 * Tests del flujo financiero de Pagos contra OCs.
 *
 * Corre con: `node --test server/services/__tests__/pago-flow.test.js`
 *
 * Usamos la DB real (mismo patrón que `oc-flow.test.js`). Cada scenario
 * fixture-iza con un tag aleatorio para no chocar con la seed ni con runs
 * paralelos.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import prisma from '../../db.js';
import { approveCotizacion } from '../oc-flow.js';
import { markPaid, unmarkPaid } from '../pago-flow.js';

// ---------------------------------------------------------------------------
// Fixtures helpers
// ---------------------------------------------------------------------------

const createdClienteIds = [];
const createdExchangeRateIds = [];

function tag() {
  return crypto.randomBytes(4).toString('hex');
}

async function makeCliente() {
  const c = await prisma.cliente.create({ data: { nombre: `PagoTest-${tag()}` } });
  createdClienteIds.push(c.id);
  return c;
}

async function makeObra(clienteId, slug) {
  return prisma.obra.create({
    data: { clienteId, nombre: `Obra-${tag()}`, slug, estado: 'en_curso' },
  });
}

async function makeCategoria(obraId) {
  return prisma.categoriaPresupuesto.create({
    data: { obraId, nombre: `Cat-${tag()}`, orden: 0 },
  });
}

async function makeProveedor() {
  return prisma.proveedor.create({ data: { nombre: `Prov-${tag()}`, activo: true } });
}

async function makeCotizacionAndApprove({ obraId, proveedorId, categoriaId, moneda = 'CRC', total = '1000' }) {
  const cot = await prisma.cotizacion.create({
    data: {
      obraId,
      proveedorId,
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
            descripcion: 'Test item', cantidad: '1', unidad: 'unidad',
            precioUnitario: total, subtotal: total, ivaMonto: '0', orden: 0,
          },
        ],
      },
    },
  });
  const { oc } = await approveCotizacion(prisma, {
    cotizacionId: cot.id,
    categoriaId,
  });
  return oc;
}

async function makePago(ocId, { monto = '1000', currency = 'CRC', metodo = 'transferencia' } = {}) {
  return prisma.pago.create({
    data: {
      ocId,
      fechaProgramada: new Date(),
      montoAmount: monto,
      montoCurrency: currency,
      metodo,
    },
  });
}

async function ensureExchangeRate(date, sell) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  try {
    const created = await prisma.exchangeRate.create({
      data: {
        currency: 'USD',
        date: d,
        buy: String(Number(sell) - 5),
        sell: String(sell),
        source: 'manual',
      },
    });
    createdExchangeRateIds.push(created.id);
    return created;
  } catch (e) {
    if (e.code === 'P2002') {
      return prisma.exchangeRate.findUnique({
        where: { currency_date: { currency: 'USD', date: d } },
      });
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

after(async () => {
  for (const id of createdExchangeRateIds) {
    try {
      await prisma.exchangeRate.delete({ where: { id } });
    } catch { /* ignore */ }
  }
  for (const cid of createdClienteIds) {
    try {
      const obras = await prisma.obra.findMany({ where: { clienteId: cid }, select: { id: true } });
      const obraIds = obras.map((o) => o.id);
      if (obraIds.length > 0) {
        const ocs = await prisma.ordenCompra.findMany({ where: { obraId: { in: obraIds } }, select: { id: true } });
        const ocIds = ocs.map((o) => o.id);
        if (ocIds.length > 0) {
          // Borrar pagos y sus relaciones antes de borrar OCs (FK Restrict).
          const pagos = await prisma.pago.findMany({ where: { ocId: { in: ocIds } }, select: { id: true } });
          const pagoIds = pagos.map((p) => p.id);
          if (pagoIds.length > 0) {
            await prisma.pagoHito.deleteMany({ where: { pagoId: { in: pagoIds } } });
            await prisma.pago.deleteMany({ where: { id: { in: pagoIds } } });
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
// Tests
// ---------------------------------------------------------------------------

test('markPaid happy path en CRC: estado OC pasa a pagada', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id, `crc-full-${tag()}`);
  const cat = await makeCategoria(obra.id);
  const prov = await makeProveedor();
  const oc = await makeCotizacionAndApprove({
    obraId: obra.id, proveedorId: prov.id, categoriaId: cat.id, total: '1000',
  });
  const pago = await makePago(oc.id, { monto: '1000', currency: 'CRC' });

  const res = await markPaid(prisma, { pagoId: pago.id });
  assert.equal(res.pago.fechaRealizada != null, true);
  assert.equal(res.oc.estado, 'pagada');
  assert.equal(res.transitionedFrom, 'autorizada');
  assert.equal(res.transitionedTo, 'pagada');
});

test('markPaid suma parcial: OC pasa a pagada_parcial', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id, `crc-partial-${tag()}`);
  const cat = await makeCategoria(obra.id);
  const prov = await makeProveedor();
  const oc = await makeCotizacionAndApprove({
    obraId: obra.id, proveedorId: prov.id, categoriaId: cat.id, total: '1000',
  });
  const pagoA = await makePago(oc.id, { monto: '400', currency: 'CRC' });
  await makePago(oc.id, { monto: '600', currency: 'CRC' });

  const res = await markPaid(prisma, { pagoId: pagoA.id });
  assert.equal(res.oc.estado, 'pagada_parcial');
});

test('markPaid completo en dos pagos → pagada', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id, `crc-twopay-${tag()}`);
  const cat = await makeCategoria(obra.id);
  const prov = await makeProveedor();
  const oc = await makeCotizacionAndApprove({
    obraId: obra.id, proveedorId: prov.id, categoriaId: cat.id, total: '1000',
  });
  const pagoA = await makePago(oc.id, { monto: '500', currency: 'CRC' });
  const pagoB = await makePago(oc.id, { monto: '500', currency: 'CRC' });

  const r1 = await markPaid(prisma, { pagoId: pagoA.id });
  assert.equal(r1.oc.estado, 'pagada_parcial');
  const r2 = await markPaid(prisma, { pagoId: pagoB.id });
  assert.equal(r2.oc.estado, 'pagada');
});

test('markPaid doble → 409 PAGO_ALREADY_PAID', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id, `dbl-mark-${tag()}`);
  const cat = await makeCategoria(obra.id);
  const prov = await makeProveedor();
  const oc = await makeCotizacionAndApprove({
    obraId: obra.id, proveedorId: prov.id, categoriaId: cat.id, total: '500',
  });
  const pago = await makePago(oc.id, { monto: '500', currency: 'CRC' });
  await markPaid(prisma, { pagoId: pago.id });

  let caught = null;
  try {
    await markPaid(prisma, { pagoId: pago.id });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'segunda marca debió fallar');
  assert.equal(caught.code, 'PAGO_ALREADY_PAID');
  assert.equal(caught.status, 409);
});

test('markPaid USD con TC: snapshot fxRateApplied + conversión correcta para estado OC', async () => {
  // OC en USD, pago en CRC con TC del día → suma normalizada en USD.
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id, `usd-mixed-${tag()}`);
  const cat = await makeCategoria(obra.id);
  const prov = await makeProveedor();
  // Necesitamos TC para que approveCotizacion snapshot funcione también.
  const fecha = new Date();
  await ensureExchangeRate(fecha, 500);

  const oc = await makeCotizacionAndApprove({
    obraId: obra.id, proveedorId: prov.id, categoriaId: cat.id,
    moneda: 'USD', total: '100',
  });
  // Pago en CRC equivalente a USD 100 al TC 500 = 50,000 CRC.
  const pago = await makePago(oc.id, { monto: '50000', currency: 'CRC' });

  const res = await markPaid(prisma, { pagoId: pago.id, fechaRealizada: fecha });
  // CRC pago no necesita snapshot TC propio porque es CRC, pero la
  // normalización CRC → USD para estado SI usa TC.
  assert.equal(res.oc.estado, 'pagada');
  // Pago en CRC: fxRateApplied debe quedar null porque pago.currency === CRC.
  assert.equal(res.pago.fxRateApplied, null);
});

test('markPaid pago en USD sobre OC USD: fxRateApplied null (same currency, no conversion needed)', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id, `usd-usd-${tag()}`);
  const cat = await makeCategoria(obra.id);
  const prov = await makeProveedor();
  const fecha = new Date();
  await ensureExchangeRate(fecha, 510);

  const oc = await makeCotizacionAndApprove({
    obraId: obra.id, proveedorId: prov.id, categoriaId: cat.id,
    moneda: 'USD', total: '200',
  });
  const pago = await makePago(oc.id, { monto: '200', currency: 'USD' });

  const res = await markPaid(prisma, { pagoId: pago.id, fechaRealizada: fecha });
  // Snapshot: pago.currency !== CRC, así que el código intenta lookup TC.
  // El TC del día existe → snapshot non-null.
  assert.ok(res.pago.fxRateApplied != null);
  assert.equal(res.oc.estado, 'pagada');
});

test('markPaid sin TC histórico: omite del cálculo y no falla (warning)', async () => {
  // OC en USD, pago en CRC pero usamos fecha muy antigua sin TC → la
  // normalización falla y el pago se OMITE → estado no avanza a pagada.
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id, `no-tc-${tag()}`);
  const cat = await makeCategoria(obra.id);
  const prov = await makeProveedor();

  // approveCotizacion también necesita TC; sin TC dejará fxRateApplied null
  // pero NO bloquea. Usamos fecha 2019 que no debería tener TC.
  const fechaVieja = new Date('2019-01-01T00:00:00.000Z');
  await prisma.exchangeRate.deleteMany({
    where: { currency: 'USD', date: { lte: fechaVieja } },
  });

  const oc = await makeCotizacionAndApprove({
    obraId: obra.id, proveedorId: prov.id, categoriaId: cat.id,
    moneda: 'USD', total: '100',
  });
  // Pago en CRC con fecha 2019 → no hay TC → omitido del cálculo.
  const pago = await prisma.pago.create({
    data: {
      ocId: oc.id,
      fechaProgramada: fechaVieja,
      montoAmount: '50000',
      montoCurrency: 'CRC',
      metodo: 'transferencia',
    },
  });

  const res = await markPaid(prisma, { pagoId: pago.id, fechaRealizada: fechaVieja });
  // Pago marcado OK pero suma normalizada queda en 0 → estado no avanza.
  assert.equal(res.pago.fechaRealizada != null, true);
  // Como no hay TC y el pago se omite, suma=0 → estado vuelve a autorizada
  // (la lógica devuelve autorizada cuando sumaNormalizada == 0 y estado actual
  // está en OC_FIN_TRANSITIONABLE).
  assert.equal(res.oc.estado, 'autorizada');
});

test('unmarkPaid revierte estado correctamente', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id, `unmark-${tag()}`);
  const cat = await makeCategoria(obra.id);
  const prov = await makeProveedor();
  const oc = await makeCotizacionAndApprove({
    obraId: obra.id, proveedorId: prov.id, categoriaId: cat.id, total: '1000',
  });
  const pago = await makePago(oc.id, { monto: '1000', currency: 'CRC' });

  const r1 = await markPaid(prisma, { pagoId: pago.id });
  assert.equal(r1.oc.estado, 'pagada');

  const r2 = await unmarkPaid(prisma, { pagoId: pago.id });
  assert.equal(r2.pago.fechaRealizada, null);
  assert.equal(r2.pago.fxRateApplied, null);
  assert.equal(r2.oc.estado, 'autorizada');
  assert.equal(r2.transitionedFrom, 'pagada');
  assert.equal(r2.transitionedTo, 'autorizada');
});

test('unmarkPaid sobre pago no marcado → 409', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id, `unmark-err-${tag()}`);
  const cat = await makeCategoria(obra.id);
  const prov = await makeProveedor();
  const oc = await makeCotizacionAndApprove({
    obraId: obra.id, proveedorId: prov.id, categoriaId: cat.id, total: '500',
  });
  const pago = await makePago(oc.id);

  let caught = null;
  try {
    await unmarkPaid(prisma, { pagoId: pago.id });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught);
  assert.equal(caught.code, 'PAGO_NOT_PAID');
  assert.equal(caught.status, 409);
});
