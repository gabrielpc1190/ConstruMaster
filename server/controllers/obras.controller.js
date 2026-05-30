/**
 * Controllers para Obras + Categorías de Presupuesto + Presupuestos.
 *
 * Convenciones (ver `prisma/schema.prisma` y CLAUDE.md):
 * - IDs son BigInt en Prisma; convertimos `req.params.*` con `BigInt(...)`.
 * - Money se serializa como `{amount: string, currency: 'CRC'|'USD'}` en el
 *   wire format; internamente son dos columnas `montoAmount` + `montoCurrency`.
 * - El JSON serializer global de BigInt vive en `server/index.js`.
 */
import { z } from 'zod';

import prisma from '../db.js';
import { slugify, uniqueSlug } from '../lib/slug.js';
import { auditCreate, auditUpdate, auditDelete, getIp } from '../lib/audit.js';

// ===================== Audit wrappers =====================
// Los helpers de audit.js tiran si Prisma falla o si falta modelName.
// Wrappers locales: nunca propagan el error al handler (rule #4 de la spec).
function safeAuditCreate(args) {
  return auditCreate(prisma, args).catch((err) => console.error('[audit:obras]', err));
}
function safeAuditUpdate(args) {
  return auditUpdate(prisma, args).catch((err) => console.error('[audit:obras]', err));
}
function safeAuditDelete(args) {
  return auditDelete(prisma, args).catch((err) => console.error('[audit:obras]', err));
}

function userIdFromReq(req) {
  return req.user?.id != null ? BigInt(req.user.id) : null;
}

// ===================== Helpers =====================

/** Acepta números y strings; devuelve un BigInt válido o null si no parsea. */
function toBigIntOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** 400 helper para errores Zod. */
function zodError(res, err) {
  return res.status(400).json({
    error: 'Validation failed',
    issues: err.issues ?? err.errors ?? [],
  });
}

/** Acepta `2026-05-27` o ISO; devuelve Date o null. Inválido → throw. */
function parseDateOrNull(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    const e = new Error(`Invalid date for ${field}: ${value}`);
    e.status = 400;
    throw e;
  }
  return d;
}

// ===================== Money serialization =====================

/** Wire `{amount, currency}` Zod schema. */
const MoneySchema = z.object({
  amount: z.union([z.string(), z.number()]),
  currency: z.enum(['CRC', 'USD']),
});

function moneyOut(amount, currency) {
  if (amount === null || amount === undefined) return null;
  // Prisma Decimal expone `.toFixed` / `.toString`.
  const str = typeof amount === 'object' && typeof amount.toFixed === 'function'
    ? amount.toFixed(2)
    : String(amount);
  return { amount: str, currency };
}

// ===================== Serializers =====================

function serializeObra(o) {
  if (!o) return o;
  return {
    id: Number(o.id),
    clienteId: Number(o.clienteId),
    cliente: o.cliente
      ? { id: Number(o.cliente.id), nombre: o.cliente.nombre }
      : undefined,
    nombre: o.nombre,
    slug: o.slug,
    direccion: o.direccion,
    fechaInicio: o.fechaInicio ? o.fechaInicio.toISOString().slice(0, 10) : null,
    fechaFinEstimada: o.fechaFinEstimada
      ? o.fechaFinEstimada.toISOString().slice(0, 10)
      : null,
    monedaReporte: o.monedaReporte,
    estado: o.estado,
    nextOcSeq: o.nextOcSeq,
    notas: o.notas,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    categorias: o.categorias ? o.categorias.map(serializeCategoria) : undefined,
    presupuestos: o.presupuestos
      ? o.presupuestos.map(serializePresupuesto)
      : undefined,
  };
}

function serializeCategoria(c) {
  if (!c) return c;
  return {
    id: Number(c.id),
    obraId: Number(c.obraId),
    nombre: c.nombre,
    orden: c.orden,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function serializePresupuesto(p) {
  if (!p) return p;
  return {
    id: Number(p.id),
    obraId: Number(p.obraId),
    categoriaId: Number(p.categoriaId),
    categoria: p.categoria ? serializeCategoria(p.categoria) : undefined,
    monto: moneyOut(p.montoAmount, p.montoCurrency),
    notas: p.notas,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// ===================== Schemas =====================

const ObraEstadoEnum = z.enum(['planificada', 'en_curso', 'pausada', 'finalizada']);

const ObraCreateSchema = z.object({
  nombre: z.string().min(1).max(200),
  clienteId: z.union([z.string(), z.number()]),
  direccion: z.string().optional().nullable(),
  fechaInicio: z.string().optional().nullable(),
  fechaFinEstimada: z.string().optional().nullable(),
  monedaReporte: z.enum(['CRC', 'USD']).optional(),
  estado: ObraEstadoEnum.optional(),
  notas: z.string().optional().nullable(),
});

const ObraUpdateSchema = z.object({
  nombre: z.string().min(1).max(200).optional(),
  clienteId: z.union([z.string(), z.number()]).optional(),
  direccion: z.string().nullable().optional(),
  fechaInicio: z.string().nullable().optional(),
  fechaFinEstimada: z.string().nullable().optional(),
  monedaReporte: z.enum(['CRC', 'USD']).optional(),
  estado: ObraEstadoEnum.optional(),
  notas: z.string().nullable().optional(),
});

const CategoriaCreateSchema = z.object({
  nombre: z.string().min(1).max(100),
  orden: z.number().int().optional(),
});

const CategoriaUpdateSchema = z.object({
  nombre: z.string().min(1).max(100).optional(),
  orden: z.number().int().optional(),
});

const PresupuestoCreateSchema = z.object({
  categoriaId: z.union([z.string(), z.number()]),
  monto: MoneySchema,
  notas: z.string().nullable().optional(),
});

const PresupuestoUpdateSchema = z.object({
  monto: MoneySchema.optional(),
  notas: z.string().nullable().optional(),
});

// ===================== Obra =====================

export async function listObras(req, res) {
  try {
    const where = {};
    if (req.query.estado) {
      const parsed = ObraEstadoEnum.safeParse(req.query.estado);
      if (!parsed.success) {
        return res.status(400).json({ error: `Invalid estado: ${req.query.estado}` });
      }
      where.estado = parsed.data;
    }
    if (req.query.clienteId) {
      const cid = toBigIntOrNull(req.query.clienteId);
      if (cid === null) return res.status(400).json({ error: 'Invalid clienteId' });
      where.clienteId = cid;
    }

    const rows = await prisma.obra.findMany({
      where,
      include: { cliente: { select: { id: true, nombre: true } } },
      orderBy: { nombre: 'asc' },
    });
    return res.json(rows.map(serializeObra));
  } catch (err) {
    console.error('[obras.list] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function createObra(req, res) {
  try {
    const parsed = ObraCreateSchema.safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    const data = parsed.data;

    const clienteId = toBigIntOrNull(data.clienteId);
    if (clienteId === null) return res.status(400).json({ error: 'Invalid clienteId' });

    const cliente = await prisma.cliente.findUnique({ where: { id: clienteId } });
    if (!cliente) return res.status(400).json({ error: 'Cliente no existe' });

    const slug = await uniqueSlug(prisma, data.nombre);

    const created = await prisma.obra.create({
      data: {
        nombre: data.nombre,
        slug,
        clienteId,
        direccion: data.direccion ?? null,
        fechaInicio: parseDateOrNull(data.fechaInicio, 'fechaInicio'),
        fechaFinEstimada: parseDateOrNull(data.fechaFinEstimada, 'fechaFinEstimada'),
        monedaReporte: data.monedaReporte ?? 'USD',
        estado: data.estado ?? 'planificada',
        notas: data.notas ?? null,
      },
      include: { cliente: { select: { id: true, nombre: true } } },
    });

    console.log('[obras] create id=%s slug=%s nombre=%s', created.id, created.slug, created.nombre);
    safeAuditCreate({
      modelName: 'Obra',
      recordId: String(created.id),
      data: created,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.status(201).json(serializeObra(created));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('[obras.create] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function getObra(req, res) {
  try {
    const id = toBigIntOrNull(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });

    const obra = await prisma.obra.findUnique({
      where: { id },
      include: {
        cliente: { select: { id: true, nombre: true } },
        categorias: { orderBy: [{ orden: 'asc' }, { nombre: 'asc' }] },
        presupuestos: { include: { categoria: true } },
      },
    });
    if (!obra) return res.status(404).json({ error: 'Obra no encontrada' });
    return res.json(serializeObra(obra));
  } catch (err) {
    console.error('[obras.get] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function updateObra(req, res) {
  try {
    const id = toBigIntOrNull(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });

    const parsed = ObraUpdateSchema.safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    const data = parsed.data;

    // Slug es immutable: ignorar si llega.
    if ('slug' in (req.body || {})) {
      // No reject — sólo ignoramos.
    }

    const update = {};
    if (data.nombre !== undefined) update.nombre = data.nombre;
    if (data.clienteId !== undefined) {
      const cid = toBigIntOrNull(data.clienteId);
      if (cid === null) return res.status(400).json({ error: 'Invalid clienteId' });
      const c = await prisma.cliente.findUnique({ where: { id: cid } });
      if (!c) return res.status(400).json({ error: 'Cliente no existe' });
      update.clienteId = cid;
    }
    if (data.direccion !== undefined) update.direccion = data.direccion;
    if (data.fechaInicio !== undefined)
      update.fechaInicio = parseDateOrNull(data.fechaInicio, 'fechaInicio');
    if (data.fechaFinEstimada !== undefined)
      update.fechaFinEstimada = parseDateOrNull(data.fechaFinEstimada, 'fechaFinEstimada');
    if (data.monedaReporte !== undefined) update.monedaReporte = data.monedaReporte;
    if (data.estado !== undefined) update.estado = data.estado;
    if (data.notas !== undefined) update.notas = data.notas;

    const before = await prisma.obra.findUnique({ where: { id } });
    if (!before) return res.status(404).json({ error: 'Obra no encontrada' });

    const updated = await prisma.obra.update({
      where: { id },
      data: update,
      include: { cliente: { select: { id: true, nombre: true } } },
    });
    safeAuditUpdate({
      modelName: 'Obra',
      recordId: String(updated.id),
      before,
      after: updated,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.json(serializeObra(updated));
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Obra no encontrada' });
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('[obras.update] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

/**
 * DELETE soft. El schema no expone un estado 'cancelada', así que en su
 * lugar marcamos la obra como `finalizada` y prependeamos `[CANCELADA]` a las
 * notas para dejar trail. Si querés un hard delete, agregalo aparte. Devuelvo
 * 200 con el row resultante para que el front confirme.
 */
export async function deleteObra(req, res) {
  try {
    const id = toBigIntOrNull(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });

    const existing = await prisma.obra.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Obra no encontrada' });

    const tag = '[CANCELADA] ';
    const newNotas = existing.notas && existing.notas.startsWith(tag)
      ? existing.notas
      : `${tag}${existing.notas ?? ''}`.trim();

    const updated = await prisma.obra.update({
      where: { id },
      data: { estado: 'finalizada', notas: newNotas },
      include: { cliente: { select: { id: true, nombre: true } } },
    });
    console.log('[obras] delete-soft id=%s slug=%s', updated.id, updated.slug);
    // Soft-delete → auditamos como 'delete' con snapshot pre-cambio.
    safeAuditDelete({
      modelName: 'Obra',
      recordId: String(updated.id),
      snapshot: existing,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.json({ ok: true, obra: serializeObra(updated) });
  } catch (err) {
    console.error('[obras.delete] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ===================== Categorías =====================

export async function listCategorias(req, res) {
  try {
    const obraId = toBigIntOrNull(req.params.id);
    if (obraId === null) return res.status(400).json({ error: 'Invalid obra id' });

    const obra = await prisma.obra.findUnique({ where: { id: obraId } });
    if (!obra) return res.status(404).json({ error: 'Obra no encontrada' });

    const rows = await prisma.categoriaPresupuesto.findMany({
      where: { obraId },
      orderBy: [{ orden: 'asc' }, { nombre: 'asc' }],
    });
    return res.json(rows.map(serializeCategoria));
  } catch (err) {
    console.error('[obras.categorias.list] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function createCategoria(req, res) {
  try {
    const obraId = toBigIntOrNull(req.params.id);
    if (obraId === null) return res.status(400).json({ error: 'Invalid obra id' });

    const parsed = CategoriaCreateSchema.safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    const data = parsed.data;

    const obra = await prisma.obra.findUnique({ where: { id: obraId } });
    if (!obra) return res.status(404).json({ error: 'Obra no encontrada' });

    const created = await prisma.categoriaPresupuesto.create({
      data: {
        obraId,
        nombre: data.nombre,
        orden: data.orden ?? 0,
      },
    });
    console.log('[obras] categoria.create id=%s obraId=%s nombre=%s', created.id, obraId, created.nombre);
    safeAuditCreate({
      modelName: 'CategoriaPresupuesto',
      recordId: String(created.id),
      data: created,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.status(201).json(serializeCategoria(created));
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'Ya existe una categoría con ese nombre en la obra' });
    }
    console.error('[obras.categorias.create] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function updateCategoria(req, res) {
  try {
    const catId = toBigIntOrNull(req.params.catId);
    if (catId === null) return res.status(400).json({ error: 'Invalid categoria id' });

    const parsed = CategoriaUpdateSchema.safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    const data = parsed.data;

    const update = {};
    if (data.nombre !== undefined) update.nombre = data.nombre;
    if (data.orden !== undefined) update.orden = data.orden;

    const before = await prisma.categoriaPresupuesto.findUnique({ where: { id: catId } });
    if (!before) return res.status(404).json({ error: 'Categoría no encontrada' });

    const updated = await prisma.categoriaPresupuesto.update({
      where: { id: catId },
      data: update,
    });
    safeAuditUpdate({
      modelName: 'CategoriaPresupuesto',
      recordId: String(updated.id),
      before,
      after: updated,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.json(serializeCategoria(updated));
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Categoría no encontrada' });
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'Ya existe una categoría con ese nombre en la obra' });
    }
    console.error('[obras.categorias.update] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function deleteCategoria(req, res) {
  try {
    const catId = toBigIntOrNull(req.params.catId);
    if (catId === null) return res.status(400).json({ error: 'Invalid categoria id' });

    const snapshot = await prisma.categoriaPresupuesto.findUnique({ where: { id: catId } });
    await prisma.categoriaPresupuesto.delete({ where: { id: catId } });
    console.log('[obras] categoria.delete id=%s', catId);
    if (snapshot) {
      safeAuditDelete({
        modelName: 'CategoriaPresupuesto',
        recordId: String(snapshot.id),
        snapshot,
        userId: userIdFromReq(req),
        ipAddress: getIp(req),
      });
    }
    return res.json({ ok: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Categoría no encontrada' });
    if (err.code === 'P2003') {
      return res.status(409).json({
        error: 'No se puede eliminar la categoría: tiene presupuestos / OCs / RFQs asociadas',
      });
    }
    console.error('[obras.categorias.delete] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ===================== Presupuestos =====================

export async function listPresupuestos(req, res) {
  try {
    const obraId = toBigIntOrNull(req.params.id);
    if (obraId === null) return res.status(400).json({ error: 'Invalid obra id' });

    const obra = await prisma.obra.findUnique({ where: { id: obraId } });
    if (!obra) return res.status(404).json({ error: 'Obra no encontrada' });

    const rows = await prisma.presupuesto.findMany({
      where: { obraId },
      include: { categoria: true },
      orderBy: { id: 'asc' },
    });
    return res.json(rows.map(serializePresupuesto));
  } catch (err) {
    console.error('[obras.presupuestos.list] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

/**
 * Crea o upserta el presupuesto para `(obraId, categoriaId)`. Si ya existe,
 * sobrescribe el monto y las notas. Devuelve 201 nuevo / 200 existente.
 */
export async function createPresupuesto(req, res) {
  try {
    const obraId = toBigIntOrNull(req.params.id);
    if (obraId === null) return res.status(400).json({ error: 'Invalid obra id' });

    const parsed = PresupuestoCreateSchema.safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    const data = parsed.data;

    const categoriaId = toBigIntOrNull(data.categoriaId);
    if (categoriaId === null) return res.status(400).json({ error: 'Invalid categoriaId' });

    const cat = await prisma.categoriaPresupuesto.findUnique({ where: { id: categoriaId } });
    if (!cat) return res.status(400).json({ error: 'Categoría no existe' });
    if (cat.obraId !== obraId) {
      return res.status(400).json({ error: 'La categoría no pertenece a esta obra' });
    }

    const existing = await prisma.presupuesto.findUnique({
      where: { obraId_categoriaId: { obraId, categoriaId } },
    });

    const upsertData = {
      montoAmount: data.monto.amount,
      montoCurrency: data.monto.currency,
      notas: data.notas ?? null,
    };

    const row = await prisma.presupuesto.upsert({
      where: { obraId_categoriaId: { obraId, categoriaId } },
      update: upsertData,
      create: { obraId, categoriaId, ...upsertData },
      include: { categoria: true },
    });

    console.log(
      '[obras] presupuesto.upsert id=%s obraId=%s catId=%s monto=%s %s',
      row.id, obraId, categoriaId, upsertData.montoAmount, upsertData.montoCurrency,
    );
    if (existing) {
      safeAuditUpdate({
        modelName: 'Presupuesto',
        recordId: String(row.id),
        before: existing,
        after: row,
        userId: userIdFromReq(req),
        ipAddress: getIp(req),
      });
    } else {
      safeAuditCreate({
        modelName: 'Presupuesto',
        recordId: String(row.id),
        data: row,
        userId: userIdFromReq(req),
        ipAddress: getIp(req),
      });
    }
    return res.status(existing ? 200 : 201).json(serializePresupuesto(row));
  } catch (err) {
    console.error('[obras.presupuestos.create] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function updatePresupuesto(req, res) {
  try {
    const pId = toBigIntOrNull(req.params.pId);
    if (pId === null) return res.status(400).json({ error: 'Invalid presupuesto id' });

    const parsed = PresupuestoUpdateSchema.safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    const data = parsed.data;

    const update = {};
    if (data.monto !== undefined) {
      update.montoAmount = data.monto.amount;
      update.montoCurrency = data.monto.currency;
    }
    if (data.notas !== undefined) update.notas = data.notas;

    const before = await prisma.presupuesto.findUnique({ where: { id: pId } });
    if (!before) return res.status(404).json({ error: 'Presupuesto no encontrado' });

    const updated = await prisma.presupuesto.update({
      where: { id: pId },
      data: update,
      include: { categoria: true },
    });
    safeAuditUpdate({
      modelName: 'Presupuesto',
      recordId: String(updated.id),
      before,
      after: updated,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.json(serializePresupuesto(updated));
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Presupuesto no encontrado' });
    console.error('[obras.presupuestos.update] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function deletePresupuesto(req, res) {
  try {
    const pId = toBigIntOrNull(req.params.pId);
    if (pId === null) return res.status(400).json({ error: 'Invalid presupuesto id' });

    const snapshot = await prisma.presupuesto.findUnique({ where: { id: pId } });
    await prisma.presupuesto.delete({ where: { id: pId } });
    console.log('[obras] presupuesto.delete id=%s', pId);
    if (snapshot) {
      safeAuditDelete({
        modelName: 'Presupuesto',
        recordId: String(snapshot.id),
        snapshot,
        userId: userIdFromReq(req),
        ipAddress: getIp(req),
      });
    }
    return res.json({ ok: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Presupuesto no encontrado' });
    console.error('[obras.presupuestos.delete] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// Exporto los serializers para los tests / otros controllers.
export const __internals = {
  serializeObra,
  serializeCategoria,
  serializePresupuesto,
  slugify,
  moneyOut,
};
