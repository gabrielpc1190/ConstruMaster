import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import {
  listCotizaciones,
  getCotizacion,
  createCotizacion,
  updateCotizacion,
  aprobarCotizacion,
  rechazarCotizacion,
} from '../controllers/cotizaciones.controller.js';

const router = express.Router();

router.use(authenticateToken);

router.get('/', listCotizaciones);
router.post('/', createCotizacion);
router.get('/:id', getCotizacion);
router.put('/:id', updateCotizacion);
router.post('/:id/aprobar', aprobarCotizacion);
router.post('/:id/rechazar', rechazarCotizacion);

export default router;
