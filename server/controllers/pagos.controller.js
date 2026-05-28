/**
 * [compras] Pagos + Hitos controller.
 *
 * Endpoints:
 *   Pagos:
 *     - listPagos        GET   /api/pagos
 *     - getPago          GET   /api/pagos/:id
 *     - createPago       POST  /api/ocs/:ocId/pagos
 *     - updatePago       PUT   /api/pagos/:id
 *     - deletePago       DEL   /api/pagos/:id
 *     - marcarPagado     POST  /api/pagos/:id/marcar-pagado
 *     - desmarcarPagado  POST  /api/pagos/:id/desmarcar
 *
 *   Hitos:
 *     - listHitosByOc    GET   /api/ocs/:ocId/hitos
 *     - createHito       POST  /api/ocs/:ocId/items/:itemId/hitos
 *     - updateHito       PUT   /api/ocs/hitos/:hitoId
 *     - completarHito    POST  /api/ocs/hitos/:hitoId/completar
 *
 * El recálculo del estado financiero de OC (autorizada ↔ pagada_parcial ↔ pagada)
 * vive en `services/pago-flow.js`. Acá solo orquestamos el CRUD + validación.
 */
import { z } from 'zod';
import prisma from '../db.js';
import { markPaid, unmarkPaid } from '../services/pago-flow.js';

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

const ROLES_CREATE_PAGO = new Set(['admin', 'supervisor', 'operativo']);
const ROLES_MARCAR = new Set(['admin', 'supervisor']);
const ROLES_EDIT = new Set(['admin', 'supervisor']);
const ROLES_DELETE = new Set(['admin']);
const ROLES_DESMARCAR = new Set(['admin']);

const ROLES_HITO_WRITE = new Set(['admin', 'supervisor']);

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const PAGO_METODOS = ['transferencia', 'cheque', 'efectivo', 'tarjeta', 'otro'];

const moneyShape = z.object({
  amount: z.union([z.number(), z.string()]),
  currency: z.enum(['CRC', 'USD']),
});

const createPagoSchema = z.object({
  fechaProgramada: z.string().min(1),
  monto: moneyShape,
  metodo: z.enum(PAGO_METODOS),
  referencia: z.string().max(120).optional().nullable(),
  notas: z.string().optional().nullable(),
  hitoIds: z.array(z.union([z.number(), z.string()])).optional(),
});

const updatePagoSchema = z.object({
  fechaProgramada: z.string().optional(),
  monto: moneyShape.optional(),
  metodo: z.enum(PAGO_METODOS).optional(),
  referencia: z.string().max(120).optional().nullable(),
  notas: z.string().optional().nullable(),
  hitoIds: z.array(z.union([z.number(), z.string()])).optional(),
});

const marcarPagadoSchema = z.object({
  fechaRealizada: z.string().optional(),
});

const createHitoSchema = z.object({
  nombre: z.string().min(1).max(200),
  monto: z.union([z.number(), z.string()]).optional().nullable(),
  fechaEstimada: z.string().optional().nullable(),
  orden: z.number().int().optional(),
  notas: z.string().optional().nullable(),
});

const updateHitoSchema = z.object({
  nombre: z.string().min(1).max(200).optional(),
  monto: z.union([z.number(), z.string()]).optional().nullable(),
  fechaEstimada: z.string().optional().nullable(),
  orden: z.number().int().optional(),
  notas: z.string().optional().nullable(),
});

const listPagosQuerySchema = z.object({
  ocId: z.union([z.string(), z.number()]).optional(),
  fechaRealizada: z.enum(['null', 'notnull']).optional(),
  fechaProgramadaFrom: z.string().optional(),
  fechaProgramadaTo: z.string().optional(),
  metodo: z.enum(PAGO_METODOS).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBig(v) {
  try {
    return v == null ? null : BigInt(v);
  } catch {
    return null;
  }
}

function toDec(v) {
  if (v == null || v === '') return null;
  return typeof v === 'string' ? v : String(v);
}

function parseDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function bad(res, msg, status = 400) {
  return res.status(status).json({ error: msg });
}

function logErr(handler, err) {
  console.error(`[compras] ${handler} error:`, err);
}

function zodMsg(parsed) {
  return parsed.error.issues
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
}

// ---------------------------------------------------------------------------
// PAGOS
// ---------------------------------------------------------------------------

export async function listPagos(req, res) {
  try {
    const parsed = listPagosQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return bad(res, `Query inválida: ${zodMsg(parsed)}`, 400);
    }
    const q = parsed.data;
    const where = {};
    if (q.ocId) {
      const oid = toBig(q.ocId);
      if (oid == null) return bad(res, 'ocId inválido', 400);
      where.ocId = oid;
    }
    if (q.fechaRealizada === 'null') where.fechaRealizada = null;
    if (q.fechaRealizada === 'notnull') where.fechaRealizada = { not: null };
    if (q.fechaProgramadaFrom || q.fechaProgramadaTo) {
      where.fechaProgramada = {};
      if (q.fechaProgramadaFrom) {
        const f = parseDateOrNull(q.fechaProgramadaFrom);
        if (!f) return bad(res, 'fechaProgramadaFrom inválida', 400);
        where.fechaProgramada.gte = f;
      }
      if (q.fechaProgramadaTo) {
        const t = parseDateOrNull(q.fechaProgramadaTo);
        if (!t) return bad(res, 'fechaProgramadaTo inválida', 400);
        where.fechaProgramada.lte = t;
      }
    }
    if (q.metodo) where.metodo = q.metodo;

    const rows = await prisma.pago.findMany({
      where,
      orderBy: [{ fechaProgramada: 'desc' }, { id: 'desc' }],
      include: {
        oc: {
          select: { id: true, numeroOc: true, estado: true, proveedor: { select: { id: true, nombre: true } } },
        },
      },
    });
    return res.json(rows);
  } catch (err) {
    logErr('listPagos', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function getPago(req, res) {
  try {
    const id = toBig(req.params.id);
    if (id == null) return bad(res, 'id inválido', 400);
    const row = await prisma.pago.findUnique({
      where: { id },
      include: {
        oc: {
          select: {
            id: true,
            numeroOc: true,
            estado: true,
            moneda: true,
            montoTotalAmount: true,
            montoTotalCurrency: true,
            proveedor: { select: { id: true, nombre: true } },
            obra: { select: { id: true, nombre: true, slug: true } },
          },
        },
        hitosRelacionados: { include: { hito: true } },
        registradoPor: { select: { id: true, username: true, fullName: true } },
        marcadoPagadoPor: { select: { id: true, username: true, fullName: true } },
      },
    });
    if (!row) return bad(res, 'Pago no encontrado', 404);
    return res.json(row);
  } catch (err) {
    logErr('getPago', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function createPago(req, res) {
  try {
    if (!ROLES_CREATE_PAGO.has(req.user?.role)) {
      return bad(res, 'No autorizado para crear pagos', 403);
    }
    const ocId = toBig(req.params.ocId);
    if (ocId == null) return bad(res, 'ocId inválido', 400);

    const parsed = createPagoSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return bad(res, `Payload inválido: ${zodMsg(parsed)}`, 400);
    }
    const data = parsed.data;

    const oc = await prisma.ordenCompra.findUnique({ where: { id: ocId } });
    if (!oc) return bad(res, 'OC no encontrada', 404);
    if (oc.estado === 'cancelada') {
      return res.status(409).json({ error: 'OC cancelada: no se pueden programar pagos' });
    }

    const fechaProg = parseDateOrNull(data.fechaProgramada);
    if (!fechaProg) return bad(res, 'fechaProgramada inválida', 400);

    // Validar hitoIds si vienen: deben existir y pertenecer a items de esta OC.
    let hitoBigIds = [];
    if (data.hitoIds && data.hitoIds.length > 0) {
      hitoBigIds = data.hitoIds.map((h) => toBig(h)).filter((x) => x != null);
      if (hitoBigIds.length !== data.hitoIds.length) {
        return bad(res, 'hitoIds contiene valores inválidos', 400);
      }
      const hitos = await prisma.hito.findMany({
        where: { id: { in: hitoBigIds } },
        include: { ocItem: { select: { ocId: true } } },
      });
      if (hitos.length !== hitoBigIds.length) {
        return bad(res, 'Alguno de los hitoIds no existe', 404);
      }
      const fueraDeOc = hitos.filter((h) => h.ocItem.ocId !== ocId);
      if (fueraDeOc.length > 0) {
        return bad(res, 'Hay hitos que no pertenecen a esta OC', 400);
      }
    }

    const registradoPorId = req.user?.id != null ? toBig(req.user.id) : null;

    const created = await prisma.$transaction(async (tx) => {
      const pago = await tx.pago.create({
        data: {
          ocId,
          fechaProgramada: fechaProg,
          montoAmount: toDec(data.monto.amount),
          montoCurrency: data.monto.currency,
          metodo: data.metodo,
          referencia: data.referencia ?? null,
          notas: data.notas ?? null,
          registradoPorId,
        },
      });
      if (hitoBigIds.length > 0) {
        await tx.pagoHito.createMany({
          data: hitoBigIds.map((hitoId) => ({ pagoId: pago.id, hitoId })),
        });
      }
      return tx.pago.findUnique({
        where: { id: pago.id },
        include: {
          oc: { select: { id: true, numeroOc: true, estado: true } },
          hitosRelacionados: { include: { hito: true } },
        },
      });
    });

    console.log(`[compras] pago creado id=${created.id} ocId=${ocId} ${data.monto.amount} ${data.monto.currency}`);
    return res.status(201).json(created);
  } catch (err) {
    logErr('createPago', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function updatePago(req, res) {
  try {
    if (!ROLES_EDIT.has(req.user?.role)) {
      return bad(res, 'Solo admin/supervisor pueden editar pagos', 403);
    }
    const id = toBig(req.params.id);
    if (id == null) return bad(res, 'id inválido', 400);

    const parsed = updatePagoSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return bad(res, `Payload inválido: ${zodMsg(parsed)}`, 400);
    }
    const data = parsed.data;

    const existing = await prisma.pago.findUnique({ where: { id } });
    if (!existing) return bad(res, 'Pago no encontrado', 404);
    if (existing.fechaRealizada != null) {
      return res.status(409).json({
        error: 'Pago ya marcado como pagado: no editable. Use desmarcar primero.',
      });
    }

    const payload = {};
    if (data.fechaProgramada !== undefined) {
      const f = parseDateOrNull(data.fechaProgramada);
      if (!f) return bad(res, 'fechaProgramada inválida', 400);
      payload.fechaProgramada = f;
    }
    if (data.monto !== undefined) {
      payload.montoAmount = toDec(data.monto.amount);
      payload.montoCurrency = data.monto.currency;
    }
    if (data.metodo !== undefined) payload.metodo = data.metodo;
    if (data.referencia !== undefined) payload.referencia = data.referencia;
    if (data.notas !== undefined) payload.notas = data.notas;

    let hitoBigIds = null;
    if (data.hitoIds !== undefined) {
      hitoBigIds = data.hitoIds.map((h) => toBig(h)).filter((x) => x != null);
      if (hitoBigIds.length !== data.hitoIds.length) {
        return bad(res, 'hitoIds contiene valores inválidos', 400);
      }
      // Validar pertenencia a la misma OC del pago.
      if (hitoBigIds.length > 0) {
        const hitos = await prisma.hito.findMany({
          where: { id: { in: hitoBigIds } },
          include: { ocItem: { select: { ocId: true } } },
        });
        if (hitos.length !== hitoBigIds.length) {
          return bad(res, 'Alguno de los hitoIds no existe', 404);
        }
        const fueraDeOc = hitos.filter((h) => h.ocItem.ocId !== existing.ocId);
        if (fueraDeOc.length > 0) {
          return bad(res, 'Hay hitos que no pertenecen a la OC de este pago', 400);
        }
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.pago.update({ where: { id }, data: payload });
      if (hitoBigIds !== null) {
        await tx.pagoHito.deleteMany({ where: { pagoId: id } });
        if (hitoBigIds.length > 0) {
          await tx.pagoHito.createMany({
            data: hitoBigIds.map((hitoId) => ({ pagoId: id, hitoId })),
          });
        }
      }
      return tx.pago.findUnique({
        where: { id },
        include: {
          oc: { select: { id: true, numeroOc: true, estado: true } },
          hitosRelacionados: { include: { hito: true } },
        },
      });
    });
    return res.json(updated);
  } catch (err) {
    logErr('updatePago', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function deletePago(req, res) {
  try {
    if (!ROLES_DELETE.has(req.user?.role)) {
      return bad(res, 'Solo admin puede eliminar pagos', 403);
    }
    const id = toBig(req.params.id);
    if (id == null) return bad(res, 'id inválido', 400);

    const existing = await prisma.pago.findUnique({ where: { id } });
    if (!existing) return bad(res, 'Pago no encontrado', 404);
    if (existing.fechaRealizada != null) {
      return res.status(409).json({
        error: 'Pago ya marcado como pagado: desmarque antes de eliminar',
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.pagoHito.deleteMany({ where: { pagoId: id } });
      await tx.pago.delete({ where: { id } });
    });
    return res.status(204).end();
  } catch (err) {
    logErr('deletePago', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function marcarPagado(req, res) {
  try {
    if (!ROLES_MARCAR.has(req.user?.role)) {
      return bad(res, 'Solo admin/supervisor pueden marcar pagos como pagados', 403);
    }
    const id = toBig(req.params.id);
    if (id == null) return bad(res, 'id inválido', 400);

    const parsed = marcarPagadoSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return bad(res, `Payload inválido: ${zodMsg(parsed)}`, 400);
    }
    const { fechaRealizada } = parsed.data;
    const marcadoPorId = req.user?.id != null ? toBig(req.user.id) : null;

    const result = await markPaid(prisma, {
      pagoId: id,
      fechaRealizada,
      marcadoPorId,
    });
    return res.json(result);
  } catch (err) {
    if (err.status && err.status < 500) {
      return res.status(err.status).json({
        error: err.message,
        ...(err.code ? { code: err.code } : {}),
      });
    }
    logErr('marcarPagado', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function desmarcarPagado(req, res) {
  try {
    if (!ROLES_DESMARCAR.has(req.user?.role)) {
      return bad(res, 'Solo admin puede desmarcar pagos', 403);
    }
    const id = toBig(req.params.id);
    if (id == null) return bad(res, 'id inválido', 400);

    const result = await unmarkPaid(prisma, { pagoId: id });
    return res.json(result);
  } catch (err) {
    if (err.status && err.status < 500) {
      return res.status(err.status).json({
        error: err.message,
        ...(err.code ? { code: err.code } : {}),
      });
    }
    logErr('desmarcarPagado', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ---------------------------------------------------------------------------
// HITOS
// ---------------------------------------------------------------------------

export async function listHitosByOc(req, res) {
  try {
    const ocId = toBig(req.params.ocId);
    if (ocId == null) return bad(res, 'ocId inválido', 400);
    const oc = await prisma.ordenCompra.findUnique({ where: { id: ocId } });
    if (!oc) return bad(res, 'OC no encontrada', 404);

    const items = await prisma.ordenCompraItem.findMany({
      where: { ocId },
      orderBy: { orden: 'asc' },
      include: {
        material: { select: { id: true, nombreCanonico: true, tipo: true } },
        hitos: { orderBy: { orden: 'asc' } },
      },
    });

    return res.json(items);
  } catch (err) {
    logErr('listHitosByOc', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function createHito(req, res) {
  try {
    if (!ROLES_HITO_WRITE.has(req.user?.role)) {
      return bad(res, 'Solo admin/supervisor pueden crear hitos', 403);
    }
    const ocId = toBig(req.params.ocId);
    const itemId = toBig(req.params.itemId);
    if (ocId == null || itemId == null) return bad(res, 'ids inválidos', 400);

    const parsed = createHitoSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return bad(res, `Payload inválido: ${zodMsg(parsed)}`, 400);
    }
    const data = parsed.data;

    const item = await prisma.ordenCompraItem.findUnique({
      where: { id: itemId },
      include: { material: { select: { tipo: true } } },
    });
    if (!item) return bad(res, 'Item de OC no encontrado', 404);
    if (item.ocId !== ocId) {
      return bad(res, 'El item no pertenece a la OC indicada', 400);
    }
    // Si el item tiene material, debe ser de tipo `servicio`. Si no tiene
    // material (ad-hoc), permitimos hitos sin validar tipo (flexibilidad).
    if (item.material && item.material.tipo !== 'servicio') {
      return res.status(409).json({
        error: 'Hitos solo aplican a items de tipo servicio o ad-hoc',
        materialTipo: item.material.tipo,
      });
    }

    const fechaEstimada = parseDateOrNull(data.fechaEstimada);

    const hito = await prisma.hito.create({
      data: {
        ocItemId: itemId,
        nombre: data.nombre,
        monto: data.monto != null ? toDec(data.monto) : null,
        fechaEstimada,
        orden: data.orden ?? 0,
        notas: data.notas ?? null,
      },
    });
    return res.status(201).json(hito);
  } catch (err) {
    logErr('createHito', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function updateHito(req, res) {
  try {
    if (!ROLES_HITO_WRITE.has(req.user?.role)) {
      return bad(res, 'Solo admin/supervisor pueden editar hitos', 403);
    }
    const hitoId = toBig(req.params.hitoId);
    if (hitoId == null) return bad(res, 'hitoId inválido', 400);

    const parsed = updateHitoSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return bad(res, `Payload inválido: ${zodMsg(parsed)}`, 400);
    }
    const data = parsed.data;

    const existing = await prisma.hito.findUnique({ where: { id: hitoId } });
    if (!existing) return bad(res, 'Hito no encontrado', 404);

    const payload = {};
    if (data.nombre !== undefined) payload.nombre = data.nombre;
    if (data.monto !== undefined) payload.monto = data.monto != null ? toDec(data.monto) : null;
    if (data.fechaEstimada !== undefined) payload.fechaEstimada = parseDateOrNull(data.fechaEstimada);
    if (data.orden !== undefined) payload.orden = data.orden;
    if (data.notas !== undefined) payload.notas = data.notas;

    const updated = await prisma.hito.update({ where: { id: hitoId }, data: payload });
    return res.json(updated);
  } catch (err) {
    logErr('updateHito', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function completarHito(req, res) {
  try {
    if (!ROLES_HITO_WRITE.has(req.user?.role)) {
      return bad(res, 'Solo admin/supervisor pueden completar hitos', 403);
    }
    const hitoId = toBig(req.params.hitoId);
    if (hitoId == null) return bad(res, 'hitoId inválido', 400);

    const existing = await prisma.hito.findUnique({ where: { id: hitoId } });
    if (!existing) return bad(res, 'Hito no encontrado', 404);
    if (existing.completado) {
      return res.json(existing);
    }

    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);
    const updated = await prisma.hito.update({
      where: { id: hitoId },
      data: { completado: true, fechaCompletado: now },
    });
    return res.json(updated);
  } catch (err) {
    logErr('completarHito', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
