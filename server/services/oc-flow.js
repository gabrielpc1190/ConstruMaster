/**
 * [oc-flow] — Flujo de aprobación de Cotización → Orden de Compra.
 *
 * Esta función es el punto crítico de Compras: convierte una Cotización aprobada
 * en una OrdenCompra (OC) con su número correlativo por obra, snapshot del tipo
 * de cambio (si aplica) y snapshot de items.
 *
 * Concurrencia:
 *   La generación de `numeroOc` usa `obra.next_oc_seq` como contador serial.
 *   Para evitar duplicados bajo aprobaciones simultáneas dentro de la MISMA
 *   obra usamos `pg_advisory_xact_lock(obraId)`: serializa SOLO los writes
 *   de OC de esa obra. Otras obras pueden aprobar en paralelo. El lock se
 *   libera al cerrar la transacción.
 *
 * Idempotencia:
 *   Si la cotización está en estado terminal (`aprobada`/`rechazada`/`vencida`)
 *   lanzamos un error con `code='COTIZACION_TERMINAL'` que la capa HTTP traduce
 *   a 409.
 *
 * Snapshot TC:
 *   Si `cotizacion.moneda === 'USD'`, buscamos el último `ExchangeRate` con
 *   `currency='USD'` y `date<=fechaAprobacion`, y guardamos `sell` en
 *   `oc.fxRateApplied` + esa fecha en `oc.fxRateDate`. Si no hay TC en DB,
 *   dejamos ambos `null` (el supervisor podrá editar luego).
 *
 * Snapshot de items:
 *   Cada `OrdenCompraItem` guarda `materialNombreSnapshot` y `materialUnidadSnapshot`
 *   tomados del `ItemCatalogo` (si existe) en el momento de la aprobación.
 *   Si el item del catálogo se renombra después, la OC histórica preserva el
 *   nombre original.
 *
 * RFQ:
 *   Si la cotización tiene `rfqId`, marcamos la RFQ como `cerrada` (no
 *   `cancelada`: cerrada = se aprobó una de sus cotizaciones).
 */

/**
 * Approveuna cotización y crea su OrdenCompra. Retorna `{cotizacion, oc}`.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {object} args
 * @param {bigint|number|string} args.cotizacionId
 * @param {bigint|number|string} args.categoriaId  Categoría destino de la OC (presupuesto).
 * @param {Date|string} [args.fechaAprobacion]      Defaults a hoy.
 * @param {bigint|number|null} [args.approverId]   User id que aprueba.
 */
export async function approveCotizacion(prisma, args) {
  const {
    cotizacionId: rawCotizacionId,
    categoriaId: rawCategoriaId,
    fechaAprobacion,
    approverId,
  } = args;

  if (rawCotizacionId === undefined || rawCotizacionId === null) {
    throw badRequest('cotizacionId requerido');
  }
  if (rawCategoriaId === undefined || rawCategoriaId === null) {
    throw badRequest('categoriaId requerido');
  }

  const cotizacionId = toBigInt(rawCotizacionId, 'cotizacionId');
  const categoriaId = toBigInt(rawCategoriaId, 'categoriaId');
  const approverBigInt = approverId == null ? null : toBigInt(approverId, 'approverId');
  const fechaAprob = parseDate(fechaAprobacion) ?? today();

  console.log(`[oc-flow] approveCotizacion start cotizacionId=${cotizacionId} categoriaId=${categoriaId}`);

  // Pre-check fuera de la tx para fallar rápido con 404 sin tomar lock.
  const cot = await prisma.cotizacion.findUnique({
    where: { id: cotizacionId },
    include: { items: { orderBy: { orden: 'asc' } } },
  });
  if (!cot) throw notFound('Cotización no encontrada');

  if (TERMINAL_ESTADOS.has(cot.estado)) {
    const err = new Error('Cotización ya está en estado terminal');
    err.code = 'COTIZACION_TERMINAL';
    err.estado = cot.estado;
    throw err;
  }

  // Validar que la categoría exista y pertenezca a la obra de la cotización.
  const categoria = await prisma.categoriaPresupuesto.findUnique({
    where: { id: categoriaId },
  });
  if (!categoria) throw notFound('Categoría no encontrada');
  if (categoria.obraId !== cot.obraId) {
    throw badRequest('La categoría no pertenece a la obra de la cotización');
  }

  return prisma.$transaction(async (tx) => {
    // 1. Advisory lock por obra. Solo serializa writes de OC de ESTA obra.
    //    pg_advisory_xact_lock(bigint) → unsigned-ish: cast a int4 podría
    //    chocar con ids grandes; usamos la firma bigint nativa.
    const obraIdNum = Number(cot.obraId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${obraIdNum}::bigint)`;

    // 2. Re-leer dentro de la tx para asegurar consistencia frente al lock.
    const obra = await tx.obra.findUnique({ where: { id: cot.obraId } });
    if (!obra) throw notFound('Obra no encontrada');

    // Re-check estado: alguien pudo aprobar entre el pre-check y el lock.
    const cotLatest = await tx.cotizacion.findUnique({
      where: { id: cotizacionId },
      select: { estado: true },
    });
    if (!cotLatest) throw notFound('Cotización no encontrada');
    if (TERMINAL_ESTADOS.has(cotLatest.estado)) {
      const err = new Error('Cotización ya está en estado terminal');
      err.code = 'COTIZACION_TERMINAL';
      err.estado = cotLatest.estado;
      throw err;
    }

    // 3. Generar numeroOc.
    const seq = obra.nextOcSeq;
    const numeroOc = `${obra.slug.toUpperCase()}-OC-${String(seq).padStart(4, '0')}`;
    console.log(`[oc-flow] generando ${numeroOc} (obraId=${obra.id}, seq=${seq})`);

    // 4. Incrementar contador.
    await tx.obra.update({
      where: { id: obra.id },
      data: { nextOcSeq: seq + 1 },
    });

    // 5. Snapshot TC si moneda !== CRC.
    let fxRateApplied = null;
    let fxRateDate = null;
    if (cot.moneda !== 'CRC') {
      const rate = await tx.exchangeRate.findFirst({
        where: {
          currency: 'USD',
          date: { lte: fechaAprob },
        },
        orderBy: { date: 'desc' },
      });
      if (rate) {
        fxRateApplied = rate.sell;
        fxRateDate = rate.date;
        console.log(`[oc-flow] TC snapshot ${fxRateApplied} @ ${fxRateDate.toISOString().slice(0, 10)}`);
      } else {
        console.warn('[oc-flow] no hay ExchangeRate en DB; se deja TC null (editable luego)');
      }
    }

    // 6. Crear OC + items en un solo create con `data` anidado.
    const oc = await tx.ordenCompra.create({
      data: {
        obraId: obra.id,
        categoriaId,
        cotizacionOrigenId: cot.id,
        proveedorId: cot.proveedorId,
        numeroOc,
        fechaAprobacion: fechaAprob,
        aprobadaPorId: approverBigInt,
        moneda: cot.moneda,
        montoTotalAmount: cot.totalAmount,
        montoTotalCurrency: cot.totalCurrency,
        fxRateApplied,
        fxRateDate,
        esEspecial: cot.esEspecial,
        tiempoEstimadoDias: cot.plazoEntregaDias ?? null,
        pctAnticipo: cot.pctAnticipo ?? null,
        estado: 'autorizada',
        items: {
          create: await buildOcItemsCreate(tx, cot.items),
        },
      },
      include: {
        items: { orderBy: { orden: 'asc' } },
        proveedor: true,
        obra: true,
        categoria: true,
      },
    });

    // 7. Marcar cotización como aprobada.
    const updatedCot = await tx.cotizacion.update({
      where: { id: cot.id },
      data: { estado: 'aprobada' },
      include: { items: { orderBy: { orden: 'asc' } }, proveedor: true, obra: true },
    });

    // 8. Si tiene RFQ, cerrarla.
    if (cot.rfqId != null) {
      await tx.solicitudCotizacion.update({
        where: { id: cot.rfqId },
        data: { estado: 'cerrada' },
      });
    }

    console.log(`[oc-flow] approveCotizacion OK cotizacionId=${cotizacionId} numeroOc=${numeroOc}`);
    return { cotizacion: updatedCot, oc };
  });
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

const TERMINAL_ESTADOS = new Set(['aprobada', 'rechazada', 'vencida']);

/**
 * Construye el array `data` para `tx.ordenCompra.create({data:{items:{create:...}}})`
 * resolviendo los snapshots de material en el momento de la aprobación.
 */
async function buildOcItemsCreate(tx, cotizacionItems) {
  // Pre-fetch materiales en batch para no hacer N+1.
  const materialIds = [...new Set(
    cotizacionItems.map((it) => it.materialId).filter((x) => x != null),
  )];
  let materialsById = new Map();
  if (materialIds.length > 0) {
    const mats = await tx.itemCatalogo.findMany({
      where: { id: { in: materialIds } },
    });
    materialsById = new Map(mats.map((m) => [m.id.toString(), m]));
  }

  return cotizacionItems.map((it) => {
    const mat = it.materialId != null
      ? materialsById.get(it.materialId.toString())
      : null;
    return {
      materialId: it.materialId,
      materialNombreSnapshot: mat?.nombreCanonico ?? null,
      materialUnidadSnapshot: mat?.unidad ?? null,
      descripcion: it.descripcion,
      cantidad: it.cantidad,
      unidad: it.unidad,
      precioUnitario: it.precioUnitario,
      subtotal: it.subtotal,
      ivaMonto: it.ivaMonto,
      codigoCabys: it.codigoCabys,
      orden: it.orden,
    };
  });
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

function toBigInt(value, label) {
  try {
    return typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    throw badRequest(`${label} inválido: ${value}`);
  }
}

function parseDate(input) {
  if (input == null || input === '') return null;
  const d = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw badRequest(`fecha inválida: ${input}`);
  }
  return d;
}

function today() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
