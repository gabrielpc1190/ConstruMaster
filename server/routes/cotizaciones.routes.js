import express from 'express';
import multer from 'multer';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole, WRITE_ROLES, CATALOG_WRITE } from '../lib/permissions.js';
import { cotizacionArchivoUpload } from '../lib/uploads.js';
import {
  listCotizaciones,
  getCotizacion,
  createCotizacion,
  updateCotizacion,
  aprobarCotizacion,
  rechazarCotizacion,
  uploadArchivoCotizacion,
  downloadArchivoCotizacion,
  deleteArchivoCotizacion,
} from '../controllers/cotizaciones.controller.js';
import { parseCotizacionDocument } from '../controllers/cotizaciones-ocr.controller.js';

const router = express.Router();

router.use(authenticateToken);

// ---------------------------------------------------------------------------
// OCR de cotizaciones (parse-document) — multer separado del flujo de
// archivo de evidencia: aquí guardamos en /tmp/ porque el archivo se borra
// después de extraer el JSON. El upload definitivo lo maneja `/:id/archivo`.
// ---------------------------------------------------------------------------

const ocrUpload = multer({
  dest: '/tmp/',
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mimeOk = /^(application\/pdf|image\/(jpeg|png|heic|heif|webp))$/.test(file.mimetype);
    const extOk = /\.(pdf|jpg|jpeg|png|heic|heif|webp)$/i.test(file.originalname || '');
    if (mimeOk || extOk) return cb(null, true);
    const err = new Error(`Tipo no soportado (mime=${file.mimetype})`);
    err.status = 415;
    err.code = 'INVALID_FILE_TYPE';
    return cb(err);
  },
});

function runOcrUpload(req, res, next) {
  ocrUpload.single('archivo')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Archivo demasiado grande (máx 20 MB)' });
    }
    if (err.code === 'INVALID_FILE_TYPE') {
      return res.status(415).json({ error: err.message });
    }
    console.error('[cotizaciones.ocr] multer error:', err);
    return res.status(err.status || 500).json({ error: err.message || 'Upload failed' });
  });
}

// IMPORTANTE: `/parse-document` debe ir ANTES de las rutas con `/:id`.
router.post(
  '/parse-document',
  requireRole(...CATALOG_WRITE),
  runOcrUpload,
  parseCotizacionDocument,
);

router.get('/', listCotizaciones);
router.post('/', createCotizacion);
router.get('/:id', getCotizacion);
router.put('/:id', updateCotizacion);
router.post('/:id/aprobar', aprobarCotizacion);
router.post('/:id/rechazar', rechazarCotizacion);

// ---------------------------------------------------------------------------
// Archivo de evidencia (PDF / foto)
// ---------------------------------------------------------------------------
//
// Multer corre ANTES del controller. Si falla (mime/size/etc.), envolvemos el
// error para devolver el status code semántico (415/413/400) en lugar del
// 500 genérico del errorHandler global. Mismo patrón que facturas.routes.js.

function runCotizacionArchivoUpload(req, res, next) {
  cotizacionArchivoUpload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Archivo demasiado grande (máx 20 MB)' });
    }
    if (err.code === 'INVALID_FILE_TYPE') {
      return res.status(415).json({ error: err.message });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Campo de archivo inesperado (esperado "archivo")' });
    }
    console.error('[cotizaciones.archivo] multer error:', err);
    return res.status(err.status || 500).json({ error: err.message || 'Upload failed' });
  });
}

router.post(
  '/:id/archivo',
  requireRole(...CATALOG_WRITE),
  runCotizacionArchivoUpload,
  uploadArchivoCotizacion,
);
router.get('/:id/archivo', downloadArchivoCotizacion);
router.delete('/:id/archivo', requireRole(...WRITE_ROLES), deleteArchivoCotizacion);

export default router;
