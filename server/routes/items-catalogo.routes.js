/**
 * Rutas REST de ItemCatalogo (`/api/items-catalogo`).
 *
 * Auth: JWT requerido en todos los endpoints.
 * - GET list/detail/autocomplete: cualquier rol autenticado.
 * - POST /: admin + supervisor + operativo (operativo crea con estado=pendiente).
 * - PUT /:id: admin + supervisor.
 * - POST /:id/aprobar: admin + supervisor.
 * - DELETE /:id: admin (soft delete).
 */

import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole, CATALOG_WRITE, WRITE_ROLES } from '../lib/permissions.js';
import {
  listItems,
  autocompleteItems,
  getItem,
  createItem,
  updateItem,
  approveItem,
  deleteItem,
} from '../controllers/items-catalogo.controller.js';

const router = express.Router();

router.use(authenticateToken);

router.get('/autocomplete', autocompleteItems);
router.get('/', listItems);
router.get('/:id', getItem);
router.post('/', requireRole(...CATALOG_WRITE), createItem);
router.put('/:id', requireRole(...WRITE_ROLES), updateItem);
router.post('/:id/aprobar', requireRole(...WRITE_ROLES), approveItem);
router.delete('/:id', requireRole('admin'), deleteItem);

export default router;
