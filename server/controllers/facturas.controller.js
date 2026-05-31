/**
 * Controllers de Facturas (Hacienda CR v4.4).
 *
 * Workflow del XML upload:
 *   pending → processing → extracted → confirmed
 *                                  └── error (anulación o parsing fallido)
 *
 * Decisiones:
 *  - El XML es determinista, por lo que `confidenceScore` queda `null` siempre
 *    (a diferencia del OCR de PDF/imagen que sí lo va a usar). Esto matchea el
 *    fix #13 del review original.
 *  - Si el parser tira `XmlSyntaxError` / `UnknownComprobanteError`, NO
 *    re-lanzamos. Marcamos la Factura como `error` y devolvemos 200 con el
 *    payload. El frontend lee `status` y muestra el error inline.
 *  - Duplicado de `clave_numerica` (UNIQUE partial en Postgres) → 409 +
 *    `existingFacturaId`. Borramos el archivo subido para no acumular basura.
 *  - Anulación es soft: setea `status='error'` con `errorMessage=motivo`.
 *    Útil para descartar facturas mal subidas sin borrarlas del audit log.
 *  - IDs llegan como string desde Express; los convertimos a BigInt para
 *    Prisma. Cualquier valor no parseable → 400.
 *
 * TODO: parsing async vía worker para XMLs grandes (p.ej. FEC con cientos de
 *       líneas). Hoy el parser es síncrono y bloquea el handler ~10ms por XML
 *       de 50 líneas; está bien para v1.
 * TODO: validación XSD opt-in (ver comentario en xml-parser.js).
 * TODO: vincular líneas del XML a `OrdenCompraItem` por `codigoCabys` cuando
 *       implementemos el reconciler.
 */

import fs from 'node:fs';
import { unlink, stat } from 'node:fs/promises';

import { z } from 'zod';

import prisma from '../db.js';
import { absoluteFromUploads, relativeToUploads } from '../lib/uploads.js';
import { processFacturaXml } from '../services/factura-processor.js';
import { enqueueFacturaParse } from '../queues/factura-queue.js';
import { auditCreate, auditUpdate, getIp } from '../lib/audit.js';

function safeAuditCreate(args) {
  return auditCreate(prisma, args).catch((err) => console.error('[audit:facturas]', err));
}
function safeAuditUpdate(args) {
  return auditUpdate(prisma, args).catch((err) => console.error('[audit:facturas]', err));
}
function userIdFromReq(req) {
  return req.user?.id != null ? BigInt(req.user.id) : null;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const STATUS_VALUES = ['pending', 'processing', 'extracted', 'confirmed', 'error'];
const TIPO_VALUES = ['FE', 'TE', 'NC', 'ND', 'FEC', 'FEE'];

const listQuerySchema = z.object({
  ocId: z.coerce.bigint().optional(),
  status: z.enum(STATUS_VALUES).optional(),
  tipoComprobante: z.enum(TIPO_VALUES).optional(),
});

const anularSchema = z.object({
  motivo: z.string().trim().max(500).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse `req.params.id` → BigInt. Si no es válido, lanza 400. */
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

/** Borra un archivo del disco sin tirar si no existe. */
async function safeUnlink(absPath) {
  try {
    await unlink(absPath);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn(`[facturas] no se pudo borrar archivo ${absPath}: ${err.message}`);
    }
  }
}

/** Convierte una factura cruda de Prisma a JSON serializable (BigInt → number, Decimal → string). */
function facturaToJson(f) {
  if (!f) return null;
  const dec = (v) => (v == null ? null : v.toString());
  return {
    id: Number(f.id),
    ocId: Number(f.ocId),
    sourceType: f.sourceType,
    tipoComprobante: f.tipoComprobante,
    archivoOriginalPath: f.archivoOriginalPath,
    status: f.status,
    extractedData: f.extractedData,
    confidenceScore: f.confidenceScore,
    claveNumerica: f.claveNumerica,
    numeroConsecutivo: f.numeroConsecutivo,
    fechaEmision: f.fechaEmision ? f.fechaEmision.toISOString().slice(0, 10) : null,
    montoTotal:
      f.montoTotalAmount != null
        ? { amount: dec(f.montoTotalAmount), currency: f.montoTotalCurrency }
        : null,
    condicionVenta: f.condicionVenta,
    mediosPago: f.mediosPago,
    fxRateApplied: dec(f.fxRateApplied),
    fxRateDate: f.fxRateDate ? f.fxRateDate.toISOString().slice(0, 10) : null,
    confirmadaPorId: f.confirmadaPorId != null ? Number(f.confirmadaPorId) : null,
    errorMessage: f.errorMessage,
    notas: f.notas,
    createdAt: f.createdAt?.toISOString(),
    updatedAt: f.updatedAt?.toISOString(),
    oc: f.oc
      ? {
          id: Number(f.oc.id),
          numeroOc: f.oc.numeroOc,
          montoTotal:
            f.oc.montoTotalAmount != null
              ? { amount: dec(f.oc.montoTotalAmount), currency: f.oc.montoTotalCurrency }
              : null,
          proveedor: f.oc.proveedor
            ? { id: Number(f.oc.proveedor.id), nombre: f.oc.proveedor.nombre }
            : null,
        }
      : undefined,
    confirmadaPor: f.confirmadaPor
      ? {
          id: Number(f.confirmadaPor.id),
          username: f.confirmadaPor.username,
          fullName: f.confirmadaPor.fullName,
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// GET /api/facturas
// ---------------------------------------------------------------------------

export async function listFacturas(req, res) {
  try {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Query inválido', details: parsed.error.issues });
    }
    const { ocId, status, tipoComprobante } = parsed.data;
    const where = {};
    if (ocId != null) where.ocId = ocId;
    if (status) where.status = status;
    if (tipoComprobante) where.tipoComprobante = tipoComprobante;

    const facturas = await prisma.factura.findMany({
      where,
      include: {
        oc: { select: { id: true, numeroOc: true, montoTotalAmount: true, montoTotalCurrency: true, proveedor: { select: { id: true, nombre: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json(facturas.map(facturaToJson));
  } catch (err) {
    console.error('[facturas.list] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ---------------------------------------------------------------------------
// GET /api/facturas/:id
// ---------------------------------------------------------------------------

export async function getFactura(req, res) {
  try {
    const id = parseIdParam(req.params.id);
    const factura = await prisma.factura.findUnique({
      where: { id },
      include: {
        oc: { select: { id: true, numeroOc: true, montoTotalAmount: true, montoTotalCurrency: true, proveedor: { select: { id: true, nombre: true } } } },
        confirmadaPor: { select: { id: true, username: true, fullName: true } },
      },
    });
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
    return res.json(facturaToJson(factura));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[facturas.get] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ---------------------------------------------------------------------------
// POST /api/facturas/upload/:ocId
// ---------------------------------------------------------------------------

/**
 * Handler post-multer. Multer ya guardó el archivo y dejó `req.file`.
 * Si llegamos acá sin `req.file`, es error de cliente.
 *
 * Flujo:
 *  1. Crea la Factura en estado `pending` (referencia al archivo en disco).
 *  2. Si la queue (Redis) está disponible → encola job + 202 Accepted.
 *     El worker procesa async y deja la factura en `extracted`/`error`.
 *  3. Si NO hay queue → procesa inline llamando `processFacturaXml`
 *     (path histórico) + 201 Created.
 *
 * En cualquier caso, si la factura sale como `error` por XML inválido o
 * clave_numerica duplicada (path sync), respondemos con la factura, no con
 * un 409, para mantener consistencia con el path async. La UI lee `status`
 * y `errorMessage`.
 */
export async function uploadFacturaXml(req, res) {
  let absPath = null;

  try {
    const ocId = parseIdParam(req.params.ocId, 'ocId');

    if (!req.file) {
      return res.status(400).json({ error: 'Archivo requerido (field "archivo")' });
    }
    absPath = req.file.path;

    // 1. Verificar que la OC existe.
    const oc = await prisma.ordenCompra.findUnique({ where: { id: ocId } });
    if (!oc) {
      await safeUnlink(absPath);
      return res.status(404).json({ error: `OC ${ocId} no existe` });
    }

    const relPath = relativeToUploads(absPath);

    // 2. Crear factura en `pending` para tener registro aunque el procesamiento falle.
    const factura = await prisma.factura.create({
      data: {
        ocId,
        sourceType: 'xml',
        archivoOriginalPath: relPath,
        status: 'pending',
      },
    });
    safeAuditCreate({
      modelName: 'Factura',
      recordId: String(factura.id),
      data: factura,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });

    // 3. Intentar encolar (no-op si REDIS_URL no está definida).
    let queued = null;
    try {
      queued = await enqueueFacturaParse({ facturaId: factura.id, kind: 'xml' });
    } catch (err) {
      console.warn(`[facturas.upload] enqueue falló, fallback a sync: ${err.message}`);
    }

    if (queued) {
      // 4a. Path async: el worker procesa. Respondemos 202 con el id para que
      //     el frontend haga polling de `/api/facturas/:id`.
      const withRels = await prisma.factura.findUnique({
        where: { id: factura.id },
        include: {
          oc: { select: { id: true, numeroOc: true, montoTotalAmount: true, montoTotalCurrency: true, proveedor: { select: { id: true, nombre: true } } } },
        },
      });
      return res.status(202).json({ ...facturaToJson(withRels), queued: true, jobId: queued.id });
    }

    // 4b. Path sync (legacy): procesar inline.
    const updated = await processFacturaXml(prisma, factura.id);
    const withRels = await prisma.factura.findUnique({
      where: { id: updated.id },
      include: {
        oc: { select: { id: true, numeroOc: true, montoTotalAmount: true, montoTotalCurrency: true, proveedor: { select: { id: true, nombre: true } } } },
      },
    });

    // Preservar contrato HTTP histórico del sync path:
    //  - status='error' por XML mal formado / namespace desconocido / archivo
    //    no legible → 200 con la factura (frontend lee body.status).
    //  - status='error' por clave_numerica duplicada → 409 + existingFacturaId
    //    y cleanup del archivo + delete de la factura fallida (consistente con
    //    el comportamiento original previo al refactor).
    if (updated.status === 'error' && updated.errorMessage) {
      const isDup = /clave_numerica="[^"]+" ya existe/.test(updated.errorMessage);
      if (isDup) {
        // Extraer la clave del errorMessage para buscar la factura existente.
        // processFacturaXml setea: `Factura con clave_numerica="<clave>" ya existe`
        const m = updated.errorMessage.match(/clave_numerica="([^"]+)"/);
        const clave = m ? m[1] : null;
        const existing = clave
          ? await prisma.factura.findFirst({
              where: { claveNumerica: clave, NOT: { id: updated.id } },
              select: { id: true },
            })
          : null;
        await prisma.factura.delete({ where: { id: updated.id } }).catch(() => {});
        await safeUnlink(absPath);
        return res.status(409).json({
          error: 'Factura con esa clave ya existe',
          existingFacturaId: existing ? Number(existing.id) : null,
        });
      }
      return res.status(200).json(facturaToJson(withRels));
    }

    return res.status(201).json(facturaToJson(withRels));
  } catch (err) {
    // Cleanup en cualquier error inesperado
    if (absPath) await safeUnlink(absPath);
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[facturas.upload] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ---------------------------------------------------------------------------
// POST /api/facturas/:id/confirmar
// ---------------------------------------------------------------------------

export async function confirmarFactura(req, res) {
  try {
    const id = parseIdParam(req.params.id);
    const factura = await prisma.factura.findUnique({ where: { id } });
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });

    if (factura.status !== 'extracted') {
      return res.status(409).json({
        error: `Solo se puede confirmar una factura en estado 'extracted' (actual: '${factura.status}')`,
      });
    }

    const updated = await prisma.factura.update({
      where: { id },
      data: {
        status: 'confirmed',
        confirmadaPorId: BigInt(req.user.id),
      },
      include: {
        oc: { select: { id: true, numeroOc: true, montoTotalAmount: true, montoTotalCurrency: true, proveedor: { select: { id: true, nombre: true } } } },
        confirmadaPor: { select: { id: true, username: true, fullName: true } },
      },
    });
    const { oc: _co, confirmadaPor: _cp, ...afterScalar } = updated;
    safeAuditUpdate({
      modelName: 'Factura',
      recordId: String(updated.id),
      before: factura,
      after: afterScalar,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.json(facturaToJson(updated));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[facturas.confirmar] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ---------------------------------------------------------------------------
// POST /api/facturas/:id/anular
// ---------------------------------------------------------------------------

export async function anularFactura(req, res) {
  try {
    const id = parseIdParam(req.params.id);
    const body = anularSchema.safeParse(req.body || {});
    if (!body.success) {
      return res.status(400).json({ error: 'Body inválido', details: body.error.issues });
    }

    const factura = await prisma.factura.findUnique({ where: { id } });
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });

    const updated = await prisma.factura.update({
      where: { id },
      data: {
        status: 'error',
        errorMessage: body.data.motivo ?? 'Anulada por usuario',
      },
    });
    safeAuditUpdate({
      modelName: 'Factura',
      recordId: String(updated.id),
      before: factura,
      after: updated,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.json(facturaToJson(updated));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[facturas.anular] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ---------------------------------------------------------------------------
// GET /api/facturas/:id/archivo
// ---------------------------------------------------------------------------

/**
 * Mapea la extensión del archivo a un Content-Type razonable. Sirve para
 * descargas tanto de XML como de PDF/imagen (facturas escaneadas via OCR).
 */
function contentTypeFromPath(path) {
  const lower = String(path || '').toLowerCase();
  if (lower.endsWith('.xml')) return 'application/xml; charset=utf-8';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.heic')) return 'image/heic';
  if (lower.endsWith('.heif')) return 'image/heif';
  return 'application/octet-stream';
}

export async function downloadArchivo(req, res) {
  try {
    const id = parseIdParam(req.params.id);
    const factura = await prisma.factura.findUnique({
      where: { id },
      select: {
        archivoOriginalPath: true,
        claveNumerica: true,
        numeroConsecutivo: true,
        sourceType: true,
      },
    });
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
    if (!factura.archivoOriginalPath) {
      return res.status(404).json({ error: 'Factura sin archivo asociado' });
    }

    const absPath = absoluteFromUploads(factura.archivoOriginalPath);
    try {
      await stat(absPath);
    } catch {
      return res.status(404).json({ error: 'Archivo no encontrado en disco' });
    }

    // Para facturas escaneadas conservamos la extensión original (PDF/JPG/etc).
    // Para XML preservamos el nombre legible histórico.
    const origBase = factura.archivoOriginalPath.split('/').pop() || '';
    const extMatch = origBase.match(/\.[a-z0-9]+$/i);
    const ext = extMatch ? extMatch[0] : '.xml';
    const filename = `${factura.claveNumerica || factura.numeroConsecutivo || `factura-${id}`}${ext}`;
    res.setHeader('Content-Type', contentTypeFromPath(factura.archivoOriginalPath));
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const stream = fs.createReadStream(absPath);
    stream.on('error', (err) => {
      console.error('[facturas.download] stream error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Error leyendo archivo' });
    });
    stream.pipe(res);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[facturas.download] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
