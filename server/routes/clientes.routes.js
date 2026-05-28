import express from 'express';
import { z } from 'zod';
import prisma from '../db.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole, WRITE_ROLES } from '../lib/permissions.js';

const router = express.Router();
router.use(authenticateToken);

const ClienteCreate = z.object({
  nombre: z.string().min(1).max(200),
  identificacion: z.string().max(50).optional().nullable(),
  notas: z.string().optional().nullable(),
});

router.get('/', async (_req, res) => {
  try {
    const clientes = await prisma.cliente.findMany({ orderBy: { nombre: 'asc' } });
    return res.json(clientes);
  } catch (err) {
    console.error('[clientes.list]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = BigInt(req.params.id);
    const cliente = await prisma.cliente.findUnique({ where: { id } });
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
    return res.json(cliente);
  } catch {
    return res.status(400).json({ error: 'ID inválido' });
  }
});

router.post('/', requireRole(...WRITE_ROLES), async (req, res) => {
  try {
    const parsed = ClienteCreate.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Validación', details: parsed.error.issues });
    const cliente = await prisma.cliente.create({ data: parsed.data });
    return res.status(201).json(cliente);
  } catch (err) {
    console.error('[clientes.create]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

router.put('/:id', requireRole(...WRITE_ROLES), async (req, res) => {
  try {
    const id = BigInt(req.params.id);
    const parsed = ClienteCreate.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Validación', details: parsed.error.issues });
    const cliente = await prisma.cliente.update({ where: { id }, data: parsed.data });
    return res.json(cliente);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Cliente no encontrado' });
    console.error('[clientes.update]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
