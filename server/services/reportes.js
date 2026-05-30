/**
 * [reportes] Helpers puros para agregar datos transversales (sin Express).
 *
 * Cada helper recibe el prisma client + filtros y devuelve un objeto JSON-safe
 * con BigInts ya normalizados a Number y Decimals ya convertidos a strings. La
 * idea es que los controllers HTTP simplemente serialicen el resultado a JSON
 * (o lo pasen a `serializeToCSV` para exports CSV).
 *
 * Helpers:
 *  - reporteProveedor: estado de cuenta de un proveedor (OCs + pagado por OC).
 *  - reporteReconciliacionObra: comprado-vs-entregado por material, en la
 *    moneda de reporte de la obra (convirtiendo con `convert()` cuando hay
 *    OCs en moneda distinta y TC histórico disponible).
 *  - reporteTipoCambio: serie temporal de tipos de cambio en un rango.
 *  - serializeToCSV: utilitario genérico para exportar arrays a CSV con BOM
 *    UTF-8 (para que Excel respete acentos).
 *
 * Convenciones:
 *  - "Money" siempre se devuelve como `{amount: string, currency: 'CRC'|'USD'}`
 *    (mismo wire format que el resto del backend).
 *  - Conversiones FX usan `convert()` del service `finance` con la fecha de
 *    aprobación de la OC para reproducir el snapshot histórico.
 *  - Si una OC no puede ser convertida (no hay TC histórico para esa fecha)
 *    la omitimos del agregado en moneda de obra y agregamos un warning.
 */

import { convert, NoExchangeRateError } from './finance.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function decToString(d) {
  if (d == null) return '0';
  if (typeof d === 'string') return d;
  if (typeof d === 'number') return d.toFixed(2);
  if (typeof d.toFixed === 'function') return d.toFixed(2);
  return String(d);
}

function decToNumber(d) {
  if (d == null) return 0;
  if (typeof d === 'number') return d;
  const n = Number(String(d));
  return Number.isFinite(n) ? n : 0;
}

function ymd(d) {
  if (d == null) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return null;
}

function parseDateOrNull(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(d.getTime())) {
    const err = new Error(`fecha inválida: ${value}`);
    err.status = 400;
    throw err;
  }
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function toBigIntOrThrow(value, label) {
  if (value == null) {
    const err = new Error(`${label} requerido`);
    err.status = 400;
    throw err;
  }
  try {
    return typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    const err = new Error(`${label} inválido: ${value}`);
    err.status = 400;
    throw err;
  }
}

function money(amount, currency) {
  return { amount: decToString(amount), currency };
}

// ---------------------------------------------------------------------------
// reporteProveedor
// ---------------------------------------------------------------------------

/**
 * Estado de cuenta de un proveedor: OCs + pagado por OC + entregado (TODO).
 *
 * Pagos: sumamos pagos con `fechaRealizada IS NOT NULL` por OC. Si vienen
 * `desde`/`hasta`, filtramos pagos por `fechaRealizada` en ese rango.
 *
 * Entregado: dejamos `montoEntregado=0` con TODO. El cálculo correcto requiere
 * normalizar EntregaItem.cantidad × ocItem.precioUnitario por OC y convertir
 * a una moneda común — postpuesto para v2.1.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{proveedorId: bigint|number|string, desde?: string|Date, hasta?: string|Date}} opts
 */
export async function reporteProveedor(prisma, { proveedorId, desde, hasta } = {}) {
  const provId = toBigIntOrThrow(proveedorId, 'proveedorId');
  const desdeDate = parseDateOrNull(desde);
  const hastaDate = parseDateOrNull(hasta);

  const proveedor = await prisma.proveedor.findUnique({ where: { id: provId } });
  if (!proveedor) {
    const err = new Error('Proveedor no encontrado');
    err.status = 404;
    throw err;
  }

  // OCs del proveedor (todas — el rango filtra PAGOS por `fechaRealizada`,
  // no OCs por `fechaAprobacion`, para mostrar el estado de cuenta de un
  // período aunque las OCs sean previas).
  const ocs = await prisma.ordenCompra.findMany({
    where: { proveedorId: provId },
    orderBy: { fechaAprobacion: 'desc' },
  });

  const ocIds = ocs.map((o) => o.id);

  // Pagos realizados agrupados por OC.
  const pagosWhere = {
    ocId: { in: ocIds.length ? ocIds : [BigInt(-1)] },
    fechaRealizada: { not: null },
  };
  if (desdeDate || hastaDate) {
    pagosWhere.fechaRealizada = { not: null };
    if (desdeDate) pagosWhere.fechaRealizada.gte = desdeDate;
    if (hastaDate) pagosWhere.fechaRealizada.lte = hastaDate;
  }

  const pagos = ocIds.length
    ? await prisma.pago.findMany({ where: pagosWhere })
    : [];

  // Agrupamos pagos por OC. NO convertimos entre monedas aquí: si una OC en
  // USD recibió un pago en CRC, lo dejamos asentado en su moneda original
  // (el detalle por moneda es responsabilidad del UI; este reporte se
  // concentra en la moneda de la OC y suma pagos en esa misma moneda).
  const pagadoPorOc = new Map();
  for (const p of pagos) {
    const key = String(p.ocId);
    const prev = pagadoPorOc.get(key) ?? 0;
    pagadoPorOc.set(key, prev + decToNumber(p.montoAmount));
  }

  // Totales por moneda (las OCs pueden ser CRC o USD). No convertimos: el
  // consumidor del reporte verá montos en sus monedas nativas con un breakdown
  // claro.
  const totalesPorMoneda = { CRC: { ocs: 0, pagado: 0 }, USD: { ocs: 0, pagado: 0 } };

  const ocsOut = ocs.map((oc) => {
    const totalPagadoNum = pagadoPorOc.get(String(oc.id)) ?? 0;
    const montoOcNum = decToNumber(oc.montoTotalAmount);
    const cur = oc.montoTotalCurrency;
    if (totalesPorMoneda[cur]) {
      totalesPorMoneda[cur].ocs += montoOcNum;
      totalesPorMoneda[cur].pagado += totalPagadoNum;
    }
    return {
      id: Number(oc.id),
      numeroOc: oc.numeroOc,
      fechaAprobacion: ymd(oc.fechaAprobacion),
      monto: money(oc.montoTotalAmount, oc.montoTotalCurrency),
      totalPagado: money(totalPagadoNum.toFixed(2), oc.montoTotalCurrency),
      // TODO entregado: requiere sumar EntregaItem.cantidad × ocItem.precioUnitario
      //  por OC (en moneda de la OC). Postpuesto.
      totalEntregado: money('0', oc.montoTotalCurrency),
      estado: oc.estado,
    };
  });

  return {
    proveedor: {
      id: Number(proveedor.id),
      nombre: proveedor.nombre,
      identificacion: proveedor.identificacion,
    },
    rango: {
      desde: desdeDate ? ymd(desdeDate) : null,
      hasta: hastaDate ? ymd(hastaDate) : null,
    },
    ocs: ocsOut,
    totales: {
      ocsCount: ocs.length,
      // Mantenemos los totales agrupados por moneda; quien consume decide.
      porMoneda: {
        CRC: {
          montoOcs: totalesPorMoneda.CRC.ocs.toFixed(2),
          montoPagado: totalesPorMoneda.CRC.pagado.toFixed(2),
        },
        USD: {
          montoOcs: totalesPorMoneda.USD.ocs.toFixed(2),
          montoPagado: totalesPorMoneda.USD.pagado.toFixed(2),
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// reporteReconciliacionObra
// ---------------------------------------------------------------------------

/**
 * Reconciliación comprado-vs-entregado por material de una obra.
 *
 * Para cada `ItemCatalogo` referenciado en OCs no canceladas de la obra,
 * agregamos:
 *  - comprado: sum(ocItem.cantidad × ocItem.precioUnitario) convertido a
 *    `obra.monedaReporte` con `convert()` usando `oc.fechaAprobacion`. Si una
 *    OC no tiene TC histórico, se omite del agregado y se agrega warning.
 *  - entregado: sum(entregaItem.cantidad × ocItem.precioUnitario), misma
 *    conversión (FX snapshot de la OC origen).
 *  - pendiente: diferencia en cantidad y monto.
 *
 * Items con `materialId=null` (ad-hoc / extras sin catálogo) se agrupan bajo
 * un material sintético "Sin catálogo" — útil para detectar gaps.
 */
export async function reporteReconciliacionObra(prisma, { obraId } = {}) {
  const obraIdBig = toBigIntOrThrow(obraId, 'obraId');

  const obra = await prisma.obra.findUnique({ where: { id: obraIdBig } });
  if (!obra) {
    const err = new Error('Obra no encontrada');
    err.status = 404;
    throw err;
  }

  const targetCurrency = obra.monedaReporte;

  // OCs no canceladas de la obra.
  const ocs = await prisma.ordenCompra.findMany({
    where: { obraId: obraIdBig, estado: { not: 'cancelada' } },
    include: {
      items: { include: { material: true }, orderBy: { orden: 'asc' } },
    },
  });

  if (ocs.length === 0) {
    return {
      obra: { id: Number(obra.id), nombre: obra.nombre, slug: obra.slug, monedaReporte: targetCurrency },
      items: [],
      totales: {
        compradoMonto: { amount: '0.00', currency: targetCurrency },
        entregadoMonto: { amount: '0.00', currency: targetCurrency },
        pendienteMonto: { amount: '0.00', currency: targetCurrency },
      },
      warnings: [],
    };
  }

  // Sumar entregas por ocItemId (todas las entregas de esas OCs).
  const ocItemIds = ocs.flatMap((oc) => oc.items.map((it) => it.id));
  const entregaGroups = ocItemIds.length
    ? await prisma.entregaItem.groupBy({
        by: ['ocItemId'],
        where: { ocItemId: { in: ocItemIds } },
        _sum: { cantidad: true },
      })
    : [];

  const entregadoPorOcItem = new Map();
  for (const g of entregaGroups) {
    if (g.ocItemId == null) continue;
    entregadoPorOcItem.set(String(g.ocItemId), decToNumber(g._sum?.cantidad));
  }

  // Pre-calcular factor de conversión por OC (cacheado por ocId) para no
  // pegarle a la DB N veces.
  const fxFactorPorOc = new Map(); // ocId(string) → number | null (null = sin TC).
  const warnings = [];
  for (const oc of ocs) {
    const ocCurrency = oc.montoTotalCurrency;
    if (ocCurrency === targetCurrency) {
      fxFactorPorOc.set(String(oc.id), 1);
      continue;
    }
    try {
      const conv = await convert(
        { amount: 1, currency: ocCurrency },
        targetCurrency,
        oc.fechaAprobacion,
        prisma,
      );
      const factor = Number(conv.amount);
      fxFactorPorOc.set(String(oc.id), Number.isFinite(factor) ? factor : null);
    } catch (e) {
      if (e instanceof NoExchangeRateError) {
        fxFactorPorOc.set(String(oc.id), null);
        warnings.push({
          ocId: Number(oc.id),
          numeroOc: oc.numeroOc,
          message: `Sin TC histórico para ${ymd(oc.fechaAprobacion)}; OC omitida del agregado.`,
        });
      } else {
        throw e;
      }
    }
  }

  // Agrupar por material. Key = String(materialId) || 'null' (sintético).
  const byMaterial = new Map();
  function ensureBucket(material) {
    const key = material ? String(material.id) : 'null';
    let b = byMaterial.get(key);
    if (!b) {
      b = {
        materialId: material ? Number(material.id) : null,
        materialNombre: material ? material.nombreCanonico : 'Sin catálogo',
        unidad: material ? material.unidad : null,
        compradoCantidad: 0,
        entregadoCantidad: 0,
        compradoMontoConverted: 0, // en targetCurrency
        entregadoMontoConverted: 0,
      };
      byMaterial.set(key, b);
    }
    return b;
  }

  let totalCompradoConverted = 0;
  let totalEntregadoConverted = 0;

  for (const oc of ocs) {
    const fxFactor = fxFactorPorOc.get(String(oc.id));
    for (const it of oc.items) {
      const bucket = ensureBucket(it.material);
      const cantidadOrdenada = decToNumber(it.cantidad);
      const precioUnit = decToNumber(it.precioUnitario);
      const entregadaCantidad = entregadoPorOcItem.get(String(it.id)) ?? 0;
      const subtotalNativo = cantidadOrdenada * precioUnit;
      const entregadoSubtotalNativo = entregadaCantidad * precioUnit;

      bucket.compradoCantidad += cantidadOrdenada;
      bucket.entregadoCantidad += entregadaCantidad;

      if (fxFactor != null) {
        const compradoConv = subtotalNativo * fxFactor;
        const entregadoConv = entregadoSubtotalNativo * fxFactor;
        bucket.compradoMontoConverted += compradoConv;
        bucket.entregadoMontoConverted += entregadoConv;
        totalCompradoConverted += compradoConv;
        totalEntregadoConverted += entregadoConv;
      }
      // Si fxFactor es null, el item suma a cantidades pero NO a monto convertido
      // (se omite con warning ya registrado a nivel de OC).
    }
  }

  const itemsOut = Array.from(byMaterial.values())
    .map((b) => {
      const pendCantidad = b.compradoCantidad - b.entregadoCantidad;
      const pendMonto = b.compradoMontoConverted - b.entregadoMontoConverted;
      return {
        material: {
          id: b.materialId,
          nombre: b.materialNombre,
          unidad: b.unidad,
        },
        comprado: {
          cantidad: b.compradoCantidad,
          monto: { amount: b.compradoMontoConverted.toFixed(2), currency: targetCurrency },
        },
        entregado: {
          cantidad: b.entregadoCantidad,
          monto: { amount: b.entregadoMontoConverted.toFixed(2), currency: targetCurrency },
        },
        pendiente: {
          cantidad: pendCantidad,
          monto: { amount: pendMonto.toFixed(2), currency: targetCurrency },
        },
      };
    })
    .sort((a, b) => (a.material.nombre || '').localeCompare(b.material.nombre || ''));

  return {
    obra: {
      id: Number(obra.id),
      nombre: obra.nombre,
      slug: obra.slug,
      monedaReporte: targetCurrency,
    },
    items: itemsOut,
    totales: {
      compradoMonto: { amount: totalCompradoConverted.toFixed(2), currency: targetCurrency },
      entregadoMonto: { amount: totalEntregadoConverted.toFixed(2), currency: targetCurrency },
      pendienteMonto: {
        amount: (totalCompradoConverted - totalEntregadoConverted).toFixed(2),
        currency: targetCurrency,
      },
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// reporteTipoCambio
// ---------------------------------------------------------------------------

/**
 * Serie temporal de tipos de cambio. Default: últimos 90 días.
 *
 * @returns {Promise<Array<{date: string, buy: string, sell: string, source: string}>>}
 *   ordered ascending by date.
 */
export async function reporteTipoCambio(prisma, { desde, hasta, currency = 'USD' } = {}) {
  const cur = String(currency || 'USD').trim().toUpperCase();
  let desdeDate = parseDateOrNull(desde);
  let hastaDate = parseDateOrNull(hasta);

  if (!desdeDate && !hastaDate) {
    // Default últimos 90 días.
    hastaDate = new Date();
    hastaDate.setUTCHours(0, 0, 0, 0);
    desdeDate = new Date(hastaDate.getTime());
    desdeDate.setUTCDate(desdeDate.getUTCDate() - 90);
  }

  const where = { currency: cur };
  if (desdeDate || hastaDate) {
    where.date = {};
    if (desdeDate) where.date.gte = desdeDate;
    if (hastaDate) where.date.lte = hastaDate;
  }

  const rows = await prisma.exchangeRate.findMany({
    where,
    orderBy: { date: 'asc' },
  });

  return rows.map((r) => ({
    date: ymd(r.date),
    buy: decToString(r.buy),
    sell: decToString(r.sell),
    source: r.source,
  }));
}

// ---------------------------------------------------------------------------
// serializeToCSV
// ---------------------------------------------------------------------------

/**
 * Serializa un array de objetos a CSV con BOM UTF-8 (para Excel).
 *
 * @param {Array<object>} rows
 * @param {Array<{key: string, header: string, value?: (row: object) => any}>} columnDefs
 * @returns {string} CSV con BOM + headers + rows.
 *
 * Reglas de escape RFC 4180:
 *  - Si el valor contiene `,`, `"`, `\n` o `\r` → lo envolvemos en comillas.
 *  - Las comillas dentro se duplican (`"` → `""`).
 *  - `null`/`undefined` → string vacío.
 *  - BigInt → toString (sin notación científica).
 */
export function serializeToCSV(rows, columnDefs) {
  if (!Array.isArray(columnDefs) || columnDefs.length === 0) {
    throw new Error('serializeToCSV: columnDefs requeridos');
  }
  const lines = [];
  // Header
  lines.push(columnDefs.map((c) => escapeCsvCell(c.header)).join(','));
  // Rows
  for (const row of rows ?? []) {
    const cells = columnDefs.map((c) => {
      const raw = c.value ? c.value(row) : row?.[c.key];
      return escapeCsvCell(stringifyCsv(raw));
    });
    lines.push(cells.join(','));
  }
  // BOM UTF-8 + CRLF (Excel-friendly).
  return '﻿' + lines.join('\r\n');
}

function stringifyCsv(v) {
  if (v == null) return '';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') {
    // {amount, currency} → "12,345.67 CRC" ? No: emitimos amount crudo.
    if ('amount' in v && 'currency' in v) {
      return `${v.amount} ${v.currency}`;
    }
    return JSON.stringify(v);
  }
  return String(v);
}

function escapeCsvCell(value) {
  const s = String(value ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
