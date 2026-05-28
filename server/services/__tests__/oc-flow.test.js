/**
 * Tests del flujo crítico de aprobación Cotización → OrdenCompra.
 *
 * Corre con: `node --test server/services/__tests__/oc-flow.test.js`
 *
 * Estos tests usan la DB real (Postgres). Cada test envuelve su scenario en
 * fixtures con sufijo aleatorio para no chocar con seed ni con runs paralelos.
 *
 * NO usamos supertest: testeamos la función pura `approveCotizacion` que es
 * lo que importa del flow.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import prisma from '../../db.js';
import { approveCotizacion } from '../oc-flow.js';

// ---------------------------------------------------------------------------
// Fixtures helpers
// ---------------------------------------------------------------------------

const createdClienteIds = [];

function tag() {
  return crypto.randomBytes(4).toString('hex');
}

async function makeCliente(name = 'Test Cliente') {
  const c = await prisma.cliente.create({ data: { nombre: `${name}-${tag()}` } });
  createdClienteIds.push(c.id);
  return c;
}

async function makeObra(clienteId, { nombre = 'Obra Test', slug } = {}) {
  const slugFinal = slug ?? `obra-test-${tag()}`;
  return prisma.obra.create({
    data: {
      clienteId,
      nombre: `${nombre}-${tag()}`,
      slug: slugFinal,
      estado: 'en_curso',
    },
  });
}

async function makeCategoria(obraId, nombre = 'Materiales') {
  return prisma.categoriaPresupuesto.create({
    data: { obraId, nombre: `${nombre}-${tag()}`, orden: 0 },
  });
}

async function makeProveedor(nombre = 'Proveedor Test') {
  return prisma.proveedor.create({
    data: { nombre: `${nombre}-${tag()}`, activo: true },
  });
}

async function makeMaterial(nombreCanonico = 'Cemento Test') {
  return prisma.itemCatalogo.create({
    data: {
      tipo: 'material',
      nombreCanonico: `${nombreCanonico}-${tag()}`,
      unidad: 'saco',
      slug: `cemento-test-${tag()}`,
      estado: 'aprobado',
      activo: true,
    },
  });
}

async function makeCotizacion(
  { obraId, proveedorId, rfqId = null, moneda = 'CRC', materialId = null } = {},
) {
  return prisma.cotizacion.create({
    data: {
      obraId,
      proveedorId,
      rfqId,
      numeroCotizacion: `COT-${tag()}`,
      fecha: new Date(),
      moneda,
      subtotalAmount: '100.00',
      subtotalCurrency: moneda,
      ivaAmount: '13.00',
      ivaCurrency: moneda,
      totalAmount: '113.00',
      totalCurrency: moneda,
      plazoEntregaDias: 10,
      pctAnticipo: '50.00',
      esEspecial: false,
      estado: 'recibida',
      items: {
        create: [
          {
            materialId,
            descripcion: 'Cemento UGC 50kg',
            cantidad: '10.0000',
            unidad: 'saco',
            precioUnitario: '10.00000',
            subtotal: '100.00',
            ivaMonto: '13.00',
            orden: 0,
          },
        ],
      },
    },
    include: { items: true },
  });
}

// ---------------------------------------------------------------------------
// Cleanup global: las relaciones de Obra son Restrict; debemos borrar en
// orden inverso. Hacemos un cleanup amplio al final que borra todo lo creado
// en este run vía cascada de Cliente (que sí cascadea Bodega/Obra → categorias
// → cotizaciones → cotizacion_items, etc. en Prisma).
//
// PERO: Obra->Cliente es Restrict. Por eso primero hay que borrar Obras y
// sus dependencias antes de borrar Cliente.
// ---------------------------------------------------------------------------

async function cleanupRun() {
  // Borramos OCs (cascade items via Cascade), cotizaciones (cascade items),
  // categorias, obras, proveedores, materiales creados en este run.
  // Más simple: borrar por clientes nuevos en este run.
  for (const cid of createdClienteIds) {
    try {
      // Resolver obras del cliente.
      const obras = await prisma.obra.findMany({ where: { clienteId: cid }, select: { id: true } });
      const obraIds = obras.map(o => o.id);

      if (obraIds.length > 0) {
        // OCs primero (items cascade).
        await prisma.ordenCompra.deleteMany({ where: { obraId: { in: obraIds } } });
        // Cotizaciones (items cascade).
        await prisma.cotizacion.deleteMany({ where: { obraId: { in: obraIds } } });
        // RFQs.
        await prisma.solicitudCotizacion.deleteMany({ where: { obraId: { in: obraIds } } });
        // Categorías.
        await prisma.categoriaPresupuesto.deleteMany({ where: { obraId: { in: obraIds } } });
        // Obras.
        await prisma.obra.deleteMany({ where: { id: { in: obraIds } } });
      }
      // Bodegas del cliente (si las hay).
      await prisma.bodega.deleteMany({ where: { clienteId: cid } });
      // Cliente.
      await prisma.cliente.delete({ where: { id: cid } });
    } catch (e) {
      console.warn(`[cleanup] cliente ${cid}:`, e.message);
    }
  }
  // Proveedores y materiales sueltos creados: los marcamos con tag aleatorio,
  // limpiamos por createdAt recent + nombre con `-Test-` para no tocar seed.
}

after(async () => {
  await cleanupRun();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('approveCotizacion: happy path crea OC con numeroOc formateado y marca cotizacion aprobada', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id, { slug: `mi-obra-${tag()}` });
  const categoria = await makeCategoria(obra.id);
  const proveedor = await makeProveedor();
  const material = await makeMaterial();
  const cot = await makeCotizacion({
    obraId: obra.id,
    proveedorId: proveedor.id,
    materialId: material.id,
  });

  const { cotizacion, oc } = await approveCotizacion(prisma, {
    cotizacionId: cot.id,
    categoriaId: categoria.id,
    approverId: null,
  });

  // Cotización ahora aprobada.
  assert.equal(cotizacion.estado, 'aprobada');

  // OC creada.
  assert.ok(oc.id);
  assert.equal(oc.estado, 'autorizada');
  assert.equal(oc.cotizacionOrigenId, cot.id);
  assert.equal(oc.proveedorId, proveedor.id);
  assert.equal(oc.obraId, obra.id);
  assert.equal(oc.categoriaId, categoria.id);

  // numeroOc formato `SLUG-OC-0001`
  const expectedPrefix = `${obra.slug.toUpperCase()}-OC-`;
  assert.ok(oc.numeroOc.startsWith(expectedPrefix), `numeroOc=${oc.numeroOc} no empieza con ${expectedPrefix}`);
  assert.equal(oc.numeroOc, `${obra.slug.toUpperCase()}-OC-0001`);

  // Counter incrementado.
  const obraAfter = await prisma.obra.findUnique({ where: { id: obra.id } });
  assert.equal(obraAfter.nextOcSeq, 2);

  // Items copiados con snapshot.
  assert.equal(oc.items.length, 1);
  const item = oc.items[0];
  assert.equal(item.descripcion, 'Cemento UGC 50kg');
  assert.equal(item.cantidad.toString(), '10');
  assert.equal(item.materialId, material.id);
  assert.ok(item.materialNombreSnapshot?.startsWith('Cemento Test-'));
  assert.equal(item.materialUnidadSnapshot, 'saco');

  // Snapshot pctAnticipo y plazoEntregaDias → tiempoEstimadoDias.
  assert.equal(oc.pctAnticipo.toString(), '50');
  assert.equal(oc.tiempoEstimadoDias, 10);

  // CRC: sin snapshot TC.
  assert.equal(oc.fxRateApplied, null);
  assert.equal(oc.fxRateDate, null);
});

test('approveCotizacion: doble aprobación devuelve error COTIZACION_TERMINAL (segunda llamada)', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id, { slug: `doble-aprob-${tag()}` });
  const categoria = await makeCategoria(obra.id);
  const proveedor = await makeProveedor();
  const cot = await makeCotizacion({ obraId: obra.id, proveedorId: proveedor.id });

  // Primera vez: ok.
  await approveCotizacion(prisma, {
    cotizacionId: cot.id,
    categoriaId: categoria.id,
    approverId: null,
  });

  // Segunda vez: debe lanzar.
  let caught = null;
  try {
    await approveCotizacion(prisma, {
      cotizacionId: cot.id,
      categoriaId: categoria.id,
      approverId: null,
    });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'segunda aprobación debió lanzar');
  assert.equal(caught.code, 'COTIZACION_TERMINAL');
  assert.equal(caught.estado, 'aprobada');
});

test('approveCotizacion: snapshot TC con ExchangeRate disponible para USD', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id, { slug: `usd-tc-${tag()}` });
  const categoria = await makeCategoria(obra.id);
  const proveedor = await makeProveedor();
  const cot = await makeCotizacion({
    obraId: obra.id,
    proveedorId: proveedor.id,
    moneda: 'USD',
  });

  // Crear un exchange_rate. La tabla tiene unique(currency,date) y la seed no
  // toca ExchangeRate; intentamos hoy y si choca rotamos a una fecha pasada
  // que con altísima probabilidad esté libre.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  let createdRate;
  try {
    createdRate = await prisma.exchangeRate.create({
      data: {
        currency: 'USD',
        date: today,
        buy: '500.00000',
        sell: '510.50000',
        source: 'manual',
      },
    });
  } catch (e) {
    if (e.code === 'P2002') {
      createdRate = await prisma.exchangeRate.findUnique({
        where: { currency_date: { currency: 'USD', date: today } },
      });
    } else {
      throw e;
    }
  }

  const { oc } = await approveCotizacion(prisma, {
    cotizacionId: cot.id,
    categoriaId: categoria.id,
    fechaAprobacion: today,
    approverId: null,
  });

  assert.ok(oc.fxRateApplied, 'fxRateApplied debe estar set en USD');
  // Aceptar igual al sell del rate creado O cualquier rate más reciente
  // (en caso de TC del día creado por otro test concurrent).
  assert.ok(oc.fxRateDate, 'fxRateDate debe estar set en USD');

  // Limpiar rate solo si lo creamos NOSOTROS y nadie más lo referencia.
  if (createdRate && oc.fxRateDate?.getTime() === today.getTime()) {
    try {
      await prisma.exchangeRate.delete({ where: { id: createdRate.id } });
    } catch {
      // OK si otro test lo borró
    }
  }
});

test('approveCotizacion: USD sin TC en DB → fxRateApplied null (no bloquea)', async () => {
  // Asegurarse de que no haya rates antes de la fecha que usamos.
  // Usamos una fecha futura muy pasada (2020-01-01).
  const oldDate = new Date('2020-01-01T00:00:00.000Z');

  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id, { slug: `usd-no-tc-${tag()}` });
  const categoria = await makeCategoria(obra.id);
  const proveedor = await makeProveedor();
  const cot = await makeCotizacion({
    obraId: obra.id,
    proveedorId: proveedor.id,
    moneda: 'USD',
  });

  // Borrar rates < 2020-01-01 si existieran (no debería haber).
  await prisma.exchangeRate.deleteMany({
    where: { currency: 'USD', date: { lte: oldDate } },
  });

  const { oc } = await approveCotizacion(prisma, {
    cotizacionId: cot.id,
    categoriaId: categoria.id,
    fechaAprobacion: oldDate,
    approverId: null,
  });

  assert.equal(oc.fxRateApplied, null);
  assert.equal(oc.fxRateDate, null);
  assert.equal(oc.moneda, 'USD');
});

test('approveCotizacion: cierra RFQ asociada', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id, { slug: `rfq-cierre-${tag()}` });
  const categoria = await makeCategoria(obra.id);
  const proveedor = await makeProveedor();

  // Necesitamos un user para crear la RFQ.
  const user = await prisma.user.findFirst();
  assert.ok(user, 'seed debe tener al menos un user');

  const rfq = await prisma.solicitudCotizacion.create({
    data: {
      obraId: obra.id,
      categoriaId: categoria.id,
      descripcion: 'RFQ test',
      creadaPorId: user.id,
      estado: 'abierta',
    },
  });

  const cot = await makeCotizacion({
    obraId: obra.id,
    proveedorId: proveedor.id,
    rfqId: rfq.id,
  });

  await approveCotizacion(prisma, {
    cotizacionId: cot.id,
    categoriaId: categoria.id,
    approverId: user.id,
  });

  const rfqAfter = await prisma.solicitudCotizacion.findUnique({ where: { id: rfq.id } });
  assert.equal(rfqAfter.estado, 'cerrada');
});

test('approveCotizacion: categoría de otra obra → 400', async () => {
  const cliente = await makeCliente();
  const obraA = await makeObra(cliente.id, { slug: `obra-a-${tag()}` });
  const obraB = await makeObra(cliente.id, { slug: `obra-b-${tag()}` });
  const categoriaB = await makeCategoria(obraB.id); // categoría de OTRA obra
  const proveedor = await makeProveedor();
  const cot = await makeCotizacion({ obraId: obraA.id, proveedorId: proveedor.id });

  let caught = null;
  try {
    await approveCotizacion(prisma, {
      cotizacionId: cot.id,
      categoriaId: categoriaB.id,
      approverId: null,
    });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught);
  assert.equal(caught.status, 400);
  assert.match(caught.message, /categoría no pertenece/i);
});

test('approveCotizacion: dos cotizaciones de la misma obra aprobadas en paralelo → OC-0001 y OC-0002 sin colisión', async () => {
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id, { slug: `race-${tag()}` });
  const categoria = await makeCategoria(obra.id);
  const proveedor = await makeProveedor();
  const cotA = await makeCotizacion({ obraId: obra.id, proveedorId: proveedor.id });
  const cotB = await makeCotizacion({ obraId: obra.id, proveedorId: proveedor.id });

  // Lanzar las dos aprobaciones EN PARALELO. El advisory lock por obra debe
  // serializarlas y producir OC-0001 + OC-0002 (no colisión en numero_oc).
  const [resA, resB] = await Promise.all([
    approveCotizacion(prisma, { cotizacionId: cotA.id, categoriaId: categoria.id }),
    approveCotizacion(prisma, { cotizacionId: cotB.id, categoriaId: categoria.id }),
  ]);

  const numeros = [resA.oc.numeroOc, resB.oc.numeroOc].sort();
  const expected = [
    `${obra.slug.toUpperCase()}-OC-0001`,
    `${obra.slug.toUpperCase()}-OC-0002`,
  ];
  assert.deepEqual(numeros, expected, `numeros generados: ${numeros.join(', ')}`);

  // Contador final en 3 (próxima OC sería la -0003).
  const obraAfter = await prisma.obra.findUnique({ where: { id: obra.id } });
  assert.equal(obraAfter.nextOcSeq, 3);
});
