/**
 * Controller de `/api/audit-log`. Read-only y solo admin.
 *
 * Filtros opcionales: modelName, recordId, userId, action, from, to.
 * Default limit 100, max 500.
 */

import prisma from '../db.js';

function serialize(row) {
  if (!row) return row;
  return {
    id: Number(row.id),
    modelName: row.modelName,
    recordId: row.recordId,
    action: row.action,
    changes: row.changes,
    userId: row.userId !== null && row.userId !== undefined ? Number(row.userId) : null,
    user: row.user
      ? {
        id: Number(row.user.id),
        username: row.user.username,
        fullName: row.user.fullName,
      }
      : null,
    ipAddress: row.ipAddress,
    createdAt: row.createdAt,
  };
}

function parseLimit(raw, def = 100, max = 500) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

export async function listAuditLog(req, res) {
  try {
    const where = {};

    if (typeof req.query.modelName === 'string' && req.query.modelName.trim()) {
      where.modelName = req.query.modelName.trim();
    }
    if (typeof req.query.recordId === 'string' && req.query.recordId.trim()) {
      where.recordId = req.query.recordId.trim();
    }
    if (typeof req.query.userId === 'string' && req.query.userId.trim()) {
      try {
        where.userId = BigInt(req.query.userId.trim());
      } catch {
        return res.status(400).json({ error: 'Invalid userId' });
      }
    }
    if (typeof req.query.action === 'string' && ['create', 'update', 'delete'].includes(req.query.action)) {
      where.action = req.query.action;
    }
    if (typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}/.test(req.query.from)) {
      where.createdAt = { ...(where.createdAt || {}), gte: new Date(req.query.from) };
    }
    if (typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}/.test(req.query.to)) {
      where.createdAt = { ...(where.createdAt || {}), lte: new Date(req.query.to) };
    }

    const limit = parseLimit(req.query.limit);

    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      take: limit,
      include: {
        user: { select: { id: true, username: true, fullName: true } },
      },
    });
    return res.json(rows.map(serialize));
  } catch (err) {
    console.error('[audit-log.list] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export const __internals = { serialize, parseLimit };
