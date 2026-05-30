/**
 * Controllers de Proveedores. CRUD con soft delete (`activo`).
 *
 * Validación: zod schemas inline. Identificación cubre cédula física (9),
 * jurídica (10) y DIMEX (11-12) con regex `^\d{9,12}$`.
 *
 * Permisos:
 * - list/detail: cualquier rol autenticado.
 * - create: admin + supervisor + operativo (lazy creation desde flujo de cotización).
 * - update: admin + supervisor.
 * - delete (soft): admin.
 */

import { z } from 'zod';
import prisma from '../db.js';
import { auditCreate, auditUpdate, auditDelete, getIp } from '../lib/audit.js';

function safeAuditCreate(args) {
  return auditCreate(prisma, args).catch((err) => console.error('[audit:proveedores]', err));
}
function safeAuditUpdate(args) {
  return auditUpdate(prisma, args).catch((err) => console.error('[audit:proveedores]', err));
}
function safeAuditDelete(args) {
  return auditDelete(prisma, args).catch((err) => console.error('[audit:proveedores]', err));
}
function userIdFromReq(req) {
  return req.user?.id != null ? BigInt(req.user.id) : null;
}

// --- Schemas ---------------------------------------------------------------

const identificacionSchema = z
  .string()
  .regex(/^\d{9,12}$/, 'Identificación debe ser 9-12 dígitos (cédula física, jurídica o DIMEX)')
  .optional()
  .or(z.literal('').transform(() => undefined));

const createSchema = z.object({
  nombre: z.string().trim().min(1, 'nombre requerido').max(200),
  identificacion: identificacionSchema,
  emailFacturacion: z.string().trim().email().max(254).optional().or(z.literal('').transform(() => undefined)),
  telefono: z.string().trim().max(30).optional().or(z.literal('').transform(() => undefined)),
  notas: z.string().optional().or(z.literal('').transform(() => undefined)),
});

const updateSchema = createSchema.partial();

// --- Helpers ---------------------------------------------------------------

function serialize(p) {
  if (!p) return p;
  return {
    id: Number(p.id),
    nombre: p.nombre,
    identificacion: p.identificacion,
    emailFacturacion: p.emailFacturacion,
    telefono: p.telefono,
    notas: p.notas,
    activo: p.activo,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function zodError(res, error) {
  return res.status(400).json({
    error: 'Validation error',
    issues: error.issues.map((i) => ({ path: i.path, message: i.message })),
  });
}

// --- Handlers --------------------------------------------------------------

export async function listProveedores(req, res) {
  try {
    const activoQuery = req.query.activo;
    let activo = true;
    if (activoQuery === 'false') activo = false;
    else if (activoQuery === 'all') activo = undefined;

    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    const where = {};
    if (activo !== undefined) where.activo = activo;
    if (search) {
      where.OR = [
        { nombre: { contains: search, mode: 'insensitive' } },
        { identificacion: { contains: search, mode: 'insensitive' } },
      ];
    }

    const items = await prisma.proveedor.findMany({
      where,
      orderBy: { nombre: 'asc' },
    });
    return res.json(items.map(serialize));
  } catch (err) {
    console.error('[proveedores.list] unexpected error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function getProveedor(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const p = await prisma.proveedor.findUnique({ where: { id: BigInt(id) } });
    if (!p) return res.status(404).json({ error: 'Proveedor no encontrado' });
    return res.json(serialize(p));
  } catch (err) {
    console.error('[proveedores.get] unexpected error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function createProveedor(req, res) {
  try {
    const parsed = createSchema.safeParse(req.body || {});
    if (!parsed.success) return zodError(res, parsed.error);

    const created = await prisma.proveedor.create({
      data: {
        nombre: parsed.data.nombre,
        identificacion: parsed.data.identificacion ?? null,
        emailFacturacion: parsed.data.emailFacturacion ?? null,
        telefono: parsed.data.telefono ?? null,
        notas: parsed.data.notas ?? null,
      },
    });
    safeAuditCreate({
      modelName: 'Proveedor',
      recordId: String(created.id),
      data: created,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.status(201).json(serialize(created));
  } catch (err) {
    console.error('[proveedores.create] unexpected error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function updateProveedor(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const parsed = updateSchema.safeParse(req.body || {});
    if (!parsed.success) return zodError(res, parsed.error);

    const existing = await prisma.proveedor.findUnique({ where: { id: BigInt(id) } });
    if (!existing) return res.status(404).json({ error: 'Proveedor no encontrado' });

    const data = {};
    if (parsed.data.nombre !== undefined) data.nombre = parsed.data.nombre;
    if (parsed.data.identificacion !== undefined) data.identificacion = parsed.data.identificacion ?? null;
    if (parsed.data.emailFacturacion !== undefined) data.emailFacturacion = parsed.data.emailFacturacion ?? null;
    if (parsed.data.telefono !== undefined) data.telefono = parsed.data.telefono ?? null;
    if (parsed.data.notas !== undefined) data.notas = parsed.data.notas ?? null;

    const updated = await prisma.proveedor.update({
      where: { id: BigInt(id) },
      data,
    });
    safeAuditUpdate({
      modelName: 'Proveedor',
      recordId: String(updated.id),
      before: existing,
      after: updated,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.json(serialize(updated));
  } catch (err) {
    console.error('[proveedores.update] unexpected error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function deleteProveedor(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const existing = await prisma.proveedor.findUnique({ where: { id: BigInt(id) } });
    if (!existing) return res.status(404).json({ error: 'Proveedor no encontrado' });

    const updated = await prisma.proveedor.update({
      where: { id: BigInt(id) },
      data: { activo: false },
    });
    safeAuditDelete({
      modelName: 'Proveedor',
      recordId: String(updated.id),
      snapshot: existing,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.json(serialize(updated));
  } catch (err) {
    console.error('[proveedores.delete] unexpected error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// Exports agrupados para testear sin levantar Express.
export const __testables = {
  createSchema,
  updateSchema,
  identificacionSchema,
  serialize,
};
