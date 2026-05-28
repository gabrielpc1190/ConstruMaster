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
import { readFileSync } from 'node:fs';
import { unlink, stat } from 'node:fs/promises';

import { z } from 'zod';

import prisma from '../db.js';
import {
  parseComprobanteXml,
  XmlSyntaxError,
  UnknownComprobanteError,
} from '../services/xml-parser.js';
import { absoluteFromUploads, relativeToUploads } from '../lib/uploads.js';

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

/**
 * Convierte una fecha de Hacienda (ISO 8601 con offset, ej.
 * "2026-05-04T14:16:06-06:00") a un Date apto para Prisma @db.Date.
 *
 * Tolera strings vacíos / null. Si es inparseable, devuelve null.
 */
function parseHaciendaDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/** Mapea el output del parser a campos canónicos del modelo Factura. */
function buildCanonicalFromParsed(parsed) {
  const totalComp = parsed.totales?.totalComprobante ?? null;
  const monedaCode = parsed.moneda || 'CRC';
  // El enum Currency de Prisma solo acepta CRC / USD. Si el XML trae otra
  // moneda (ej. EUR), guardamos null y dejamos el detalle en extractedData.
  const currency = monedaCode === 'CRC' || monedaCode === 'USD' ? monedaCode : null;

  return {
    tipoComprobante: parsed.tipo ?? null,
    claveNumerica: parsed.claveNumerica ?? null,
    numeroConsecutivo: parsed.numeroConsecutivo ?? null,
    fechaEmision: parseHaciendaDate(parsed.fechaEmision),
    montoTotalAmount: totalComp != null ? totalComp : null,
    montoTotalCurrency: totalComp != null ? currency : null,
    condicionVenta: parsed.condicionVenta ?? null,
    mediosPago: parsed.medioPago ?? [],
  };
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
        oc: { select: { id: true, numeroOc: true, proveedor: { select: { id: true, nombre: true } } } },
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
        oc: { select: { id: true, numeroOc: true, proveedor: { select: { id: true, nombre: true } } } },
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
 */
export async function uploadFacturaXml(req, res) {
  let absPath = null;

  try {
    const ocId = parseIdParam(req.params.ocId, 'ocId');

    if (!req.file) {
      return res.status(400).json({ error: 'Archivo requerido (field "archivo")' });
    }
    absPath = req.file.path;

    // 1. Verificar que la OC existe (después de multer para no crear path
    //    de almacenamiento por una OC inexistente — pero igual chequeamos
    //    acá y limpiamos si falla).
    const oc = await prisma.ordenCompra.findUnique({ where: { id: ocId } });
    if (!oc) {
      await safeUnlink(absPath);
      return res.status(404).json({ error: `OC ${ocId} no existe` });
    }

    const relPath = relativeToUploads(absPath);

    // 2. Crear factura en `processing` para tener registro aunque el parser falle.
    let factura = await prisma.factura.create({
      data: {
        ocId,
        sourceType: 'xml',
        archivoOriginalPath: relPath,
        status: 'processing',
      },
    });

    // 3. Parsear
    let parsed;
    try {
      const xmlString = readFileSync(absPath, 'utf-8');
      parsed = parseComprobanteXml(xmlString);
    } catch (err) {
      if (err instanceof XmlSyntaxError || err instanceof UnknownComprobanteError) {
        console.warn(`[facturas.upload] parsing falló (id=${factura.id}): ${err.message}`);
        factura = await prisma.factura.update({
          where: { id: factura.id },
          data: {
            status: 'error',
            errorMessage: err.message,
          },
        });
        return res.status(200).json(facturaToJson(factura));
      }
      // Cualquier otro error es bug nuestro — re-lanzamos.
      throw err;
    }

    // 4. Persistir resultado canónico
    const canonical = buildCanonicalFromParsed(parsed);
    try {
      factura = await prisma.factura.update({
        where: { id: factura.id },
        data: {
          ...canonical,
          extractedData: parsed,
          status: 'extracted',
          confidenceScore: null, // XML es determinista
          errorMessage: null,
        },
      });
    } catch (err) {
      // Unique violation en clave_numerica → 409
      if (err && err.code === 'P2002') {
        const existing = canonical.claveNumerica
          ? await prisma.factura.findFirst({
              where: {
                claveNumerica: canonical.claveNumerica,
                NOT: { id: factura.id },
              },
              select: { id: true },
            })
          : null;
        // Borrar el registro fallido y el archivo en disco.
        await prisma.factura.delete({ where: { id: factura.id } }).catch(() => {});
        await safeUnlink(absPath);
        return res.status(409).json({
          error: 'Factura con esa clave ya existe',
          existingFacturaId: existing ? Number(existing.id) : null,
        });
      }
      throw err;
    }

    return res.status(201).json(facturaToJson(factura));
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
        oc: { select: { id: true, numeroOc: true, proveedor: { select: { id: true, nombre: true } } } },
        confirmadaPor: { select: { id: true, username: true, fullName: true } },
      },
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

export async function downloadArchivo(req, res) {
  try {
    const id = parseIdParam(req.params.id);
    const factura = await prisma.factura.findUnique({
      where: { id },
      select: { archivoOriginalPath: true, claveNumerica: true, numeroConsecutivo: true },
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

    const filename = `${factura.claveNumerica || factura.numeroConsecutivo || `factura-${id}`}.xml`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
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
