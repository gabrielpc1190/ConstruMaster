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
import { extractInvoice, OCRError } from '../services/gemini-ocr.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIDENCE = 0.85;

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
 * Mapea el output del OCR Gemini al schema canónico de Factura.
 *
 * Acepta variantes habituales en los nombres de campos: el modelo a veces
 * devuelve `numero`, `consecutivo`, `factura`, etc., dependiendo del prompt
 * y de cómo "ve" el documento. Tolerancia liberal acá; el supervisor revisa.
 */
function mapOcrToCanonical(data) {
  const numeroConsecutivo =
    data?.numero ??
    data?.consecutivo ??
    data?.factura ??
    data?.numero_factura ??
    null;

  const fechaEmision = parseLooseDate(data?.fecha);

  const total = data?.total;
  const totalNum = typeof total === 'number' ? total : Number(total);
  const hasTotal = Number.isFinite(totalNum);
  const currency = normalizeCurrency(data?.moneda);

  return {
    tipoComprobante: null,
    claveNumerica: null,
    numeroConsecutivo:
      numeroConsecutivo != null ? String(numeroConsecutivo) : null,
    fechaEmision,
    montoTotalAmount: hasTotal ? totalNum : null,
    montoTotalCurrency: hasTotal ? currency : null,
    condicionVenta: null,
    mediosPago: [],
  };
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
 * Handler post-multer para subida de factura escaneada.
 * Multer ya guardó el archivo en `uploads/facturas/<...>` y dejó `req.file`.
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

    // 2. Crear factura en `processing` para tener registro aunque el OCR falle.
    let factura = await prisma.factura.create({
      data: {
        ocId,
        sourceType,
        archivoOriginalPath: relPath,
        status: 'processing',
      },
    });
    facturaId = factura.id;

    // 3. Llamar OCR Gemini (síncrono, ~10-30s típico).
    let ocrResult;
    try {
      ocrResult = await extractInvoice(absPath);
    } catch (err) {
      const message =
        err instanceof OCRError ? err.message : `OCR falló: ${err.message}`;
      console.warn(
        `[facturas-ocr.upload] OCR falló (id=${factura.id}): ${message}`,
      );
      factura = await prisma.factura.update({
        where: { id: factura.id },
        data: {
          status: 'error',
          errorMessage: message,
        },
      });
      // Conservamos el archivo en disco para que el operador pueda revisarlo.
      return res.status(200).json(facturaToJson(factura));
    }

    // 4. Mapear y persistir el resultado canónico.
    const canonical = mapOcrToCanonical(ocrResult.data);
    const confidence =
      typeof ocrResult.confidence === 'number'
        ? ocrResult.confidence
        : DEFAULT_CONFIDENCE;

    try {
      factura = await prisma.factura.update({
        where: { id: factura.id },
        data: {
          ...canonical,
          extractedData: ocrResult.data,
          status: 'extracted',
          confidenceScore: confidence,
          errorMessage: null,
        },
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
    } catch (err) {
      // No esperamos P2002 porque claveNumerica es null (UNIQUE es parcial WHERE
      // NOT NULL). Lo manejamos igual por defensa: limpiar archivo + responder.
      if (err && err.code === 'P2002') {
        await prisma.factura.delete({ where: { id: factura.id } }).catch(() => {});
        await safeUnlink(absPath);
        return res.status(409).json({
          error: 'Conflicto al persistir factura escaneada',
          details: err.meta || null,
        });
      }
      throw err;
    }

    return res.status(201).json(facturaToJson(factura));
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
