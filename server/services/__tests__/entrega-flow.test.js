/**
 * Tests del servicio entrega-flow.
 *
 * Run: `node --test server/services/__tests__/entrega-flow.test.js`
 *
 * Estrategia: DB real (Postgres) con fixtures aleatorios. Cleanup amplio al
 * final. Sigue el mismo patrón que oc-flow.test.js.
 *
 * Cubre:
 *  - Crear entrega → items reflejados.
 *  - Entrega parcial → oc.estado = entregada_parcial (cuando OC empieza
 *    autorizada o pagada_parcial).
 *  - Entrega completa de OC pagada → estado completada.
 *  - Pendientes: cantidad pendiente = ordenada - sum(entregadas por ocItemId).
 *  - Item con ocItemId=null no afecta pendientes.
 *  - Borrar entrega completa baja OC a entregada_parcial.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import prisma from '../../db.js';
import {
  createEntrega,
  pendientesPorItem,
  isOcEntregadaCompleta,
  deleteEntrega,
} from '../entrega-flow.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const createdClienteIds = [];

function tag() {
  return crypto.randomBytes(4).toString('hex');
}

async function makeCliente() {
  const c = await prisma.cliente.create({ data: { nombre: `Cli-${tag()}` } });
  createdClienteIds.push(c.id);
  return c;
}

async function makeObra(clienteId) {
  return prisma.obra.create({
    data: {
      clienteId,
      nombre: `Obra-${tag()}`,
      slug: `obra-test-${tag()}`,
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

async function makeOc({ obraId, categoriaId, proveedorId, items, estado = 'autorizada' }) {
  return prisma.ordenCompra.create({
    data: {
      obraId,
      categoriaId,
      proveedorId,
      numeroOc: `TEST-${tag()}-OC-0001`,
      fechaAprobacion: new Date(),
      moneda: 'CRC',
      montoTotalAmount: '100.00',
      montoTotalCurrency: 'CRC',
      estado,
      items: { create: items },
    },
    include: { items: true },
  });
}

async function getOrSeedUser() {
  let user = await prisma.user.findFirst();
  if (user) return user;
  // Fallback: crear un user de test.
  user = await prisma.user.create({
    data: {
      username: `test-${tag()}`,
      passwordHash: 'x',
      role: 'operativo',
    },
  });
  return user;
}

after(async () => {
  for (const cid of createdClienteIds) {
    try {
      const obras = await prisma.obra.findMany({ where: { clienteId: cid }, select: { id: true } });
      const obraIds = obras.map((o) => o.id);
      if (obraIds.length > 0) {
        const ocs = await prisma.ordenCompra.findMany({
          where: { obraId: { in: obraIds } },
          select: { id: true },
        });
        const ocIds = ocs.map((o) => o.id);
        if (ocIds.length > 0) {
          await prisma.entrega.deleteMany({ where: { ocId: { in: ocIds } } });
        }
        await prisma.ordenCompra.deleteMany({ where: { obraId: { in: obraIds } } });
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

test('createEntrega: crea entrega + items y queda asociada a la OC', async () => {
  const user = await getOrSeedUser();
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const categoria = await makeCategoria(obra.id);
  const proveedor = await makeProveedor();
  const oc = await makeOc({
    obraId: obra.id,
    categoriaId: categoria.id,
    proveedorId: proveedor.id,
    items: [
      { descripcion: 'Cemento', cantidad: '10', unidad: 'saco', precioUnitario: '5000', subtotal: '50000', orden: 0 },
      { descripcion: 'Varilla #3', cantidad: '20', unidad: 'varilla', precioUnitario: '2500', subtotal: '50000', orden: 1 },
    ],
  });

  const { entrega } = await createEntrega(prisma, {
    ocId: oc.id,
    fecha: new Date(),
    recibidoPor: 'Tony',
    registradaPorId: user.id,
    items: [
      { ocItemId: oc.items[0].id, descripcion: 'Cemento', cantidad: 5, unidad: 'saco' },
    ],
  });

  assert.ok(entrega.id, 'entrega creada');
  assert.equal(String(entrega.ocId), String(oc.id));
  assert.equal(entrega.recibidoPor, 'Tony');
  assert.equal(entrega.items.length, 1);
  assert.equal(entrega.items[0].descripcion, 'Cemento');
  assert.equal(Number(entrega.items[0].cantidad), 5);
});

test('pendientesPorItem: cantidadPendiente = ordenada - sum(entregada por ocItemId)', async () => {
  const user = await getOrSeedUser();
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const categoria = await makeCategoria(obra.id);
  const proveedor = await makeProveedor();
  const oc = await makeOc({
    obraId: obra.id,
    categoriaId: categoria.id,
    proveedorId: proveedor.id,
    items: [
      { descripcion: 'Cemento', cantidad: '10', unidad: 'saco', precioUnitario: '5000', subtotal: '50000', orden: 0 },
      { descripcion: 'Varilla', cantidad: '20', unidad: 'varilla', precioUnitario: '2500', subtotal: '50000', orden: 1 },
    ],
  });

  // Entrega 1: 4 sacos cemento + 8 varillas.
  await createEntrega(prisma, {
    ocId: oc.id,
    fecha: new Date(),
    recibidoPor: 'Tony',
    registradaPorId: user.id,
    items: [
      { ocItemId: oc.items[0].id, descripcion: 'Cemento', cantidad: 4, unidad: 'saco' },
      { ocItemId: oc.items[1].id, descripcion: 'Varilla', cantidad: 8, unidad: 'varilla' },
    ],
  });

  let pendientes = await pendientesPorItem(prisma, oc.id);
  const cemento1 = pendientes.find((p) => p.ocItemId === Number(oc.items[0].id));
  const varilla1 = pendientes.find((p) => p.ocItemId === Number(oc.items[1].id));
  assert.equal(cemento1.cantidadOrdenada, 10);
  assert.equal(cemento1.cantidadEntregada, 4);
  assert.equal(cemento1.cantidadPendiente, 6);
  assert.equal(varilla1.cantidadEntregada, 8);
  assert.equal(varilla1.cantidadPendiente, 12);

  // Entrega 2: cierra el resto.
  await createEntrega(prisma, {
    ocId: oc.id,
    fecha: new Date(),
    recibidoPor: 'Adrian',
    registradaPorId: user.id,
    items: [
      { ocItemId: oc.items[0].id, descripcion: 'Cemento', cantidad: 6, unidad: 'saco' },
      { ocItemId: oc.items[1].id, descripcion: 'Varilla', cantidad: 12, unidad: 'varilla' },
    ],
  });

  pendientes = await pendientesPorItem(prisma, oc.id);
  for (const p of pendientes) {
    assert.equal(p.cantidadPendiente, 0, `${p.descripcion} debe estar al día`);
  }
  assert.equal(await isOcEntregadaCompleta(prisma, oc.id), true);
});

test('createEntrega parcial: OC pasa de autorizada → entregada_parcial', async () => {
  const user = await getOrSeedUser();
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const categoria = await makeCategoria(obra.id);
  const proveedor = await makeProveedor();
  const oc = await makeOc({
    obraId: obra.id,
    categoriaId: categoria.id,
    proveedorId: proveedor.id,
    estado: 'autorizada',
    items: [
      { descripcion: 'Cemento', cantidad: '10', unidad: 'saco', precioUnitario: '5000', subtotal: '50000', orden: 0 },
    ],
  });

  const { oc: updated } = await createEntrega(prisma, {
    ocId: oc.id,
    fecha: new Date(),
    recibidoPor: 'Tony',
    registradaPorId: user.id,
    items: [
      { ocItemId: oc.items[0].id, descripcion: 'Cemento', cantidad: 3, unidad: 'saco' },
    ],
  });

  assert.equal(updated.estado, 'entregada_parcial');
});

test('createEntrega que completa la OC pagada → estado completada', async () => {
  const user = await getOrSeedUser();
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const categoria = await makeCategoria(obra.id);
  const proveedor = await makeProveedor();
  const oc = await makeOc({
    obraId: obra.id,
    categoriaId: categoria.id,
    proveedorId: proveedor.id,
    estado: 'pagada',
    items: [
      { descripcion: 'Cemento', cantidad: '5', unidad: 'saco', precioUnitario: '5000', subtotal: '25000', orden: 0 },
    ],
  });

  const { oc: updated, entrega } = await createEntrega(prisma, {
    ocId: oc.id,
    fecha: new Date(),
    recibidoPor: 'Tony',
    registradaPorId: user.id,
    items: [
      { ocItemId: oc.items[0].id, descripcion: 'Cemento', cantidad: 5, unidad: 'saco' },
    ],
  });

  assert.equal(updated.estado, 'completada');
  assert.equal(entrega.completa, true);
});

test('Item con ocItemId=null (extra) NO afecta el cálculo de pendientes', async () => {
  const user = await getOrSeedUser();
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const categoria = await makeCategoria(obra.id);
  const proveedor = await makeProveedor();
  const oc = await makeOc({
    obraId: obra.id,
    categoriaId: categoria.id,
    proveedorId: proveedor.id,
    items: [
      { descripcion: 'Cemento', cantidad: '10', unidad: 'saco', precioUnitario: '5000', subtotal: '50000', orden: 0 },
    ],
  });

  await createEntrega(prisma, {
    ocId: oc.id,
    fecha: new Date(),
    recibidoPor: 'Tony',
    registradaPorId: user.id,
    items: [
      // Item extra que no estaba en la OC.
      { ocItemId: null, descripcion: 'Clavos', cantidad: 100, unidad: 'unidad' },
    ],
  });

  const pendientes = await pendientesPorItem(prisma, oc.id);
  assert.equal(pendientes.length, 1);
  assert.equal(pendientes[0].cantidadEntregada, 0, 'extras no cuentan');
  assert.equal(pendientes[0].cantidadPendiente, 10);
});

test('deleteEntrega: borrar entrega completa baja OC a entregada_parcial', async () => {
  const user = await getOrSeedUser();
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const categoria = await makeCategoria(obra.id);
  const proveedor = await makeProveedor();
  const oc = await makeOc({
    obraId: obra.id,
    categoriaId: categoria.id,
    proveedorId: proveedor.id,
    estado: 'pagada',
    items: [
      { descripcion: 'Cemento', cantidad: '5', unidad: 'saco', precioUnitario: '5000', subtotal: '25000', orden: 0 },
    ],
  });

  // 1ª entrega parcial.
  const { entrega: e1 } = await createEntrega(prisma, {
    ocId: oc.id,
    fecha: new Date(),
    recibidoPor: 'Tony',
    registradaPorId: user.id,
    items: [{ ocItemId: oc.items[0].id, descripcion: 'Cemento', cantidad: 2, unidad: 'saco' }],
  });

  // 2ª entrega que completa.
  const { oc: ocCompleta, entrega: e2 } = await createEntrega(prisma, {
    ocId: oc.id,
    fecha: new Date(),
    recibidoPor: 'Tony',
    registradaPorId: user.id,
    items: [{ ocItemId: oc.items[0].id, descripcion: 'Cemento', cantidad: 3, unidad: 'saco' }],
  });
  assert.equal(ocCompleta.estado, 'completada');

  // Borrar la segunda entrega: vuelve a entregada_parcial (porque queda e1).
  const res = await deleteEntrega(prisma, e2.id);
  assert.equal(res.prevEstado, 'completada');
  assert.equal(res.nextEstado, 'entregada_parcial');

  // Verificar en DB.
  const ocAfter = await prisma.ordenCompra.findUnique({ where: { id: oc.id } });
  assert.equal(ocAfter.estado, 'entregada_parcial');

  // Borrar también la primera: sin entregas, baja a autorizada.
  const res2 = await deleteEntrega(prisma, e1.id);
  assert.equal(res2.nextEstado, 'autorizada');
});

test('createEntrega: ocItemId que pertenece a otra OC → 400', async () => {
  const user = await getOrSeedUser();
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const categoria = await makeCategoria(obra.id);
  const proveedor = await makeProveedor();

  const ocA = await makeOc({
    obraId: obra.id,
    categoriaId: categoria.id,
    proveedorId: proveedor.id,
    items: [
      { descripcion: 'Cemento A', cantidad: '5', unidad: 'saco', precioUnitario: '5000', subtotal: '25000', orden: 0 },
    ],
  });
  const ocB = await makeOc({
    obraId: obra.id,
    categoriaId: categoria.id,
    proveedorId: proveedor.id,
    items: [
      { descripcion: 'Cemento B', cantidad: '5', unidad: 'saco', precioUnitario: '5000', subtotal: '25000', orden: 0 },
    ],
  });

  let caught = null;
  try {
    await createEntrega(prisma, {
      ocId: ocA.id,
      fecha: new Date(),
      recibidoPor: 'Tony',
      registradaPorId: user.id,
      // ocItemId pertenece a la OC B.
      items: [{ ocItemId: ocB.items[0].id, descripcion: 'X', cantidad: 1, unidad: 'saco' }],
    });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'debe rechazar');
  assert.equal(caught.status, 400);
});

test('createEntrega rechaza OC cancelada', async () => {
  const user = await getOrSeedUser();
  const cliente = await makeCliente();
  const obra = await makeObra(cliente.id);
  const categoria = await makeCategoria(obra.id);
  const proveedor = await makeProveedor();
  const oc = await makeOc({
    obraId: obra.id,
    categoriaId: categoria.id,
    proveedorId: proveedor.id,
    estado: 'cancelada',
    items: [
      { descripcion: 'Cemento', cantidad: '5', unidad: 'saco', precioUnitario: '5000', subtotal: '25000', orden: 0 },
    ],
  });

  let caught = null;
  try {
    await createEntrega(prisma, {
      ocId: oc.id,
      fecha: new Date(),
      recibidoPor: 'Tony',
      registradaPorId: user.id,
      items: [{ ocItemId: oc.items[0].id, descripcion: 'X', cantidad: 1, unidad: 'saco' }],
    });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught);
  assert.equal(caught.status, 409);
});
