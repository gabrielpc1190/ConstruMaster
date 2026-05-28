import express from 'express';
import rateLimit from 'express-rate-limit';
import { login, logout, me } from '../controllers/auth.controller.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de login, intente más tarde' },
  skipSuccessfulRequests: true,
});

router.post('/login', loginLimiter, login);
router.post('/logout', logout);
router.get('/me', authenticateToken, me);

export default router;
