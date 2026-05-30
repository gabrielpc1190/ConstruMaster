/**
 * Rutas REST de Reportes (`/api/reportes`).
 *
 * Auth: todos los endpoints requieren JWT válido. Cualquier rol autenticado
 * puede consultar los reportes (incluyendo descarga CSV) — el log de export
 * en el controller auditará a quién hizo cada descarga.
 *
 * Para montar en `server/index.js`:
 *   import reportesRoutes from './routes/reportes.routes.js';
 *   app.use('/api/reportes', reportesRoutes);
 */
import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import {
  getReporteProveedor,
  getReporteReconciliacion,
  getReporteTipoCambio,
} from '../controllers/reportes.controller.js';

const router = express.Router();

router.use(authenticateToken);

router.get('/proveedor/:proveedorId', getReporteProveedor);
router.get('/reconciliacion/:obraId', getReporteReconciliacion);
router.get('/tipo-cambio', getReporteTipoCambio);

export default router;
