/**
 * Routes `/api/facturas` — gestión de facturas Hacienda CR v4.4.
 *
 * Endpoints:
 *  - `GET  /`                  → list (con filtros)
 *  - `GET  /:id`               → detail
 *  - `POST /upload/:ocId`      → subir XML (admin+supervisor+operativo)
 *  - `POST /:id/confirmar`     → workflow extracted→confirmed (admin+supervisor)
 *  - `POST /:id/anular`        → workflow * → error (admin+supervisor)
 *  - `GET  /:id/archivo`       → descarga el XML original
 *
 * El middleware `xmlUpload` corre ANTES del controller en `POST /upload/:ocId`
 * y guarda el archivo en disco. Si multer falla (mime inválido, tamaño,
 * etc.), capturamos el error en `handleMulterError` y devolvemos JSON.
 */

import express from 'express';

import { authenticateToken } from '../middleware/auth.js';
import { requireRole, CATALOG_WRITE, WRITE_ROLES, ALL_AUTH_ROLES } from '../lib/permissions.js';
import { xmlUpload } from '../lib/uploads.js';
import {
  listFacturas,
  getFactura,
  uploadFacturaXml,
  confirmarFactura,
  anularFactura,
  downloadArchivo,
} from '../controllers/facturas.controller.js';

const router = express.Router();

// Todas las rutas requieren auth.
router.use(authenticateToken);

router.get('/', requireRole(...ALL_AUTH_ROLES), listFacturas);
router.get('/:id', requireRole(...ALL_AUTH_ROLES), getFactura);
router.get('/:id/archivo', requireRole(...ALL_AUTH_ROLES), downloadArchivo);

/**
 * Wrapper de multer que convierte errores en JSON. Sin esto, multer pasa al
 * `errorHandler` global, lo cual está OK, pero acá queremos códigos más
 * específicos (413 para tamaño, 415 para mime).
 */
function runXmlUpload(req, res, next) {
  xmlUpload(req, res, (err) => {
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
    console.error('[facturas.upload] multer error:', err);
    return res.status(err.status || 500).json({ error: err.message || 'Upload failed' });
  });
}

router.post(
  '/upload/:ocId',
  requireRole(...CATALOG_WRITE),
  runXmlUpload,
  uploadFacturaXml,
);

router.post('/:id/confirmar', requireRole(...WRITE_ROLES), confirmarFactura);
router.post('/:id/anular', requireRole(...WRITE_ROLES), anularFactura);

export default router;
