/**
 * OCR de facturas no-electrónicas via Gemini Flash-Lite con structured output.
 *
 * Port del módulo Python `apps/facturas/parsers/ocr_gemini.py` (ConstruMaster v1).
 *
 * Modelo default: `gemini-3.1-flash-lite` (preview, override por env var
 * OCR_MODEL para fallback a `gemini-2.5-flash-lite` stable).
 *
 * Costo aproximado: ~$0.30/mes para 900 facturas/mes (Flash-Lite). Datos
 * salen a Google API.
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { GoogleGenAI } from '@google/genai';

// JSON Schema constrained output (mismo schema que el Python parser, fix #12
// regex DIMEX 9-12 dígitos).
export const INVOICE_SCHEMA = {
  type: 'object',
  properties: {
    emisor: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        identificacion: { type: 'string' },
      },
      required: ['nombre'],
    },
    consecutivo: { type: 'string' },
    clave: { type: 'string' },
    fecha: { type: 'string', format: 'date' },
    moneda: { type: 'string', enum: ['CRC', 'USD'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          descripcion: { type: 'string' },
          cantidad: { type: 'number' },
          unidad: { type: 'string' },
          precio_unitario: { type: 'number' },
          subtotal: { type: 'number' },
          iva: { type: 'number' },
        },
        required: ['descripcion'],
      },
    },
    subtotal: { type: 'number' },
    iva: { type: 'number' },
    total: { type: 'number' },
    confianza: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['emisor', 'fecha', 'total'],
};

const PROMPT = `Extraé los datos de esta factura costarricense.
Si un campo no es legible, dejalo vacío en lugar de inventar.
Reportá tu confianza self-assessment (0.0-1.0) en el campo "confianza".
La moneda es CRC (colones costarricenses) o USD (dólares).
La cédula del emisor puede ser jurídica CR (10 dígitos), física CR (9 dígitos),
o DIMEX (11-12 dígitos para residentes extranjeros).
`;

// Cédula CR jurídica/física/DIMEX: 9-12 dígitos (fix #12 del review externo).
const CEDULA_REGEX = /^\d{9,12}$/;

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
};

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

/**
 * Error en proceso OCR (config faltante, file not found, modelo rechaza, etc).
 */
export class OCRError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'OCRError';
  }
}

/**
 * Factory del cliente Gemini. Exportado para permitir mocks en tests
 * (mock.method(geminiClientFactory, 'create', ...)).
 */
export const geminiClientFactory = {
  create(apiKey) {
    return new GoogleGenAI({ apiKey });
  },
};

/**
 * OCR de una factura (PDF/imagen) via Gemini Flash-Lite.
 *
 * @param {string} filePath - Ruta absoluta al archivo (PDF/JPG/PNG/WebP/HEIC).
 * @returns {Promise<{
 *   data: object,
 *   confidence: number|null,
 *   model: string,
 *   raw: string,
 * }>} `data` puede contener `_warnings` (string[]) con validaciones blandas
 *     que pasaron (cédula no estándar, total <= 0). Estas no impiden el
 *     resultado — el supervisor las revisa al confirmar. Y `data.status`
 *     será `'low_confidence'` si hubo warnings.
 *
 * @throws {OCRError} GEMINI_API_KEY no configurado, file not found, error
 *     parseando JSON de respuesta, error de red de Gemini.
 */
export async function extractInvoice(filePath) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new OCRError('GEMINI_API_KEY no configurado en environment');
  }

  const model = process.env.OCR_MODEL || DEFAULT_MODEL;

  const ext = extname(filePath).toLowerCase();
  const mimeType = MIME_BY_EXT[ext] || 'application/octet-stream';

  let fileBytes;
  try {
    fileBytes = await readFile(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new OCRError(`Archivo no encontrado: ${filePath}`, { cause: err });
    }
    throw new OCRError(`Error leyendo archivo ${filePath}: ${err.message}`, {
      cause: err,
    });
  }

  const client = geminiClientFactory.create(apiKey);

  let response;
  try {
    response = await client.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                data: fileBytes.toString('base64'),
                mimeType,
              },
            },
            { text: PROMPT },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: INVOICE_SCHEMA,
        temperature: 0,
      },
    });
  } catch (err) {
    throw new OCRError(`Gemini API error: ${err.message}`, { cause: err });
  }

  const raw = typeof response.text === 'string' ? response.text : '';
  if (!raw) {
    throw new OCRError('Respuesta de Gemini vacía o sin texto');
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new OCRError(`Respuesta no parseable como JSON: ${err.message}`, {
      cause: err,
    });
  }

  // Extraer confidence (self-assessment del modelo), removerlo del data
  // para evitar duplicado.
  let confidence = null;
  if (typeof data.confianza === 'number') {
    confidence = data.confianza;
  }
  delete data.confianza;

  // Validaciones blandas (no levantan; agregan _warnings + status).
  const warnings = [];

  if (typeof data.total !== 'number' || data.total <= 0) {
    warnings.push('total inválido (<=0)');
  }

  const ced = data.emisor?.identificacion;
  if (ced && !CEDULA_REGEX.test(String(ced))) {
    warnings.push(
      `cédula no matchea regex 9-12 dígitos (CR física/jurídica/DIMEX): ${ced}`,
    );
  }

  if (warnings.length > 0) {
    data._warnings = warnings;
    data.status = 'low_confidence';
  }

  return { data, confidence, model, raw };
}
