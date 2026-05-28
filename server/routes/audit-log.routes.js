/**
 * Routes para `/api/audit-log`.
 *
 * Solo admin: el log de auditoría contiene snapshots de cambios y
 * direcciones IP de usuarios; no se expone a otros roles.
 *
 * Montar en `server/index.js`:
 *   import auditLogRoutes from './routes/audit-log.routes.js';
 *   app.use('/api/audit-log', auditLogRoutes);
 */

import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../lib/permissions.js';
import { listAuditLog } from '../controllers/audit-log.controller.js';

const router = express.Router();

router.use(authenticateToken);

router.get('/', requireRole('admin'), listAuditLog);

export default router;
