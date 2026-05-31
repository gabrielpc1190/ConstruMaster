/**
 * [compras] OrdenesCompra controller.
 *
 * Endpoints:
 *   - list      GET    /api/ocs
 *   - detail    GET    /api/ocs/:id
 *   - update    PUT    /api/ocs/:id        (notas, pctAnticipo, tiempoEstimadoDias)
 *   - cancelar  POST   /api/ocs/:id/cancelar  (solo admin, sin pagos/entregas)
 *
 * Las OCs se crean SIEMPRE desde el flow de aprobación de Cotización
 * (`services/oc-flow.js`). Aquí no exponemos POST de creación directa: cualquier
 * OC fuera del flow rompería el correlativo + snapshot TC.
 */
import { z } from 'zod';
import prisma from '../db.js';
import { auditUpdate, getIp } from '../lib/audit.js';
import { ocOut } from '../lib/money.js';

function safeAuditUpdate(args) {
  return auditUpdate(prisma, args).catch((err) => console.error('[audit:ocs]', err));
}
function userIdFromReq(req) {
  return req.user?.id != null ? BigInt(req.user.id) : null;
}

const ROLES_UPDATE = new Set(['admin', 'supervisor']);
const ROLES_CANCEL = new Set(['admin']);

const updateSchema = z.object({
  notas: z.string().optional().nullable(),
  pctAnticipo: z.union([z.number(), z.string()]).optional().nullable(),
  tiempoEstimadoDias: z.number().int().nonnegative().optional().nullable(),
});

const cancelSchema = z.object({
  motivo: z.string().max(500).optional().nullable(),
});

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

function bad(res, msg, status = 400) {
  return res.status(status).json({ error: msg });
}

function logErr(handler, err) {
  console.error(`[compras] ${handler} error:`, err);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function listOcs(req, res) {
  try {
    const { obraId, proveedorId, estado } = req.query;
    const where = {};
    if (obraId) where.obraId = toBig(obraId) ?? undefined;
    if (proveedorId) where.proveedorId = toBig(proveedorId) ?? undefined;
    if (estado) {
      // Aceptar "autorizada,pagada,..." (CSV) además de un único estado.
      const list = String(estado).split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length === 1) where.estado = list[0];
      else if (list.length > 1) where.estado = { in: list };
    }

    const rows = await prisma.ordenCompra.findMany({
      where,
      orderBy: [{ fechaAprobacion: 'desc' }],
      include: {
        proveedor: true,
        obra: true,
        _count: { select: { items: true, pagos: true, entregas: true } },
      },
    });
    return res.json(rows.map((r) => ocOut(r)));
  } catch (err) {
    logErr('listOcs', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function getOc(req, res) {
  try {
    const id = toBig(req.params.id);
    if (id == null) return bad(res, 'id inválido', 400);
    const row = await prisma.ordenCompra.findUnique({
      where: { id },
      include: {
        items: { orderBy: { orden: 'asc' } },
        pagos: { orderBy: { fechaProgramada: 'desc' } },
        entregas: { orderBy: { fecha: 'desc' } },
        facturas: { orderBy: { createdAt: 'desc' } },
        categoria: true,
        proveedor: true,
        obra: true,
      },
    });
    if (!row) return bad(res, 'OC no encontrada', 404);
    return res.json(ocOut(row));
  } catch (err) {
    logErr('getOc', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function updateOc(req, res) {
  try {
    if (!ROLES_UPDATE.has(req.user?.role)) {
      return bad(res, 'Solo admin/supervisor pueden editar OCs', 403);
    }
    const id = toBig(req.params.id);
    if (id == null) return bad(res, 'id inválido', 400);

    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return bad(res, `Payload inválido: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 400);
    }

    const existing = await prisma.ordenCompra.findUnique({ where: { id } });
    if (!existing) return bad(res, 'OC no encontrada', 404);
    if (existing.estado === 'cancelada') {
      return res.status(409).json({ error: 'OC cancelada: no editable' });
    }

    const data = parsed.data;
    const payload = {};
    if (data.notas !== undefined) payload.notas = data.notas;
    if (data.pctAnticipo !== undefined) payload.pctAnticipo = data.pctAnticipo != null ? toDec(data.pctAnticipo) : null;
    if (data.tiempoEstimadoDias !== undefined) payload.tiempoEstimadoDias = data.tiempoEstimadoDias;

    const updated = await prisma.ordenCompra.update({
      where: { id },
      data: payload,
      include: {
        items: { orderBy: { orden: 'asc' } },
        proveedor: true,
        obra: true,
        categoria: true,
      },
    });
    const { items: _u_i, proveedor: _u_p, obra: _u_o, categoria: _u_c, ...afterScalar } = updated;
    safeAuditUpdate({
      modelName: 'OrdenCompra',
      recordId: String(updated.id),
      before: existing,
      after: afterScalar,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.json(ocOut(updated));
  } catch (err) {
    logErr('updateOc', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function cancelarOc(req, res) {
  try {
    if (!ROLES_CANCEL.has(req.user?.role)) {
      return bad(res, 'Solo admin puede cancelar OCs', 403);
    }
    const id = toBig(req.params.id);
    if (id == null) return bad(res, 'id inválido', 400);

    const parsed = cancelSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return bad(res, 'Payload inválido', 400);
    }

    const existing = await prisma.ordenCompra.findUnique({
      where: { id },
      include: { _count: { select: { pagos: true, entregas: true } } },
    });
    if (!existing) return bad(res, 'OC no encontrada', 404);
    if (existing.estado === 'cancelada') {
      return res.status(409).json({ error: 'OC ya está cancelada' });
    }
    if (existing._count.pagos > 0 || existing._count.entregas > 0) {
      return res.status(409).json({
        error: 'No se puede cancelar OC con pagos o entregas registradas',
        pagos: existing._count.pagos,
        entregas: existing._count.entregas,
      });
    }

    const motivo = parsed.data.motivo?.trim();
    let notas = existing.notas ?? null;
    if (motivo) {
      const stamp = `[CANCELACION ${new Date().toISOString().slice(0, 10)}] ${motivo}`;
      notas = notas ? `${notas}\n${stamp}` : stamp;
    }

    const updated = await prisma.ordenCompra.update({
      where: { id },
      data: { estado: 'cancelada', notas },
    });
    console.log(`[compras] OC ${id} cancelada`);
    // Cancelación de OC = transición importante; auditamos como update.
    const { _count: _ec, ...beforeScalar } = existing;
    safeAuditUpdate({
      modelName: 'OrdenCompra',
      recordId: String(updated.id),
      before: beforeScalar,
      after: updated,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.json(ocOut(updated));
  } catch (err) {
    logErr('cancelarOc', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
