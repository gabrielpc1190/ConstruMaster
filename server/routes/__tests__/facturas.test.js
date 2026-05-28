/**
 * Tests de los controllers de Facturas.
 *
 * Run: `node --test server/routes/__tests__/facturas.test.js`
 *
 * Estrategia (per instrucciones del task):
 *  - NO usar supertest.
 *  - Invocar los controllers directamente con req/res mocks.
 *  - Stubbear Prisma con un cliente en memoria minimal (un Map por modelo).
 *  - El parser XML real se usa (no se mockea) — necesitamos el comportamiento
 *    end-to-end del happy path.
 *
 * Cubre:
 *  1. Upload XML válido → status='extracted', clave numérica poblada.
 *  2. Upload XML mal formado → status='error', errorMessage no vacío, 200.
 *  3. Doble upload de la misma clave → 409 + existingFacturaId.
 *  4. Confirmar `extracted` → `confirmed` + confirmadaPorId.
 *  5. Confirmar `pending` → 409.
 *  6. GET /archivo devuelve el contenido raw.
 *  7. Bonus: anular factura.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Importes del módulo bajo test. ¡OJO! tenemos que stubbear `prisma` antes
// de importar el controller, pero Node ESM evalúa los imports al top. Solución:
// importamos prisma primero, monkey-patch sus métodos, e importamos el
// controller después (en el primer beforeEach con dynamic import).

import prisma from '../../db.js';
import { UPLOADS_ROOT } from '../../lib/uploads.js';

let controllers; // se carga en beforeEach
let originalPrismaMethods;
let tempUploadDir; // no usado para storage, sí para el fixture XML válido
const stagedPaths = []; // archivos creados durante el test para cleanup

// Mini store en memoria que mockea las pocas operaciones de Prisma que tocamos.
const store = {
  facturas: new Map(), // id -> Factura
  ordenes: new Map(),  // id -> OC
  users: new Map(),    // id -> User
  proveedores: new Map(),
  nextFacturaId: 1n,
};

function makeOc(id, numeroOc, proveedorId) {
  const oc = {
    id: BigInt(id),
    numeroOc,
    proveedorId: BigInt(proveedorId),
    obraId: 1n,
    categoriaId: 1n,
    montoTotalAmount: '100',
    montoTotalCurrency: 'CRC',
  };
  store.ordenes.set(String(oc.id), oc);
  return oc;
}

function makeProveedor(id, nombre) {
  const p = { id: BigInt(id), nombre };
  store.proveedores.set(String(p.id), p);
  return p;
}

function makeUser(id, username, role = 'admin') {
  const u = { id: BigInt(id), username, fullName: username.toUpperCase(), role };
  store.users.set(String(u.id), u);
  return u;
}

// --- Mocking de Prisma ----------------------------------------------------

function installPrismaMock() {
  originalPrismaMethods = {
    factura: prisma.factura,
    ordenCompra: prisma.ordenCompra,
  };

  prisma.factura = {
    async create({ data }) {
      const id = store.nextFacturaId++;
      const row = {
        id,
        ocId: data.ocId,
        sourceType: data.sourceType,
        tipoComprobante: data.tipoComprobante ?? null,
        archivoOriginalPath: data.archivoOriginalPath,
        status: data.status ?? 'pending',
        extractedData: data.extractedData ?? {},
        confidenceScore: data.confidenceScore ?? null,
        claveNumerica: data.claveNumerica ?? null,
        numeroConsecutivo: data.numeroConsecutivo ?? null,
        fechaEmision: data.fechaEmision ?? null,
        montoTotalAmount: data.montoTotalAmount ?? null,
        montoTotalCurrency: data.montoTotalCurrency ?? null,
        condicionVenta: data.condicionVenta ?? null,
        mediosPago: data.mediosPago ?? [],
        fxRateApplied: null,
        fxRateDate: null,
        confirmadaPorId: data.confirmadaPorId ?? null,
        errorMessage: data.errorMessage ?? null,
        notas: data.notas ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      store.facturas.set(String(id), row);
      return row;
    },

    async update({ where, data, include }) {
      const row = store.facturas.get(String(where.id));
      if (!row) throw Object.assign(new Error('Not found'), { code: 'P2025' });

      // Si actualizan claveNumerica y ya existe en otra fila, simulamos P2002.
      if (data.claveNumerica) {
        for (const [otherId, other] of store.facturas.entries()) {
          if (otherId !== String(where.id) && other.claveNumerica === data.claveNumerica) {
            const err = new Error('Unique constraint failed on facturas.clave_numerica');
            err.code = 'P2002';
            err.meta = { target: ['clave_numerica'] };
            throw err;
          }
        }
      }

      Object.assign(row, data, { updatedAt: new Date() });
      return hydrate(row, include);
    },

    async findUnique({ where, include, select }) {
      const row = store.facturas.get(String(where.id));
      if (!row) return null;
      if (select) {
        const out = {};
        for (const k of Object.keys(select)) out[k] = row[k];
        return out;
      }
      return hydrate(row, include);
    },

    async findFirst({ where, select }) {
      for (const row of store.facturas.values()) {
        let match = true;
        if (where.claveNumerica && row.claveNumerica !== where.claveNumerica) match = false;
        if (where.NOT && where.NOT.id && String(row.id) === String(where.NOT.id)) match = false;
        if (match) {
          if (select) {
            const out = {};
            for (const k of Object.keys(select)) out[k] = row[k];
            return out;
          }
          return row;
        }
      }
      return null;
    },

    async findMany({ where, include, orderBy }) {
      let rows = Array.from(store.facturas.values());
      if (where) {
        if (where.ocId != null) rows = rows.filter((r) => String(r.ocId) === String(where.ocId));
        if (where.status) rows = rows.filter((r) => r.status === where.status);
        if (where.tipoComprobante) rows = rows.filter((r) => r.tipoComprobante === where.tipoComprobante);
      }
      if (orderBy && orderBy.createdAt === 'desc') {
        rows.sort((a, b) => b.createdAt - a.createdAt);
      }
      return rows.map((r) => hydrate(r, include));
    },

    async delete({ where }) {
      store.facturas.delete(String(where.id));
      return null;
    },
  };

  prisma.ordenCompra = {
    async findUnique({ where }) {
      return store.ordenes.get(String(where.id)) || null;
    },
  };
}

function hydrate(row, include) {
  const out = { ...row };
  if (include?.oc) {
    const oc = store.ordenes.get(String(row.ocId));
    if (oc) {
      const prov = store.proveedores.get(String(oc.proveedorId));
      out.oc = {
        id: oc.id,
        numeroOc: oc.numeroOc,
        proveedor: prov ? { id: prov.id, nombre: prov.nombre } : null,
      };
    }
  }
  if (include?.confirmadaPor && row.confirmadaPorId != null) {
    const u = store.users.get(String(row.confirmadaPorId));
    if (u) out.confirmadaPor = { id: u.id, username: u.username, fullName: u.fullName };
  }
  return out;
}

function restorePrismaMock() {
  prisma.factura = originalPrismaMethods.factura;
  prisma.ordenCompra = originalPrismaMethods.ordenCompra;
}

// --- Mocks de req/res ------------------------------------------------------

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.headersSent = true; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    _streamData: '',
  };
  return res;
}

function makeReq({ params = {}, query = {}, body = {}, user, file } = {}) {
  return {
    params,
    query,
    body,
    user: user ?? { id: 1, username: 'admin', role: 'admin' },
    file,
    headers: {},
  };
}

// --- Test fixtures ---------------------------------------------------------

const FIXTURE_TE = join(__dirname, '..', '..', 'services', '__tests__', 'fixtures', 'te_real.xml');

beforeEach(async () => {
  // Reset store
  store.facturas.clear();
  store.ordenes.clear();
  store.users.clear();
  store.proveedores.clear();
  store.nextFacturaId = 1n;

  // Seed
  const prov = makeProveedor(10, 'MATERIALES LA COSTA, S.A.');
  makeOc(100, 'OC-001', prov.id);
  makeUser(1, 'admin', 'admin');

  installPrismaMock();

  // Carpeta temporal para escribir XMLs no-fixtures.
  tempUploadDir = mkdtempSync(join(tmpdir(), 'facturas-test-'));

  // Dynamic import después del mock (cache de módulos no se invalida, pero
  // el controller accede a prisma como módulo, no en time-of-import, así que
  // un import normal es suficiente — los métodos se resuelven en runtime).
  controllers = await import('../../controllers/facturas.controller.js');
});

afterEach(() => {
  restorePrismaMock();
  if (tempUploadDir && existsSync(tempUploadDir)) {
    rmSync(tempUploadDir, { recursive: true, force: true });
  }
  // Limpiar todo lo que el test escribió en uploads/ real.
  while (stagedPaths.length) {
    const p = stagedPaths.pop();
    try { rmSync(p, { force: true }); } catch { /* noop */ }
  }
});

// --- Helpers para subida directa ------------------------------------------

/**
 * Copia un XML al lugar donde estaría tras pasar por multer (dentro de
 * `uploads/`) y arma el `req.file` que el controller espera.
 */
async function stageXmlAsync(srcPath, ocId) {
  const { factoraStoragePath } = await import('../../lib/uploads.js');
  const { absolutePath, relativePath, filename } = factoraStoragePath({
    ocId,
    originalName: 'test.xml',
  });
  // mkdir + copy
  const fs = await import('node:fs');
  fs.mkdirSync(dirname(absolutePath), { recursive: true });
  fs.copyFileSync(srcPath, absolutePath);
  stagedPaths.push(absolutePath);
  return {
    file: {
      path: absolutePath,
      originalname: 'test.xml',
      mimetype: 'application/xml',
      filename,
    },
    absolutePath,
    relativePath,
  };
}

/**
 * Crea un archivo XML temporal con el contenido dado y devuelve la "fake
 * multer file" lista para usar.
 */
async function stageInlineXml(content, ocId) {
  const { factoraStoragePath } = await import('../../lib/uploads.js');
  const { absolutePath, relativePath, filename } = factoraStoragePath({
    ocId,
    originalName: 'test.xml',
  });
  const fs = await import('node:fs');
  fs.mkdirSync(dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf-8');
  stagedPaths.push(absolutePath);
  return {
    file: {
      path: absolutePath,
      originalname: 'test.xml',
      mimetype: 'application/xml',
      filename,
    },
    absolutePath,
    relativePath,
  };
}

// =========================================================================
// TESTS
// =========================================================================

test('upload XML válido → status=extracted, claveNumerica poblada', async () => {
  const { file } = await stageXmlAsync(FIXTURE_TE, 100);
  const req = makeReq({ params: { ocId: '100' }, file });
  const res = makeRes();

  await controllers.uploadFacturaXml(req, res);

  assert.equal(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.status, 'extracted');
  assert.equal(res.body.claveNumerica, '50604052600310169828000100001040000134414127865041');
  assert.equal(res.body.tipoComprobante, 'TE');
  assert.equal(res.body.numeroConsecutivo, '00100001040000134414');
  assert.equal(res.body.confidenceScore, null, 'XML es determinista, no usa confidence');
  assert.ok(res.body.montoTotal, 'montoTotal serializado');
  assert.equal(res.body.montoTotal.currency, 'CRC');
  assert.ok(res.body.extractedData, 'extractedData persistido');
  assert.equal(res.body.extractedData.tipo, 'TE');
  assert.ok(Array.isArray(res.body.extractedData.items));
  assert.ok(res.body.extractedData.items.length >= 1);
});

test('upload XML mal formado → status=error, errorMessage poblado, NO 500', async () => {
  const malformed = '<not really xml at all >>><<<';
  const { file, absolutePath } = await stageInlineXml(malformed, 100);
  const req = makeReq({ params: { ocId: '100' }, file });
  const res = makeRes();

  await controllers.uploadFacturaXml(req, res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}`);
  assert.equal(res.body.status, 'error');
  assert.ok(res.body.errorMessage && res.body.errorMessage.length > 0);
  // El archivo no se debería haber borrado en este caso (queremos conservar
  // el XML mal formado por si el cliente lo quiere ver). Verificación opcional.
  assert.ok(existsSync(absolutePath), 'el archivo mal formado se conserva en disco');
});

test('upload XML con namespace desconocido → status=error', async () => {
  const unknown = `<?xml version="1.0"?>
<UnknownRoot xmlns="https://example.com/unknown">
  <Clave>X</Clave>
</UnknownRoot>`;
  const { file } = await stageInlineXml(unknown, 100);
  const req = makeReq({ params: { ocId: '100' }, file });
  const res = makeRes();

  await controllers.uploadFacturaXml(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'error');
  assert.ok(res.body.errorMessage);
});

test('upload con ocId inexistente → 404 y archivo limpiado', async () => {
  const { file, absolutePath } = await stageXmlAsync(FIXTURE_TE, 9999);
  const req = makeReq({ params: { ocId: '9999' }, file });
  const res = makeRes();

  await controllers.uploadFacturaXml(req, res);

  assert.equal(res.statusCode, 404);
  assert.ok(!existsSync(absolutePath), 'el archivo se borró tras detectar OC inexistente');
});

test('doble upload de la misma clave_numerica → 409 con existingFacturaId', async () => {
  // Primer upload — debería extraer OK
  const stage1 = await stageXmlAsync(FIXTURE_TE, 100);
  const req1 = makeReq({ params: { ocId: '100' }, file: stage1.file });
  const res1 = makeRes();
  await controllers.uploadFacturaXml(req1, res1);
  assert.equal(res1.statusCode, 201);
  const firstId = res1.body.id;

  // Segundo upload del mismo XML
  const stage2 = await stageXmlAsync(FIXTURE_TE, 100);
  const req2 = makeReq({ params: { ocId: '100' }, file: stage2.file });
  const res2 = makeRes();
  await controllers.uploadFacturaXml(req2, res2);

  assert.equal(res2.statusCode, 409, `expected 409, got ${res2.statusCode}: ${JSON.stringify(res2.body)}`);
  assert.equal(res2.body.existingFacturaId, firstId);
  assert.ok(!existsSync(stage2.absolutePath), 'archivo duplicado limpiado');
});

test('confirmar factura extracted → status=confirmed, confirmadaPorId seteado', async () => {
  // Subimos primero para tener una factura extracted
  const { file } = await stageXmlAsync(FIXTURE_TE, 100);
  const uploadReq = makeReq({ params: { ocId: '100' }, file });
  const uploadRes = makeRes();
  await controllers.uploadFacturaXml(uploadReq, uploadRes);
  const facturaId = uploadRes.body.id;
  assert.equal(uploadRes.body.status, 'extracted');

  const req = makeReq({
    params: { id: String(facturaId) },
    user: { id: 1, username: 'admin', role: 'admin' },
  });
  const res = makeRes();
  await controllers.confirmarFactura(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'confirmed');
  assert.equal(res.body.confirmadaPorId, 1);
});

test('confirmar factura pending → 409', async () => {
  // Creamos manualmente una factura en pending vía el store
  await prisma.factura.create({
    data: {
      ocId: 100n,
      sourceType: 'xml',
      archivoOriginalPath: 'facturas/2026/05/100/fake.xml',
      status: 'pending',
    },
  });

  const req = makeReq({
    params: { id: '1' },
    user: { id: 1, username: 'admin', role: 'admin' },
  });
  const res = makeRes();
  await controllers.confirmarFactura(req, res);

  assert.equal(res.statusCode, 409);
  assert.ok(/extracted/.test(res.body.error));
});

test('confirmar factura inexistente → 404', async () => {
  const req = makeReq({
    params: { id: '99999' },
    user: { id: 1, username: 'admin', role: 'admin' },
  });
  const res = makeRes();
  await controllers.confirmarFactura(req, res);
  assert.equal(res.statusCode, 404);
});

test('anular factura → status=error, errorMessage=motivo', async () => {
  await prisma.factura.create({
    data: {
      ocId: 100n,
      sourceType: 'xml',
      archivoOriginalPath: 'facturas/2026/05/100/fake.xml',
      status: 'extracted',
    },
  });

  const req = makeReq({
    params: { id: '1' },
    body: { motivo: 'XML subido a la OC equivocada' },
  });
  const res = makeRes();
  await controllers.anularFactura(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'error');
  assert.equal(res.body.errorMessage, 'XML subido a la OC equivocada');
});

test('GET /:id/archivo devuelve el XML raw vía stream', async () => {
  // Upload primero para tener un archivo real en disco.
  const { file, relativePath, absolutePath } = await stageXmlAsync(FIXTURE_TE, 100);
  const uploadReq = makeReq({ params: { ocId: '100' }, file });
  const uploadRes = makeRes();
  await controllers.uploadFacturaXml(uploadReq, uploadRes);
  assert.equal(uploadRes.statusCode, 201);
  const facturaId = uploadRes.body.id;

  // Forzamos a que la factura en el store apunte al archivo que sí existe
  // (stageXmlAsync escribió en una ruta calculada; el controller persistió
  //  su `relativeToUploads(req.file.path)` = relativePath del stage).
  const fakeFactura = store.facturas.get(String(facturaId));
  assert.equal(fakeFactura.archivoOriginalPath, relativePath);

  // Implementación: capturamos el stream a un buffer.
  const req = makeReq({ params: { id: String(facturaId) } });
  const chunks = [];
  let finished;
  const donePromise = new Promise((resolve) => { finished = resolve; });
  const res = {
    statusCode: 200,
    headers: {},
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.headersSent = true; finished(); return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    write(chunk) { chunks.push(chunk); return true; },
    end(chunk) { if (chunk) chunks.push(chunk); finished(); },
    on() {},
    once() {},
    emit() {},
  };

  await controllers.downloadArchivo(req, res);
  await donePromise;

  const captured = Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))));
  const expected = readFileSync(absolutePath);
  assert.equal(captured.toString('utf-8'), expected.toString('utf-8'));
  assert.match(res.headers['content-type'] || '', /application\/xml/);
  assert.match(res.headers['content-disposition'] || '', /attachment/);
});

test('GET /:id/archivo con factura inexistente → 404', async () => {
  const req = makeReq({ params: { id: '99999' } });
  const res = makeRes();
  await controllers.downloadArchivo(req, res);
  assert.equal(res.statusCode, 404);
});

test('list facturas filtra por ocId/status/tipoComprobante', async () => {
  const { file } = await stageXmlAsync(FIXTURE_TE, 100);
  const uploadReq = makeReq({ params: { ocId: '100' }, file });
  const uploadRes = makeRes();
  await controllers.uploadFacturaXml(uploadReq, uploadRes);

  // Sin filtros
  let req = makeReq({ query: {} });
  let res = makeRes();
  await controllers.listFacturas(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 1);

  // Filtro por status
  req = makeReq({ query: { status: 'extracted' } });
  res = makeRes();
  await controllers.listFacturas(req, res);
  assert.equal(res.body.length, 1);

  req = makeReq({ query: { status: 'confirmed' } });
  res = makeRes();
  await controllers.listFacturas(req, res);
  assert.equal(res.body.length, 0);

  // Filtro por tipo
  req = makeReq({ query: { tipoComprobante: 'TE' } });
  res = makeRes();
  await controllers.listFacturas(req, res);
  assert.equal(res.body.length, 1);

  req = makeReq({ query: { tipoComprobante: 'FE' } });
  res = makeRes();
  await controllers.listFacturas(req, res);
  assert.equal(res.body.length, 0);
});
