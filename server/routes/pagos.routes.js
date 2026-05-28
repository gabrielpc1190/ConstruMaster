/**
 * Routes para Pagos + Hitos.
 *
 * Este router se monta en dos prefijos distintos (ver `server/index.js`):
 *  - `/api/pagos`  → endpoints "globales" de pagos (list, detail, marcar, etc.)
 *  - `/api/ocs`    → endpoints anidados de creación de pago y hitos
 *                    contra una OC específica.
 *
 * Exponemos dos routers para que `index.js` pueda elegir explícitamente
 * el prefijo correcto.
 */
import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import {
  listPagos,
  getPago,
  createPago,
  updatePago,
  deletePago,
  marcarPagado,
  desmarcarPagado,
  listHitosByOc,
  createHito,
  updateHito,
  completarHito,
} from '../controllers/pagos.controller.js';

// Router montado en `/api/pagos`.
export const pagosRouter = express.Router();
pagosRouter.use(authenticateToken);
pagosRouter.get('/', listPagos);
pagosRouter.get('/:id', getPago);
pagosRouter.put('/:id', updatePago);
pagosRouter.delete('/:id', deletePago);
pagosRouter.post('/:id/marcar-pagado', marcarPagado);
pagosRouter.post('/:id/desmarcar', desmarcarPagado);

// Router montado en `/api/ocs` para las rutas anidadas:
//   POST /:ocId/pagos
//   GET  /:ocId/hitos
//   POST /:ocId/items/:itemId/hitos
//   PUT  /hitos/:hitoId
//   POST /hitos/:hitoId/completar
export const pagosOcRouter = express.Router();
pagosOcRouter.use(authenticateToken);
pagosOcRouter.post('/:ocId/pagos', createPago);
pagosOcRouter.get('/:ocId/hitos', listHitosByOc);
pagosOcRouter.post('/:ocId/items/:itemId/hitos', createHito);
pagosOcRouter.put('/hitos/:hitoId', updateHito);
pagosOcRouter.post('/hitos/:hitoId/completar', completarHito);

export default pagosRouter;
