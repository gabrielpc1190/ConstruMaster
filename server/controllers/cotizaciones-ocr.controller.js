/**
 * Controller dedicado al OCR de cotizaciones (PDF/imagen del proveedor).
 *
 * Archivo SEPARADO de `cotizaciones.controller.js` para no chocar con otro
 * agente que está extendiéndolo con upload de archivo de evidencia.
 *
 * Endpoint:
 *   POST /api/cotizaciones/parse-document  (multipart, field `archivo`)
 *     → { data, model, warnings, matches: { proveedorId?, items: [...] } }
 *
 * El handler:
 *   1. Recibe el archivo (multer lo guardó en /tmp).
 *   2. Llama Gemini OCR (gemini-cotizacion-ocr.js).
 *   3. Borra el tmp file.
 *   4. ENRIQUECE: intenta matchear proveedor (por cédula o nombre) e items
 *      (por nombre canónico o alias en ItemCatalogo).
 *   5. Devuelve el JSON estructurado + los matches para que el frontend
 *      pre-llene el form.
 *
 * El archivo de evidencia definitivo lo sube otro flujo (otro agente):
 *   POST/GET/DELETE /api/cotizaciones/:id/archivo
 */

import { unlink } from 'node:fs/promises';
import prisma from '../db.js';
import {
  extractCotizacion,
  CotizacionOcrError,
} from '../services/gemini-cotizacion-ocr.js';

const ROLES_OCR = new Set(['admin', 'supervisor', 'operativo']);

/**
 * Devuelve `{id, nombre}` si hay match ÚNICO; null si no hay match o hay
 * múltiples (ambiguo → forzamos al usuario a elegir manualmente).
 */
async function matchProveedor({ identificacion, nombre }) {
  // 1) Match exacto por cédula si existe.
  const ced = identificacion ? String(identificacion).trim() : '';
  if (ced) {
    const byCed = await prisma.proveedor.findMany({
      where: { identificacion: ced, activo: true },
      select: { id: true, nombre: true },
      take: 2,
    });
    if (byCed.length === 1) {
      return { id: Number(byCed[0].id), nombre: byCed[0].nombre };
    }
    // Si hay más de uno por cédula es un dato sucio en DB; no auto-elegimos.
    if (byCed.length > 1) return null;
  }

  // 2) Match por nombre case-insensitive (contains, defensivo).
  const nom = nombre ? String(nombre).trim() : '';
  if (!nom) return null;

  const byName = await prisma.proveedor.findMany({
    where: {
      nombre: { contains: nom, mode: 'insensitive' },
      activo: true,
    },
    select: { id: true, nombre: true },
    take: 5,
  });
  if (byName.length === 1) {
    return { id: Number(byName[0].id), nombre: byName[0].nombre };
  }
  // Ambiguo (varios matches) → no decidimos.
  return null;
}

/**
 * Para cada item devuelto por OCR, intenta encontrar match único en
 * ItemCatalogo (estado=aprobado, activo). Devuelve el item original con
 * `materialId` agregado si hay match único.
 */
async function enrichItems(items) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const out = [];
  for (const it of items) {
    const desc = String(it?.descripcion ?? '').trim();
    if (!desc) {
      out.push({ ...it, materialId: null });
      continue;
    }
    // Match por nombre canónico o alias (contains, insensitive).
    const matches = await prisma.itemCatalogo.findMany({
      where: {
        activo: true,
        estado: 'aprobado',
        OR: [
          { nombreCanonico: { contains: desc, mode: 'insensitive' } },
          { alias: { contains: desc, mode: 'insensitive' } },
        ],
      },
      select: { id: true, nombreCanonico: true, unidad: true },
      take: 2,
    });
    if (matches.length === 1) {
      out.push({
        ...it,
        materialId: Number(matches[0].id),
        materialNombre: matches[0].nombreCanonico,
        unidad: it.unidad || matches[0].unidad,
      });
    } else {
      out.push({ ...it, materialId: null });
    }
  }
  return out;
}

/**
 * POST /api/cotizaciones/parse-document
 * multipart, field `archivo`.
 *
 * 200 → { data, model, warnings, matches }
 * 400 → archivo faltante / tipo no soportado (multer ya filtra antes).
 * 403 → rol no autorizado.
 * 422 → OCR falló (Gemini rechazó, JSON inválido, etc).
 * 500 → error inesperado.
 */
export async function parseCotizacionDocument(req, res) {
  if (!ROLES_OCR.has(req.user?.role)) {
    return res.status(403).json({ error: 'No autorizado para usar OCR' });
  }

  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'Falta archivo (field `archivo`)' });
  }

  const tmpPath = file.path;
  let ocrResult;
  try {
    ocrResult = await extractCotizacion(tmpPath);
  } catch (err) {
    // Borrar tmp aunque falle.
    unlink(tmpPath).catch(() => {});
    if (err instanceof CotizacionOcrError) {
      console.error('[cotizaciones-ocr] extract failed:', err.message);
      return res.status(422).json({
        error: 'OCR failed',
        detail: err.message,
      });
    }
    console.error('[cotizaciones-ocr] unexpected error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }

  // OCR ok → borrar tmp file (best effort).
  unlink(tmpPath).catch((e) => {
    console.warn('[cotizaciones-ocr] no pude borrar tmp:', tmpPath, e.message);
  });

  const { data, model, raw, warnings } = ocrResult;

  // Enrichment: match de proveedor + items.
  let proveedorMatch = null;
  try {
    proveedorMatch = await matchProveedor({
      identificacion: data?.proveedor?.identificacion,
      nombre: data?.proveedor?.nombre,
    });
  } catch (err) {
    console.warn('[cotizaciones-ocr] matchProveedor falló:', err.message);
  }

  let itemsEnriched = data?.items ?? [];
  try {
    itemsEnriched = await enrichItems(data?.items ?? []);
  } catch (err) {
    console.warn('[cotizaciones-ocr] enrichItems falló:', err.message);
  }

  return res.json({
    data,
    model,
    raw,
    warnings,
    matches: {
      proveedorId: proveedorMatch?.id ?? null,
      proveedorNombre: proveedorMatch?.nombre ?? null,
      items: itemsEnriched.map((it) => ({
        descripcion: it.descripcion,
        cantidad: it.cantidad,
        unidad: it.unidad,
        precioUnitario: it.precioUnitario,
        subtotal: it.subtotal,
        ivaMonto: it.ivaMonto,
        materialId: it.materialId ?? null,
        materialNombre: it.materialNombre ?? null,
      })),
    },
  });
}

// Exports para tests.
export const __testables = { matchProveedor, enrichItems };
