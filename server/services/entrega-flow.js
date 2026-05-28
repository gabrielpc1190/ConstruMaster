/**
 * [entrega-flow] — Servicio de recepción de material en bodega + reconciliación.
 *
 * Tony/Adrián registran lo que llega físicamente a una bodega. Cada Entrega
 * se asocia a una OC y a (opcionalmente) una bodega destino. Sus items se
 * vinculan a OrdenCompraItem cuando el material corresponde a algo ordenado
 * (`ocItemId`), o quedan "extra" cuando llega algo no pedido (`ocItemId=null`).
 *
 * Conceptos:
 *  - `completa` (en Entrega): true cuando ESTA entrega, sumada a las
 *    anteriores, deja todos los items de la OC en cantidadPendiente <= 0.
 *    Es un snapshot informativo; el estado de OC se calcula aparte.
 *  - Reconciliación: `pendientesPorItem()` agrupa EntregaItem.cantidad por
 *    ocItemId y compara contra OrdenCompraItem.cantidad. Items con
 *    `ocItemId=null` (extras) NO afectan el cálculo de pendientes.
 *
 * Transición de estado de OC al crear/borrar entrega:
 *   - `pagada` + entrega completa  → `completada`
 *   - `autorizada` o `pagada_parcial` + entrega parcial → `entregada_parcial`
 *   - `entregada_parcial` + nueva entrega que completa → `completada` si la
 *     OC YA estaba `pagada`; si no, queda `entregada_parcial` (la transición
 *     a `completada` requiere que también esté pagada — decisión de spec).
 *   - Borrar una entrega completa puede bajar la OC a `entregada_parcial`.
 *
 * NOTA: el enum `OcEstado` actual no incluye `entregada_total`; la spec
 * explícitamente dice "mantener `entregada_parcial`" en ese caso.
 *
 * Tests: server/services/__tests__/entrega-flow.test.js (unidad) +
 *        server/routes/__tests__/entregas.test.js (controllers con stubs).
 */

const NON_CANCELABLE = new Set(['cancelada']);

// ---------------------------------------------------------------------------
// Errors / helpers
// ---------------------------------------------------------------------------

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
  if (value === null || value === undefined) return null;
  try {
    return typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    throw badRequest(`${label} inválido: ${value}`);
  }
}

function toBigIntRequired(value, label) {
  if (value === null || value === undefined) {
    throw badRequest(`${label} requerido`);
  }
  return toBigInt(value, label);
}

function parseDate(input) {
  if (input == null || input === '') return null;
  const d = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw badRequest(`fecha inválida: ${input}`);
  }
  return d;
}

function decToNumber(dec) {
  if (dec == null) return 0;
  if (typeof dec === 'number') return dec;
  if (typeof dec === 'bigint') return Number(dec);
  // Decimal (de Prisma) tiene .toString()
  const n = Number(String(dec));
  return Number.isFinite(n) ? n : 0;
}

function sameId(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

// ---------------------------------------------------------------------------
// Reconciliación
// ---------------------------------------------------------------------------

/**
 * Pendientes por item de la OC. Devuelve, para cada OrdenCompraItem,
 * la cantidad pedida, sumada entregada (excluyendo items con ocItemId=null,
 * que son "extras"), y la pendiente (clamped a >= 0 si se entregó de más).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {bigint|number|string} ocId
 * @returns {Promise<Array<{
 *   ocItemId: number,
 *   descripcion: string,
 *   unidad: string,
 *   cantidadOrdenada: number,
 *   cantidadEntregada: number,
 *   cantidadPendiente: number
 * }>>}
 */
export async function pendientesPorItem(prisma, ocId) {
  const ocIdBig = toBigIntRequired(ocId, 'ocId');

  const items = await prisma.ordenCompraItem.findMany({
    where: { ocId: ocIdBig },
    orderBy: { orden: 'asc' },
  });

  if (items.length === 0) return [];

  const ocItemIds = items.map((it) => it.id);

  // Agregamos cantidad entregada por ocItemId. Excluimos ocItemId NULL
  // (items "extras" no atribuidos a una línea de la OC).
  const grouped = await prisma.entregaItem.groupBy({
    by: ['ocItemId'],
    where: { ocItemId: { in: ocItemIds } },
    _sum: { cantidad: true },
  });

  const sumByOcItemId = new Map();
  for (const g of grouped) {
    if (g.ocItemId == null) continue;
    sumByOcItemId.set(String(g.ocItemId), decToNumber(g._sum?.cantidad));
  }

  return items.map((it) => {
    const cantidadOrdenada = decToNumber(it.cantidad);
    const cantidadEntregada = sumByOcItemId.get(String(it.id)) ?? 0;
    // Permitir negativos hacia arriba; pero para "pendiente" clamp a 0.
    const pendienteRaw = cantidadOrdenada - cantidadEntregada;
    const cantidadPendiente = pendienteRaw > 0 ? pendienteRaw : 0;
    return {
      ocItemId: Number(it.id),
      descripcion: it.descripcion,
      unidad: it.unidad,
      cantidadOrdenada,
      cantidadEntregada,
      cantidadPendiente,
    };
  });
}

/**
 * `true` si todas las cantidades pendientes de la OC son <= 0 (entrega total).
 * Si la OC no tiene items, retorna `false`.
 */
export async function isOcEntregadaCompleta(prisma, ocId) {
  const pendientes = await pendientesPorItem(prisma, ocId);
  if (pendientes.length === 0) return false;
  return pendientes.every((p) => p.cantidadPendiente <= 0);
}

// ---------------------------------------------------------------------------
// Transición de estado OC en función de entregas
// ---------------------------------------------------------------------------

/**
 * Re-evalúa el estado de la OC tras crear/borrar entregas y lo actualiza si
 * corresponde. Se llama dentro de la misma transacción.
 *
 * Reglas:
 *   - `cancelada` → no se toca.
 *   - Hay al menos una entrega + completa según items pendientes:
 *       * si estaba `pagada` → `completada`.
 *       * si estaba `autorizada` o `pagada_parcial` o `entregada_parcial`
 *         → queda `entregada_parcial` (no `completada` hasta que esté pagada).
 *   - Hay al menos una entrega + parcial:
 *       * si estaba `autorizada` o `pagada_parcial` → `entregada_parcial`.
 *       * si estaba `pagada` y no quedan pendientes... cubierto arriba.
 *       * si estaba `completada` y borraron una entrega → vuelve a
 *         `entregada_parcial` (downgrade).
 *   - No quedan entregas:
 *       * si estaba `entregada_parcial` → vuelve a `autorizada` o a
 *         `pagada` / `pagada_parcial` según corresponda; aquí no
 *         podemos reconstruir eso. La regla cauta: si está
 *         `entregada_parcial` o `completada` y ya no hay entregas, baja
 *         a `autorizada`.
 */
async function recomputeOcStateAfterEntregaChange(tx, ocId) {
  const oc = await tx.ordenCompra.findUnique({ where: { id: ocId } });
  if (!oc) return null;
  if (NON_CANCELABLE.has(oc.estado)) return oc; // cancelada → no tocar.

  const entregaCount = await tx.entrega.count({ where: { ocId } });
  const completa = await isOcEntregadaCompleta(tx, ocId);

  let nextEstado = oc.estado;
  if (entregaCount === 0) {
    // No hay entregas. Si estábamos en estados de entrega, retrocedemos.
    if (oc.estado === 'entregada_parcial' || oc.estado === 'completada') {
      nextEstado = 'autorizada';
    }
  } else if (completa) {
    // Hay entregas y cierran el total.
    // Spec: si estaba `pagada` → `completada`. Si estaba
    // `entregada_parcial` y nueva entrega completa → `completada`.
    // Si estaba `autorizada` o `pagada_parcial` y se completa sin haber
    // estado en `pagada`, mantenemos `entregada_parcial` (no hay
    // `entregada_total` en el enum).
    if (oc.estado === 'pagada' || oc.estado === 'entregada_parcial') {
      nextEstado = 'completada';
    } else if (oc.estado === 'autorizada' || oc.estado === 'pagada_parcial') {
      nextEstado = 'entregada_parcial';
    } else if (oc.estado === 'completada') {
      nextEstado = oc.estado;
    }
  } else {
    // Hay entregas pero parciales.
    if (oc.estado === 'autorizada' || oc.estado === 'pagada_parcial' || oc.estado === 'pagada') {
      nextEstado = 'entregada_parcial';
    } else if (oc.estado === 'completada') {
      // Downgrade tras borrar una entrega.
      nextEstado = 'entregada_parcial';
    }
  }

  if (nextEstado !== oc.estado) {
    console.log(`[entrega-flow] OC ${ocId} estado ${oc.estado} → ${nextEstado}`);
    return tx.ordenCompra.update({ where: { id: ocId }, data: { estado: nextEstado } });
  }
  return oc;
}

// ---------------------------------------------------------------------------
// createEntrega — atómico
// ---------------------------------------------------------------------------

/**
 * Crea una Entrega + sus EntregaItems en una transacción y actualiza el
 * estado de la OC si corresponde.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {object} args
 * @param {bigint|number|string} args.ocId
 * @param {bigint|number|string|null} [args.bodegaDestinoId]
 * @param {Date|string} args.fecha
 * @param {string} args.recibidoPor
 * @param {bigint|number|string} args.registradaPorId
 * @param {Array<{
 *   ocItemId?: bigint|number|string|null,
 *   materialId?: bigint|number|string|null,
 *   descripcion: string,
 *   cantidad: number|string,
 *   unidad: string,
 *   notas?: string|null,
 * }>} args.items
 * @param {string} [args.notas]
 *
 * @returns {Promise<{ entrega: object, oc: object }>}
 */
export async function createEntrega(prisma, args) {
  const ocId = toBigIntRequired(args.ocId, 'ocId');
  const bodegaDestinoId = args.bodegaDestinoId != null
    ? toBigInt(args.bodegaDestinoId, 'bodegaDestinoId')
    : null;
  const registradaPorId = toBigIntRequired(args.registradaPorId, 'registradaPorId');
  const fecha = parseDate(args.fecha) ?? new Date();
  const recibidoPor = String(args.recibidoPor ?? '').trim();
  if (!recibidoPor) throw badRequest('recibidoPor requerido');

  if (!Array.isArray(args.items) || args.items.length === 0) {
    throw badRequest('La entrega debe incluir al menos un item');
  }

  // Pre-validar items y normalizar.
  const normalizedItems = args.items.map((it, idx) => {
    const descripcion = String(it.descripcion ?? '').trim();
    if (!descripcion) {
      throw badRequest(`items[${idx}].descripcion requerido`);
    }
    const cantidadNum = typeof it.cantidad === 'number'
      ? it.cantidad
      : Number(String(it.cantidad ?? '').trim());
    if (!Number.isFinite(cantidadNum) || cantidadNum <= 0) {
      throw badRequest(`items[${idx}].cantidad debe ser un número > 0`);
    }
    const unidad = String(it.unidad ?? '').trim();
    if (!unidad) {
      throw badRequest(`items[${idx}].unidad requerido`);
    }
    return {
      ocItemId: it.ocItemId != null ? toBigInt(it.ocItemId, `items[${idx}].ocItemId`) : null,
      materialId: it.materialId != null ? toBigInt(it.materialId, `items[${idx}].materialId`) : null,
      descripcion,
      cantidad: String(cantidadNum), // Decimal-friendly string
      unidad,
      notas: it.notas ? String(it.notas) : null,
    };
  });

  return prisma.$transaction(async (tx) => {
    // 1. Validar OC.
    const oc = await tx.ordenCompra.findUnique({ where: { id: ocId } });
    if (!oc) throw notFound('OC no encontrada');
    if (oc.estado === 'cancelada') {
      const err = new Error('No se pueden registrar entregas en una OC cancelada');
      err.status = 409;
      throw err;
    }

    // 2. Validar ocItemIds: que pertenezcan a esta OC.
    const ocItemIdsToCheck = normalizedItems
      .map((it) => it.ocItemId)
      .filter((v) => v != null);
    if (ocItemIdsToCheck.length > 0) {
      const ocItems = await tx.ordenCompraItem.findMany({
        where: { id: { in: ocItemIdsToCheck } },
        select: { id: true, ocId: true },
      });
      const found = new Map(ocItems.map((it) => [String(it.id), it]));
      for (const idStr of ocItemIdsToCheck.map(String)) {
        const it = found.get(idStr);
        if (!it) throw badRequest(`ocItem ${idStr} no encontrado`);
        if (!sameId(it.ocId, ocId)) {
          throw badRequest(`ocItem ${idStr} no pertenece a la OC ${ocId}`);
        }
      }
    }

    // 3. Crear Entrega + items (completa se setea provisionalmente; la
    //    re-evaluamos después de existir, contemplando todas las entregas
    //    de la OC).
    let entrega = await tx.entrega.create({
      data: {
        ocId,
        bodegaDestinoId,
        fecha,
        recibidoPor,
        registradaPorId,
        completa: false,
        notas: args.notas ? String(args.notas) : null,
        items: {
          create: normalizedItems.map((it) => ({
            ocItemId: it.ocItemId,
            materialId: it.materialId,
            descripcion: it.descripcion,
            cantidad: it.cantidad,
            unidad: it.unidad,
            notas: it.notas,
          })),
        },
      },
      include: { items: true },
    });

    // 4. Reconciliar: ¿esta entrega + las previas dejan la OC al día?
    const completa = await isOcEntregadaCompleta(tx, ocId);
    if (completa) {
      entrega = await tx.entrega.update({
        where: { id: entrega.id },
        data: { completa: true },
        include: { items: true },
      });
    }

    // 5. Actualizar estado OC si corresponde.
    const updatedOc = await recomputeOcStateAfterEntregaChange(tx, ocId);

    return { entrega, oc: updatedOc };
  });
}

// ---------------------------------------------------------------------------
// attachFotosToEntrega — crear EntregaFoto[] desde files ya subidos por multer
// ---------------------------------------------------------------------------

/**
 * Crea registros EntregaFoto para los archivos provistos.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {bigint|number|string} entregaId
 * @param {Array<{ relativePath: string, originalName?: string }>} fileRecords
 * @param {bigint|number|string} userId
 *
 * @returns {Promise<Array<object>>} array de EntregaFoto creados
 */
export async function attachFotosToEntrega(prisma, entregaId, fileRecords, userId) {
  const entregaIdBig = toBigIntRequired(entregaId, 'entregaId');
  const userIdBig = toBigIntRequired(userId, 'userId');

  if (!Array.isArray(fileRecords) || fileRecords.length === 0) {
    return [];
  }

  // Validar entrega.
  const entrega = await prisma.entrega.findUnique({
    where: { id: entregaIdBig },
    select: { id: true },
  });
  if (!entrega) throw notFound('Entrega no encontrada');

  const created = [];
  for (const f of fileRecords) {
    if (!f || !f.relativePath) continue;
    const row = await prisma.entregaFoto.create({
      data: {
        entregaId: entregaIdBig,
        archivoPath: f.relativePath,
        subidaPorId: userIdBig,
      },
    });
    created.push(row);
  }
  return created;
}

// ---------------------------------------------------------------------------
// deleteEntrega — borra Entrega (cascade items+fotos via schema) y reajusta OC
// ---------------------------------------------------------------------------

/**
 * Borra una Entrega y reajusta el estado de la OC si la eliminación cambia la
 * reconciliación (p.ej. la OC era `completada` y baja a `entregada_parcial`).
 *
 * Devuelve `{ ocId, prevEstado, nextEstado }`. Los archivos físicos en disco
 * se borran fuera (controller responsabilidad), porque acá no tocamos FS.
 */
export async function deleteEntrega(prisma, entregaId) {
  const idBig = toBigIntRequired(entregaId, 'entregaId');

  return prisma.$transaction(async (tx) => {
    const entrega = await tx.entrega.findUnique({
      where: { id: idBig },
      include: { fotos: true },
    });
    if (!entrega) throw notFound('Entrega no encontrada');

    const ocId = entrega.ocId;
    const ocBefore = await tx.ordenCompra.findUnique({ where: { id: ocId } });

    // Capturar paths antes del delete para que el controller los limpie en disco.
    const fotoPaths = entrega.fotos.map((f) => f.archivoPath);

    await tx.entrega.delete({ where: { id: idBig } });

    const ocAfter = await recomputeOcStateAfterEntregaChange(tx, ocId);

    return {
      ocId: Number(ocId),
      prevEstado: ocBefore?.estado ?? null,
      nextEstado: ocAfter?.estado ?? null,
      fotoPaths,
    };
  });
}
