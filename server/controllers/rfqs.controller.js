/**
 * [compras] Solicitudes de Cotización (SC, modelo `SolicitudCotizacion`).
 *
 * El operativo arma una SC con descripción + obra + categoría + fecha
 * requerida; supervisores/admins reciben cotizaciones de varios proveedores
 * contra esa misma SC (cada `Cotizacion` apunta opcionalmente a `rfqId`).
 * Cuando se aprueba una cotización vinculada, `oc-flow.approveCotizacion`
 * cierra la SC (`estado='cerrada'`). Acá manejamos sólo create/read/update/
 * cancel — la transición a `cerrada` vive en `services/oc-flow.js`.
 *
 * Endpoints:
 *   - list      GET    /api/rfqs
 *   - detail    GET    /api/rfqs/:id
 *   - create    POST   /api/rfqs           (admin + supervisor + operativo)
 *   - update    PUT    /api/rfqs/:id       (solo en estado 'abierta')
 *   - cancelar  POST   /api/rfqs/:id/cancelar  (admin + supervisor)
 *
 * Nota: la URL pública es `/api/rfqs` (matchea el campo Prisma `rfqId` en
 * `Cotizacion` y mantiene paridad con el código). En la UI hablamos siempre
 * de "Solicitud de cotización", nunca "RFQ".
 */
import { z } from 'zod';
import prisma from '../db.js';
import { auditCreate, auditUpdate, getIp } from '../lib/audit.js';

function safeAuditCreate(args) {
  return auditCreate(prisma, args).catch((err) => console.error('[audit:rfqs]', err));
}
function safeAuditUpdate(args) {
  return auditUpdate(prisma, args).catch((err) => console.error('[audit:rfqs]', err));
}
function userIdFromReq(req) {
  return req.user?.id != null ? BigInt(req.user.id) : null;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const createSchema = z.object({
  obraId: z.union([z.number(), z.string()]),
  categoriaId: z.union([z.number(), z.string()]),
  descripcion: z.string().trim().min(1, 'descripcion requerida').max(2000),
  fechaRequerida: z.string().optional().nullable().or(z.literal('').transform(() => undefined)),
  notas: z.string().optional().nullable().or(z.literal('').transform(() => undefined)),
});

const updateSchema = z.object({
  descripcion: z.string().trim().min(1).max(2000).optional(),
  fechaRequerida: z.string().optional().nullable().or(z.literal('').transform(() => undefined)),
  notas: z.string().optional().nullable().or(z.literal('').transform(() => undefined)),
});

const cancelSchema = z.object({
  motivo: z.string().trim().max(500).optional().nullable().or(z.literal('').transform(() => undefined)),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROLES_CREATE = new Set(['admin', 'supervisor', 'operativo']);
const ROLES_CANCEL = new Set(['admin', 'supervisor']);

function toBig(v) {
  try { return v == null ? null : BigInt(v); } catch { return null; }
}

function parseDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function bad(res, msg, status = 400) {
  return res.status(status).json({ error: msg });
}

function logHandlerError(handler, err) {
  console.error(`[rfqs] ${handler} error:`, err);
}

// Incluye estándar para list (no carga cotizaciones, solo el count).
const LIST_INCLUDE = {
  obra: { select: { id: true, nombre: true, slug: true } },
  categoria: { select: { id: true, nombre: true } },
  creadaPor: { select: { id: true, username: true, fullName: true } },
  _count: { select: { cotizaciones: true } },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function listRfqs(req, res) {
  try {
    const { obraId, estado, search } = req.query ?? {};
    const where = {};
    if (obraId) {
      const id = toBig(obraId);
      if (id != null) where.obraId = id;
    }
    if (estado) where.estado = String(estado);
    if (search && String(search).trim()) {
      where.descripcion = { contains: String(search).trim(), mode: 'insensitive' };
    }

    const rows = await prisma.solicitudCotizacion.findMany({
      where,
      include: LIST_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return res.json(rows);
  } catch (err) {
    logHandlerError('listRfqs', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function getRfq(req, res) {
  try {
    const id = toBig(req.params.id);
    if (id == null) return bad(res, 'id inválido', 400);

    const row = await prisma.solicitudCotizacion.findUnique({
      where: { id },
      include: {
        obra: { select: { id: true, nombre: true, slug: true } },
        categoria: { select: { id: true, nombre: true } },
        creadaPor: { select: { id: true, username: true, fullName: true } },
        cotizaciones: {
          include: {
            proveedor: { select: { id: true, nombre: true, identificacion: true } },
            _count: { select: { items: true } },
          },
          orderBy: [{ fecha: 'desc' }, { createdAt: 'desc' }],
        },
        _count: { select: { cotizaciones: true } },
      },
    });
    if (!row) return bad(res, 'Solicitud de cotización no encontrada', 404);
    return res.json(row);
  } catch (err) {
    logHandlerError('getRfq', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function createRfq(req, res) {
  try {
    if (!ROLES_CREATE.has(req.user?.role)) {
      return bad(res, 'No autorizado para crear solicitudes de cotización', 403);
    }

    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return bad(res, `Payload inválido: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 400);
    }
    const data = parsed.data;

    const obraId = toBig(data.obraId);
    const categoriaId = toBig(data.categoriaId);
    if (obraId == null || categoriaId == null) return bad(res, 'obraId/categoriaId inválidos', 400);

    const creadaPorId = toBig(req.user?.id);
    if (creadaPorId == null) return bad(res, 'Usuario inválido', 401);

    // FK existence checks (Prisma errores crípticos sin esto).
    const [obra, categoria] = await Promise.all([
      prisma.obra.findUnique({ where: { id: obraId } }),
      prisma.categoriaPresupuesto.findUnique({ where: { id: categoriaId } }),
    ]);
    if (!obra) return bad(res, 'Obra no encontrada', 404);
    if (!categoria) return bad(res, 'Categoría no encontrada', 404);
    if (categoria.obraId !== obraId) {
      return bad(res, 'La categoría no pertenece a la obra indicada', 400);
    }

    const fechaRequerida = parseDateOrNull(data.fechaRequerida);

    const created = await prisma.solicitudCotizacion.create({
      data: {
        obraId,
        categoriaId,
        descripcion: data.descripcion,
        fechaRequerida,
        notas: data.notas ?? null,
        creadaPorId,
        estado: 'abierta', // siempre — ignoramos cualquier override del body
      },
      include: LIST_INCLUDE,
    });

    console.log(`[rfqs] SC creada id=${created.id} obra=${obraId} categoria=${categoriaId}`);
    const { obra: _co, categoria: _cc, creadaPor: _ccp, _count: _ccount, ...createdScalar } = created;
    safeAuditCreate({
      modelName: 'SolicitudCotizacion',
      recordId: String(created.id),
      data: createdScalar,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.status(201).json(created);
  } catch (err) {
    logHandlerError('createRfq', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function updateRfq(req, res) {
  try {
    if (!ROLES_CREATE.has(req.user?.role)) {
      return bad(res, 'No autorizado', 403);
    }
    const id = toBig(req.params.id);
    if (id == null) return bad(res, 'id inválido', 400);

    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return bad(res, `Payload inválido: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 400);
    }

    const existing = await prisma.solicitudCotizacion.findUnique({ where: { id } });
    if (!existing) return bad(res, 'Solicitud de cotización no encontrada', 404);
    if (existing.estado !== 'abierta') {
      return res.status(409).json({
        error: 'Solo se pueden editar solicitudes en estado abierta',
        estado: existing.estado,
      });
    }

    const data = parsed.data;
    const payload = {};
    if (data.descripcion !== undefined) payload.descripcion = data.descripcion;
    if (data.fechaRequerida !== undefined) payload.fechaRequerida = parseDateOrNull(data.fechaRequerida);
    if (data.notas !== undefined) payload.notas = data.notas ?? null;

    const updated = await prisma.solicitudCotizacion.update({
      where: { id },
      data: payload,
      include: LIST_INCLUDE,
    });
    const { obra: _uo, categoria: _uc, creadaPor: _ucp, _count: _ucount, ...afterScalar } = updated;
    safeAuditUpdate({
      modelName: 'SolicitudCotizacion',
      recordId: String(updated.id),
      before: existing,
      after: afterScalar,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.json(updated);
  } catch (err) {
    logHandlerError('updateRfq', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function cancelRfq(req, res) {
  try {
    if (!ROLES_CANCEL.has(req.user?.role)) {
      return bad(res, 'Solo admin/supervisor pueden cancelar solicitudes', 403);
    }
    const id = toBig(req.params.id);
    if (id == null) return bad(res, 'id inválido', 400);

    const parsed = cancelSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return bad(res, 'Payload inválido', 400);
    }

    const existing = await prisma.solicitudCotizacion.findUnique({
      where: { id },
      include: {
        cotizaciones: { select: { id: true, estado: true } },
      },
    });
    if (!existing) return bad(res, 'Solicitud de cotización no encontrada', 404);

    if (existing.estado !== 'abierta') {
      return res.status(409).json({
        error: 'Solo se pueden cancelar solicitudes en estado abierta',
        estado: existing.estado,
      });
    }

    const tieneAprobada = existing.cotizaciones.some(c => c.estado === 'aprobada');
    if (tieneAprobada) {
      return res.status(409).json({
        error: 'No se puede cancelar: ya hay una cotización aprobada vinculada',
      });
    }

    const motivo = parsed.data.motivo?.trim();
    let notas = existing.notas ?? null;
    if (motivo) {
      const stamp = `[CANCELADA ${new Date().toISOString().slice(0, 10)}] ${motivo}`;
      notas = notas ? `${notas}\n${stamp}` : stamp;
    } else {
      // sin motivo, igual dejamos rastro
      const stamp = `[CANCELADA ${new Date().toISOString().slice(0, 10)}]`;
      notas = notas ? `${notas}\n${stamp}` : stamp;
    }

    const updated = await prisma.solicitudCotizacion.update({
      where: { id },
      data: { estado: 'cancelada', notas },
      include: LIST_INCLUDE,
    });
    console.log(`[rfqs] SC ${id} cancelada`);
    const { cotizaciones: _xc, ...beforeScalar } = existing;
    const { obra: _co, categoria: _cc, creadaPor: _ccp, _count: _ccount, ...afterScalar } = updated;
    safeAuditUpdate({
      modelName: 'SolicitudCotizacion',
      recordId: String(updated.id),
      before: beforeScalar,
      after: afterScalar,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.json(updated);
  } catch (err) {
    logHandlerError('cancelRfq', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// Exports agrupados para testear schemas en aislamiento.
export const __testables = {
  createSchema,
  updateSchema,
  cancelSchema,
};
