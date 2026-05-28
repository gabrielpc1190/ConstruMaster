import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import {
  listOcs,
  getOc,
  updateOc,
  cancelarOc,
} from '../controllers/ocs.controller.js';

const router = express.Router();

router.use(authenticateToken);

router.get('/', listOcs);
router.get('/:id', getOc);
router.put('/:id', updateOc);
router.post('/:id/cancelar', cancelarOc);

export default router;
