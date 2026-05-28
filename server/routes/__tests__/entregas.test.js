/**
 * Tests de los controllers de Entregas.
 *
 * Run: `node --test server/routes/__tests__/entregas.test.js`
 *
 * Estrategia:
 *  - NO usar supertest.
 *  - Invocar controllers directos con req/res mocks.
 *  - Stubbear Prisma con un store en memoria minimal.
 *  - Cubre: list, get, create (con service), uploadFotos (con files
 *    sintéticos), download de foto, pendientes, delete (admin).
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import prisma from '../../db.js';
import { UPLOADS_ROOT, entregaFotoStoragePath } from '../../lib/uploads.js';

let controllers;
let originalPrisma;
let stagedDirs = [];

// ---------------------------------------------------------------------------
// Store en memoria
// ---------------------------------------------------------------------------

const store = {
  ordenes: new Map(),
  ocItems: new Map(),
  entregas: new Map(),
  entregaItems: new Map(),
  entregaFotos: new Map(),
  bodegas: new Map(),
  users: new Map(),
  proveedores: new Map(),
  materiales: new Map(),
  nextEntregaId: 1n,
  nextEntregaItemId: 1n,
  nextEntregaFotoId: 1n,
};

function resetStore() {
  for (const k of Object.keys(store)) {
    if (store[k] instanceof Map) store[k].clear();
  }
  store.nextEntregaId = 1n;
  store.nextEntregaItemId = 1n;
  store.nextEntregaFotoId = 1n;
}

function seedOc(id, { estado = 'pagada', items = [], proveedorId = 10n } = {}) {
  const ocId = BigInt(id);
  store.ordenes.set(String(ocId), {
    id: ocId,
    numeroOc: `OC-${id}`,
    estado,
    proveedorId,
    obraId: 1n,
    categoriaId: 1n,
  });
  for (const it of items) {
    const idBig = BigInt(it.id);
    store.ocItems.set(String(idBig), {
      id: idBig,
      ocId,
      descripcion: it.descripcion,
      cantidad: String(it.cantidad),
      unidad: it.unidad,
      orden: it.orden ?? 0,
      materialId: it.materialId ?? null,
    });
  }
  return store.ordenes.get(String(ocId));
}

function seedUser(id, username = 'tony', role = 'operativo') {
  const u = { id: BigInt(id), username, fullName: username, role };
  store.users.set(String(u.id), u);
  return u;
}

function seedProveedor(id, nombre) {
  const p = { id: BigInt(id), nombre };
  store.proveedores.set(String(p.id), p);
  return p;
}

// ---------------------------------------------------------------------------
// Prisma stubs
// ---------------------------------------------------------------------------

function dec(n) {
  if (n == null) return null;
  return String(n);
}

function ocHydrate(oc) {
  if (!oc) return null;
  const prov = store.proveedores.get(String(oc.proveedorId));
  return {
    id: oc.id,
    numeroOc: oc.numeroOc,
    proveedor: prov ? { id: prov.id, nombre: prov.nombre } : null,
  };
}

function entregaHydrate(e, include) {
  const out = {
    id: e.id,
    ocId: e.ocId,
    bodegaDestinoId: e.bodegaDestinoId,
    fecha: e.fecha,
    recibidoPor: e.recibidoPor,
    registradaPorId: e.registradaPorId,
    completa: !!e.completa,
    notas: e.notas ?? null,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
  if (include?.oc) {
    const oc = store.ordenes.get(String(e.ocId));
    out.oc = ocHydrate(oc);
  }
  if (include?.bodegaDestino && e.bodegaDestinoId != null) {
    const b = store.bodegas.get(String(e.bodegaDestinoId));
    if (b) out.bodegaDestino = { id: b.id, nombre: b.nombre };
  }
  if (include?.registradaPor) {
    const u = store.users.get(String(e.registradaPorId));
    if (u) out.registradaPor = { id: u.id, username: u.username, fullName: u.fullName };
  }
  if (include?.items) {
    const items = [...store.entregaItems.values()]
      .filter((it) => String(it.entregaId) === String(e.id));
    items.sort((a, b) => Number(a.id) - Number(b.id));
    out.items = items.map((it) => {
      const out = { ...it };
      if (include.items.include?.material && it.materialId != null) {
        const m = store.materiales.get(String(it.materialId));
        if (m) out.material = m;
      }
      return out;
    });
  }
  if (include?.fotos) {
    const fotos = [...store.entregaFotos.values()]
      .filter((f) => String(f.entregaId) === String(e.id));
    fotos.sort((a, b) => b.fecha - a.fecha);
    out.fotos = fotos.map((f) => {
      const out = { ...f };
      if (include.fotos.include?.subidaPor) {
        const u = store.users.get(String(f.subidaPorId));
        if (u) out.subidaPor = { id: u.id, username: u.username, fullName: u.fullName };
      }
      return out;
    });
  }
  if (include?._count) {
    const items = [...store.entregaItems.values()]
      .filter((it) => String(it.entregaId) === String(e.id));
    const fotos = [...store.entregaFotos.values()]
      .filter((f) => String(f.entregaId) === String(e.id));
    out._count = { items: items.length, fotos: fotos.length };
  }
  return out;
}

function installPrismaMock() {
  originalPrisma = {
    entrega: prisma.entrega,
    entregaItem: prisma.entregaItem,
    entregaFoto: prisma.entregaFoto,
    ordenCompra: prisma.ordenCompra,
    ordenCompraItem: prisma.ordenCompraItem,
    $transaction: prisma.$transaction.bind(prisma),
  };

  prisma.entrega = {
    async create({ data, include }) {
      const id = store.nextEntregaId++;
      const now = new Date();
      const row = {
        id,
        ocId: BigInt(data.ocId),
        bodegaDestinoId: data.bodegaDestinoId != null ? BigInt(data.bodegaDestinoId) : null,
        fecha: data.fecha instanceof Date ? data.fecha : new Date(data.fecha),
        recibidoPor: data.recibidoPor,
        registradaPorId: BigInt(data.registradaPorId),
        completa: !!data.completa,
        notas: data.notas ?? null,
        createdAt: now,
        updatedAt: now,
      };
      store.entregas.set(String(id), row);

      if (data.items?.create) {
        for (const it of data.items.create) {
          const itId = store.nextEntregaItemId++;
          store.entregaItems.set(String(itId), {
            id: itId,
            entregaId: id,
            ocItemId: it.ocItemId != null ? BigInt(it.ocItemId) : null,
            materialId: it.materialId != null ? BigInt(it.materialId) : null,
            descripcion: it.descripcion,
            cantidad: String(it.cantidad),
            unidad: it.unidad,
            notas: it.notas ?? null,
          });
        }
      }
      return entregaHydrate(row, include);
    },

    async findUnique({ where, include, select }) {
      const row = store.entregas.get(String(where.id));
      if (!row) return null;
      if (select) {
        const out = {};
        for (const k of Object.keys(select)) out[k] = row[k];
        return out;
      }
      return entregaHydrate(row, include);
    },

    async findMany({ where, include, orderBy }) {
      let rows = [...store.entregas.values()];
      if (where?.ocId != null) rows = rows.filter((r) => String(r.ocId) === String(where.ocId));
      if (where?.fecha) {
        if (where.fecha.gte) rows = rows.filter((r) => r.fecha >= where.fecha.gte);
        if (where.fecha.lte) rows = rows.filter((r) => r.fecha <= where.fecha.lte);
      }
      if (Array.isArray(orderBy)) {
        rows.sort((a, b) => {
          for (const o of orderBy) {
            const k = Object.keys(o)[0];
            const dir = o[k] === 'desc' ? -1 : 1;
            if (a[k] < b[k]) return -1 * dir;
            if (a[k] > b[k]) return 1 * dir;
          }
          return 0;
        });
      }
      return rows.map((r) => entregaHydrate(r, include));
    },

    async update({ where, data, include }) {
      const row = store.entregas.get(String(where.id));
      if (!row) throw Object.assign(new Error('Not found'), { code: 'P2025' });
      Object.assign(row, data, { updatedAt: new Date() });
      return entregaHydrate(row, include);
    },

    async delete({ where }) {
      const id = String(where.id);
      const row = store.entregas.get(id);
      if (!row) return null;
      store.entregas.delete(id);
      // Cascade items + fotos
      for (const [k, v] of [...store.entregaItems.entries()]) {
        if (String(v.entregaId) === id) store.entregaItems.delete(k);
      }
      for (const [k, v] of [...store.entregaFotos.entries()]) {
        if (String(v.entregaId) === id) store.entregaFotos.delete(k);
      }
      return row;
    },

    async count({ where }) {
      let rows = [...store.entregas.values()];
      if (where?.ocId != null) rows = rows.filter((r) => String(r.ocId) === String(where.ocId));
      return rows.length;
    },
  };

  prisma.entregaItem = {
    async groupBy({ by, where, _sum }) {
      // by: ['ocItemId'], where: { ocItemId: { in: [...] } }, _sum: { cantidad: true }
      const ids = new Set((where?.ocItemId?.in ?? []).map((x) => String(x)));
      const acc = new Map(); // ocItemId -> sum
      for (const it of store.entregaItems.values()) {
        if (it.ocItemId == null) continue;
        const k = String(it.ocItemId);
        if (!ids.has(k)) continue;
        acc.set(k, (acc.get(k) ?? 0) + Number(it.cantidad));
      }
      const out = [];
      for (const [k, sum] of acc.entries()) {
        out.push({ ocItemId: BigInt(k), _sum: { cantidad: String(sum) } });
      }
      return out;
    },
  };

  prisma.entregaFoto = {
    async create({ data }) {
      const id = store.nextEntregaFotoId++;
      const row = {
        id,
        entregaId: BigInt(data.entregaId),
        archivoPath: data.archivoPath,
        subidaPorId: BigInt(data.subidaPorId),
        fecha: new Date(),
      };
      store.entregaFotos.set(String(id), row);
      return row;
    },
    async findUnique({ where, select }) {
      const row = store.entregaFotos.get(String(where.id));
      if (!row) return null;
      if (select) {
        const out = {};
        for (const k of Object.keys(select)) out[k] = row[k];
        return out;
      }
      return row;
    },
  };

  prisma.ordenCompra = {
    async findUnique({ where, select }) {
      const row = store.ordenes.get(String(where.id));
      if (!row) return null;
      if (select) {
        const out = {};
        for (const k of Object.keys(select)) out[k] = row[k];
        return out;
      }
      // IMPORTANTE: copia para que el caller no vea mutaciones posteriores.
      return { ...row };
    },
    async update({ where, data }) {
      const row = store.ordenes.get(String(where.id));
      if (!row) throw Object.assign(new Error('Not found'), { code: 'P2025' });
      Object.assign(row, data);
      return { ...row };
    },
  };

  prisma.ordenCompraItem = {
    async findMany({ where, orderBy, select }) {
      let rows = [...store.ocItems.values()];
      if (where?.ocId != null) rows = rows.filter((r) => String(r.ocId) === String(where.ocId));
      if (where?.id?.in) {
        const ids = new Set(where.id.in.map(String));
        rows = rows.filter((r) => ids.has(String(r.id)));
      }
      if (orderBy?.orden === 'asc') {
        rows.sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));
      }
      if (select) {
        return rows.map((r) => {
          const out = {};
          for (const k of Object.keys(select)) out[k] = r[k];
          return out;
        });
      }
      return rows;
    },
  };

  prisma.$transaction = async (fn) => {
    // Stub muy simple: ejecutamos secuencialmente sobre el mismo "tx" (= prisma).
    return fn(prisma);
  };
}

function restorePrismaMock() {
  for (const k of Object.keys(originalPrisma)) {
    prisma[k] = originalPrisma[k];
  }
}

// ---------------------------------------------------------------------------
// req/res helpers
// ---------------------------------------------------------------------------

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.headersSent = true; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  };
  return res;
}

function makeReq({ params = {}, query = {}, body = {}, user, files } = {}) {
  return {
    params,
    query,
    body,
    user: user ?? { id: 1, username: 'admin', role: 'admin' },
    files,
    headers: {},
  };
}

// ---------------------------------------------------------------------------
// Setup/teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  resetStore();
  installPrismaMock();
  seedUser(1, 'admin', 'admin');
  seedUser(2, 'tony', 'operativo');
  seedProveedor(10, 'Materiales La Costa');
  controllers = await import('../../controllers/entregas.controller.js');
});

afterEach(() => {
  restorePrismaMock();
  for (const dir of stagedDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
  stagedDirs = [];
});

// =========================================================================
// TESTS
// =========================================================================

test('POST /api/ocs/:ocId/entregas crea la entrega y actualiza estado OC', async () => {
  seedOc(100, {
    estado: 'pagada',
    items: [{ id: 200, descripcion: 'Cemento', cantidad: 5, unidad: 'saco', orden: 0 }],
  });

  const req = makeReq({
    params: { ocId: '100' },
    body: {
      fecha: '2026-05-28',
      recibidoPor: 'Tony',
      items: [{ ocItemId: 200, descripcion: 'Cemento', cantidad: 5, unidad: 'saco' }],
    },
    user: { id: 2, username: 'tony', role: 'operativo' },
  });
  const res = makeRes();
  await controllers.createEntregaHandler(req, res);

  assert.equal(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.recibidoPor, 'Tony');
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.completa, true);

  // La OC debe haber pasado a completada (estaba pagada + entrega completa).
  const oc = store.ordenes.get('100');
  assert.equal(oc.estado, 'completada');
});

test('GET /api/ocs/:ocId/pendientes devuelve cantidades correctas', async () => {
  seedOc(100, {
    estado: 'autorizada',
    items: [
      { id: 200, descripcion: 'Cemento', cantidad: 10, unidad: 'saco', orden: 0 },
      { id: 201, descripcion: 'Varilla', cantidad: 20, unidad: 'varilla', orden: 1 },
    ],
  });

  // Crear entrega parcial.
  await controllers.createEntregaHandler(
    makeReq({
      params: { ocId: '100' },
      body: {
        fecha: '2026-05-28',
        recibidoPor: 'Tony',
        items: [
          { ocItemId: 200, descripcion: 'Cemento', cantidad: 3, unidad: 'saco' },
        ],
      },
    }),
    makeRes(),
  );

  const req = makeReq({ params: { ocId: '100' } });
  const res = makeRes();
  await controllers.getPendientes(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items.length, 2);
  const cem = res.body.items.find((p) => p.ocItemId === 200);
  assert.equal(cem.cantidadOrdenada, 10);
  assert.equal(cem.cantidadEntregada, 3);
  assert.equal(cem.cantidadPendiente, 7);
  const varilla = res.body.items.find((p) => p.ocItemId === 201);
  assert.equal(varilla.cantidadEntregada, 0);
  assert.equal(varilla.cantidadPendiente, 20);
});

test('GET /api/entregas devuelve lista con filtro por ocId', async () => {
  seedOc(100, {
    items: [{ id: 200, descripcion: 'Cemento', cantidad: 5, unidad: 'saco' }],
  });
  seedOc(101, {
    items: [{ id: 201, descripcion: 'Otra cosa', cantidad: 5, unidad: 'saco' }],
  });

  // Entrega en OC 100.
  await controllers.createEntregaHandler(
    makeReq({
      params: { ocId: '100' },
      body: {
        fecha: '2026-05-28',
        recibidoPor: 'Tony',
        items: [{ ocItemId: 200, descripcion: 'Cemento', cantidad: 1, unidad: 'saco' }],
      },
    }),
    makeRes(),
  );
  // Entrega en OC 101.
  await controllers.createEntregaHandler(
    makeReq({
      params: { ocId: '101' },
      body: {
        fecha: '2026-05-28',
        recibidoPor: 'Adrian',
        items: [{ ocItemId: 201, descripcion: 'Otra cosa', cantidad: 1, unidad: 'saco' }],
      },
    }),
    makeRes(),
  );

  let res = makeRes();
  await controllers.listEntregas(makeReq({ query: {} }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items.length, 2);

  res = makeRes();
  await controllers.listEntregas(makeReq({ query: { ocId: '100' } }), res);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].ocId, 100);
});

test('POST /api/entregas/:id/fotos crea 3 EntregaFoto y escribe archivos a disco', async () => {
  seedOc(100, {
    items: [{ id: 200, descripcion: 'Cemento', cantidad: 5, unidad: 'saco' }],
  });
  const createRes = makeRes();
  await controllers.createEntregaHandler(
    makeReq({
      params: { ocId: '100' },
      body: {
        fecha: '2026-05-28',
        recibidoPor: 'Tony',
        items: [{ ocItemId: 200, descripcion: 'Cemento', cantidad: 1, unidad: 'saco' }],
      },
    }),
    createRes,
  );
  const entregaId = createRes.body.id;

  // Simular req.files (post-multer): generamos paths reales bajo uploads/.
  const files = [];
  for (const name of ['foto1.jpg', 'foto2.png', 'foto3.webp']) {
    const { absolutePath, filename } = entregaFotoStoragePath({
      entregaId,
      originalName: name,
    });
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, `fake-${name}`, 'utf-8');
    stagedDirs.push(dirname(absolutePath));
    files.push({ path: absolutePath, originalname: name, filename, mimetype: 'image/jpeg' });
  }

  const req = makeReq({ params: { id: String(entregaId) }, files });
  const res = makeRes();
  await controllers.uploadFotos(req, res);

  assert.equal(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.fotos.length, 3);

  // Verificar que las 3 rows existen en el store.
  assert.equal(store.entregaFotos.size, 3);
  // Verificar archivos físicos.
  for (const f of files) {
    assert.ok(existsSync(f.path), `archivo debe existir: ${f.path}`);
  }
});

test('POST /api/entregas/:id/fotos sin files → 400', async () => {
  seedOc(100, {
    items: [{ id: 200, descripcion: 'X', cantidad: 1, unidad: 'saco' }],
  });
  const createRes = makeRes();
  await controllers.createEntregaHandler(
    makeReq({
      params: { ocId: '100' },
      body: {
        fecha: '2026-05-28', recibidoPor: 'Tony',
        items: [{ ocItemId: 200, descripcion: 'X', cantidad: 1, unidad: 'saco' }],
      },
    }),
    createRes,
  );
  const entregaId = createRes.body.id;

  const req = makeReq({ params: { id: String(entregaId) }, files: [] });
  const res = makeRes();
  await controllers.uploadFotos(req, res);
  assert.equal(res.statusCode, 400);
});

test('DELETE /api/entregas/:id borra entrega y deja OC en autorizada si era la única', async () => {
  seedOc(100, {
    estado: 'pagada',
    items: [{ id: 200, descripcion: 'X', cantidad: 5, unidad: 'saco' }],
  });
  const createRes = makeRes();
  await controllers.createEntregaHandler(
    makeReq({
      params: { ocId: '100' },
      body: {
        fecha: '2026-05-28', recibidoPor: 'Tony',
        items: [{ ocItemId: 200, descripcion: 'X', cantidad: 5, unidad: 'saco' }],
      },
    }),
    createRes,
  );
  const entregaId = createRes.body.id;

  // OC debe estar completada.
  assert.equal(store.ordenes.get('100').estado, 'completada');

  const res = makeRes();
  await controllers.deleteEntregaHandler(
    makeReq({ params: { id: String(entregaId) }, user: { id: 1, role: 'admin', username: 'admin' } }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.prevOcEstado, 'completada');
  // Sin entregas restantes → autorizada (bajada desde completada).
  assert.equal(res.body.nextOcEstado, 'autorizada');
});

test('GET entrega no encontrada → 404', async () => {
  const req = makeReq({ params: { id: '99999' } });
  const res = makeRes();
  await controllers.getEntrega(req, res);
  assert.equal(res.statusCode, 404);
});

test('POST entrega con body inválido → 400', async () => {
  seedOc(100, { items: [{ id: 200, descripcion: 'X', cantidad: 1, unidad: 'saco' }] });
  const req = makeReq({
    params: { ocId: '100' },
    body: { /* fecha y recibidoPor faltantes */ items: [] },
  });
  const res = makeRes();
  await controllers.createEntregaHandler(req, res);
  assert.equal(res.statusCode, 400);
});
