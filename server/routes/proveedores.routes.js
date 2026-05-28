/**
 * Rutas REST de Proveedores (`/api/proveedores`).
 *
 * Auth: todos los endpoints requieren JWT válido. Permisos por método:
 * - GET (list/detail): cualquier rol autenticado.
 * - POST: admin + supervisor + operativo (lazy creation desde cotizaciones).
 * - PUT: admin + supervisor.
 * - DELETE: admin (soft delete).
 */

import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole, CATALOG_WRITE, WRITE_ROLES } from '../lib/permissions.js';
import {
  listProveedores,
  getProveedor,
  createProveedor,
  updateProveedor,
  deleteProveedor,
} from '../controllers/proveedores.controller.js';

const router = express.Router();

router.use(authenticateToken);

router.get('/', listProveedores);
router.get('/:id', getProveedor);
router.post('/', requireRole(...CATALOG_WRITE), createProveedor);
router.put('/:id', requireRole(...WRITE_ROLES), updateProveedor);
router.delete('/:id', requireRole('admin'), deleteProveedor);

export default router;
