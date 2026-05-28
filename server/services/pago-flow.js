/**
 * [pago-flow] Lógica financiera de Pagos contra Órdenes de Compra.
 *
 * Operaciones core:
 *  - markPaid:    marca un pago como realizado, snapshot del TC del día, y
 *                 recalcula el estado financiero de la OC (pagada_parcial /
 *                 pagada) con base en la suma normalizada de pagos.
 *  - unmarkPaid:  revierte la marca, limpia snapshot y recalcula estado.
 *
 * Concurrencia:
 *   Igual que `oc-flow.approveCotizacion`, serializamos writes por OC con
 *   `pg_advisory_xact_lock(ocId)`. Distintos OCs progresan en paralelo.
 *
 * Snapshot TC:
 *   Si `pago.montoCurrency !== 'CRC'`, buscamos el TC más reciente con
 *   `date <= fechaRealizada` desde `finance.getRateForDate(..., 'sell')`. Si
 *   no hay TC histórico, dejamos los campos `null` con un warning a stdout
 *   (no bloqueamos: el supervisor podrá editar luego).
 *
 * Normalización para estado OC:
 *   Sumamos todos los pagos `fechaRealizada != null` convertidos a la moneda
 *   `oc.montoTotalCurrency` con `convert(..., pago.fechaRealizada)`. Si un
 *   pago no tiene TC histórico disponible, se OMITE del cálculo y se loguea
 *   (mismo trato que el v1 Django: nunca dejamos que un faltante de TC
 *   degrade silenciosamente el estado de la OC).
 *
 * Transiciones permitidas:
 *   El estado solo se ajusta entre `autorizada` ↔ `pagada_parcial` ↔ `pagada`.
 *   Nunca tocamos estados de entrega (`entregada_parcial`, `completada`) ni
 *   `cancelada`.
 */

import { convert, getRateForDate, NoExchangeRateError } from './finance.js';

// ---------------------------------------------------------------------------
// Errores tipados
// ---------------------------------------------------------------------------

function makeErr(message, { code, status } = {}) {
  const err = new Error(message);
  if (code) err.code = code;
  if (status) err.status = status;
  return err;
}

// ---------------------------------------------------------------------------
// Helpers de parsing
// ---------------------------------------------------------------------------

function toBigInt(value, label) {
  try {
    return typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    throw makeErr(`${label} inválido: ${value}`, { status: 400 });
  }
}

function parseDate(input) {
  if (input == null || input === '') return null;
  const d = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw makeErr(`fecha inválida: ${input}`, { status: 400 });
  }
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function today() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Estados financieros mutuamente transitables por markPaid/unmarkPaid.
// `pagada` se incluye para permitir democión cuando un desmarcado reduce
// la suma normalizada. NUNCA tocamos `entregada_parcial`, `completada`, ni
// `cancelada`: esos los manejan otros flows (entregas / cancelar OC).
const OC_FIN_TRANSITIONABLE = new Set(['autorizada', 'pagada_parcial', 'pagada']);

// ---------------------------------------------------------------------------
// markPaid
// ---------------------------------------------------------------------------

/**
 * Marca un Pago como realizado, snapshot del TC del día (si aplica) y
 * recalcula el estado financiero de la OC.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {object} args
 * @param {bigint|number|string} args.pagoId
 * @param {Date|string} [args.fechaRealizada] Defaults a hoy (UTC midnight).
 * @param {bigint|number|null} [args.marcadoPorId]
 * @returns {Promise<{pago: object, oc: object, transitionedFrom?: string, transitionedTo?: string}>}
 */
export async function markPaid(prisma, args) {
  const { pagoId: rawPagoId, fechaRealizada, marcadoPorId } = args ?? {};
  if (rawPagoId == null) {
    throw makeErr('pagoId requerido', { status: 400 });
  }
  const pagoId = toBigInt(rawPagoId, 'pagoId');
  const fecha = parseDate(fechaRealizada) ?? today();
  const marcadoPorBig = marcadoPorId == null ? null : toBigInt(marcadoPorId, 'marcadoPorId');

  return prisma.$transaction(async (tx) => {
    // 1. Lock por OC. Necesitamos el ocId primero (sin lock todavía).
    const pago = await tx.pago.findUnique({ where: { id: pagoId } });
    if (!pago) throw makeErr('Pago no encontrado', { status: 404 });

    const ocIdNum = Number(pago.ocId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ocIdNum}::bigint)`;

    // 2. Re-leer pago + OC dentro del lock.
    const pagoLocked = await tx.pago.findUnique({ where: { id: pagoId } });
    if (!pagoLocked) throw makeErr('Pago no encontrado', { status: 404 });
    if (pagoLocked.fechaRealizada != null) {
      throw makeErr('Pago ya está marcado como pagado', {
        code: 'PAGO_ALREADY_PAID',
        status: 409,
      });
    }

    const oc = await tx.ordenCompra.findUnique({ where: { id: pagoLocked.ocId } });
    if (!oc) throw makeErr('OC no encontrada', { status: 404 });
    if (oc.estado === 'cancelada') {
      throw makeErr('OC cancelada: no se puede marcar pagos', {
        code: 'OC_CANCELLED',
        status: 409,
      });
    }

    // 3. Snapshot TC del pago si moneda != CRC.
    let fxRateApplied = null;
    let fxRateDate = null;
    if (pagoLocked.montoCurrency !== 'CRC') {
      try {
        const rateInfo = await getRateForDate(
          pagoLocked.montoCurrency,
          fecha,
          'sell',
          tx,
        );
        fxRateApplied = rateInfo.rate;
        fxRateDate = rateInfo.fxRateDate;
        console.log(
          `[pago-flow] TC snapshot pago=${pagoId} ${fxRateApplied} @ ${fxRateDate.toISOString().slice(0, 10)}`,
        );
      } catch (e) {
        if (e instanceof NoExchangeRateError) {
          console.warn(
            `[pago-flow] no hay TC histórico para pago=${pagoId} fecha=${fecha
              .toISOString()
              .slice(0, 10)}; se deja null (editable luego)`,
          );
        } else {
          throw e;
        }
      }
    }

    // 4. Actualizar pago.
    const pagoUpdated = await tx.pago.update({
      where: { id: pagoId },
      data: {
        fechaRealizada: fecha,
        fxRateApplied: fxRateApplied != null ? String(fxRateApplied) : null,
        fxRateDate,
        marcadoPagadoPorId: marcadoPorBig,
      },
    });

    // 5. Recalcular suma normalizada en moneda de la OC.
    const transition = await recomputeOcEstadoFinanciero(tx, oc);

    const ocAfter = await tx.ordenCompra.findUnique({ where: { id: oc.id } });
    return {
      pago: pagoUpdated,
      oc: ocAfter,
      ...transition,
    };
  });
}

// ---------------------------------------------------------------------------
// unmarkPaid
// ---------------------------------------------------------------------------

/**
 * Limpia `fechaRealizada` + snapshot TC + marcadoPagadoPorId, y recalcula
 * estado financiero de la OC. Útil para corregir un mark accidental.
 */
export async function unmarkPaid(prisma, args) {
  const { pagoId: rawPagoId } = args ?? {};
  if (rawPagoId == null) {
    throw makeErr('pagoId requerido', { status: 400 });
  }
  const pagoId = toBigInt(rawPagoId, 'pagoId');

  return prisma.$transaction(async (tx) => {
    const pago = await tx.pago.findUnique({ where: { id: pagoId } });
    if (!pago) throw makeErr('Pago no encontrado', { status: 404 });

    const ocIdNum = Number(pago.ocId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ocIdNum}::bigint)`;

    const pagoLocked = await tx.pago.findUnique({ where: { id: pagoId } });
    if (!pagoLocked) throw makeErr('Pago no encontrado', { status: 404 });
    if (pagoLocked.fechaRealizada == null) {
      throw makeErr('Pago no está marcado como pagado', {
        code: 'PAGO_NOT_PAID',
        status: 409,
      });
    }

    const oc = await tx.ordenCompra.findUnique({ where: { id: pagoLocked.ocId } });
    if (!oc) throw makeErr('OC no encontrada', { status: 404 });

    const pagoUpdated = await tx.pago.update({
      where: { id: pagoId },
      data: {
        fechaRealizada: null,
        fxRateApplied: null,
        fxRateDate: null,
        marcadoPagadoPorId: null,
      },
    });

    const transition = await recomputeOcEstadoFinanciero(tx, oc);
    const ocAfter = await tx.ordenCompra.findUnique({ where: { id: oc.id } });

    return {
      pago: pagoUpdated,
      oc: ocAfter,
      ...transition,
    };
  });
}

// ---------------------------------------------------------------------------
// Recalculo del estado financiero (interno)
// ---------------------------------------------------------------------------

/**
 * Recalcula `oc.estado` financiero con base en la suma normalizada de los
 * pagos realizados.
 *
 * Reglas:
 *  - Sólo transicionamos si estado actual está en `OC_FIN_TRANSITIONABLE`
 *    (`autorizada` o `pagada_parcial`). Esto evita degradar `pagada` a
 *    `pagada_parcial` por un unmark involuntario sobre una OC que pudo haber
 *    avanzado a entregada/completada.
 *  - Pagos sin TC histórico cuando se necesita conversión se OMITEN (warning),
 *    igual que en v1.
 *
 * @returns {Promise<{transitionedFrom?: string, transitionedTo?: string}>}
 */
async function recomputeOcEstadoFinanciero(tx, oc) {
  const pagos = await tx.pago.findMany({
    where: { ocId: oc.id, fechaRealizada: { not: null } },
  });

  const targetCurrency = oc.montoTotalCurrency;
  let sumaNormalizada = 0;
  for (const p of pagos) {
    const money = { amount: p.montoAmount, currency: p.montoCurrency };
    if (p.montoCurrency === targetCurrency) {
      sumaNormalizada += Number(p.montoAmount);
      continue;
    }
    try {
      const conv = await convert(money, targetCurrency, p.fechaRealizada, tx);
      sumaNormalizada += Number(conv.amount);
    } catch (e) {
      if (e instanceof NoExchangeRateError) {
        console.warn(
          `[pago-flow] pago=${p.id} omitido del cálculo (sin TC histórico para ${p.fechaRealizada
            ?.toISOString()
            .slice(0, 10)})`,
        );
        continue;
      }
      throw e;
    }
  }

  const total = Number(oc.montoTotalAmount);
  let nuevoEstado = oc.estado;
  if (OC_FIN_TRANSITIONABLE.has(oc.estado)) {
    // Tolerancia ₡1 / USD 0.01 para floating point.
    const tolerance = targetCurrency === 'USD' ? 0.01 : 1;
    if (sumaNormalizada >= total - tolerance) {
      nuevoEstado = 'pagada';
    } else if (sumaNormalizada > 0) {
      nuevoEstado = 'pagada_parcial';
    } else {
      nuevoEstado = 'autorizada';
    }
  }

  if (nuevoEstado !== oc.estado) {
    await tx.ordenCompra.update({
      where: { id: oc.id },
      data: { estado: nuevoEstado },
    });
    console.log(
      `[pago-flow] OC ${oc.id} transición ${oc.estado} → ${nuevoEstado} (suma=${sumaNormalizada.toFixed(
        2,
      )} ${targetCurrency} / total=${total.toFixed(2)} ${targetCurrency})`,
    );
    return { transitionedFrom: oc.estado, transitionedTo: nuevoEstado };
  }
  return {};
}
