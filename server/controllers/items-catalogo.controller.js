/**
 * Controllers de ItemCatalogo. CRUD + workflow de aprobación.
 *
 * Lazy creation: si `req.user.role === 'operativo'`, los items nuevos quedan
 * `estado=pendiente` y `sugeridoPorId=req.user.id`. Admin/supervisor crean
 * directo en `estado=aprobado`.
 *
 * Autocomplete: endpoint dedicado para typeahead, solo aprobados+activos.
 *
 * Slug: auto-generado con `slugify` + `uniqueSlug` (tabla `items_catalogo`,
 * maxLen 220 según schema).
 */

import { z } from 'zod';
import prisma from '../db.js';
import { slugify, uniqueSlug } from '../lib/slug.js';

const TIPOS = ['material', 'servicio'];
const ESTADOS = ['pendiente', 'aprobado', 'inactivo'];
const UNIDADES = [
  'saco', 'kg', 'm3', 'm2', 'm', 'unidad', 'varilla',
  'galon', 'litro', 'hora', 'dia', 'visita', 'global', 'mes',
];

const SLUG_TABLE = 'items_catalogo';
const SLUG_MAX = 220;

// --- Schemas ---------------------------------------------------------------

const createSchema = z.object({
  tipo: z.enum(TIPOS),
  nombreCanonico: z.string().trim().min(1, 'nombreCanonico requerido').max(200),
  unidad: z.enum(UNIDADES),
  alias: z.string().optional().or(z.literal('').transform(() => undefined)),
  categoriaSugeridaId: z
    .union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)])
    .optional(),
});

const updateSchema = z.object({
  nombreCanonico: z.string().trim().min(1).max(200).optional(),
  unidad: z.enum(UNIDADES).optional(),
  alias: z.string().optional().or(z.literal('').transform(() => undefined)),
  estado: z.enum(ESTADOS).optional(),
  categoriaSugeridaId: z
    .union([
      z.number().int().positive(),
      z.string().regex(/^\d+$/).transform(Number),
      z.null(),
    ])
    .optional(),
});

// --- Helpers ---------------------------------------------------------------

function serialize(it) {
  if (!it) return it;
  return {
    id: Number(it.id),
    tipo: it.tipo,
    nombreCanonico: it.nombreCanonico,
    unidad: it.unidad,
    categoriaSugeridaId: it.categoriaSugeridaId == null ? null : Number(it.categoriaSugeridaId),
    slug: it.slug,
    alias: it.alias,
    estado: it.estado,
    sugeridoPorId: it.sugeridoPorId == null ? null : Number(it.sugeridoPorId),
    activo: it.activo,
    createdAt: it.createdAt,
    updatedAt: it.updatedAt,
  };
}

function zodError(res, error) {
  return res.status(400).json({
    error: 'Validation error',
    issues: error.issues.map((i) => ({ path: i.path, message: i.message })),
  });
}

// --- Handlers --------------------------------------------------------------

export async function listItems(req, res) {
  try {
    const { tipo, estado, search, unidad } = req.query;

    const where = { activo: true };
    if (tipo && TIPOS.includes(tipo)) where.tipo = tipo;
    if (unidad && UNIDADES.includes(unidad)) where.unidad = unidad;
    if (estado && ESTADOS.includes(estado)) {
      where.estado = estado;
    } else if (!estado) {
      where.estado = 'aprobado';
    } else if (estado === 'all') {
      // sin filtro de estado
    }

    if (typeof search === 'string' && search.trim()) {
      const q = search.trim();
      where.OR = [
        { nombreCanonico: { contains: q, mode: 'insensitive' } },
        { alias: { contains: q, mode: 'insensitive' } },
      ];
    }

    const items = await prisma.itemCatalogo.findMany({
      where,
      orderBy: { nombreCanonico: 'asc' },
    });
    return res.json(items.map(serialize));
  } catch (err) {
    console.error('[items.list] unexpected error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function autocompleteItems(req, res) {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) return res.json([]);

    const where = {
      activo: true,
      estado: 'aprobado',
      OR: [
        { nombreCanonico: { startsWith: q, mode: 'insensitive' } },
        { nombreCanonico: { contains: q, mode: 'insensitive' } },
        { alias: { startsWith: q, mode: 'insensitive' } },
        { alias: { contains: q, mode: 'insensitive' } },
      ],
    };

    const items = await prisma.itemCatalogo.findMany({
      where,
      orderBy: { nombreCanonico: 'asc' },
      take: 10,
      select: { id: true, nombreCanonico: true, unidad: true, tipo: true },
    });
    return res.json(items.map((i) => ({
      id: Number(i.id),
      nombreCanonico: i.nombreCanonico,
      unidad: i.unidad,
      tipo: i.tipo,
    })));
  } catch (err) {
    console.error('[items.autocomplete] unexpected error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function getItem(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const it = await prisma.itemCatalogo.findUnique({ where: { id: BigInt(id) } });
    if (!it) return res.status(404).json({ error: 'Item no encontrado' });
    return res.json(serialize(it));
  } catch (err) {
    console.error('[items.get] unexpected error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function createItem(req, res) {
  try {
    const parsed = createSchema.safeParse(req.body || {});
    if (!parsed.success) return zodError(res, parsed.error);

    const role = req.user?.role;
    const isOperativo = role === 'operativo';
    const estado = isOperativo ? 'pendiente' : 'aprobado';

    const base = slugify(parsed.data.nombreCanonico, SLUG_MAX);
    const slug = await uniqueSlug(prisma, base || 'item', SLUG_TABLE, SLUG_MAX);

    const created = await prisma.itemCatalogo.create({
      data: {
        tipo: parsed.data.tipo,
        nombreCanonico: parsed.data.nombreCanonico,
        unidad: parsed.data.unidad,
        alias: parsed.data.alias ?? null,
        categoriaSugeridaId: parsed.data.categoriaSugeridaId
          ? BigInt(parsed.data.categoriaSugeridaId)
          : null,
        slug,
        estado,
        sugeridoPorId: isOperativo && req.user?.id ? BigInt(req.user.id) : null,
      },
    });
    return res.status(201).json(serialize(created));
  } catch (err) {
    console.error('[items.create] unexpected error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function updateItem(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const parsed = updateSchema.safeParse(req.body || {});
    if (!parsed.success) return zodError(res, parsed.error);

    const existing = await prisma.itemCatalogo.findUnique({ where: { id: BigInt(id) } });
    if (!existing) return res.status(404).json({ error: 'Item no encontrado' });

    const data = {};
    if (parsed.data.nombreCanonico !== undefined) {
      data.nombreCanonico = parsed.data.nombreCanonico;
      // Re-genera slug si cambió el nombre canónico.
      if (parsed.data.nombreCanonico !== existing.nombreCanonico) {
        const base = slugify(parsed.data.nombreCanonico, SLUG_MAX) || 'item';
        data.slug = await uniqueSlug(prisma, base, SLUG_TABLE, SLUG_MAX);
      }
    }
    if (parsed.data.unidad !== undefined) data.unidad = parsed.data.unidad;
    if (parsed.data.alias !== undefined) data.alias = parsed.data.alias ?? null;
    if (parsed.data.estado !== undefined) data.estado = parsed.data.estado;
    if (parsed.data.categoriaSugeridaId !== undefined) {
      data.categoriaSugeridaId = parsed.data.categoriaSugeridaId == null
        ? null
        : BigInt(parsed.data.categoriaSugeridaId);
    }

    const updated = await prisma.itemCatalogo.update({
      where: { id: BigInt(id) },
      data,
    });
    return res.json(serialize(updated));
  } catch (err) {
    console.error('[items.update] unexpected error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function approveItem(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const existing = await prisma.itemCatalogo.findUnique({ where: { id: BigInt(id) } });
    if (!existing) return res.status(404).json({ error: 'Item no encontrado' });
    if (existing.estado !== 'pendiente') {
      return res.status(400).json({
        error: `Solo items en estado=pendiente se pueden aprobar (estado actual: ${existing.estado})`,
      });
    }
    const updated = await prisma.itemCatalogo.update({
      where: { id: BigInt(id) },
      data: { estado: 'aprobado' },
    });
    return res.json(serialize(updated));
  } catch (err) {
    console.error('[items.approve] unexpected error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function deleteItem(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const existing = await prisma.itemCatalogo.findUnique({ where: { id: BigInt(id) } });
    if (!existing) return res.status(404).json({ error: 'Item no encontrado' });

    const updated = await prisma.itemCatalogo.update({
      where: { id: BigInt(id) },
      data: { activo: false },
    });
    return res.json(serialize(updated));
  } catch (err) {
    console.error('[items.delete] unexpected error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// Exports para tests unitarios.
export const __testables = {
  createSchema,
  updateSchema,
  serialize,
  TIPOS,
  ESTADOS,
  UNIDADES,
};
