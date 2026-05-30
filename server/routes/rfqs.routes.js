/**
 * Rutas REST de Solicitudes de Cotización (`/api/rfqs`).
 *
 * En la UI siempre se llama "Solicitud de cotización". El URL `/api/rfqs`
 * matchea el campo Prisma `rfqId` en `Cotizacion` y mantiene paridad con
 * el código backend.
 *
 * Auth: todos los endpoints requieren JWT válido.
 *
 * Permisos:
 * - GET (list/detail): cualquier rol autenticado.
 * - POST (create): admin + supervisor + operativo.
 * - PUT (update): admin + supervisor + operativo (controller chequea que
 *   el estado sea 'abierta' — 409 si no).
 * - POST /:id/cancelar: admin + supervisor.
 */
import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import {
  listRfqs,
  getRfq,
  createRfq,
  updateRfq,
  cancelRfq,
} from '../controllers/rfqs.controller.js';

const router = express.Router();

router.use(authenticateToken);

router.get('/', listRfqs);
router.get('/:id', getRfq);
router.post('/', createRfq);
router.put('/:id', updateRfq);
router.post('/:id/cancelar', cancelRfq);

export default router;
