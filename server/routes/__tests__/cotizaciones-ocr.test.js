/**
 * Tests del controller de OCR de cotizaciones.
 *
 * Run: `node --test server/routes/__tests__/cotizaciones-ocr.test.js`
 *
 * Estrategia:
 *  - NO levantamos express ni multer; invocamos `parseCotizacionDocument`
 *    directamente con req/res mocks y `req.file` (la forma normal que
 *    multer.single() deja antes del controller).
 *  - Mockeamos el SDK Gemini via `geminiClientFactory.create` (propiedad
 *    writable de un objeto regular — funciona en ESM). El controller llama
 *    `extractCotizacion` que internamente usa este factory.
 *  - Stubbeamos `prisma.proveedor` y `prisma.itemCatalogo` con stores en
 *    memoria mínimos.
 *
 * Casos:
 *  1. Happy path — proveedor matchea por cédula exacta, item matchea por
 *     nombre canónico → respuesta incluye `matches.proveedorId` y
 *     `materialId` en el item.
 *  2. Cédula no matchea, nombre matchea único → proveedorMatch por nombre.
 *  3. Múltiples proveedores con el mismo nombre → `proveedorId: null`
 *     (ambiguo, no auto-elegimos).
 *  4. OCR falla → 422 con `{error, detail}`.
 *  5. Rol no autorizado → 403.
 *  6. Sin archivo → 400.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import prisma from '../../db.js';
import { geminiClientFactory } from '../../services/gemini-cotizacion-ocr.js';
import { parseCotizacionDocument } from '../../controllers/cotizaciones-ocr.controller.js';

BigInt.prototype.toJSON = function () { return Number(this); };

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

const stores = {
  proveedores: [],
  items: [],
};

function resetStores() {
  stores.proveedores = [];
  stores.items = [];
}

// ---------------------------------------------------------------------------
// Prisma mock
// ---------------------------------------------------------------------------

let originalProveedor;
let originalItemCatalogo;

function installPrismaMock() {
  originalProveedor = prisma.proveedor;
  originalItemCatalogo = prisma.itemCatalogo;

  prisma.proveedor = {
    async findMany({ where, take }) {
      let out = stores.proveedores.filter((p) => {
        if (where.activo !== undefined && p.activo !== where.activo) return false;
        if (where.identificacion && p.identificacion !== where.identificacion) {
          return false;
        }
        if (where.nombre?.contains) {
          const q = String(where.nombre.contains).toLowerCase();
          if (!String(p.nombre || '').toLowerCase().includes(q)) return false;
        }
        return true;
      });
      if (take) out = out.slice(0, take);
      return out.map((p) => ({ id: p.id, nombre: p.nombre }));
    },
  };

  prisma.itemCatalogo = {
    async findMany({ where, take }) {
      let out = stores.items.filter((it) => {
        if (where.activo !== undefined && it.activo !== where.activo) return false;
        if (where.estado && it.estado !== where.estado) return false;
        if (where.OR) {
          const anyMatch = where.OR.some((cond) => {
            if (cond.nombreCanonico?.contains) {
              const q = String(cond.nombreCanonico.contains).toLowerCase();
              return String(it.nombreCanonico || '').toLowerCase().includes(q);
            }
            if (cond.alias?.contains) {
              const q = String(cond.alias.contains).toLowerCase();
              return String(it.alias || '').toLowerCase().includes(q);
            }
            return false;
          });
          if (!anyMatch) return false;
        }
        return true;
      });
      if (take) out = out.slice(0, take);
      return out.map((it) => ({
        id: it.id,
        nombreCanonico: it.nombreCanonico,
        unidad: it.unidad,
      }));
    },
  };
}

function restorePrismaMock() {
  prisma.proveedor = originalProveedor;
  prisma.itemCatalogo = originalItemCatalogo;
}

// ---------------------------------------------------------------------------
// Gemini SDK mock (mismo patrón que gemini-cotizacion-ocr.test.js)
// ---------------------------------------------------------------------------

let originalFactory;
let nextResponseText = '{}';
let nextSdkError = null;

function installSdkMock() {
  originalFactory = geminiClientFactory.create;
  geminiClientFactory.create = function () {
    return {
      models: {
        async generateContent() {
          if (nextSdkError) throw nextSdkError;
          return { text: nextResponseText };
        },
      },
    };
  };
}

function restoreSdkMock() {
  geminiClientFactory.create = originalFactory;
}

// ---------------------------------------------------------------------------
// req / res helpers
// ---------------------------------------------------------------------------

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
  };
}

function makeReq({ user, file } = {}) {
  return {
    user: user ?? { id: 1, username: 'tony', role: 'operativo' },
    file: file ?? null,
    params: {},
    body: {},
    query: {},
  };
}

let tempDir;

beforeEach(async () => {
  resetStores();
  nextResponseText = '{}';
  nextSdkError = null;
  tempDir = await mkdtemp(join(tmpdir(), 'cot-ocr-ctrl-'));
  process.env.GEMINI_API_KEY = 'fake-test-key';
  installSdkMock();
  installPrismaMock();
});

afterEach(async () => {
  restoreSdkMock();
  restorePrismaMock();
  await rm(tempDir, { recursive: true, force: true });
  delete process.env.GEMINI_API_KEY;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('parseCotizacionDocument: happy path con match proveedor por cédula + item por nombre', async () => {
  stores.proveedores.push({
    id: 42n,
    nombre: 'Materiales La Costa',
    identificacion: '3101698280',
    activo: true,
  });
  stores.items.push({
    id: 7n,
    nombreCanonico: 'Cemento Holcim saco 50kg',
    alias: null,
    unidad: 'saco',
    estado: 'aprobado',
    activo: true,
  });

  nextResponseText = JSON.stringify({
    proveedor: {
      nombre: 'Materiales La Costa S.A.',
      identificacion: '3101698280',
    },
    items: [
      {
        descripcion: 'Cemento Holcim saco 50kg',
        cantidad: 10,
        unidad: 'saco',
        precioUnitario: 9500,
      },
    ],
    total: 95000,
  });

  const tmpFile = join(tempDir, 'cot.pdf');
  await writeFile(tmpFile, Buffer.from('%PDF-1.4 dummy'));

  const req = makeReq({
    user: { id: 1, role: 'admin' },
    file: { path: tmpFile, originalname: 'cot.pdf', mimetype: 'application/pdf' },
  });
  const res = makeRes();
  await parseCotizacionDocument(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body, 'expected response body');
  assert.equal(res.body.matches.proveedorId, 42);
  assert.equal(res.body.matches.proveedorNombre, 'Materiales La Costa');
  assert.equal(res.body.matches.items.length, 1);
  assert.equal(res.body.matches.items[0].materialId, 7);
});

test('parseCotizacionDocument: sin cédula, nombre matchea único', async () => {
  stores.proveedores.push({
    id: 9n,
    nombre: 'Ferretería Don Pedro',
    identificacion: null,
    activo: true,
  });

  nextResponseText = JSON.stringify({
    proveedor: { nombre: 'Ferretería Don Pedro' },
    items: [{ descripcion: 'tornillo', cantidad: 100, precioUnitario: 50 }],
    total: 5000,
  });

  const tmpFile = join(tempDir, 'cot.pdf');
  await writeFile(tmpFile, Buffer.from('x'));

  const req = makeReq({
    user: { id: 1, role: 'admin' },
    file: { path: tmpFile, originalname: 'cot.pdf', mimetype: 'application/pdf' },
  });
  const res = makeRes();
  await parseCotizacionDocument(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.matches.proveedorId, 9);
});

test('parseCotizacionDocument: múltiples matches por nombre → proveedorId null', async () => {
  stores.proveedores.push(
    { id: 1n, nombre: 'Casa Constructora SA', identificacion: null, activo: true },
    { id: 2n, nombre: 'Casa Constructora Norte', identificacion: null, activo: true },
  );

  nextResponseText = JSON.stringify({
    proveedor: { nombre: 'Casa Constructora' },
    items: [{ descripcion: 'x', cantidad: 1, precioUnitario: 10 }],
    total: 10,
  });

  const tmpFile = join(tempDir, 'cot.pdf');
  await writeFile(tmpFile, Buffer.from('x'));

  const req = makeReq({
    user: { id: 1, role: 'admin' },
    file: { path: tmpFile, originalname: 'cot.pdf', mimetype: 'application/pdf' },
  });
  const res = makeRes();
  await parseCotizacionDocument(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.matches.proveedorId, null);
});

test('parseCotizacionDocument: OCR falla → 422', async () => {
  // Simulamos JSON inválido del SDK → CotizacionOcrError
  nextResponseText = 'no soy json {{{';

  const tmpFile = join(tempDir, 'cot.pdf');
  await writeFile(tmpFile, Buffer.from('x'));

  const req = makeReq({
    user: { id: 1, role: 'admin' },
    file: { path: tmpFile, originalname: 'cot.pdf', mimetype: 'application/pdf' },
  });
  const res = makeRes();
  await parseCotizacionDocument(req, res);

  assert.equal(res.statusCode, 422);
  assert.equal(res.body.error, 'OCR failed');
  assert.match(res.body.detail, /JSON/i);
});

test('parseCotizacionDocument: rol lector → 403', async () => {
  const req = makeReq({
    user: { id: 9, role: 'lector' },
    file: { path: '/tmp/x', originalname: 'cot.pdf', mimetype: 'application/pdf' },
  });
  const res = makeRes();
  await parseCotizacionDocument(req, res);
  assert.equal(res.statusCode, 403);
});

test('parseCotizacionDocument: sin file → 400', async () => {
  const req = makeReq({ user: { id: 1, role: 'admin' }, file: null });
  const res = makeRes();
  await parseCotizacionDocument(req, res);
  assert.equal(res.statusCode, 400);
});
