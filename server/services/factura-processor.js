/**
 * Procesamiento de facturas (XML + OCR Gemini) compartido entre:
 *  - el controller sync (path inline cuando no hay Redis), y
 *  - el worker async (`server/queues/factura-worker.js` cuando hay Redis).
 *
 * Ambos paths deben dejar la Factura EXACTAMENTE en el mismo estado final, así
 * la UI no distingue origen. Las funciones son **idempotentes**: si la Factura
 * ya está en `extracted` o `confirmed`, no la reprocesan (devuelven la row tal
 * cual).
 *
 * Errores:
 *  - `parseComprobanteXml` puede lanzar `XmlSyntaxError` / `UnknownComprobanteError`
 *    — son permanentes. El processor los captura, marca la Factura como `error`
 *    y NO los re-lanza. El worker debe interpretar esto como "job completado
 *    correctamente, no hay nada que reintentar".
 *  - `extractInvoice` (Gemini OCR) puede lanzar `OCRError` — también permanente.
 *  - P2002 (UNIQUE clave_numerica) en el path XML → marca como error con un
 *    mensaje específico. NO borra la Factura ni el archivo (el supervisor
 *    decide qué hacer; con el path inline, el controller sync sí los borraba
 *    porque era response 409, pero acá no podemos responder).
 *  - Cualquier otro throw es bug nuestro — lo dejamos propagar para que el
 *    worker reintente (BullMQ backoff) o el controller responda 500.
 *
 * Validación XSD opt-in:
 *  - Si `XSD_VALIDATE=true`, antes de `parseComprobanteXml` se valida con
 *    `validateXml`. Si falla → status='error' con el primer mensaje.
 *  - La detección del tipo para el XSD se hace con un mini-pre-parse (regex
 *    sobre el root element), evitando tener que parsear dos veces.
 */
import { readFile } from 'node:fs/promises';

import {
  parseComprobanteXml,
  XmlSyntaxError,
  UnknownComprobanteError,
  NAMESPACE_MAP,
} from './xml-parser.js';
import { extractInvoice, OCRError } from './gemini-ocr.js';
import { absoluteFromUploads } from '../lib/uploads.js';
import { validateXml, isXsdEnabled } from './xml-validator.js';

// ---------------------------------------------------------------------------
// Helpers compartidos
// ---------------------------------------------------------------------------

const FINAL_STATUSES = new Set(['extracted', 'confirmed']);

function parseHaciendaDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function buildCanonicalFromParsed(parsed) {
  const totalComp = parsed.totales?.totalComprobante ?? null;
  const monedaCode = parsed.moneda || 'CRC';
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

function parseLooseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function normalizeCurrency(value) {
  if (!value) return 'CRC';
  const code = String(value).trim().toUpperCase();
  if (code === 'CRC' || code === 'USD') return code;
  return 'CRC';
}

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
    numeroConsecutivo: numeroConsecutivo != null ? String(numeroConsecutivo) : null,
    fechaEmision,
    montoTotalAmount: hasTotal ? totalNum : null,
    montoTotalCurrency: hasTotal ? currency : null,
    condicionVenta: null,
    mediosPago: [],
  };
}

/**
 * Detecta el tipo de comprobante con un mini-regex (sin parsear el XML
 * completo). Sirve para elegir el XSD adecuado ANTES del parser oficial.
 * Si no encuentra match, devuelve null y el llamador puede saltar la
 * validación XSD (parser oficial igual va a tirar UnknownComprobanteError).
 */
function detectTypeFromXmlString(xmlString) {
  // Match: xmlns="https://cdn.comprobanteselectronicos.go.cr/.../tipoX"
  const nsMatch = xmlString.match(
    /xmlns(?::[\w-]+)?\s*=\s*["']([^"']+comprobanteselectronicos\.go\.cr[^"']+)["']/,
  );
  if (nsMatch && NAMESPACE_MAP[nsMatch[1]]) return NAMESPACE_MAP[nsMatch[1]];
  // Fallback por root element name
  const rootMatch = xmlString.match(/<(?:[\w-]+:)?([A-Z][\w]+)\b/);
  if (rootMatch) {
    const local = rootMatch[1];
    const map = {
      FacturaElectronica: 'FE',
      TiqueteElectronico: 'TE',
      NotaCreditoElectronica: 'NC',
      NotaDebitoElectronica: 'ND',
      FacturaElectronicaCompra: 'FEC',
      FacturaElectronicaExportacion: 'FEE',
    };
    if (map[local]) return map[local];
  }
  return null;
}

// ---------------------------------------------------------------------------
// XML processor
// ---------------------------------------------------------------------------

/**
 * Procesa una Factura `pending`/`processing` con `sourceType='xml'`. Lee el
 * archivo de disco, parsea con `xml-parser`, opcionalmente valida XSD, y
 * actualiza la row a `extracted` o `error`.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {bigint|number|string} facturaId
 * @returns {Promise<object>} Factura actualizada (BigInt no convertido — el
 *                            caller responde JSON con `facturaToJson`).
 */
export async function processFacturaXml(prisma, facturaId) {
  const id = typeof facturaId === 'bigint' ? facturaId : BigInt(facturaId);

  const factura = await prisma.factura.findUnique({ where: { id } });
  if (!factura) {
    const err = new Error(`Factura ${id} no encontrada`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (FINAL_STATUSES.has(factura.status)) {
    return factura; // idempotente
  }
  if (factura.sourceType !== 'xml') {
    const err = new Error(
      `Factura ${id} tiene sourceType="${factura.sourceType}", se esperaba "xml"`,
    );
    err.code = 'WRONG_SOURCE';
    throw err;
  }
  if (!factura.archivoOriginalPath) {
    return prisma.factura.update({
      where: { id },
      data: { status: 'error', errorMessage: 'Sin archivo asociado' },
    });
  }

  // Marcar processing (opcional — ya puede estar). Solo si no.
  if (factura.status !== 'processing') {
    await prisma.factura.update({
      where: { id },
      data: { status: 'processing' },
    });
  }

  const absPath = absoluteFromUploads(factura.archivoOriginalPath);
  let xmlString;
  try {
    xmlString = await readFile(absPath, 'utf-8');
  } catch (err) {
    return prisma.factura.update({
      where: { id },
      data: {
        status: 'error',
        errorMessage: `No se pudo leer archivo: ${err.message}`,
      },
    });
  }

  // Validación XSD opt-in.
  if (isXsdEnabled()) {
    const tipo = detectTypeFromXmlString(xmlString);
    if (tipo) {
      const xsd = await validateXml(xmlString, tipo);
      if (!xsd.valid) {
        const first = xsd.errors[0]?.message || 'XSD validation failed';
        return prisma.factura.update({
          where: { id },
          data: {
            status: 'error',
            errorMessage: `XSD validation failed: ${first}`,
          },
        });
      }
    }
  }

  let parsed;
  try {
    parsed = parseComprobanteXml(xmlString);
  } catch (err) {
    if (err instanceof XmlSyntaxError || err instanceof UnknownComprobanteError) {
      return prisma.factura.update({
        where: { id },
        data: {
          status: 'error',
          errorMessage: err.message,
        },
      });
    }
    throw err;
  }

  const canonical = buildCanonicalFromParsed(parsed);
  try {
    return await prisma.factura.update({
      where: { id },
      data: {
        ...canonical,
        extractedData: parsed,
        status: 'extracted',
        confidenceScore: null,
        errorMessage: null,
      },
    });
  } catch (err) {
    if (err && err.code === 'P2002') {
      // Conflict en clave_numerica. En el path inline (controller), esto se
      // manejaba con un 409 + cleanup del archivo. Acá (path worker) NO
      // borramos: dejamos la factura como error para que el operador la
      // revise y la pueda eliminar manualmente desde la UI.
      return prisma.factura.update({
        where: { id },
        data: {
          status: 'error',
          errorMessage: `Factura con clave_numerica="${canonical.claveNumerica}" ya existe`,
        },
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Imagen / PDF (OCR Gemini) processor
// ---------------------------------------------------------------------------

const DEFAULT_CONFIDENCE = 0.85;

/**
 * Procesa una Factura `pending`/`processing` con `sourceType in {'pdf','imagen'}`.
 * Llama Gemini OCR, mapea al schema canónico y actualiza la row.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {bigint|number|string} facturaId
 * @returns {Promise<object>} Factura actualizada.
 */
export async function processFacturaImagen(prisma, facturaId) {
  const id = typeof facturaId === 'bigint' ? facturaId : BigInt(facturaId);

  const factura = await prisma.factura.findUnique({ where: { id } });
  if (!factura) {
    const err = new Error(`Factura ${id} no encontrada`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (FINAL_STATUSES.has(factura.status)) {
    return factura;
  }
  if (factura.sourceType === 'xml') {
    const err = new Error(`Factura ${id} es XML, usar processFacturaXml`);
    err.code = 'WRONG_SOURCE';
    throw err;
  }
  if (!factura.archivoOriginalPath) {
    return prisma.factura.update({
      where: { id },
      data: { status: 'error', errorMessage: 'Sin archivo asociado' },
    });
  }

  if (factura.status !== 'processing') {
    await prisma.factura.update({
      where: { id },
      data: { status: 'processing' },
    });
  }

  const absPath = absoluteFromUploads(factura.archivoOriginalPath);
  let ocrResult;
  try {
    ocrResult = await extractInvoice(absPath);
  } catch (err) {
    const message = err instanceof OCRError ? err.message : `OCR falló: ${err.message}`;
    return prisma.factura.update({
      where: { id },
      data: {
        status: 'error',
        errorMessage: message,
      },
    });
  }

  const canonical = mapOcrToCanonical(ocrResult.data);
  const confidence =
    typeof ocrResult.confidence === 'number' ? ocrResult.confidence : DEFAULT_CONFIDENCE;

  try {
    return await prisma.factura.update({
      where: { id },
      data: {
        ...canonical,
        extractedData: ocrResult.data,
        status: 'extracted',
        confidenceScore: confidence,
        errorMessage: null,
      },
    });
  } catch (err) {
    if (err && err.code === 'P2002') {
      return prisma.factura.update({
        where: { id },
        data: {
          status: 'error',
          errorMessage: `Conflicto al persistir: ${err.meta?.target || 'unique constraint'}`,
        },
      });
    }
    throw err;
  }
}
