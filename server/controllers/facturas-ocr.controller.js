/**
 * Controller para subida de FACTURAS NO-ELECTRÓNICAS (PDF/imagen) via OCR Gemini.
 *
 * El operador recibe muchas facturas que NO son comprobantes electrónicos
 * (FE/TE/etc) y solo existen como PDF o foto. Este endpoint las sube, las
 * pasa por `services/gemini-ocr.js`, mapea el output al schema canónico de
 * Factura y la deja `status='extracted'` lista para revisión + confirmación.
 *
 * Diferencias vs el XML upload (`facturas.controller.js#uploadFacturaXml`):
 *  - `tipoComprobante = null` (no es FE Hacienda, así no choca con el UNIQUE
 *    partial sobre clave_numerica — que igual queda null).
 *  - `sourceType` = `'pdf'` o `'imagen'` según el MIME del archivo subido.
 *  - `confidenceScore` viene del SDK Gemini (self-assessment del modelo);
 *    si no lo trae, default `0.85`.
 *  - `claveNumerica` queda null — no aplica al UNIQUE partial, así que NO
 *    debería disparar P2002. De todos modos manejamos el caso por defensa.
 *  - Si OCR falla → status=`error`, errorMessage=err.message, 200 OK con la
 *    Factura (el frontend muestra el error inline). Layout en disco exacto al
 *    XML upload para reusar el endpoint de descarga existente.
 *
 * Endpoint: POST /api/facturas/upload-imagen/:ocId
 * Body: multipart con field `archivo` (PDF/JPG/PNG/HEIC/HEIF/WEBP, 20 MiB).
 *
 * Reutilizamos `facturaToJson` y helpers del controller existente para
 * mantener una sola fuente de verdad del shape JSON. Los handlers existentes
 * de `confirmar`, `anular` y `downloadArchivo` aplican igual a estas facturas.
 */

import { unlink } from 'node:fs/promises';

import prisma from '../db.js';
import { relativeToUploads } from '../lib/uploads.js';
import { processFacturaImagen } from '../services/factura-processor.js';
import { enqueueFacturaParse } from '../queues/factura-queue.js';
import { auditCreate, auditUpdate, getIp } from '../lib/audit.js';

function safeAuditCreate(args) {
  return auditCreate(prisma, args).catch((err) => console.error('[audit:facturas-ocr]', err));
}
function safeAuditUpdate(args) {
  return auditUpdate(prisma, args).catch((err) => console.error('[audit:facturas-ocr]', err));
}
function userIdFromReq(req) {
  return req.user?.id != null ? BigInt(req.user.id) : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse `req.params.ocId` → BigInt. Si no es válido, lanza 400. */
function parseIdParam(value, name = 'ocId') {
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
      console.warn(
        `[facturas-ocr] no se pudo borrar archivo ${absPath}: ${err.message}`,
      );
    }
  }
}

function sourceTypeFromMime(mime) {
  if (mime === 'application/pdf') return 'pdf';
  if (typeof mime === 'string' && mime.startsWith('image/')) return 'imagen';
  // Defaults seguros (sin XML — el endpoint XML usa otro path).
  return 'imagen';
}

/**
 * Parsea una fecha en cualquier formato razonable (ISO 8601, YYYY-MM-DD).
 * Devuelve un Date apto para Prisma @db.Date o null.
 */
function parseLooseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/** Normaliza moneda a enum Currency (CRC|USD). Default CRC. */
function normalizeCurrency(value) {
  if (!value) return 'CRC';
  const code = String(value).trim().toUpperCase();
  if (code === 'CRC' || code === 'USD') return code;
  return 'CRC';
}

/**
 * Convierte una factura cruda de Prisma a JSON serializable.
 * Duplica lo justo de `facturas.controller.js` para no introducir un import
 * cíclico ni exportar un helper interno; el shape se mantiene en sync.
 */
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
    fechaEmision: f.fechaEmision
      ? f.fechaEmision.toISOString().slice(0, 10)
      : null,
    montoTotal:
      f.montoTotalAmount != null
        ? { amount: dec(f.montoTotalAmount), currency: f.montoTotalCurrency }
        : null,
    condicionVenta: f.condicionVenta,
    mediosPago: f.mediosPago,
    fxRateApplied: dec(f.fxRateApplied),
    fxRateDate: f.fxRateDate ? f.fxRateDate.toISOString().slice(0, 10) : null,
    confirmadaPorId:
      f.confirmadaPorId != null ? Number(f.confirmadaPorId) : null,
    errorMessage: f.errorMessage,
    notas: f.notas,
    createdAt: f.createdAt?.toISOString(),
    updatedAt: f.updatedAt?.toISOString(),
    oc: f.oc
      ? {
          id: Number(f.oc.id),
          numeroOc: f.oc.numeroOc,
          proveedor: f.oc.proveedor
            ? { id: Number(f.oc.proveedor.id), nombre: f.oc.proveedor.nombre }
            : null,
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// POST /api/facturas/upload-imagen/:ocId
// ---------------------------------------------------------------------------

/**
 * Handler post-multer para subida de factura escaneada (PDF/imagen).
 * Multer ya guardó el archivo en `uploads/facturas/<...>` y dejó `req.file`.
 *
 * Flujo igual al XML upload:
 *  - Crea Factura `pending` con el archivo en disco.
 *  - Si la queue (Redis) está disponible → encola + 202 Accepted.
 *  - Si no → procesa inline con `processFacturaImagen` (path legacy).
 */
export async function uploadFacturaImagen(req, res) {
  let absPath = null;
  let facturaId = null;

  try {
    const ocId = parseIdParam(req.params.ocId, 'ocId');

    if (!req.file) {
      return res.status(400).json({ error: 'Archivo requerido (field "archivo")' });
    }
    absPath = req.file.path;

    // 1. Verificar que la OC existe (multer ya escribió a disco; si no existe
    //    la OC limpiamos).
    const oc = await prisma.ordenCompra.findUnique({ where: { id: ocId } });
    if (!oc) {
      await safeUnlink(absPath);
      return res.status(404).json({ error: `OC ${ocId} no existe` });
    }

    const relPath = relativeToUploads(absPath);
    const sourceType = sourceTypeFromMime(req.file.mimetype);

    // 2. Crear factura en `pending`.
    const factura = await prisma.factura.create({
      data: {
        ocId,
        sourceType,
        archivoOriginalPath: relPath,
        status: 'pending',
      },
    });
    facturaId = factura.id;
    safeAuditCreate({
      modelName: 'Factura',
      recordId: String(factura.id),
      data: factura,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });

    // 3. Intentar encolar (no-op si no hay Redis).
    let queued = null;
    try {
      queued = await enqueueFacturaParse({ facturaId: factura.id, kind: 'imagen' });
    } catch (err) {
      console.warn(`[facturas-ocr.upload] enqueue falló, fallback a sync: ${err.message}`);
    }

    if (queued) {
      const withRels = await prisma.factura.findUnique({
        where: { id: factura.id },
        include: {
          oc: {
            select: {
              id: true,
              numeroOc: true,
              proveedor: { select: { id: true, nombre: true } },
            },
          },
        },
      });
      return res
        .status(202)
        .json({ ...facturaToJson(withRels), queued: true, jobId: queued.id });
    }

    // 4. Path sync (legacy): OCR inline.
    const updated = await processFacturaImagen(prisma, factura.id);
    const withRels = await prisma.factura.findUnique({
      where: { id: updated.id },
      include: {
        oc: {
          select: {
            id: true,
            numeroOc: true,
            proveedor: { select: { id: true, nombre: true } },
          },
        },
      },
    });
    // Preservar contrato HTTP histórico del sync path: si OCR falló y la
    // factura quedó en error, respondemos 200 (no 201) para que el frontend
    // diferencie entre upload OK y upload con OCR fallido.
    const status = updated.status === 'error' ? 200 : 201;
    return res.status(status).json(facturaToJson(withRels));
  } catch (err) {
    if (absPath && !facturaId) {
      // Solo limpiamos el archivo si no llegamos a crear la Factura;
      // si ya hay registro, dejamos el archivo para que el supervisor lo vea.
      await safeUnlink(absPath);
    }
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[facturas-ocr.upload] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ---------------------------------------------------------------------------
// PUT /api/facturas/:id  → editar datos OCR pre-confirmación
// ---------------------------------------------------------------------------

/**
 * Permite al supervisor corregir los datos extraídos antes de confirmar una
 * factura escaneada. Campos editables limitados a los que el OCR puede haber
 * leído mal:
 *
 *  - numeroConsecutivo (string)
 *  - fechaEmision (YYYY-MM-DD)
 *  - montoTotalAmount + montoTotalCurrency
 *
 * Solo aplica a facturas en estado `extracted` o `error` (no a `confirmed`
 * — para esas la fuente de verdad ya quedó congelada).
 */
export async function updateFacturaCanonical(req, res) {
  try {
    const id = parseIdParam(req.params.id, 'id');
    const factura = await prisma.factura.findUnique({ where: { id } });
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
    if (factura.status === 'confirmed') {
      return res
        .status(409)
        .json({ error: 'No se puede editar una factura ya confirmada' });
    }

    const body = req.body || {};
    const data = {};

    if ('numeroConsecutivo' in body) {
      const v = body.numeroConsecutivo;
      if (v != null && typeof v !== 'string') {
        return res
          .status(400)
          .json({ error: 'numeroConsecutivo debe ser string o null' });
      }
      data.numeroConsecutivo = v && v.trim() ? v.trim().slice(0, 80) : null;
    }

    if ('fechaEmision' in body) {
      if (body.fechaEmision == null || body.fechaEmision === '') {
        data.fechaEmision = null;
      } else {
        const d = parseLooseDate(body.fechaEmision);
        if (!d) return res.status(400).json({ error: 'fechaEmision inválida' });
        data.fechaEmision = d;
      }
    }

    if ('montoTotalAmount' in body || 'montoTotalCurrency' in body) {
      const rawAmount = body.montoTotalAmount;
      const amountNum =
        rawAmount == null || rawAmount === ''
          ? null
          : Number(rawAmount);
      if (amountNum != null && !Number.isFinite(amountNum)) {
        return res
          .status(400)
          .json({ error: 'montoTotalAmount debe ser un número' });
      }
      const currency = normalizeCurrency(
        body.montoTotalCurrency ?? factura.montoTotalCurrency,
      );
      data.montoTotalAmount = amountNum;
      data.montoTotalCurrency = amountNum != null ? currency : null;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'Nada que actualizar' });
    }

    const updated = await prisma.factura.update({
      where: { id },
      data,
      include: {
        oc: {
          select: {
            id: true,
            numeroOc: true,
            proveedor: { select: { id: true, nombre: true } },
          },
        },
      },
    });
    const { oc: _ufo, ...updatedScalar } = updated;
    safeAuditUpdate({
      modelName: 'Factura',
      recordId: String(updated.id),
      before: factura,
      after: updatedScalar,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.json(facturaToJson(updated));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Factura no encontrada' });
    }
    console.error('[facturas-ocr.update] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
