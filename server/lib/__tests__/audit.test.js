/**
 * Tests del helper de auditoría (`server/lib/audit.js`).
 *
 * Corre con: `node --test server/lib/__tests__/audit.test.js`
 *
 * No tocamos Prisma real: pasamos un objeto mock con `auditLog.create`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  diff,
  logAction,
  auditCreate,
  auditUpdate,
  auditDelete,
  getIp,
  __internals,
} from '../audit.js';

const { safeValue } = __internals;

function makePrismaMock() {
  const created = [];
  return {
    created,
    auditLog: {
      async create({ data }) { created.push(data); return { id: BigInt(created.length), ...data }; },
    },
  };
}

// --- safeValue -------------------------------------------------------------

test('safeValue: BigInt → Number', () => {
  assert.equal(safeValue(42n), 42);
});

test('safeValue: Date → ISO string', () => {
  const iso = safeValue(new Date('2026-05-22T10:00:00Z'));
  assert.equal(iso, '2026-05-22T10:00:00.000Z');
});

test('safeValue: undefined → null', () => {
  assert.equal(safeValue(undefined), null);
});

// --- diff ------------------------------------------------------------------

test('diff: solo incluye campos cambiados', () => {
  const before = { nombre: 'A', activo: true, notas: 'foo' };
  const after = { nombre: 'B', activo: true, notas: 'foo' };
  const d = diff(before, after);
  assert.deepEqual(Object.keys(d), ['nombre']);
  assert.deepEqual(d.nombre, { old: 'A', new: 'B' });
});

test('diff: nuevo campo agregado aparece como { old: null, new: ... }', () => {
  const before = { nombre: 'A' };
  const after = { nombre: 'A', telefono: '888' };
  const d = diff(before, after);
  assert.deepEqual(d, { telefono: { old: null, new: '888' } });
});

test('diff: campo removido aparece como { old: ..., new: null }', () => {
  const before = { nombre: 'A', notas: 'x' };
  const after = { nombre: 'A' };
  const d = diff(before, after);
  assert.deepEqual(d, { notas: { old: 'x', new: null } });
});

test('diff: omite campos sensibles (passwordHash, token, password)', () => {
  const before = { nombre: 'A', passwordHash: 'old', token: 't1', password: 'p1' };
  const after = { nombre: 'A', passwordHash: 'new', token: 't2', password: 'p2' };
  const d = diff(before, after);
  assert.deepEqual(d, {});
});

test('diff: BigInt vs Number iguales NO se reportan como cambio', () => {
  const before = { id: 1n, count: 5 };
  const after = { id: 1n, count: 5 };
  assert.deepEqual(diff(before, after), {});
});

test('diff: Date vs misma Date ISO igual no se reporta', () => {
  const d1 = new Date('2026-05-22T10:00:00Z');
  const d2 = new Date('2026-05-22T10:00:00Z');
  assert.deepEqual(diff({ at: d1 }, { at: d2 }), {});
});

test('diff: sin cambios devuelve objeto vacío', () => {
  assert.deepEqual(diff({ a: 1, b: 2 }, { a: 1, b: 2 }), {});
});

test('diff: before o after null no rompen', () => {
  assert.deepEqual(diff(null, { a: 1 }), { a: { old: null, new: 1 } });
  assert.deepEqual(diff({ a: 1 }, null), { a: { old: 1, new: null } });
  assert.deepEqual(diff(null, null), {});
});

// --- logAction -------------------------------------------------------------

test('logAction: inserta row con campos básicos', async () => {
  const prisma = makePrismaMock();
  await logAction(prisma, {
    modelName: 'Obra',
    recordId: 42n,
    action: 'create',
    userId: 1,
    ipAddress: '1.2.3.4',
  });
  assert.equal(prisma.created.length, 1);
  assert.equal(prisma.created[0].modelName, 'Obra');
  assert.equal(prisma.created[0].recordId, '42');
  assert.equal(prisma.created[0].action, 'create');
  assert.equal(prisma.created[0].userId, 1n);
  assert.equal(prisma.created[0].ipAddress, '1.2.3.4');
});

test('logAction: action inválido lanza', async () => {
  const prisma = makePrismaMock();
  await assert.rejects(
    () => logAction(prisma, { modelName: 'X', recordId: 1, action: 'patch' }),
    /invalid action/,
  );
});

test('logAction: modelName faltante lanza', async () => {
  const prisma = makePrismaMock();
  await assert.rejects(
    () => logAction(prisma, { modelName: '', recordId: 1, action: 'create' }),
    /modelName is required/,
  );
});

// --- auditCreate / auditUpdate / auditDelete -------------------------------

test('auditCreate: serializa todos los campos como old=null', async () => {
  const prisma = makePrismaMock();
  await auditCreate(prisma, {
    modelName: 'Proveedor',
    recordId: 7,
    data: { nombre: 'Lobo', activo: true },
    userId: 1,
    ipAddress: null,
  });
  const row = prisma.created[0];
  assert.equal(row.modelName, 'Proveedor');
  assert.equal(row.action, 'create');
  assert.deepEqual(row.changes.nombre, { old: null, new: 'Lobo' });
  assert.deepEqual(row.changes.activo, { old: null, new: true });
});

test('auditUpdate: solo incluye campos cambiados en changes', async () => {
  const prisma = makePrismaMock();
  await auditUpdate(prisma, {
    modelName: 'Proveedor',
    recordId: 7,
    before: { nombre: 'Lobo', activo: true, telefono: null },
    after: { nombre: 'Ferretería Lobo', activo: true, telefono: '8888-8888' },
    userId: 2,
  });
  const row = prisma.created[0];
  assert.equal(row.action, 'update');
  assert.deepEqual(Object.keys(row.changes).sort(), ['nombre', 'telefono']);
  assert.deepEqual(row.changes.nombre, { old: 'Lobo', new: 'Ferretería Lobo' });
  assert.deepEqual(row.changes.telefono, { old: null, new: '8888-8888' });
});

test('auditDelete: snapshot completo con new=null', async () => {
  const prisma = makePrismaMock();
  await auditDelete(prisma, {
    modelName: 'Obra',
    recordId: 1n,
    snapshot: { nombre: 'X', activo: true },
    userId: 1,
  });
  const row = prisma.created[0];
  assert.equal(row.action, 'delete');
  assert.deepEqual(row.changes.nombre, { old: 'X', new: null });
  assert.deepEqual(row.changes.activo, { old: true, new: null });
});

// --- getIp -----------------------------------------------------------------

test('getIp: prioriza x-forwarded-for', () => {
  const req = { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(getIp(req), '1.2.3.4');
});

test('getIp: usa socket.remoteAddress si no hay XFF', () => {
  const req = { headers: {}, socket: { remoteAddress: '10.0.0.1' } };
  assert.equal(getIp(req), '10.0.0.1');
});

test('getIp: req null devuelve null', () => {
  assert.equal(getIp(null), null);
});

test('getIp: XFF array handling', () => {
  const req = { headers: { 'x-forwarded-for': ['9.9.9.9'] }, socket: {} };
  assert.equal(getIp(req), '9.9.9.9');
});
