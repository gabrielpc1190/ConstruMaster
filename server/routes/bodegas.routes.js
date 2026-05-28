/**
 * Routes para Bodegas.
 *
 * Montar con `app.use('/api/bodegas', bodegasRoutes)` en `server/index.js`.
 *
 * Auth: todas las rutas requieren login. Writes son `admin`+`supervisor`.
 * DELETE es admin-only (delete = soft, `activo=false`).
 */
import express from 'express';

import { authenticateToken } from '../middleware/auth.js';
import { requireRole, WRITE_ROLES } from '../lib/permissions.js';
import {
  listBodegas,
  createBodega,
  getBodega,
  updateBodega,
  deleteBodega,
} from '../controllers/bodegas.controller.js';

const router = express.Router();

router.use(authenticateToken);

router.get('/', listBodegas);
router.post('/', requireRole(...WRITE_ROLES), createBodega);
router.get('/:id', getBodega);
router.put('/:id', requireRole(...WRITE_ROLES), updateBodega);
router.delete('/:id', requireRole('admin'), deleteBodega);

export default router;
