/**
 * OCR de COTIZACIONES (presupuestos) de proveedores via Gemini Flash-Lite.
 *
 * Hermano de `gemini-ocr.js` (que maneja FACTURAS Hacienda CR v4.4). Las
 * cotizaciones son documentos distintos: NO tienen clave numérica ni
 * consecutivo formal, SÍ tienen fecha de validez, condiciones de pago,
 * plazo de entrega y % de anticipo.
 *
 * Modelo default: `gemini-3.1-flash-lite` (preview), override por env var
 * OCR_MODEL.
 *
 * Costo aproximado: similar a facturas (~$0.30/mes en volúmenes esperados).
 * Datos salen a Google API.
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { GoogleGenAI } from '@google/genai';

// JSON Schema constrained output específico para cotizaciones de proveedor.
export const COTIZACION_SCHEMA = {
  type: 'object',
  properties: {
    proveedor: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        identificacion: {
          type: 'string',
          description: 'Cédula jurídica o física, 9-12 dígitos',
        },
        telefono: { type: 'string' },
        email: { type: 'string' },
      },
      required: ['nombre'],
    },
    numeroCotizacion: {
      type: 'string',
      description:
        'Número que aparece en el documento. Puede ser COT-001, vlsdmf-2026-001, etc.',
    },
    fecha: {
      type: 'string',
      description: 'Fecha de emisión YYYY-MM-DD',
    },
    fechaValidez: {
      type: 'string',
      description:
        'Fecha hasta la que es válida la cotización YYYY-MM-DD si la indica',
    },
    moneda: { type: 'string', enum: ['CRC', 'USD'] },
    condicionesPago: {
      type: 'string',
      description: 'Texto libre: contado, crédito 30 días, etc.',
    },
    plazoEntregaDias: {
      type: 'integer',
      description: 'Días para entrega desde aprobación',
    },
    pctAnticipo: {
      type: 'number',
      description: 'Porcentaje de anticipo solicitado (0-100)',
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          descripcion: { type: 'string' },
          cantidad: { type: 'number' },
          unidad: {
            type: 'string',
            description: 'saco, kg, m3, unidad, etc.',
          },
          precioUnitario: { type: 'number' },
          subtotal: { type: 'number' },
          ivaMonto: { type: 'number' },
        },
        required: ['descripcion', 'cantidad', 'precioUnitario'],
      },
    },
    subtotal: { type: 'number' },
    iva: { type: 'number' },
    total: { type: 'number' },
    notas: {
      type: 'string',
      description: 'Cualquier nota o aclaración relevante del documento',
    },
  },
  required: ['proveedor', 'items', 'total'],
};

const PROMPT = `Extraé los datos de esta cotización (presupuesto) que envió un proveedor para una obra de construcción.
Devolvé un JSON con la estructura indicada en el schema.
Si un campo no aparece en el documento, omitilo (no inventes).
Para precios y montos en colones (₡, CRC), retorná solo el número sin símbolos.
La moneda es CRC (colones costarricenses) o USD (dólares).
La cédula del proveedor puede ser jurídica CR (10 dígitos), física CR (9 dígitos),
o DIMEX (11-12 dígitos para residentes extranjeros).
`;

// Cédula CR jurídica/física/DIMEX: 9-12 dígitos.
const CEDULA_REGEX = /^\d{9,12}$/;

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

/**
 * Error en proceso OCR de cotización (config faltante, file not found,
 * modelo rechaza, etc).
 */
export class CotizacionOcrError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'CotizacionOcrError';
  }
}

/**
 * Factory del cliente Gemini. Exportado para permitir mocks en tests.
 */
export const geminiClientFactory = {
  create(apiKey) {
    return new GoogleGenAI({ apiKey });
  },
};

/**
 * OCR de una cotización (PDF/imagen) via Gemini Flash-Lite.
 *
 * @param {string} filePath - Ruta absoluta al archivo.
 * @returns {Promise<{
 *   data: object,
 *   model: string,
 *   raw: string,
 *   warnings: string[],
 * }>}
 *
 * @throws {CotizacionOcrError} GEMINI_API_KEY no configurado, file not found,
 *     error parseando JSON, error de red Gemini.
 */
export async function extractCotizacion(filePath) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new CotizacionOcrError('GEMINI_API_KEY no configurado en environment');
  }

  const model = process.env.OCR_MODEL || DEFAULT_MODEL;

  const ext = extname(filePath).toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) {
    throw new CotizacionOcrError(
      `Tipo de archivo no soportado: ${ext || '(sin extensión)'}`,
    );
  }

  let fileBytes;
  try {
    fileBytes = await readFile(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new CotizacionOcrError(`Archivo no encontrado: ${filePath}`, {
        cause: err,
      });
    }
    throw new CotizacionOcrError(
      `Error leyendo archivo ${filePath}: ${err.message}`,
      { cause: err },
    );
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
        responseSchema: COTIZACION_SCHEMA,
        temperature: 0.1,
      },
    });
  } catch (err) {
    throw new CotizacionOcrError(`Gemini API error: ${err.message}`, {
      cause: err,
    });
  }

  const raw = typeof response.text === 'string' ? response.text : '';
  if (!raw) {
    throw new CotizacionOcrError('Respuesta de Gemini vacía o sin texto');
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new CotizacionOcrError(
      `Respuesta no parseable como JSON: ${err.message}`,
      { cause: err },
    );
  }

  // Validaciones blandas — no levantan, devuelven warnings para que la UI
  // decida si mostrar advertencias al usuario antes de pre-llenar el form.
  const warnings = [];

  if (!data.proveedor || !data.proveedor.nombre) {
    warnings.push('proveedor sin nombre');
  }

  const ced = data.proveedor?.identificacion;
  if (ced && !CEDULA_REGEX.test(String(ced))) {
    warnings.push(
      `cédula no matchea regex 9-12 dígitos (CR física/jurídica/DIMEX): ${ced}`,
    );
  }

  if (typeof data.total !== 'number' || data.total <= 0) {
    warnings.push('total inválido o no detectado (<=0)');
  }

  if (!Array.isArray(data.items) || data.items.length === 0) {
    warnings.push('sin items detectados');
  } else {
    const itemsSinPrecio = data.items.filter(
      (it) => typeof it.precioUnitario !== 'number' || it.precioUnitario <= 0,
    );
    if (itemsSinPrecio.length > 0) {
      warnings.push(
        `${itemsSinPrecio.length} item(s) sin precio unitario válido`,
      );
    }
  }

  return { data, model, raw, warnings };
}
