/**
 * Routes de Entregas (recepción de material en bodega).
 *
 * Endpoints montados desde server/index.js:
 *
 *   app.use('/api/entregas', entregasRoutes);
 *   app.use('/api/ocs', entregasUnderOcsRoutes); // sub-router con :ocId
 *
 * Por las dos prefixes distintos exportamos DOS routers:
 *  - `default` (montado en /api/entregas) → list, detail, fotos, update, delete.
 *  - `entregasUnderOcs` (montado en /api/ocs) → POST /:ocId/entregas, GET /:ocId/pendientes.
 *
 * Roles:
 *  - GET (list/detail): ALL_AUTH_ROLES (lector incluido).
 *  - POST entrega + POST fotos: CATALOG_WRITE (admin+supervisor+operativo).
 *  - PUT entrega: WRITE_ROLES (admin+supervisor).
 *  - DELETE entrega: admin only.
 *  - GET pendientes: ALL_AUTH_ROLES (necesario para formularios y consultas).
 */

import express from 'express';

import { authenticateToken } from '../middleware/auth.js';
import {
  requireRole,
  CATALOG_WRITE,
  WRITE_ROLES,
  ALL_AUTH_ROLES,
} from '../lib/permissions.js';
import { fotoUpload } from '../lib/uploads.js';
import {
  listEntregas,
  getEntrega,
  createEntregaHandler,
  uploadFotos,
  downloadFoto,
  updateEntregaHandler,
  deleteEntregaHandler,
  getPendientes,
} from '../controllers/entregas.controller.js';

// ---------------------------------------------------------------------------
// Router 1: /api/entregas
// ---------------------------------------------------------------------------

const router = express.Router();
router.use(authenticateToken);

router.get('/', requireRole(...ALL_AUTH_ROLES), listEntregas);
router.get('/:id', requireRole(...ALL_AUTH_ROLES), getEntrega);
router.get('/:id/fotos/:fotoId/archivo', requireRole(...ALL_AUTH_ROLES), downloadFoto);

/**
 * Wrapper de multer para convertir errores a JSON con códigos apropiados.
 */
function runFotoUpload(req, res, next) {
  fotoUpload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Archivo demasiado grande (máx 10 MB por foto)' });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(413).json({ error: 'Máximo 10 fotos por request' });
    }
    if (err.code === 'INVALID_FILE_TYPE') {
      return res.status(415).json({ error: err.message });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Campo de archivo inesperado (esperado "fotos")' });
    }
    console.error('[entregas.upload] multer error:', err);
    return res.status(err.status || 500).json({ error: err.message || 'Upload failed' });
  });
}

router.post('/:id/fotos', requireRole(...CATALOG_WRITE), runFotoUpload, uploadFotos);

router.put('/:id', requireRole(...WRITE_ROLES), updateEntregaHandler);
router.delete('/:id', requireRole('admin'), deleteEntregaHandler);

export default router;

// ---------------------------------------------------------------------------
// Router 2: /api/ocs/:ocId/entregas + /api/ocs/:ocId/pendientes
// ---------------------------------------------------------------------------

export const entregasUnderOcs = express.Router({ mergeParams: true });
entregasUnderOcs.use(authenticateToken);

entregasUnderOcs.post('/:ocId/entregas', requireRole(...CATALOG_WRITE), createEntregaHandler);
entregasUnderOcs.get('/:ocId/pendientes', requireRole(...ALL_AUTH_ROLES), getPendientes);
