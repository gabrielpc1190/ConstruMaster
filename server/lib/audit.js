/**
 * Helpers de Auditoría — service-layer.
 *
 * Por qué service-layer y NO middleware HTTP:
 *   - Interceptar `res.json()` para sacar el `recordId` del response es feo
 *     y frágil (Express 5 cambió el comportamiento de res.json en algunos
 *     hot paths).
 *   - Calcular un diff "antes vs después" requiere acceso a la entidad
 *     antes del UPDATE — eso vive en el controller (ya hace `findUnique`).
 *   - El service-layer pattern hace explícito qué se audita y permite
 *     auditar también flujos que no son HTTP (cron jobs, tests, etc).
 *
 * Cómo usarlo desde un controller (ejemplo):
 *
 *   import { auditCreate, auditUpdate, auditDelete, getIp } from '../lib/audit.js';
 *
 *   // create:
 *   const obra = await prisma.obra.create({ data });
 *   await auditCreate(prisma, {
 *     modelName: 'Obra',
 *     recordId: obra.id,
 *     data: obra,
 *     userId: req.user.id,
 *     ipAddress: getIp(req),
 *   });
 *
 *   // update:
 *   const before = await prisma.obra.findUnique({ where: { id } });
 *   const after  = await prisma.obra.update({ where: { id }, data: patch });
 *   await auditUpdate(prisma, {
 *     modelName: 'Obra',
 *     recordId: id,
 *     before, after,
 *     userId: req.user.id,
 *     ipAddress: getIp(req),
 *   });
 *
 *   // delete:
 *   const snapshot = await prisma.obra.findUnique({ where: { id } });
 *   await prisma.obra.delete({ where: { id } });
 *   await auditDelete(prisma, {
 *     modelName: 'Obra',
 *     recordId: id,
 *     snapshot,
 *     userId: req.user.id,
 *     ipAddress: getIp(req),
 *   });
 *
 * Nota: en esta tarea NO integramos audit en los controllers existentes
 * (obras/proveedores/etc.); las helpers quedan listas para futuras tareas.
 */

const SENSITIVE_FIELDS = new Set(['passwordHash', 'password', 'token']);

/**
 * Serializa un valor para almacenarlo en `AuditLog.changes` (Json).
 *
 * - BigInt → Number (asumimos < 2^53, igual que el monkey-patch global).
 * - Date → ISO string.
 * - Decimal (Prisma) → string.
 * - undefined → null.
 */
function safeValue(v) {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && typeof v.toString === 'function' && v.constructor?.name === 'Decimal') {
    return v.toString();
  }
  return v;
}

/**
 * Calcula el diff campo a campo entre dos snapshots.
 * Solo incluye campos donde `safeValue(before[k]) !== safeValue(after[k])`.
 *
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 * @returns {Record<string, {old: unknown, new: unknown}>}
 */
export function diff(before, after) {
  const out = {};
  if (!before && !after) return out;
  const keys = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);
  for (const k of keys) {
    if (SENSITIVE_FIELDS.has(k)) continue;
    const o = safeValue(before?.[k]);
    const n = safeValue(after?.[k]);
    // Comparación shallow estricta sobre primitivos / strings serializados.
    // Para objetos anidados usamos JSON.stringify (es ok porque entidades
    // Prisma son flat para los campos que auditamos).
    const oKey = typeof o === 'object' && o !== null ? JSON.stringify(o) : o;
    const nKey = typeof n === 'object' && n !== null ? JSON.stringify(n) : n;
    if (oKey !== nKey) {
      out[k] = { old: o, new: n };
    }
  }
  return out;
}

/**
 * Helper interno: convierte recordId a string (la columna es VARCHAR(40)).
 * Acepta BigInt, number o string.
 */
function recordIdToString(recordId) {
  if (recordId === null || recordId === undefined) {
    throw new Error('[audit] recordId is required');
  }
  if (typeof recordId === 'bigint') return recordId.toString();
  return String(recordId);
}

/**
 * Helper interno: convierte userId a BigInt o null.
 */
function userIdToBigInt(userId) {
  if (userId === null || userId === undefined) return null;
  if (typeof userId === 'bigint') return userId;
  try {
    return BigInt(userId);
  } catch {
    return null;
  }
}

/**
 * Inserta un row en AuditLog. Helper base usado por las 3 acciones.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{
 *   modelName: string,
 *   recordId: string|number|bigint,
 *   action: 'create'|'update'|'delete',
 *   changes?: Record<string, unknown>,
 *   userId?: string|number|bigint|null,
 *   ipAddress?: string|null,
 * }} opts
 */
export async function logAction(prisma, {
  modelName,
  recordId,
  action,
  changes,
  userId,
  ipAddress,
}) {
  if (!modelName || typeof modelName !== 'string') {
    throw new Error('[audit] modelName is required');
  }
  if (!action || !['create', 'update', 'delete'].includes(action)) {
    throw new Error(`[audit] invalid action: ${action}`);
  }
  return prisma.auditLog.create({
    data: {
      modelName,
      recordId: recordIdToString(recordId),
      action,
      changes: changes ?? {},
      userId: userIdToBigInt(userId),
      ipAddress: ipAddress ?? null,
    },
  });
}

/**
 * Registra una CREATE. `data` se serializa completo y se guarda como
 * `{ field: { old: null, new: <value> } }` para coherencia con UPDATE.
 */
export async function auditCreate(prisma, {
  modelName,
  recordId,
  data,
  userId,
  ipAddress,
}) {
  const changes = {};
  for (const k of Object.keys(data ?? {})) {
    if (SENSITIVE_FIELDS.has(k)) continue;
    changes[k] = { old: null, new: safeValue(data[k]) };
  }
  return logAction(prisma, {
    modelName,
    recordId,
    action: 'create',
    changes,
    userId,
    ipAddress,
  });
}

/**
 * Registra una UPDATE con diff solo de campos cambiados.
 * Si no hay cambios (diff vacío), igual se inserta el row para dejar
 * trazabilidad del intento.
 */
export async function auditUpdate(prisma, {
  modelName,
  recordId,
  before,
  after,
  userId,
  ipAddress,
}) {
  const changes = diff(before, after);
  return logAction(prisma, {
    modelName,
    recordId,
    action: 'update',
    changes,
    userId,
    ipAddress,
  });
}

/**
 * Registra una DELETE. Snapshot pre-delete se guarda completo bajo
 * `{ field: { old: <value>, new: null } }`.
 */
export async function auditDelete(prisma, {
  modelName,
  recordId,
  snapshot,
  userId,
  ipAddress,
}) {
  const changes = {};
  for (const k of Object.keys(snapshot ?? {})) {
    if (SENSITIVE_FIELDS.has(k)) continue;
    changes[k] = { old: safeValue(snapshot[k]), new: null };
  }
  return logAction(prisma, {
    modelName,
    recordId,
    action: 'delete',
    changes,
    userId,
    ipAddress,
  });
}

/**
 * Extrae IP del request. Prioriza `x-forwarded-for` (Cloudflare Tunnel /
 * reverse proxy), luego `req.socket.remoteAddress`.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
export function getIp(req) {
  if (!req) return null;
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    // XFF puede traer "client, proxy1, proxy2"; tomamos el primero.
    return xff.split(',')[0].trim();
  }
  if (Array.isArray(xff) && xff.length > 0) {
    return String(xff[0]).split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? null;
}

export const __internals = { safeValue, recordIdToString, userIdToBigInt, SENSITIVE_FIELDS };
