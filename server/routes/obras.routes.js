/**
 * Routes para Obras + Categorías de Presupuesto + Presupuestos.
 *
 * Montar con `app.use('/api/obras', obrasRoutes)` (ver `server/index.js`).
 *
 * Auth: todo está detrás de `authenticateToken`. Las mutaciones requieren
 * `admin` o `supervisor` (`WRITE_ROLES`). DELETE de obra y de categoría son
 * sólo admin.
 *
 * Convención de paths:
 * - `/`               → CRUD obra
 * - `/:id`            → CRUD obra por id
 * - `/:id/categorias` → categorías de la obra
 * - `/categorias/:catId` → operar sobre categoría por id (la pertenencia se
 *                          deduce vía categoria.obraId).
 * - `/:id/presupuestos` → presupuestos de la obra
 * - `/presupuestos/:pId` → operar sobre presupuesto por id.
 */
import express from 'express';

import { authenticateToken } from '../middleware/auth.js';
import { requireRole, WRITE_ROLES } from '../lib/permissions.js';
import {
  listObras,
  createObra,
  getObra,
  updateObra,
  deleteObra,
  listCategorias,
  createCategoria,
  updateCategoria,
  deleteCategoria,
  listPresupuestos,
  createPresupuesto,
  updatePresupuesto,
  deletePresupuesto,
} from '../controllers/obras.controller.js';

const router = express.Router();

// Toda la API de obras requiere autenticación.
router.use(authenticateToken);

// ----- Categorías (rutas flat por catId) -----
// Importante: registrar antes de `/:id` para que '/categorias/:catId' no
// matchee como obra id='categorias'. Express las evalúa en orden.
router.put('/categorias/:catId', requireRole(...WRITE_ROLES), updateCategoria);
router.delete('/categorias/:catId', requireRole('admin'), deleteCategoria);

// ----- Presupuestos (rutas flat por pId) -----
router.put('/presupuestos/:pId', requireRole(...WRITE_ROLES), updatePresupuesto);
router.delete('/presupuestos/:pId', requireRole(...WRITE_ROLES), deletePresupuesto);

// ----- Obras -----
router.get('/', listObras);
router.post('/', requireRole(...WRITE_ROLES), createObra);
router.get('/:id', getObra);
router.put('/:id', requireRole(...WRITE_ROLES), updateObra);
router.delete('/:id', requireRole('admin'), deleteObra);

// ----- Categorías por obra -----
router.get('/:id/categorias', listCategorias);
router.post('/:id/categorias', requireRole(...WRITE_ROLES), createCategoria);

// ----- Presupuestos por obra -----
router.get('/:id/presupuestos', listPresupuestos);
router.post('/:id/presupuestos', requireRole(...WRITE_ROLES), createPresupuesto);

export default router;
