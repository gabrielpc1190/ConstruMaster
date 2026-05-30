/**
 * Helpers de almacenamiento de archivos subidos.
 *
 * Por ahora solo factura XML; el día que entre PDF/imagen, sumamos otro
 * `multer` con `fileFilter` distinto, manteniendo el layout
 * `uploads/<tipo>/<año>/<mes>/<oc_id>/<uuid>-<filename>`.
 *
 * Decisiones (de la spec):
 *  - `multer.diskStorage` con `filename` que usa UUID + nombre original
 *    sanitizado (sin path traversal).
 *  - `fileFilter` acepta solo `application/xml`, `text/xml` o extensión `.xml`.
 *  - Límite 20 MiB.
 *  - El campo del form se llama `archivo`.
 *
 * Devuelve la ruta RELATIVA a `uploads/` para guardar en DB; nunca persistimos
 * la ruta absoluta (portabilidad entre hosts / contenedores).
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import multer from 'multer';

// ---------------------------------------------------------------------------
// Paths base
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
// server/lib/uploads.js → projectRoot = ../../
const PROJECT_ROOT = resolve(dirname(__filename), '..', '..');
export const UPLOADS_ROOT = join(PROJECT_ROOT, 'uploads');

/** Convierte ruta absoluta → ruta relativa a `uploads/` (con `/` siempre). */
export function relativeToUploads(absPath) {
  const rel = absPath.startsWith(UPLOADS_ROOT)
    ? absPath.slice(UPLOADS_ROOT.length).replace(/^[\\/]+/, '')
    : absPath;
  return rel.split('\\').join('/');
}

/** Convierte ruta relativa (guardada en DB) → ruta absoluta del disco. */
export function absoluteFromUploads(relPath) {
  // Defensa contra path traversal: bloqueamos `..` y rutas absolutas.
  if (!relPath || relPath.includes('..') || /^([a-zA-Z]:)?[\\/]/.test(relPath)) {
    throw new Error(`Ruta inválida: ${relPath}`);
  }
  return join(UPLOADS_ROOT, relPath);
}

// ---------------------------------------------------------------------------
// Sanitización de nombre de archivo
// ---------------------------------------------------------------------------

/**
 * Sanitiza un nombre de archivo recibido del cliente:
 *  - quita cualquier path component (basename only)
 *  - normaliza unicode (descarta acentos)
 *  - reemplaza cualquier char no [a-zA-Z0-9.-_] por `_`
 *  - colapsa runs de `_`
 *  - máx 100 chars, manteniendo extensión.
 */
export function sanitizeFilename(originalName) {
  const safeName = basename(String(originalName || 'archivo.xml'));
  const ext = extname(safeName).toLowerCase();
  let stem = safeName.slice(0, safeName.length - ext.length);

  stem = stem.normalize('NFD').replace(/[̀-ͯ]/g, '');
  stem = stem.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/_+/g, '_');
  stem = stem.replace(/^_+|_+$/g, '');
  if (!stem) stem = 'archivo';

  // Limitar largo total a ~100 chars.
  const maxStem = 100 - ext.length;
  if (stem.length > maxStem) stem = stem.slice(0, maxStem);
  return `${stem}${ext}`;
}

// ---------------------------------------------------------------------------
// Path generator (también utilizable desde tests sin pasar por multer)
// ---------------------------------------------------------------------------

/**
 * Genera la ruta de destino RELATIVA a `uploads/` para una factura.
 *
 * Layout: `facturas/<año>/<mes>/<ocId>/<uuid>-<sanitized>`
 *
 * @param {{ ocId: string|number|bigint, originalName: string, now?: Date }} args
 * @returns {{ relativePath: string, absolutePath: string, filename: string, dir: string }}
 */
export function factoraStoragePath({ ocId, originalName, now }) {
  const date = now instanceof Date ? now : new Date();
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const safeName = sanitizeFilename(originalName);
  const filename = `${randomUUID()}-${safeName}`;
  const dirRel = `facturas/${year}/${month}/${String(ocId)}`;
  const relativePath = `${dirRel}/${filename}`;
  const absolutePath = join(UPLOADS_ROOT, dirRel, filename);
  return {
    relativePath,
    absolutePath,
    filename,
    dir: join(UPLOADS_ROOT, dirRel),
  };
}

// ---------------------------------------------------------------------------
// Multer middleware para subida de XMLs
// ---------------------------------------------------------------------------

const XML_MIME_TYPES = new Set(['application/xml', 'text/xml']);

/**
 * `fileFilter` para multer. Aceptamos:
 *  - mimetype `application/xml` o `text/xml` o
 *  - cualquier mimetype si la extensión es `.xml` (algunos navegadores envían
 *    `application/octet-stream` cuando arrastran un .xml).
 */
function xmlFileFilter(_req, file, cb) {
  const ext = extname(file.originalname || '').toLowerCase();
  if (XML_MIME_TYPES.has(file.mimetype) || ext === '.xml') {
    return cb(null, true);
  }
  const err = new Error(
    `Tipo de archivo no permitido (mime=${file.mimetype}, ext=${ext}). Esperado XML.`,
  );
  err.status = 415;
  err.code = 'INVALID_FILE_TYPE';
  return cb(err);
}

const xmlStorage = multer.diskStorage({
  destination(req, _file, cb) {
    try {
      const ocId = req.params.ocId ?? req.params.id ?? 'unknown';
      const date = new Date();
      const year = String(date.getUTCFullYear());
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const dir = join(UPLOADS_ROOT, 'facturas', year, month, String(ocId));
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename(_req, file, cb) {
    try {
      const safe = sanitizeFilename(file.originalname);
      cb(null, `${randomUUID()}-${safe}`);
    } catch (err) {
      cb(err);
    }
  },
});

/**
 * Middleware multer para subida de XML de factura. Lee un único archivo del
 * field `archivo`. Tira 415 si el mimetype no es XML, 413 si excede 20 MiB.
 */
export const xmlUpload = multer({
  storage: xmlStorage,
  fileFilter: xmlFileFilter,
  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MiB
    files: 1,
  },
}).single('archivo');

// ---------------------------------------------------------------------------
// Multer middleware para subida de FOTOS de entregas
// ---------------------------------------------------------------------------
//
// Layout: `uploads/entregas/<año>/<mes>/<entregaId>/<uuid>-<filename>`.
// Acepta: image/jpeg, image/png, image/heif, image/heic, image/webp.
// Máx: 10 MiB por archivo, 10 archivos por request. Field: `fotos` (array).
//
// IMPORTANTE: NO recomprimimos. Guardamos bytes raw para preservar EXIF
// (las fotos son evidencia legal de recepción de material). Si en el futuro
// se usa `sharp` para thumbnails, asegurar `withMetadata()` en pipeline.

const FOTO_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/heif',
  'image/heic',
  'image/webp',
]);
const FOTO_EXT_WHITELIST = new Set(['.jpg', '.jpeg', '.png', '.heif', '.heic', '.webp']);

function fotoFileFilter(_req, file, cb) {
  const ext = extname(file.originalname || '').toLowerCase();
  if (FOTO_MIME_TYPES.has(file.mimetype) || FOTO_EXT_WHITELIST.has(ext)) {
    return cb(null, true);
  }
  const err = new Error(
    `Tipo de archivo no permitido (mime=${file.mimetype}, ext=${ext}). Esperado JPEG, PNG, HEIF o WEBP.`,
  );
  err.status = 415;
  err.code = 'INVALID_FILE_TYPE';
  return cb(err);
}

const fotoStorage = multer.diskStorage({
  destination(req, _file, cb) {
    try {
      const entregaId = req.params.id ?? req.params.entregaId ?? 'unknown';
      const date = new Date();
      const year = String(date.getUTCFullYear());
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const dir = join(UPLOADS_ROOT, 'entregas', year, month, String(entregaId));
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename(_req, file, cb) {
    try {
      const safe = sanitizeFilename(file.originalname);
      cb(null, `${randomUUID()}-${safe}`);
    } catch (err) {
      cb(err);
    }
  },
});

/**
 * Genera la ruta de destino RELATIVA a `uploads/` para una foto de entrega.
 * Útil en tests para producir paths sin pasar por multer.
 *
 * @param {{ entregaId: string|number|bigint, originalName: string, now?: Date }} args
 * @returns {{ relativePath: string, absolutePath: string, filename: string, dir: string }}
 */
export function entregaFotoStoragePath({ entregaId, originalName, now }) {
  const date = now instanceof Date ? now : new Date();
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const safeName = sanitizeFilename(originalName);
  const filename = `${randomUUID()}-${safeName}`;
  const dirRel = `entregas/${year}/${month}/${String(entregaId)}`;
  const relativePath = `${dirRel}/${filename}`;
  const absolutePath = join(UPLOADS_ROOT, dirRel, filename);
  return {
    relativePath,
    absolutePath,
    filename,
    dir: join(UPLOADS_ROOT, dirRel),
  };
}

/**
 * Middleware multer para subida de fotos de entrega. Lee hasta 10 archivos del
 * field `fotos`. Tira 415 si el mimetype no es imagen, 413 si excede 10 MiB.
 */
export const fotoUpload = multer({
  storage: fotoStorage,
  fileFilter: fotoFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MiB por archivo
    files: 10, // hasta 10 fotos por request
  },
}).array('fotos', 10);

// ---------------------------------------------------------------------------
// Multer middleware para subida de ARCHIVO DE EVIDENCIA de cotizaciones
// ---------------------------------------------------------------------------
//
// Layout: `uploads/cotizaciones/<año>/<mes>/<cotizacionId>/<uuid>-<filename>`.
// Acepta: application/pdf, image/jpeg, image/png, image/heic, image/heif,
//         image/webp. Field name: `archivo` (single).
// Máx: 20 MiB por archivo.
//
// Decisiones:
//  - El `cotizacionId` viene en `req.params.cotizacionId` o `req.params.id`
//    (la ruta es POST /api/cotizaciones/:id/archivo). Multer ejecuta
//    `destination` ANTES del controller, por lo que el id ya está disponible.
//  - NO recomprimimos. Bytes raw — la cotización es evidencia legal del precio
//    ofrecido por el proveedor.
//  - El nombre original se sanitiza vía `sanitizeFilename`.

const COTIZACION_ARCHIVO_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
]);
const COTIZACION_ARCHIVO_EXT_WHITELIST = new Set([
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.heic',
  '.heif',
  '.webp',
]);

function cotizacionArchivoFileFilter(_req, file, cb) {
  const ext = extname(file.originalname || '').toLowerCase();
  if (
    COTIZACION_ARCHIVO_MIME_TYPES.has(file.mimetype) ||
    COTIZACION_ARCHIVO_EXT_WHITELIST.has(ext)
  ) {
    return cb(null, true);
  }
  const err = new Error(
    `Tipo de archivo no permitido (mime=${file.mimetype}, ext=${ext}). Esperado PDF, JPEG, PNG, HEIC, HEIF o WEBP.`,
  );
  err.status = 415;
  err.code = 'INVALID_FILE_TYPE';
  return cb(err);
}

const cotizacionArchivoStorage = multer.diskStorage({
  destination(req, _file, cb) {
    try {
      const cotizacionId = req.params.cotizacionId ?? req.params.id ?? 'unknown';
      const date = new Date();
      const year = String(date.getUTCFullYear());
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const dir = join(UPLOADS_ROOT, 'cotizaciones', year, month, String(cotizacionId));
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename(_req, file, cb) {
    try {
      const safe = sanitizeFilename(file.originalname);
      cb(null, `${randomUUID()}-${safe}`);
    } catch (err) {
      cb(err);
    }
  },
});

/**
 * Genera la ruta de destino RELATIVA a `uploads/` para un archivo de
 * cotización. Útil en tests para producir paths sin pasar por multer.
 *
 * Layout: `cotizaciones/<año>/<mes>/<cotizacionId>/<uuid>-<sanitized>`
 *
 * @param {{ cotizacionId: string|number|bigint, originalName: string, now?: Date }} args
 * @returns {{ relativePath: string, absolutePath: string, filename: string, dir: string }}
 */
export function cotizacionArchivoStoragePath({ cotizacionId, originalName, now }) {
  const date = now instanceof Date ? now : new Date();
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const safeName = sanitizeFilename(originalName);
  const filename = `${randomUUID()}-${safeName}`;
  const dirRel = `cotizaciones/${year}/${month}/${String(cotizacionId)}`;
  const relativePath = `${dirRel}/${filename}`;
  const absolutePath = join(UPLOADS_ROOT, dirRel, filename);
  return {
    relativePath,
    absolutePath,
    filename,
    dir: join(UPLOADS_ROOT, dirRel),
  };
}

/**
 * Middleware multer para subida de archivo de evidencia de cotización. Lee un
 * único archivo del field `archivo`. Tira 415 si el mimetype no es PDF/imagen,
 * 413 si excede 20 MiB.
 */
export const cotizacionArchivoUpload = multer({
  storage: cotizacionArchivoStorage,
  fileFilter: cotizacionArchivoFileFilter,
  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MiB
    files: 1,
  },
}).single('archivo');

// ---------------------------------------------------------------------------
// Multer middleware para subida de FACTURA ESCANEADA (PDF/imagen)
// ---------------------------------------------------------------------------
//
// Para facturas no-electrónicas que el operador recibe en PDF o foto y deben
// pasar por OCR Gemini (`services/gemini-ocr.js`). Mismo layout en disco que
// el XML para mantener consistencia: `facturas/<año>/<mes>/<ocId>/<uuid>-<safe>`.
//
// Acepta: application/pdf, image/jpeg, image/png, image/heic, image/heif,
//         image/webp. Field name: `archivo` (single).
// Máx: 20 MiB por archivo.

const FACTURA_IMAGEN_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
]);
const FACTURA_IMAGEN_EXT_WHITELIST = new Set([
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.heic',
  '.heif',
  '.webp',
]);

function facturaImagenFileFilter(_req, file, cb) {
  const ext = extname(file.originalname || '').toLowerCase();
  if (
    FACTURA_IMAGEN_MIME_TYPES.has(file.mimetype) ||
    FACTURA_IMAGEN_EXT_WHITELIST.has(ext)
  ) {
    return cb(null, true);
  }
  const err = new Error(
    `Tipo de archivo no permitido (mime=${file.mimetype}, ext=${ext}). Esperado PDF, JPEG, PNG, HEIC, HEIF o WEBP.`,
  );
  err.status = 415;
  err.code = 'INVALID_FILE_TYPE';
  return cb(err);
}

const facturaImagenStorage = multer.diskStorage({
  destination(req, _file, cb) {
    try {
      const ocId = req.params.ocId ?? req.params.id ?? 'unknown';
      const date = new Date();
      const year = String(date.getUTCFullYear());
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const dir = join(UPLOADS_ROOT, 'facturas', year, month, String(ocId));
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename(_req, file, cb) {
    try {
      const safe = sanitizeFilename(file.originalname);
      cb(null, `${randomUUID()}-${safe}`);
    } catch (err) {
      cb(err);
    }
  },
});

/**
 * Genera la ruta de destino RELATIVA a `uploads/` para una factura escaneada.
 *
 * Layout: `facturas/<año>/<mes>/<ocId>/<uuid>-<sanitized>` (mismo que XML).
 *
 * @param {{ ocId: string|number|bigint, originalName: string, now?: Date }} args
 * @returns {{ relativePath: string, absolutePath: string, filename: string, dir: string }}
 */
export function factImagenStoragePath({ ocId, originalName, now }) {
  const date = now instanceof Date ? now : new Date();
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const safeName = sanitizeFilename(originalName);
  const filename = `${randomUUID()}-${safeName}`;
  const dirRel = `facturas/${year}/${month}/${String(ocId)}`;
  const relativePath = `${dirRel}/${filename}`;
  const absolutePath = join(UPLOADS_ROOT, dirRel, filename);
  return {
    relativePath,
    absolutePath,
    filename,
    dir: join(UPLOADS_ROOT, dirRel),
  };
}

/**
 * Middleware multer para subida de factura escaneada (PDF/imagen). Lee un
 * único archivo del field `archivo`. Tira 415 si el mimetype no es PDF/imagen,
 * 413 si excede 20 MiB.
 */
export const facturaImagenUpload = multer({
  storage: facturaImagenStorage,
  fileFilter: facturaImagenFileFilter,
  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MiB
    files: 1,
  },
}).single('archivo');
