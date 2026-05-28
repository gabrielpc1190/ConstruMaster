import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../db.js';
import 'dotenv/config';

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = '7d';

// Dummy hash to neutralize timing oracle when username doesn't exist.
// bcrypt.compare runs in constant time for the same cost factor regardless of input.
const DUMMY_HASH = '$2b$12$CwTycUXWue0Thq9StjUM0uJ8eZbQjzqLwHbnRb/qjqJZb9CB.ip2W';

export async function login(req, res) {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = await prisma.user.findUnique({ where: { username } });
    const hashToCheck = user ? user.passwordHash : DUMMY_HASH;
    const ok = await bcrypt.compare(password, hashToCheck);

    if (!user || !ok) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = jwt.sign(
      { id: Number(user.id), username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: TOKEN_TTL }
    );

    return res.json({
      token,
      user: {
        id: Number(user.id),
        username: user.username,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error('[auth.login] unexpected error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export function logout(_req, res) {
  res.json({ ok: true });
}

export async function me(req, res) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(401).json({ error: 'Invalid or expired token' });
    return res.json({
      id: Number(user.id),
      username: user.username,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
    });
  } catch (err) {
    console.error('[auth.me] unexpected error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
