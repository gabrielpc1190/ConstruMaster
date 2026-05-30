/**
 * Controllers para Bodegas.
 *
 * Una bodega pertenece a un cliente y puede tener un responsable (User).
 * El delete es soft: `activo=false`. Para hard delete pasaríamos por una
 * ruta admin distinta — hoy no expuesta.
 */
import { z } from 'zod';

import prisma from '../db.js';
import { auditCreate, auditUpdate, auditDelete, getIp } from '../lib/audit.js';

function safeAuditCreate(args) {
  return auditCreate(prisma, args).catch((err) => console.error('[audit:bodegas]', err));
}
function safeAuditUpdate(args) {
  return auditUpdate(prisma, args).catch((err) => console.error('[audit:bodegas]', err));
}
function safeAuditDelete(args) {
  return auditDelete(prisma, args).catch((err) => console.error('[audit:bodegas]', err));
}
function userIdFromReq(req) {
  return req.user?.id != null ? BigInt(req.user.id) : null;
}

// ===================== Helpers =====================

function toBigIntOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function zodError(res, err) {
  return res.status(400).json({
    error: 'Validation failed',
    issues: err.issues ?? err.errors ?? [],
  });
}

function serializeBodega(b) {
  if (!b) return b;
  return {
    id: Number(b.id),
    clienteId: Number(b.clienteId),
    cliente: b.cliente
      ? { id: Number(b.cliente.id), nombre: b.cliente.nombre }
      : undefined,
    nombre: b.nombre,
    direccion: b.direccion,
    responsableId: b.responsableId !== null && b.responsableId !== undefined
      ? Number(b.responsableId)
      : null,
    responsable: b.responsable
      ? {
        id: Number(b.responsable.id),
        username: b.responsable.username,
        fullName: b.responsable.fullName,
      }
      : null,
    activo: b.activo,
    notas: b.notas,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

// ===================== Schemas =====================

const BodegaCreateSchema = z.object({
  clienteId: z.union([z.string(), z.number()]),
  nombre: z.string().min(1).max(120),
  direccion: z.string().nullable().optional(),
  responsableId: z.union([z.string(), z.number()]).nullable().optional(),
  notas: z.string().nullable().optional(),
});

const BodegaUpdateSchema = z.object({
  clienteId: z.union([z.string(), z.number()]).optional(),
  nombre: z.string().min(1).max(120).optional(),
  direccion: z.string().nullable().optional(),
  responsableId: z.union([z.string(), z.number()]).nullable().optional(),
  activo: z.boolean().optional(),
  notas: z.string().nullable().optional(),
});

// ===================== Handlers =====================

export async function listBodegas(req, res) {
  try {
    const where = {};
    if (req.query.clienteId) {
      const cid = toBigIntOrNull(req.query.clienteId);
      if (cid === null) return res.status(400).json({ error: 'Invalid clienteId' });
      where.clienteId = cid;
    }
    if (req.query.activo !== undefined && req.query.activo !== '') {
      // Acepta 'true'|'false'|'1'|'0'.
      const v = String(req.query.activo).toLowerCase();
      if (v === 'true' || v === '1') where.activo = true;
      else if (v === 'false' || v === '0') where.activo = false;
      else return res.status(400).json({ error: 'Invalid activo (expected true/false)' });
    }

    const rows = await prisma.bodega.findMany({
      where,
      include: {
        cliente: { select: { id: true, nombre: true } },
        responsable: { select: { id: true, username: true, fullName: true } },
      },
      orderBy: [{ clienteId: 'asc' }, { nombre: 'asc' }],
    });
    return res.json(rows.map(serializeBodega));
  } catch (err) {
    console.error('[bodegas.list] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function createBodega(req, res) {
  try {
    const parsed = BodegaCreateSchema.safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    const data = parsed.data;

    const clienteId = toBigIntOrNull(data.clienteId);
    if (clienteId === null) return res.status(400).json({ error: 'Invalid clienteId' });
    const cliente = await prisma.cliente.findUnique({ where: { id: clienteId } });
    if (!cliente) return res.status(400).json({ error: 'Cliente no existe' });

    let responsableId = null;
    if (data.responsableId !== null && data.responsableId !== undefined && data.responsableId !== '') {
      responsableId = toBigIntOrNull(data.responsableId);
      if (responsableId === null) return res.status(400).json({ error: 'Invalid responsableId' });
      const u = await prisma.user.findUnique({ where: { id: responsableId } });
      if (!u) return res.status(400).json({ error: 'Responsable no existe' });
    }

    const created = await prisma.bodega.create({
      data: {
        clienteId,
        nombre: data.nombre,
        direccion: data.direccion ?? null,
        responsableId,
        notas: data.notas ?? null,
      },
      include: {
        cliente: { select: { id: true, nombre: true } },
        responsable: { select: { id: true, username: true, fullName: true } },
      },
    });
    console.log('[bodegas] create id=%s clienteId=%s nombre=%s', created.id, clienteId, created.nombre);
    safeAuditCreate({
      modelName: 'Bodega',
      recordId: String(created.id),
      data: created,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.status(201).json(serializeBodega(created));
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'Ya existe una bodega con ese nombre para el cliente' });
    }
    console.error('[bodegas.create] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function getBodega(req, res) {
  try {
    const id = toBigIntOrNull(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });

    const row = await prisma.bodega.findUnique({
      where: { id },
      include: {
        cliente: { select: { id: true, nombre: true } },
        responsable: { select: { id: true, username: true, fullName: true } },
      },
    });
    if (!row) return res.status(404).json({ error: 'Bodega no encontrada' });
    return res.json(serializeBodega(row));
  } catch (err) {
    console.error('[bodegas.get] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function updateBodega(req, res) {
  try {
    const id = toBigIntOrNull(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });

    const parsed = BodegaUpdateSchema.safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    const data = parsed.data;

    const update = {};
    if (data.clienteId !== undefined) {
      const cid = toBigIntOrNull(data.clienteId);
      if (cid === null) return res.status(400).json({ error: 'Invalid clienteId' });
      const c = await prisma.cliente.findUnique({ where: { id: cid } });
      if (!c) return res.status(400).json({ error: 'Cliente no existe' });
      update.clienteId = cid;
    }
    if (data.nombre !== undefined) update.nombre = data.nombre;
    if (data.direccion !== undefined) update.direccion = data.direccion;
    if (data.responsableId !== undefined) {
      if (data.responsableId === null) {
        update.responsableId = null;
      } else {
        const rid = toBigIntOrNull(data.responsableId);
        if (rid === null) return res.status(400).json({ error: 'Invalid responsableId' });
        const u = await prisma.user.findUnique({ where: { id: rid } });
        if (!u) return res.status(400).json({ error: 'Responsable no existe' });
        update.responsableId = rid;
      }
    }
    if (data.activo !== undefined) update.activo = data.activo;
    if (data.notas !== undefined) update.notas = data.notas;

    const before = await prisma.bodega.findUnique({ where: { id } });
    if (!before) return res.status(404).json({ error: 'Bodega no encontrada' });

    const updated = await prisma.bodega.update({
      where: { id },
      data: update,
      include: {
        cliente: { select: { id: true, nombre: true } },
        responsable: { select: { id: true, username: true, fullName: true } },
      },
    });
    safeAuditUpdate({
      modelName: 'Bodega',
      recordId: String(updated.id),
      before,
      after: updated,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.json(serializeBodega(updated));
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Bodega no encontrada' });
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'Ya existe una bodega con ese nombre para el cliente' });
    }
    console.error('[bodegas.update] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function deleteBodega(req, res) {
  try {
    const id = toBigIntOrNull(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });

    const existing = await prisma.bodega.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Bodega no encontrada' });

    const updated = await prisma.bodega.update({
      where: { id },
      data: { activo: false },
      include: {
        cliente: { select: { id: true, nombre: true } },
        responsable: { select: { id: true, username: true, fullName: true } },
      },
    });
    console.log('[bodegas] delete-soft id=%s', updated.id);
    safeAuditDelete({
      modelName: 'Bodega',
      recordId: String(updated.id),
      snapshot: existing,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.json({ ok: true, bodega: serializeBodega(updated) });
  } catch (err) {
    console.error('[bodegas.delete] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export const __internals = { serializeBodega };
