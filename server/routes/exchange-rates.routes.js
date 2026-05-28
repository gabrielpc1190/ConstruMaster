/**
 * Rutas REST de Exchange Rates (`/api/exchange-rates`).
 *
 * Auth: todos los endpoints requieren JWT válido. Permisos:
 * - GET (list/latest): cualquier rol autenticado.
 * - POST backfill / fetch-today / manual create: admin + supervisor.
 * - DELETE: admin only.
 *
 * Montar en `server/index.js`:
 *   import exchangeRatesRoutes from './routes/exchange-rates.routes.js';
 *   app.use('/api/exchange-rates', exchangeRatesRoutes);
 */

import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole, WRITE_ROLES } from '../lib/permissions.js';
import {
  listExchangeRates,
  getLatestExchangeRate,
  backfillExchangeRates,
  fetchTodayExchangeRates,
  createManualExchangeRate,
  deleteExchangeRate,
} from '../controllers/exchange-rates.controller.js';

const router = express.Router();

router.use(authenticateToken);

router.get('/', listExchangeRates);
router.get('/latest', getLatestExchangeRate);
router.post('/backfill', requireRole(...WRITE_ROLES), backfillExchangeRates);
router.post('/fetch-today', requireRole(...WRITE_ROLES), fetchTodayExchangeRates);
router.post('/', requireRole(...WRITE_ROLES), createManualExchangeRate);
router.delete('/:id', requireRole('admin'), deleteExchangeRate);

export default router;
