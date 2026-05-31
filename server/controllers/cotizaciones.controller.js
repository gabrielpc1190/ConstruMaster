/**
 * [compras] Cotizaciones controller.
 *
 * Endpoints públicos:
 *   - list      GET    /api/cotizaciones
 *   - create    POST   /api/cotizaciones
 *   - detail    GET    /api/cotizaciones/:id
 *   - update    PUT    /api/cotizaciones/:id   (solo en estados editables)
 *   - aprobar   POST   /api/cotizaciones/:id/aprobar  → delega en oc-flow
 *   - rechazar  POST   /api/cotizaciones/:id/rechazar
 *
 * El flow de aprobación vive en `services/oc-flow.js` para mantener este
 * controller delgado y testeable.
 */
import fs from 'node:fs';
import { unlink, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { z } from 'zod';
import prisma from '../db.js';
import { approveCotizacion } from '../services/oc-flow.js';
import { absoluteFromUploads, relativeToUploads } from '../lib/uploads.js';
import { auditCreate, auditUpdate, getIp } from '../lib/audit.js';
import { cotizacionOut, ocOut } from '../lib/money.js';

function safeAuditCreate(args) {
  return auditCreate(prisma, args).catch((err) => console.error('[audit:cotizaciones]', err));
}
function safeAuditUpdate(args) {
  return auditUpdate(prisma, args).catch((err) => console.error('[audit:cotizaciones]', err));
}
function userIdFromReq(req) {
  return req.user?.id != null ? BigInt(req.user.id) : null;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const moneyShape = z.object({
  amount: z.union([z.number(), z.string()]),
  currency: z.enum(['CRC', 'USD']),
});

const itemShape = z.object({
  materialId: z.union([z.number(), z.string()]).optional().nullable(),
  descripcion: z.string().min(1).max(300),
  cantidad: z.union([z.number(), z.string()]),
  unidad: z.string().min(1).max(20),
  precioUnitario: z.union([z.number(), z.string()]),
  subtotal: z.union([z.number(), z.string()]),
  ivaMonto: z.union([z.number(), z.string()]).optional(),
  codigoCabys: z.string().max(13).optional().nullable(),
  orden: z.number().int().optional(),
});

const createSchema = z.object({
  obraId: z.union([z.number(), z.string()]),
  proveedorId: z.union([z.number(), z.string()]),
  rfqId: z.union([z.number(), z.string()]).optional().nullable(),
  numeroCotizacion: z.string().min(1).max(80),
  fecha: z.string().min(1),
  fechaValidez: z.string().optional().nullable(),
  moneda: z.enum(['CRC', 'USD']).optional(),
  subtotal: moneyShape,
  iva: moneyShape,
  total: moneyShape,
  condicionesPago: z.string().max(200).optional().nullable(),
  plazoEntregaDias: z.number().int().nonnegative().optional().nullable(),
  pctAnticipo: z.union([z.number(), z.string()]).optional().nullable(),
  esEspecial: z.boolean().optional(),
  archivoPath: z.string().optional().nullable(),
  notas: z.string().optional().nullable(),
  items: z.array(itemShape).min(1, 'Al menos un item es requerido'),
});

const updateSchema = z.object({
  numeroCotizacion: z.string().min(1).max(80).optional(),
  fecha: z.string().optional(),
  fechaValidez: z.string().optional().nullable(),
  condicionesPago: z.string().max(200).optional().nullable(),
  plazoEntregaDias: z.number().int().nonnegative().optional().nullable(),
  pctAnticipo: z.union([z.number(), z.string()]).optional().nullable(),
  esEspecial: z.boolean().optional(),
  estado: z.enum(['recibida', 'en_revision', 'vencida']).optional(),
  archivoPath: z.string().optional().nullable(),
  notas: z.string().optional().nullable(),
});

const approveSchema = z.object({
  categoriaId: z.union([z.number(), z.string()]),
  fechaAprobacion: z.string().optional().nullable(),
});

const rejectSchema = z.object({
  motivo: z.string().max(500).optional().nullable(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROLES_CREATE = new Set(['admin', 'supervisor', 'operativo']);
const ROLES_APPROVE = new Set(['admin', 'supervisor']);
const ROLES_UPDATE = new Set(['admin', 'supervisor', 'operativo']);

const EDITABLE_ESTADOS = new Set(['recibida', 'en_revision']);
const MONEY_TOLERANCE = 1; // ₡1 (o USD 1) — el spec dice "tolerancia ₡1".

function toBig(v) {
  try {
    return v == null ? null : BigInt(v);
  } catch {
    return null;
  }
}

function toDec(v) {
  if (v == null || v === '') return null;
  // Prisma Decimal acepta number o string. Forzamos string para precisión.
  return typeof v === 'string' ? v : String(v);
}

function toDecNum(v) {
  if (v == null || v === '') return 0;
  return typeof v === 'number' ? v : Number(v);
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
  console.error(`[compras] ${handler} error:`, err);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function listCotizaciones(req, res) {
  try {
    const { obraId, proveedorId, estado, rfqId } = req.query;
    const where = {};
    if (obraId) where.obraId = toBig(obraId) ?? undefined;
    if (proveedorId) where.proveedorId = toBig(proveedorId) ?? undefined;
    if (estado) where.estado = String(estado);
    if (rfqId) where.rfqId = toBig(rfqId) ?? undefined;

    const rows = await prisma.cotizacion.findMany({
      where,
      orderBy: [{ fecha: 'desc' }, { createdAt: 'desc' }],
      include: { proveedor: true, obra: true },
    });
    return res.json(rows.map(cotizacionOut));
  } catch (err) {
    logHandlerError('listCotizaciones', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function getCotizacion(req, res) {
  try {
    const id = toBig(req.params.id);
    if (id == null) return bad(res, 'id inválido', 400);
    const row = await prisma.cotizacion.findUnique({
      where: { id },
      include: {
        items: { orderBy: { orden: 'asc' } },
        proveedor: true,
        obra: true,
        rfq: true,
        ocs: {
          select: { id: true, numeroOc: true, estado: true, fechaAprobacion: true },
          orderBy: { fechaAprobacion: 'desc' },
        },
      },
    });
    if (!row) return bad(res, 'Cotización no encontrada', 404);
    // Mapeo legacy: el frontend lee `cotizacion.oc` (singular). Tomamos la
    // OC más reciente generada por la aprobación de esta cotización.
    const out = cotizacionOut(row);
    out.oc = row.ocs && row.ocs.length > 0 ? row.ocs[0] : null;
    return res.json(out);
  } catch (err) {
    logHandlerError('getCotizacion', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function createCotizacion(req, res) {
  try {
    if (!ROLES_CREATE.has(req.user?.role)) {
      return bad(res, 'No autorizado para crear cotizaciones', 403);
    }

    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return bad(res, `Payload inválido: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 400);
    }
    const data = parsed.data;

    // Validar consistencia de moneda: subtotal, iva, total deben coincidir.
    const moneda = data.moneda ?? data.total.currency;
    if (data.subtotal.currency !== moneda || data.iva.currency !== moneda || data.total.currency !== moneda) {
      return bad(res, 'Moneda inconsistente entre subtotal/iva/total/moneda', 400);
    }

    // Validar sumas con tolerancia.
    const subtotalDoc = toDecNum(data.subtotal.amount);
    const ivaDoc = toDecNum(data.iva.amount);
    const totalDoc = toDecNum(data.total.amount);

    const sumItemsSubtotal = data.items.reduce((acc, it) => acc + toDecNum(it.subtotal), 0);
    const sumItemsIva = data.items.reduce((acc, it) => acc + toDecNum(it.ivaMonto), 0);

    if (Math.abs(sumItemsSubtotal - subtotalDoc) > MONEY_TOLERANCE) {
      return bad(res, `Suma de subtotales de items (${sumItemsSubtotal.toFixed(2)}) ≠ subtotal documento (${subtotalDoc.toFixed(2)})`, 400);
    }
    if (Math.abs((sumItemsSubtotal + sumItemsIva) - totalDoc) > MONEY_TOLERANCE) {
      return bad(res, `Suma items (sub+iva = ${(sumItemsSubtotal + sumItemsIva).toFixed(2)}) ≠ total documento (${totalDoc.toFixed(2)})`, 400);
    }

    const obraId = toBig(data.obraId);
    const proveedorId = toBig(data.proveedorId);
    const rfqId = data.rfqId != null ? toBig(data.rfqId) : null;
    if (obraId == null || proveedorId == null) return bad(res, 'obraId/proveedorId inválidos', 400);

    // Verificar FK existence rápido (Prisma da error críptico si no existe).
    const [obra, proveedor] = await Promise.all([
      prisma.obra.findUnique({ where: { id: obraId } }),
      prisma.proveedor.findUnique({ where: { id: proveedorId } }),
    ]);
    if (!obra) return bad(res, 'Obra no encontrada', 404);
    if (!proveedor) return bad(res, 'Proveedor no encontrado', 404);
    if (rfqId != null) {
      const rfq = await prisma.solicitudCotizacion.findUnique({ where: { id: rfqId } });
      if (!rfq) return bad(res, 'RFQ no encontrada', 404);
      if (rfq.obraId !== obraId) return bad(res, 'La RFQ no pertenece a la obra indicada', 400);
    }

    const fecha = parseDateOrNull(data.fecha);
    if (!fecha) return bad(res, 'fecha inválida', 400);
    const fechaValidez = parseDateOrNull(data.fechaValidez);

    const created = await prisma.$transaction(async (tx) => {
      return tx.cotizacion.create({
        data: {
          obraId,
          proveedorId,
          rfqId,
          numeroCotizacion: data.numeroCotizacion,
          fecha,
          fechaValidez,
          moneda,
          subtotalAmount: toDec(data.subtotal.amount),
          subtotalCurrency: data.subtotal.currency,
          ivaAmount: toDec(data.iva.amount),
          ivaCurrency: data.iva.currency,
          totalAmount: toDec(data.total.amount),
          totalCurrency: data.total.currency,
          condicionesPago: data.condicionesPago ?? null,
          plazoEntregaDias: data.plazoEntregaDias ?? null,
          pctAnticipo: data.pctAnticipo != null ? toDec(data.pctAnticipo) : null,
          esEspecial: data.esEspecial ?? false,
          archivoPath: data.archivoPath ?? null,
          notas: data.notas ?? null,
          items: {
            create: data.items.map((it, idx) => ({
              materialId: it.materialId != null ? toBig(it.materialId) : null,
              descripcion: it.descripcion,
              cantidad: toDec(it.cantidad),
              unidad: it.unidad,
              precioUnitario: toDec(it.precioUnitario),
              subtotal: toDec(it.subtotal),
              ivaMonto: it.ivaMonto != null ? toDec(it.ivaMonto) : '0',
              codigoCabys: it.codigoCabys ?? null,
              orden: it.orden ?? idx,
            })),
          },
        },
        include: {
          items: { orderBy: { orden: 'asc' } },
          proveedor: true,
          obra: true,
        },
      });
    });

    console.log(`[compras] cotizacion creada id=${created.id} (${data.items.length} items)`);
    safeAuditCreate({
      modelName: 'Cotizacion',
      recordId: String(created.id),
      data: {
        obraId: created.obraId,
        proveedorId: created.proveedorId,
        rfqId: created.rfqId,
        numeroCotizacion: created.numeroCotizacion,
        fecha: created.fecha,
        moneda: created.moneda,
        totalAmount: created.totalAmount,
        totalCurrency: created.totalCurrency,
        estado: created.estado,
        itemsCount: created.items?.length ?? 0,
      },
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.status(201).json(created);
  } catch (err) {
    logHandlerError('createCotizacion', err);
    if (err.code === 'P2002') {
      return bad(res, 'Cotización duplicada (constraint unique)', 409);
    }
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function updateCotizacion(req, res) {
  try {
    if (!ROLES_UPDATE.has(req.user?.role)) {
      return bad(res, 'No autorizado', 403);
    }
    const id = toBig(req.params.id);
    if (id == null) return bad(res, 'id inválido', 400);

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return bad(res, `Payload inválido: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 400);
    }

    const existing = await prisma.cotizacion.findUnique({ where: { id } });
    if (!existing) return bad(res, 'Cotización no encontrada', 404);
    if (!EDITABLE_ESTADOS.has(existing.estado)) {
      return res.status(409).json({
        error: 'Cotización no editable en estado actual',
        estado: existing.estado,
      });
    }

    const data = parsed.data;
    const payload = {};
    if (data.numeroCotizacion !== undefined) payload.numeroCotizacion = data.numeroCotizacion;
    if (data.fecha !== undefined) {
      const f = parseDateOrNull(data.fecha);
      if (!f) return bad(res, 'fecha inválida', 400);
      payload.fecha = f;
    }
    if (data.fechaValidez !== undefined) payload.fechaValidez = parseDateOrNull(data.fechaValidez);
    if (data.condicionesPago !== undefined) payload.condicionesPago = data.condicionesPago;
    if (data.plazoEntregaDias !== undefined) payload.plazoEntregaDias = data.plazoEntregaDias;
    if (data.pctAnticipo !== undefined) payload.pctAnticipo = data.pctAnticipo != null ? toDec(data.pctAnticipo) : null;
    if (data.esEspecial !== undefined) payload.esEspecial = data.esEspecial;
    if (data.estado !== undefined) payload.estado = data.estado;
    if (data.archivoPath !== undefined) payload.archivoPath = data.archivoPath;
    if (data.notas !== undefined) payload.notas = data.notas;

    const updated = await prisma.cotizacion.update({
      where: { id },
      data: payload,
      include: { items: { orderBy: { orden: 'asc' } }, proveedor: true, obra: true },
    });
    // Excluimos relaciones del diff para no llenar el changes con objetos grandes.
    const { items: _ai, proveedor: _ap, obra: _ao, ...afterScalar } = updated;
    safeAuditUpdate({
      modelName: 'Cotizacion',
      recordId: String(updated.id),
      before: existing,
      after: afterScalar,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.json(cotizacionOut(updated));
  } catch (err) {
    logHandlerError('updateCotizacion', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function aprobarCotizacion(req, res) {
  try {
    if (!ROLES_APPROVE.has(req.user?.role)) {
      return bad(res, 'Solo admin/supervisor pueden aprobar cotizaciones', 403);
    }
    const id = toBig(req.params.id);
    if (id == null) return bad(res, 'id inválido', 400);

    const parsed = approveSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return bad(res, `Payload inválido: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 400);
    }

    const { categoriaId, fechaAprobacion } = parsed.data;
    // Snapshot pre-aprobación para auditar la transición de la cotización.
    const beforeCot = await prisma.cotizacion.findUnique({ where: { id } });
    const result = await approveCotizacion(prisma, {
      cotizacionId: id,
      categoriaId,
      fechaAprobacion: fechaAprobacion ?? null,
      approverId: req.user?.id ?? null,
    });
    // Audit FUERA de la tx (rule #6): si falla, el negocio ya está commiteado.
    if (beforeCot && result.cotizacion) {
      const { items: _ci, proveedor: _cp, obra: _co, ...afterCotScalar } = result.cotizacion;
      safeAuditUpdate({
        modelName: 'Cotizacion',
        recordId: String(result.cotizacion.id),
        before: beforeCot,
        after: afterCotScalar,
        userId: userIdFromReq(req),
        ipAddress: getIp(req),
      });
    }
    if (result.oc) {
      const { items: _oi, proveedor: _op, obra: _oo, categoria: _oc, ...ocScalar } = result.oc;
      safeAuditCreate({
        modelName: 'OrdenCompra',
        recordId: String(result.oc.id),
        data: ocScalar,
        userId: userIdFromReq(req),
        ipAddress: getIp(req),
      });
    }
    return res.status(201).json({
      cotizacion: cotizacionOut(result.cotizacion),
      oc: ocOut(result.oc),
    });
  } catch (err) {
    if (err.code === 'COTIZACION_TERMINAL') {
      return res.status(409).json({ error: 'Cotización ya está en estado terminal', estado: err.estado });
    }
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'numeroOc duplicado (race condition no manejado)' });
    }
    logHandlerError('aprobarCotizacion', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ---------------------------------------------------------------------------
// Archivo de evidencia (PDF / foto) — upload, download, delete
// ---------------------------------------------------------------------------

const ARCHIVO_ROLES_WRITE = new Set(['admin', 'supervisor', 'operativo']);
const ARCHIVO_ROLES_DELETE = new Set(['admin', 'supervisor']);

/** Borra un archivo del disco sin tirar si no existe. */
async function safeUnlink(absPath) {
  try {
    await unlink(absPath);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn(`[compras] no se pudo borrar archivo ${absPath}: ${err.message}`);
    }
  }
}

/** Resuelve Content-Type según extensión (default octet-stream). */
function contentTypeForExt(ext) {
  switch (String(ext).toLowerCase()) {
    case '.pdf': return 'application/pdf';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.heic': return 'image/heic';
    case '.heif': return 'image/heif';
    case '.webp': return 'image/webp';
    default: return 'application/octet-stream';
  }
}

/**
 * POST /api/cotizaciones/:id/archivo
 *
 * Pre-requisito: middleware multer (cotizacionArchivoUpload) ya escribió
 * `req.file`. Si la cotización ya tenía un archivo, lo reemplazamos borrando
 * el viejo del disco. Si algo falla post-multer, intentamos limpiar el
 * archivo recién escrito para evitar huérfanos.
 */
export async function uploadArchivoCotizacion(req, res) {
  let absPath = null;

  try {
    if (!ARCHIVO_ROLES_WRITE.has(req.user?.role)) {
      // Cleanup defensive: si por alguna razón llegamos sin permisos pero con
      // archivo ya escrito, lo borramos.
      if (req.file?.path) await safeUnlink(req.file.path);
      return bad(res, 'No autorizado para adjuntar archivo a cotizaciones', 403);
    }

    const id = toBig(req.params.id);
    if (id == null) {
      if (req.file?.path) await safeUnlink(req.file.path);
      return bad(res, 'id inválido', 400);
    }

    if (!req.file) {
      return bad(res, 'Archivo requerido (field "archivo")', 400);
    }
    absPath = req.file.path;

    const existing = await prisma.cotizacion.findUnique({
      where: { id },
      select: { id: true, archivoPath: true },
    });
    if (!existing) {
      await safeUnlink(absPath);
      return bad(res, 'Cotización no encontrada', 404);
    }

    const relPath = relativeToUploads(absPath);

    // Si tenía archivo previo, borrarlo del disco antes de aceptar el nuevo.
    let oldAbsPath = null;
    if (existing.archivoPath) {
      try {
        oldAbsPath = absoluteFromUploads(existing.archivoPath);
      } catch (err) {
        console.warn(`[compras] archivoPath previo inválido (id=${id}): ${err.message}`);
        oldAbsPath = null;
      }
    }

    let updated;
    try {
      updated = await prisma.cotizacion.update({
        where: { id },
        data: { archivoPath: relPath },
        select: { id: true, archivoPath: true },
      });
    } catch (err) {
      // No pudimos actualizar la DB — el archivo nuevo queda huérfano, lo borramos.
      await safeUnlink(absPath);
      throw err;
    }

    // DB OK → ahora sí borramos el archivo viejo (best effort).
    if (oldAbsPath) await safeUnlink(oldAbsPath);

    // Stat para devolver tamaño aproximado en MB (cosmético para el cliente).
    let sizeMb = null;
    try {
      const s = await stat(absPath);
      sizeMb = Number((s.size / (1024 * 1024)).toFixed(2));
    } catch {
      // ignore
    }

    console.log(`[compras] cotizacion ${id} archivo subido (${relPath})`);
    safeAuditUpdate({
      modelName: 'Cotizacion',
      recordId: String(id),
      before: { archivoPath: existing.archivoPath },
      after: { archivoPath: updated.archivoPath },
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.status(200).json({
      ok: true,
      archivoPath: updated.archivoPath,
      sizeMb,
    });
  } catch (err) {
    if (absPath) await safeUnlink(absPath);
    logHandlerError('uploadArchivoCotizacion', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

/**
 * GET /api/cotizaciones/:id/archivo
 *
 * Streamea el archivo con Content-Disposition: inline (queremos preview en
 * navegador si puede). Status 404 si no existe la cotización o no tiene archivo.
 */
export async function downloadArchivoCotizacion(req, res) {
  try {
    const id = toBig(req.params.id);
    if (id == null) return bad(res, 'id inválido', 400);

    const cot = await prisma.cotizacion.findUnique({
      where: { id },
      select: { archivoPath: true, numeroCotizacion: true },
    });
    if (!cot) return bad(res, 'Cotización no encontrada', 404);
    if (!cot.archivoPath) return bad(res, 'Cotización sin archivo adjunto', 404);

    let absPath;
    try {
      absPath = absoluteFromUploads(cot.archivoPath);
    } catch {
      return bad(res, 'archivoPath inválido', 500);
    }

    try {
      await stat(absPath);
    } catch {
      return bad(res, 'Archivo no encontrado en disco', 404);
    }

    const ext = extname(cot.archivoPath);
    // Filename: usamos el último segmento del path (que ya incluye el nombre
    // sanitizado tras el UUID prefix). Para el browser quitamos el prefijo UUID.
    const baseName = cot.archivoPath.split('/').pop() || `cotizacion-${id}${ext}`;
    const displayName = baseName.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, '');
    const safeName = displayName || `cotizacion-${id}${ext}`;

    res.setHeader('Content-Type', contentTypeForExt(ext));
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.setHeader('X-Cotizacion-Numero', cot.numeroCotizacion || '');

    const stream = fs.createReadStream(absPath);
    stream.on('error', (err) => {
      console.error('[compras] downloadArchivoCotizacion stream error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Error leyendo archivo' });
    });
    stream.pipe(res);
  } catch (err) {
    logHandlerError('downloadArchivoCotizacion', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

/**
 * DELETE /api/cotizaciones/:id/archivo
 *
 * Solo admin/supervisor. Borra el archivo del disco (best-effort) y setea
 * `archivoPath = null`.
 */
export async function deleteArchivoCotizacion(req, res) {
  try {
    if (!ARCHIVO_ROLES_DELETE.has(req.user?.role)) {
      return bad(res, 'Solo admin/supervisor pueden eliminar el archivo', 403);
    }
    const id = toBig(req.params.id);
    if (id == null) return bad(res, 'id inválido', 400);

    const existing = await prisma.cotizacion.findUnique({
      where: { id },
      select: { id: true, archivoPath: true },
    });
    if (!existing) return bad(res, 'Cotización no encontrada', 404);
    if (!existing.archivoPath) {
      // Idempotente: si no tiene archivo, OK; igual devolvemos 200.
      return res.json({ ok: true, archivoPath: null });
    }

    let absPath = null;
    try {
      absPath = absoluteFromUploads(existing.archivoPath);
    } catch (err) {
      console.warn(`[compras] archivoPath inválido al borrar (id=${id}): ${err.message}`);
    }

    await prisma.cotizacion.update({
      where: { id },
      data: { archivoPath: null },
    });

    if (absPath) await safeUnlink(absPath);

    console.log(`[compras] cotizacion ${id} archivo eliminado`);
    safeAuditUpdate({
      modelName: 'Cotizacion',
      recordId: String(id),
      before: { archivoPath: existing.archivoPath },
      after: { archivoPath: null },
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.json({ ok: true, archivoPath: null });
  } catch (err) {
    logHandlerError('deleteArchivoCotizacion', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function rechazarCotizacion(req, res) {
  try {
    if (!ROLES_APPROVE.has(req.user?.role)) {
      return bad(res, 'Solo admin/supervisor pueden rechazar cotizaciones', 403);
    }
    const id = toBig(req.params.id);
    if (id == null) return bad(res, 'id inválido', 400);

    const parsed = rejectSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return bad(res, 'Payload inválido', 400);
    }

    const existing = await prisma.cotizacion.findUnique({ where: { id } });
    if (!existing) return bad(res, 'Cotización no encontrada', 404);
    if (existing.estado === 'aprobada' || existing.estado === 'rechazada') {
      return res.status(409).json({ error: 'Cotización ya está en estado terminal', estado: existing.estado });
    }

    const motivo = parsed.data.motivo?.trim();
    let notas = existing.notas ?? null;
    if (motivo) {
      const stamp = `[RECHAZO ${new Date().toISOString().slice(0, 10)}] ${motivo}`;
      notas = notas ? `${notas}\n${stamp}` : stamp;
    }

    const updated = await prisma.cotizacion.update({
      where: { id },
      data: { estado: 'rechazada', notas },
      include: { items: { orderBy: { orden: 'asc' } }, proveedor: true, obra: true },
    });
    console.log(`[compras] cotizacion ${id} rechazada`);
    const { items: _ri, proveedor: _rp, obra: _ro, ...afterScalar } = updated;
    safeAuditUpdate({
      modelName: 'Cotizacion',
      recordId: String(updated.id),
      before: existing,
      after: afterScalar,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.json(cotizacionOut(updated));
  } catch (err) {
    logHandlerError('rechazarCotizacion', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
