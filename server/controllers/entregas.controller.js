/**
 * Controllers de Entregas (recepción de material en bodega) + fotos.
 *
 * Decisiones:
 *  - Patrón de 2 pasos para fotos: primero POST JSON crea la entrega (sin
 *    fotos); luego POST multipart /entregas/:id/fotos sube las imágenes. Más
 *    simple/testeable que multipart mixto (el frontend lo hace en serie).
 *  - Decimal/BigInt → number/string en la respuesta JSON. BigInt.prototype.toJSON
 *    está monkey-patched globalmente, pero igual lo serializamos explícito por
 *    seguridad y para mantener forma estable.
 *  - El controller borra las fotos del disco al borrar una entrega (las rows
 *    se borran por cascade del schema).
 *  - PUT no permite cambiar items (la spec lo deja explícito): para eso,
 *    eliminar y recrear.
 *  - GET de archivo de foto: stream raw con Content-Type derivado de la
 *    extensión. El frontend hace fetch + blob (token en header).
 */

import fs from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { extname } from 'node:path';

import { z } from 'zod';

import prisma from '../db.js';
import {
  createEntrega,
  pendientesPorItem,
  attachFotosToEntrega,
  deleteEntrega as svcDeleteEntrega,
} from '../services/entrega-flow.js';
import { absoluteFromUploads } from '../lib/uploads.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const itemSchema = z.object({
  ocItemId: z.union([z.number(), z.string(), z.bigint()]).nullish(),
  materialId: z.union([z.number(), z.string(), z.bigint()]).nullish(),
  descripcion: z.string().trim().min(1).max(300),
  cantidad: z.union([z.number(), z.string()]),
  unidad: z.string().trim().min(1).max(20),
  notas: z.string().nullish(),
});

const createSchema = z.object({
  bodegaDestinoId: z.union([z.number(), z.string(), z.bigint()]).nullish(),
  fecha: z.union([z.string(), z.date()]),
  recibidoPor: z.string().trim().min(1).max(120),
  items: z.array(itemSchema).min(1),
  notas: z.string().nullish(),
});

const updateSchema = z.object({
  fecha: z.union([z.string(), z.date()]).optional(),
  recibidoPor: z.string().trim().min(1).max(120).optional(),
  bodegaDestinoId: z.union([z.number(), z.string(), z.bigint()]).nullish().optional(),
  notas: z.string().nullish().optional(),
});

const listQuerySchema = z.object({
  ocId: z.coerce.bigint().optional(),
  desde: z.string().optional(),
  hasta: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseIdParam(value, name = 'id') {
  if (value == null || value === '') {
    const err = new Error(`Parámetro "${name}" requerido`);
    err.status = 400;
    throw err;
  }
  try {
    return BigInt(value);
  } catch {
    const err = new Error(`Parámetro "${name}" inválido: ${value}`);
    err.status = 400;
    throw err;
  }
}

async function safeUnlink(absPath) {
  try {
    await unlink(absPath);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn(`[entregas] no se pudo borrar archivo ${absPath}: ${err.message}`);
    }
  }
}

function decStr(v) {
  if (v == null) return null;
  return typeof v === 'string' ? v : String(v);
}

function dateISODateOnly(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function entregaItemToJson(it) {
  return {
    id: Number(it.id),
    entregaId: Number(it.entregaId),
    ocItemId: it.ocItemId != null ? Number(it.ocItemId) : null,
    materialId: it.materialId != null ? Number(it.materialId) : null,
    descripcion: it.descripcion,
    cantidad: decStr(it.cantidad),
    unidad: it.unidad,
    notas: it.notas ?? null,
    material: it.material
      ? {
          id: Number(it.material.id),
          nombreCanonico: it.material.nombreCanonico,
          unidad: it.material.unidad,
        }
      : undefined,
  };
}

function entregaFotoToJson(f) {
  return {
    id: Number(f.id),
    entregaId: Number(f.entregaId),
    archivoPath: f.archivoPath,
    subidaPorId: Number(f.subidaPorId),
    fecha: f.fecha?.toISOString?.() ?? f.fecha,
    subidaPor: f.subidaPor
      ? {
          id: Number(f.subidaPor.id),
          username: f.subidaPor.username,
          fullName: f.subidaPor.fullName ?? null,
        }
      : undefined,
  };
}

function entregaToJson(e) {
  if (!e) return null;
  return {
    id: Number(e.id),
    ocId: Number(e.ocId),
    bodegaDestinoId: e.bodegaDestinoId != null ? Number(e.bodegaDestinoId) : null,
    fecha: dateISODateOnly(e.fecha),
    recibidoPor: e.recibidoPor,
    registradaPorId: Number(e.registradaPorId),
    completa: !!e.completa,
    notas: e.notas ?? null,
    createdAt: e.createdAt?.toISOString?.() ?? null,
    updatedAt: e.updatedAt?.toISOString?.() ?? null,
    items: Array.isArray(e.items) ? e.items.map(entregaItemToJson) : undefined,
    fotos: Array.isArray(e.fotos) ? e.fotos.map(entregaFotoToJson) : undefined,
    _count: e._count
      ? {
          items: e._count.items ?? 0,
          fotos: e._count.fotos ?? 0,
        }
      : undefined,
    oc: e.oc
      ? {
          id: Number(e.oc.id),
          numeroOc: e.oc.numeroOc,
          proveedor: e.oc.proveedor
            ? { id: Number(e.oc.proveedor.id), nombre: e.oc.proveedor.nombre }
            : null,
        }
      : undefined,
    bodegaDestino: e.bodegaDestino
      ? { id: Number(e.bodegaDestino.id), nombre: e.bodegaDestino.nombre }
      : undefined,
    registradaPor: e.registradaPor
      ? {
          id: Number(e.registradaPor.id),
          username: e.registradaPor.username,
          fullName: e.registradaPor.fullName ?? null,
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// GET /api/entregas?ocId=&desde=&hasta=
// ---------------------------------------------------------------------------

export async function listEntregas(req, res) {
  try {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Query inválido', details: parsed.error.issues });
    }
    const { ocId, desde, hasta } = parsed.data;
    const where = {};
    if (ocId != null) where.ocId = ocId;
    if (desde || hasta) {
      where.fecha = {};
      if (desde) where.fecha.gte = new Date(desde);
      if (hasta) where.fecha.lte = new Date(hasta);
    }

    const rows = await prisma.entrega.findMany({
      where,
      include: {
        oc: { select: { id: true, numeroOc: true, proveedor: { select: { id: true, nombre: true } } } },
        bodegaDestino: { select: { id: true, nombre: true } },
        registradaPor: { select: { id: true, username: true, fullName: true } },
        _count: { select: { items: true, fotos: true } },
      },
      orderBy: [{ fecha: 'desc' }, { id: 'desc' }],
    });
    return res.json({ items: rows.map(entregaToJson) });
  } catch (err) {
    console.error('[entregas.list] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ---------------------------------------------------------------------------
// GET /api/entregas/:id
// ---------------------------------------------------------------------------

export async function getEntrega(req, res) {
  try {
    const id = parseIdParam(req.params.id);
    const row = await prisma.entrega.findUnique({
      where: { id },
      include: {
        oc: { select: { id: true, numeroOc: true, proveedor: { select: { id: true, nombre: true } } } },
        bodegaDestino: { select: { id: true, nombre: true } },
        registradaPor: { select: { id: true, username: true, fullName: true } },
        items: {
          orderBy: { id: 'asc' },
          include: {
            material: { select: { id: true, nombreCanonico: true, unidad: true } },
          },
        },
        fotos: {
          orderBy: { fecha: 'desc' },
          include: {
            subidaPor: { select: { id: true, username: true, fullName: true } },
          },
        },
      },
    });
    if (!row) return res.status(404).json({ error: 'Entrega no encontrada' });
    return res.json(entregaToJson(row));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[entregas.get] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ---------------------------------------------------------------------------
// POST /api/ocs/:ocId/entregas
// ---------------------------------------------------------------------------

export async function createEntregaHandler(req, res) {
  try {
    const ocId = parseIdParam(req.params.ocId, 'ocId');
    const parsed = createSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Body inválido', details: parsed.error.issues });
    }

    const { entrega } = await createEntrega(prisma, {
      ocId,
      bodegaDestinoId: parsed.data.bodegaDestinoId ?? null,
      fecha: parsed.data.fecha,
      recibidoPor: parsed.data.recibidoPor,
      registradaPorId: req.user.id,
      items: parsed.data.items,
      notas: parsed.data.notas ?? null,
    });

    // Re-leer con relaciones para devolver shape consistente.
    const full = await prisma.entrega.findUnique({
      where: { id: entrega.id },
      include: {
        oc: { select: { id: true, numeroOc: true, proveedor: { select: { id: true, nombre: true } } } },
        bodegaDestino: { select: { id: true, nombre: true } },
        registradaPor: { select: { id: true, username: true, fullName: true } },
        items: {
          orderBy: { id: 'asc' },
          include: { material: { select: { id: true, nombreCanonico: true, unidad: true } } },
        },
        fotos: true,
      },
    });
    return res.status(201).json(entregaToJson(full));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[entregas.create] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ---------------------------------------------------------------------------
// POST /api/entregas/:id/fotos  (multer .array('fotos', 10))
// ---------------------------------------------------------------------------

export async function uploadFotos(req, res) {
  try {
    const id = parseIdParam(req.params.id);
    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'Adjuntá al menos una foto (field "fotos[]")' });
    }

    const entrega = await prisma.entrega.findUnique({ where: { id }, select: { id: true } });
    if (!entrega) {
      // Limpieza: borrar lo que multer dejó.
      for (const f of files) await safeUnlink(f.path);
      return res.status(404).json({ error: 'Entrega no encontrada' });
    }

    const records = files.map((f) => {
      const absPath = f.path;
      // Multer ya escribió en uploads/entregas/<año>/<mes>/<entregaId>/<file>.
      // Calculamos el relativo a partir de UPLOADS_ROOT.
      // Importamos relativeToUploads de forma lazy para no romper test isolation.
      return { absPath, originalName: f.originalname };
    });

    // Materializar relativePath con relativeToUploads.
    const { relativeToUploads } = await import('../lib/uploads.js');
    const fileRecords = records.map((r) => ({
      relativePath: relativeToUploads(r.absPath),
      originalName: r.originalName,
    }));

    await attachFotosToEntrega(prisma, id, fileRecords, req.user.id);

    const full = await prisma.entrega.findUnique({
      where: { id },
      include: {
        oc: { select: { id: true, numeroOc: true, proveedor: { select: { id: true, nombre: true } } } },
        bodegaDestino: { select: { id: true, nombre: true } },
        registradaPor: { select: { id: true, username: true, fullName: true } },
        items: {
          orderBy: { id: 'asc' },
          include: { material: { select: { id: true, nombreCanonico: true, unidad: true } } },
        },
        fotos: {
          orderBy: { fecha: 'desc' },
          include: { subidaPor: { select: { id: true, username: true, fullName: true } } },
        },
      },
    });
    return res.status(201).json(entregaToJson(full));
  } catch (err) {
    // Limpieza best-effort si algo explotó.
    if (Array.isArray(req.files)) {
      for (const f of req.files) await safeUnlink(f.path);
    }
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[entregas.uploadFotos] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ---------------------------------------------------------------------------
// GET /api/entregas/:id/fotos/:fotoId/archivo
// ---------------------------------------------------------------------------

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.heif': 'image/heif',
  '.heic': 'image/heic',
  '.webp': 'image/webp',
};

export async function downloadFoto(req, res) {
  try {
    const entregaId = parseIdParam(req.params.id, 'id');
    const fotoId = parseIdParam(req.params.fotoId, 'fotoId');

    const foto = await prisma.entregaFoto.findUnique({
      where: { id: fotoId },
      select: { archivoPath: true, entregaId: true },
    });
    if (!foto) return res.status(404).json({ error: 'Foto no encontrada' });
    if (!sameIdLocal(foto.entregaId, entregaId)) {
      return res.status(404).json({ error: 'Foto no pertenece a la entrega indicada' });
    }
    if (!foto.archivoPath) {
      return res.status(404).json({ error: 'Foto sin archivo asociado' });
    }

    const absPath = absoluteFromUploads(foto.archivoPath);
    try {
      await stat(absPath);
    } catch {
      return res.status(404).json({ error: 'Archivo no encontrado en disco' });
    }

    const ext = extname(foto.archivoPath).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    // inline para que el navegador la muestre; el frontend va a usar blob.
    res.setHeader('Content-Disposition', `inline; filename="${foto.archivoPath.split('/').pop()}"`);
    const stream = fs.createReadStream(absPath);
    stream.on('error', (err) => {
      console.error('[entregas.downloadFoto] stream error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Error leyendo archivo' });
    });
    stream.pipe(res);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[entregas.downloadFoto] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

function sameIdLocal(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

// ---------------------------------------------------------------------------
// PUT /api/entregas/:id  (no items)
// ---------------------------------------------------------------------------

export async function updateEntregaHandler(req, res) {
  try {
    const id = parseIdParam(req.params.id);
    const parsed = updateSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Body inválido', details: parsed.error.issues });
    }
    const data = {};
    if (parsed.data.fecha !== undefined) data.fecha = new Date(parsed.data.fecha);
    if (parsed.data.recibidoPor !== undefined) data.recibidoPor = parsed.data.recibidoPor;
    if (parsed.data.bodegaDestinoId !== undefined) {
      data.bodegaDestinoId = parsed.data.bodegaDestinoId != null
        ? BigInt(parsed.data.bodegaDestinoId)
        : null;
    }
    if (parsed.data.notas !== undefined) data.notas = parsed.data.notas ?? null;

    const existing = await prisma.entrega.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Entrega no encontrada' });

    const updated = await prisma.entrega.update({
      where: { id },
      data,
      include: {
        oc: { select: { id: true, numeroOc: true, proveedor: { select: { id: true, nombre: true } } } },
        bodegaDestino: { select: { id: true, nombre: true } },
        registradaPor: { select: { id: true, username: true, fullName: true } },
        items: {
          orderBy: { id: 'asc' },
          include: { material: { select: { id: true, nombreCanonico: true, unidad: true } } },
        },
        fotos: {
          orderBy: { fecha: 'desc' },
          include: { subidaPor: { select: { id: true, username: true, fullName: true } } },
        },
      },
    });
    return res.json(entregaToJson(updated));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[entregas.update] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/entregas/:id  (admin only)
// ---------------------------------------------------------------------------

export async function deleteEntregaHandler(req, res) {
  try {
    const id = parseIdParam(req.params.id);

    // svcDeleteEntrega borra cascade (schema) + reajusta OC y devuelve paths.
    const result = await svcDeleteEntrega(prisma, id);

    // Limpiar archivos físicos de fotos.
    for (const rel of result.fotoPaths) {
      try {
        const abs = absoluteFromUploads(rel);
        await safeUnlink(abs);
      } catch (e) {
        console.warn(`[entregas.delete] no se pudo limpiar ${rel}: ${e.message}`);
      }
    }
    return res.json({
      ok: true,
      ocId: result.ocId,
      prevOcEstado: result.prevEstado,
      nextOcEstado: result.nextEstado,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[entregas.delete] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ---------------------------------------------------------------------------
// GET /api/ocs/:ocId/pendientes
// ---------------------------------------------------------------------------

export async function getPendientes(req, res) {
  try {
    const ocId = parseIdParam(req.params.ocId, 'ocId');
    const oc = await prisma.ordenCompra.findUnique({
      where: { id: ocId },
      select: { id: true, numeroOc: true, estado: true },
    });
    if (!oc) return res.status(404).json({ error: 'OC no encontrada' });

    const items = await pendientesPorItem(prisma, ocId);
    return res.json({
      ocId: Number(oc.id),
      numeroOc: oc.numeroOc,
      estado: oc.estado,
      items,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[entregas.pendientes] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
