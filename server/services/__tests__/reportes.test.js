/**
 * Tests del servicio `reportes`.
 *
 * Estrategia: stubs en memoria (no DB real). Cada helper recibe un objeto
 * "prisma" stub que implementa solo los métodos que el helper toca.
 *
 * Run: `node --test server/services/__tests__/reportes.test.js`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  reporteProveedor,
  reporteReconciliacionObra,
  reporteTipoCambio,
  serializeToCSV,
} from '../reportes.js';

// ---------------------------------------------------------------------------
// Stub factory para prisma en memoria
// ---------------------------------------------------------------------------

function makePrismaStub({
  proveedores = [],
  obras = [],
  ocs = [],
  pagos = [],
  ocItems = [],
  entregaItems = [],
  exchangeRates = [],
} = {}) {
  return {
    proveedor: {
      findUnique: async ({ where }) =>
        proveedores.find((p) => String(p.id) === String(where.id)) ?? null,
    },
    obra: {
      findUnique: async ({ where }) =>
        obras.find((o) => String(o.id) === String(where.id)) ?? null,
    },
    ordenCompra: {
      findMany: async ({ where, include }) => {
        let rows = ocs.slice();
        if (where?.proveedorId != null) {
          rows = rows.filter((o) => String(o.proveedorId) === String(where.proveedorId));
        }
        if (where?.obraId != null) {
          rows = rows.filter((o) => String(o.obraId) === String(where.obraId));
        }
        if (where?.estado?.not != null) {
          rows = rows.filter((o) => o.estado !== where.estado.not);
        }
        if (where?.fechaAprobacion) {
          if (where.fechaAprobacion.gte) {
            rows = rows.filter((o) => o.fechaAprobacion >= where.fechaAprobacion.gte);
          }
          if (where.fechaAprobacion.lte) {
            rows = rows.filter((o) => o.fechaAprobacion <= where.fechaAprobacion.lte);
          }
        }
        if (include?.items) {
          rows = rows.map((o) => ({
            ...o,
            items: ocItems
              .filter((it) => String(it.ocId) === String(o.id))
              .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0))
              .map((it) => ({
                ...it,
                material: include.items.include?.material
                  ? it.material ?? null
                  : undefined,
              })),
          }));
        }
        return rows;
      },
    },
    pago: {
      findMany: async ({ where }) => {
        let rows = pagos.slice();
        if (where?.ocId?.in) {
          const allowed = new Set(where.ocId.in.map(String));
          rows = rows.filter((p) => allowed.has(String(p.ocId)));
        }
        if (where?.fechaRealizada?.not !== undefined) {
          rows = rows.filter((p) => p.fechaRealizada != null);
        }
        if (where?.fechaRealizada?.gte) {
          rows = rows.filter((p) => p.fechaRealizada >= where.fechaRealizada.gte);
        }
        if (where?.fechaRealizada?.lte) {
          rows = rows.filter((p) => p.fechaRealizada <= where.fechaRealizada.lte);
        }
        return rows;
      },
    },
    entregaItem: {
      groupBy: async ({ where }) => {
        const allowed = where?.ocItemId?.in
          ? new Set(where.ocItemId.in.map(String))
          : null;
        const groups = new Map();
        for (const ei of entregaItems) {
          if (allowed && !allowed.has(String(ei.ocItemId))) continue;
          const key = String(ei.ocItemId);
          const prev = groups.get(key) ?? 0;
          groups.set(key, prev + Number(ei.cantidad));
        }
        return Array.from(groups.entries()).map(([k, v]) => ({
          ocItemId: BigInt(k),
          _sum: { cantidad: v },
        }));
      },
    },
    exchangeRate: {
      findMany: async ({ where, orderBy }) => {
        let rows = exchangeRates.slice();
        if (where?.currency) rows = rows.filter((r) => r.currency === where.currency);
        if (where?.date?.gte) rows = rows.filter((r) => r.date >= where.date.gte);
        if (where?.date?.lte) rows = rows.filter((r) => r.date <= where.date.lte);
        if (orderBy?.date === 'asc') rows.sort((a, b) => a.date - b.date);
        if (orderBy?.date === 'desc') rows.sort((a, b) => b.date - a.date);
        return rows;
      },
      findFirst: async ({ where, orderBy }) => {
        let rows = exchangeRates.slice();
        if (where?.currency) rows = rows.filter((r) => r.currency === where.currency);
        if (where?.date?.lte) rows = rows.filter((r) => r.date <= where.date.lte);
        if (orderBy?.date === 'desc') rows.sort((a, b) => b.date - a.date);
        return rows[0] ?? null;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// reporteProveedor
// ---------------------------------------------------------------------------

test('reporteProveedor: agrega OCs y pagos realizados', async () => {
  const prismaStub = makePrismaStub({
    proveedores: [{ id: 1n, nombre: 'Prov A', identificacion: '3-101-12345' }],
    ocs: [
      {
        id: 10n,
        proveedorId: 1n,
        numeroOc: 'OBRA-OC-0001',
        fechaAprobacion: new Date('2026-04-10'),
        montoTotalAmount: '1000',
        montoTotalCurrency: 'CRC',
        estado: 'autorizada',
      },
      {
        id: 11n,
        proveedorId: 1n,
        numeroOc: 'OBRA-OC-0002',
        fechaAprobacion: new Date('2026-04-15'),
        montoTotalAmount: '500',
        montoTotalCurrency: 'CRC',
        estado: 'pagada',
      },
    ],
    pagos: [
      { id: 100n, ocId: 10n, montoAmount: '400', montoCurrency: 'CRC', fechaRealizada: new Date('2026-04-12') },
      { id: 101n, ocId: 11n, montoAmount: '500', montoCurrency: 'CRC', fechaRealizada: new Date('2026-04-16') },
      // Pago no realizado: no debe contar.
      { id: 102n, ocId: 10n, montoAmount: '100', montoCurrency: 'CRC', fechaRealizada: null },
    ],
  });

  const r = await reporteProveedor(prismaStub, { proveedorId: 1n });
  assert.equal(r.proveedor.id, 1);
  assert.equal(r.ocs.length, 2);
  assert.equal(r.totales.ocsCount, 2);
  assert.equal(r.totales.porMoneda.CRC.montoOcs, '1500.00');
  assert.equal(r.totales.porMoneda.CRC.montoPagado, '900.00');
  const oc1 = r.ocs.find((o) => o.numeroOc === 'OBRA-OC-0001');
  assert.equal(oc1.totalPagado.amount, '400.00');
  assert.equal(oc1.totalEntregado.amount, '0'); // TODO
});

test('reporteProveedor: filtra pagos por rango fechaRealizada', async () => {
  const prismaStub = makePrismaStub({
    proveedores: [{ id: 1n, nombre: 'Prov A' }],
    ocs: [
      {
        id: 10n,
        proveedorId: 1n,
        numeroOc: 'OC-1',
        fechaAprobacion: new Date('2026-03-01'),
        montoTotalAmount: '2000',
        montoTotalCurrency: 'CRC',
        estado: 'autorizada',
      },
    ],
    pagos: [
      { id: 1n, ocId: 10n, montoAmount: '300', montoCurrency: 'CRC', fechaRealizada: new Date('2026-04-05') },
      { id: 2n, ocId: 10n, montoAmount: '400', montoCurrency: 'CRC', fechaRealizada: new Date('2026-04-20') },
      { id: 3n, ocId: 10n, montoAmount: '500', montoCurrency: 'CRC', fechaRealizada: new Date('2026-05-01') },
    ],
  });

  const r = await reporteProveedor(prismaStub, {
    proveedorId: 1n,
    desde: '2026-04-01',
    hasta: '2026-04-30',
  });
  // Pago de mayo queda fuera.
  assert.equal(r.totales.porMoneda.CRC.montoPagado, '700.00');
});

test('reporteProveedor: sin pagos → totales en 0', async () => {
  const prismaStub = makePrismaStub({
    proveedores: [{ id: 7n, nombre: 'Prov Vacío' }],
    ocs: [
      {
        id: 30n,
        proveedorId: 7n,
        numeroOc: 'OC-X',
        fechaAprobacion: new Date('2026-01-01'),
        montoTotalAmount: '999',
        montoTotalCurrency: 'CRC',
        estado: 'autorizada',
      },
    ],
    pagos: [],
  });
  const r = await reporteProveedor(prismaStub, { proveedorId: 7n });
  assert.equal(r.totales.porMoneda.CRC.montoPagado, '0.00');
  assert.equal(r.ocs[0].totalPagado.amount, '0.00');
});

test('reporteProveedor: 404 si proveedor no existe', async () => {
  const prismaStub = makePrismaStub({ proveedores: [] });
  await assert.rejects(
    () => reporteProveedor(prismaStub, { proveedorId: 999n }),
    (e) => e.status === 404,
  );
});

// ---------------------------------------------------------------------------
// reporteReconciliacionObra
// ---------------------------------------------------------------------------

test('reporteReconciliacionObra: comprado vs entregado en moneda obra', async () => {
  const prismaStub = makePrismaStub({
    obras: [{ id: 50n, nombre: 'Obra X', slug: 'obra-x', monedaReporte: 'CRC' }],
    ocs: [
      {
        id: 500n,
        obraId: 50n,
        proveedorId: 1n,
        numeroOc: 'OC-1',
        fechaAprobacion: new Date('2026-04-01'),
        montoTotalAmount: '6000',
        montoTotalCurrency: 'CRC',
        estado: 'autorizada',
      },
    ],
    ocItems: [
      {
        id: 5000n,
        ocId: 500n,
        cantidad: 10,
        unidad: 'unidad',
        precioUnitario: 100, // 10 × 100 = 1000 comprado
        material: { id: 9001n, nombreCanonico: 'Cemento', unidad: 'saco' },
        orden: 0,
      },
      {
        id: 5001n,
        ocId: 500n,
        cantidad: 5,
        unidad: 'unidad',
        precioUnitario: 1000, // 5 × 1000 = 5000 comprado
        material: { id: 9002n, nombreCanonico: 'Varilla', unidad: 'varilla' },
        orden: 1,
      },
    ],
    entregaItems: [
      { ocItemId: 5000n, cantidad: 4 },  // 4 × 100 = 400 entregado
      { ocItemId: 5001n, cantidad: 5 },  // 5 × 1000 = 5000 entregado (completo)
    ],
  });

  const r = await reporteReconciliacionObra(prismaStub, { obraId: 50n });
  assert.equal(r.obra.id, 50);
  assert.equal(r.items.length, 2);
  const cemento = r.items.find((i) => i.material.nombre === 'Cemento');
  assert.equal(cemento.comprado.cantidad, 10);
  assert.equal(cemento.entregado.cantidad, 4);
  assert.equal(cemento.pendiente.cantidad, 6);
  assert.equal(cemento.comprado.monto.amount, '1000.00');
  assert.equal(cemento.entregado.monto.amount, '400.00');
  assert.equal(cemento.pendiente.monto.amount, '600.00');
  assert.equal(r.totales.compradoMonto.amount, '6000.00');
  assert.equal(r.totales.entregadoMonto.amount, '5400.00');
  assert.equal(r.totales.pendienteMonto.amount, '600.00');
  assert.equal(r.warnings.length, 0);
});

test('reporteReconciliacionObra: OC USD convertida a CRC vía TC histórico', async () => {
  const prismaStub = makePrismaStub({
    obras: [{ id: 51n, nombre: 'Obra USD', slug: 'obra-usd', monedaReporte: 'CRC' }],
    ocs: [
      {
        id: 600n,
        obraId: 51n,
        proveedorId: 1n,
        numeroOc: 'OC-USD-1',
        fechaAprobacion: new Date('2026-04-10'),
        montoTotalAmount: '200',
        montoTotalCurrency: 'USD',
        estado: 'autorizada',
      },
    ],
    ocItems: [
      {
        id: 6000n,
        ocId: 600n,
        cantidad: 2,
        unidad: 'unidad',
        precioUnitario: 100,
        material: { id: 9100n, nombreCanonico: 'Bomba', unidad: 'unidad' },
        orden: 0,
      },
    ],
    entregaItems: [{ ocItemId: 6000n, cantidad: 1 }],
    exchangeRates: [
      { currency: 'USD', date: new Date('2026-04-09'), buy: '510', sell: '520' },
    ],
  });

  const r = await reporteReconciliacionObra(prismaStub, { obraId: 51n });
  // Comprado USD 200 × sell 520 = CRC 104,000
  assert.equal(r.items[0].comprado.monto.amount, '104000.00');
  // Entregado USD 100 × 520 = 52,000
  assert.equal(r.items[0].entregado.monto.amount, '52000.00');
  assert.equal(r.totales.pendienteMonto.amount, '52000.00');
  assert.equal(r.warnings.length, 0);
});

test('reporteReconciliacionObra: OC USD sin TC histórico → warning + monto 0', async () => {
  const prismaStub = makePrismaStub({
    obras: [{ id: 52n, nombre: 'Obra USD2', slug: 'obra-usd2', monedaReporte: 'CRC' }],
    ocs: [
      {
        id: 700n,
        obraId: 52n,
        proveedorId: 1n,
        numeroOc: 'OC-USD-2',
        fechaAprobacion: new Date('2026-04-10'),
        montoTotalAmount: '100',
        montoTotalCurrency: 'USD',
        estado: 'autorizada',
      },
    ],
    ocItems: [
      {
        id: 7000n,
        ocId: 700n,
        cantidad: 1,
        unidad: 'unidad',
        precioUnitario: 100,
        material: { id: 9200n, nombreCanonico: 'Cable', unidad: 'm' },
        orden: 0,
      },
    ],
    entregaItems: [],
    exchangeRates: [],
  });

  const r = await reporteReconciliacionObra(prismaStub, { obraId: 52n });
  // Sin TC → monto convertido queda en 0, pero cantidades sí se cuentan.
  assert.equal(r.items[0].comprado.cantidad, 1);
  assert.equal(r.items[0].comprado.monto.amount, '0.00');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0].message, /Sin TC histórico/);
});

test('reporteReconciliacionObra: obra sin OCs → arrays vacíos', async () => {
  const prismaStub = makePrismaStub({
    obras: [{ id: 70n, nombre: 'Obra fresca', slug: 'obra-fresca', monedaReporte: 'USD' }],
    ocs: [],
  });
  const r = await reporteReconciliacionObra(prismaStub, { obraId: 70n });
  assert.equal(r.items.length, 0);
  assert.equal(r.totales.compradoMonto.amount, '0.00');
  assert.equal(r.totales.compradoMonto.currency, 'USD');
});

test('reporteReconciliacionObra: 404 si obra no existe', async () => {
  const prismaStub = makePrismaStub({ obras: [] });
  await assert.rejects(
    () => reporteReconciliacionObra(prismaStub, { obraId: 9999n }),
    (e) => e.status === 404,
  );
});

// ---------------------------------------------------------------------------
// reporteTipoCambio
// ---------------------------------------------------------------------------

test('reporteTipoCambio: serie ascending con rango explícito', async () => {
  const prismaStub = makePrismaStub({
    exchangeRates: [
      { currency: 'USD', date: new Date('2026-04-03'), buy: '510', sell: '520', source: 'bccr' },
      { currency: 'USD', date: new Date('2026-04-01'), buy: '511', sell: '521', source: 'bccr' },
      { currency: 'USD', date: new Date('2026-04-02'), buy: '512', sell: '522', source: 'manual' },
      { currency: 'USD', date: new Date('2025-12-31'), buy: '500', sell: '510', source: 'bccr' },
    ],
  });
  const r = await reporteTipoCambio(prismaStub, {
    desde: '2026-04-01',
    hasta: '2026-04-30',
    currency: 'USD',
  });
  assert.equal(r.length, 3);
  assert.deepEqual(
    r.map((x) => x.date),
    ['2026-04-01', '2026-04-02', '2026-04-03'],
  );
});

test('reporteTipoCambio: sin rates → array vacío (no rompe)', async () => {
  const prismaStub = makePrismaStub({ exchangeRates: [] });
  const r = await reporteTipoCambio(prismaStub, {});
  assert.deepEqual(r, []);
});

// ---------------------------------------------------------------------------
// serializeToCSV
// ---------------------------------------------------------------------------

test('serializeToCSV: headers + rows básicos', () => {
  const csv = serializeToCSV(
    [
      { a: 'foo', b: 1 },
      { a: 'bar', b: 2 },
    ],
    [
      { key: 'a', header: 'A' },
      { key: 'b', header: 'B' },
    ],
  );
  // Quitamos el BOM para comparar.
  const noBom = csv.replace(/^﻿/, '');
  assert.equal(noBom, 'A,B\r\nfoo,1\r\nbar,2');
});

test('serializeToCSV: escapa comas, comillas, newlines', () => {
  const csv = serializeToCSV(
    [
      { texto: 'hello, world' },
      { texto: 'she said "hi"' },
      { texto: 'line1\nline2' },
    ],
    [{ key: 'texto', header: 'Texto' }],
  );
  const noBom = csv.replace(/^﻿/, '');
  assert.equal(
    noBom,
    'Texto\r\n"hello, world"\r\n"she said ""hi"""\r\n"line1\nline2"',
  );
});

test('serializeToCSV: maneja null, undefined, BigInt y money objects', () => {
  const csv = serializeToCSV(
    [
      {
        n: null,
        u: undefined,
        big: 123456789012345678901234567890n,
        money: { amount: '12345.67', currency: 'CRC' },
      },
    ],
    [
      { key: 'n', header: 'N' },
      { key: 'u', header: 'U' },
      { key: 'big', header: 'BIG' },
      { key: 'money', header: 'M' },
    ],
  );
  const noBom = csv.replace(/^﻿/, '');
  // BigInt está intacto (sin notación científica), money serializa como
  // "amount currency".
  assert.match(noBom, /N,U,BIG,M\r\n,,123456789012345678901234567890,12345\.67 CRC/);
});

test('serializeToCSV: BOM UTF-8 al principio', () => {
  const csv = serializeToCSV([], [{ key: 'a', header: 'A' }]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
});

test('serializeToCSV: throw si columnDefs vacío', () => {
  assert.throws(() => serializeToCSV([], []), /columnDefs requeridos/);
});
