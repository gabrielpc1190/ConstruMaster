import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { z } from 'zod';
import prisma from '../db.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../lib/permissions.js';
import { auditCreate, auditUpdate, auditDelete, getIp } from '../lib/audit.js';

function safeAuditCreate(args) {
  return auditCreate(prisma, args).catch((err) => console.error('[audit:users]', err));
}
function safeAuditUpdate(args) {
  return auditUpdate(prisma, args).catch((err) => console.error('[audit:users]', err));
}
function safeAuditDelete(args) {
  return auditDelete(prisma, args).catch((err) => console.error('[audit:users]', err));
}
function userIdFromReq(req) {
  return req.user?.id != null ? BigInt(req.user.id) : null;
}

const router = express.Router();
router.use(authenticateToken);

const ROLE_ENUM = z.enum(['admin', 'supervisor', 'operativo', 'lector']);

const UserCreate = z.object({
  username: z.string().min(2).max(50).regex(/^[a-z0-9_.-]+$/i, 'Username debe ser alfanumérico'),
  fullName: z.string().max(120).optional().nullable(),
  email: z.string().email().optional().nullable(),
  role: ROLE_ENUM,
  password: z.string().min(8).optional(),
});

function shape(u) {
  return {
    id: Number(u.id),
    username: u.username,
    fullName: u.fullName,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    createdAt: u.createdAt,
  };
}

router.get('/', async (req, res) => {
  try {
    const role = req.query.role;
    const where = { isActive: true };
    if (role && ROLE_ENUM.safeParse(role).success) where.role = role;
    const users = await prisma.user.findMany({ where, orderBy: { username: 'asc' } });
    return res.json(users.map(shape));
  } catch (err) {
    console.error('[users.list]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = BigInt(req.params.id);
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    return res.json(shape(user));
  } catch {
    return res.status(400).json({ error: 'ID inválido' });
  }
});

router.post('/', requireRole('admin'), async (req, res) => {
  try {
    const parsed = UserCreate.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Validación', details: parsed.error.issues });
    const { password, ...rest } = parsed.data;
    const pwd = password || crypto.randomBytes(16).toString('base64url').slice(0, 20);
    const passwordHash = await bcrypt.hash(pwd, 12);
    const user = await prisma.user.create({ data: { ...rest, passwordHash } });
    // SENSITIVE_FIELDS en audit.js ya filtra passwordHash.
    safeAuditCreate({
      modelName: 'User',
      recordId: String(user.id),
      data: user,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.status(201).json({ ...shape(user), passwordPlain: password ? undefined : pwd });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Username o email ya existe' });
    console.error('[users.create]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

router.put('/:id', requireRole('admin'), async (req, res) => {
  try {
    const id = BigInt(req.params.id);
    const parsed = UserCreate.partial().omit({ password: true }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Validación', details: parsed.error.issues });
    const before = await prisma.user.findUnique({ where: { id } });
    if (!before) return res.status(404).json({ error: 'Usuario no encontrado' });
    const user = await prisma.user.update({ where: { id }, data: parsed.data });
    safeAuditUpdate({
      modelName: 'User',
      recordId: String(user.id),
      before,
      after: user,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.json(shape(user));
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Usuario no encontrado' });
    console.error('[users.update]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/:id/reset-password', requireRole('admin'), async (req, res) => {
  try {
    const id = BigInt(req.params.id);
    const password = (req.body?.password) || crypto.randomBytes(16).toString('base64url').slice(0, 20);
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password debe tener mínimo 8 chars' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const before = await prisma.user.findUnique({ where: { id } });
    if (!before) return res.status(404).json({ error: 'Usuario no encontrado' });
    const user = await prisma.user.update({ where: { id }, data: { passwordHash } });
    // El diff oculta passwordHash (SENSITIVE_FIELDS), pero igual auditamos la
    // operación para registrar el reset en sí (changes queda vacío).
    safeAuditUpdate({
      modelName: 'User',
      recordId: String(user.id),
      before,
      after: user,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.json({ ok: true, passwordPlain: req.body?.password ? undefined : password });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Usuario no encontrado' });
    console.error('[users.reset-password]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/:id/deactivate', requireRole('admin'), async (req, res) => {
  try {
    const id = BigInt(req.params.id);
    const before = await prisma.user.findUnique({ where: { id } });
    if (!before) return res.status(404).json({ error: 'Usuario no encontrado' });
    const user = await prisma.user.update({ where: { id }, data: { isActive: false } });
    // deactivate = soft delete → audit como delete con snapshot.
    safeAuditDelete({
      modelName: 'User',
      recordId: String(user.id),
      snapshot: before,
      userId: userIdFromReq(req),
      ipAddress: getIp(req),
    });
    return res.json(shape(user));
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Usuario no encontrado' });
    return res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
