/**
 * Tests del controller de OCR de facturas no-electrónicas (PDF/imagen).
 *
 * Run: `node --test server/routes/__tests__/facturas-ocr.test.js`
 *
 * Mismo estilo que `facturas.test.js`:
 *  - Invocamos los controllers directamente con req/res mocks.
 *  - Stub a Prisma con un store en memoria.
 *  - El servicio `extractInvoice` se mockea via `geminiClientFactory.create`
 *    (mismo patrón que `gemini-ocr.test.js`) — NO golpeamos a la API real.
 *
 * Cubre:
 *  1. Upload imagen + OCR happy path → status='extracted', confidence del SDK,
 *     mapping numeroConsecutivo/fechaEmision/montoTotal.
 *  2. OCR falla → status='error', errorMessage propagado, 200 OK con factura.
 *  3. Default confidence 0.85 cuando el modelo no reporta self-assessment.
 *  4. PUT /:id editar datos extraídos pre-confirmación.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import prisma from '../../db.js';
import { geminiClientFactory } from '../../services/gemini-ocr.js';
import { factImagenStoragePath } from '../../lib/uploads.js';

let controllers;
let originalPrismaMethods;
let originalGeminiCreate;
let tempUploadDir;
const stagedPaths = [];

const store = {
  facturas: new Map(),
  ordenes: new Map(),
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
  return out;
}

function restorePrismaMock() {
  prisma.factura = originalPrismaMethods.factura;
  prisma.ordenCompra = originalPrismaMethods.ordenCompra;
}

// --- Mock del SDK Gemini --------------------------------------------------
//
// El controller llama `extractInvoice(filePath)`. Internamente eso resuelve
// `geminiClientFactory.create(apiKey).models.generateContent(...)`. Mockeamos
// `create` para devolver un client que retorna lo que cada test configure.

function installGeminiMock() {
  originalGeminiCreate = geminiClientFactory.create;
  let responseText = '{}';
  let throwErr = null;

  geminiClientFactory.create = function mockedCreate() {
    return {
      models: {
        async generateContent() {
          if (throwErr) throw throwErr;
          return { text: responseText };
        },
      },
    };
  };

  return {
    setResponseText(text) {
      responseText = text;
    },
    setError(err) {
      throwErr = err;
    },
    restore() {
      geminiClientFactory.create = originalGeminiCreate;
    },
  };
}

// --- req/res mocks --------------------------------------------------------

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
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
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
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

// --- Helpers de fichero ---------------------------------------------------

/**
 * Crea un PDF dummy en la ubicación calculada para una factura y devuelve
 * el "fake multer file" listo para el controller.
 */
function stagePdf(ocId, contents = '%PDF-1.4 dummy') {
  const { absolutePath, relativePath, filename } = factImagenStoragePath({
    ocId,
    originalName: 'factura.pdf',
  });
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, Buffer.from(contents));
  stagedPaths.push(absolutePath);
  return {
    file: {
      path: absolutePath,
      originalname: 'factura.pdf',
      mimetype: 'application/pdf',
      filename,
    },
    absolutePath,
    relativePath,
  };
}

// --- Setup / teardown -----------------------------------------------------

let gemini;

beforeEach(async () => {
  store.facturas.clear();
  store.ordenes.clear();
  store.proveedores.clear();
  store.nextFacturaId = 1n;

  const prov = makeProveedor(10, 'EL LAGAR S.A.');
  makeOc(100, 'OC-001', prov.id);

  installPrismaMock();
  gemini = installGeminiMock();

  process.env.GEMINI_API_KEY = 'fake-test-key';

  tempUploadDir = mkdtempSync(join(tmpdir(), 'facturas-ocr-test-'));

  controllers = await import('../../controllers/facturas-ocr.controller.js');
});

afterEach(() => {
  restorePrismaMock();
  gemini.restore();
  delete process.env.GEMINI_API_KEY;
  if (tempUploadDir && existsSync(tempUploadDir)) {
    rmSync(tempUploadDir, { recursive: true, force: true });
  }
  while (stagedPaths.length) {
    const p = stagedPaths.pop();
    try {
      rmSync(p, { force: true });
    } catch {
      /* noop */
    }
  }
});

// =========================================================================
// TESTS
// =========================================================================

test('upload PDF + OCR happy path → status=extracted con mapping correcto', async () => {
  gemini.setResponseText(
    JSON.stringify({
      emisor: { nombre: 'EL LAGAR S.A.', identificacion: '3101000001' },
      consecutivo: 'FAC-987654',
      fecha: '2026-05-10',
      moneda: 'CRC',
      total: 12345.67,
      items: [
        {
          descripcion: 'Cemento 50kg',
          cantidad: 10,
          unidad: 'saco',
          precio_unitario: 1234.567,
        },
      ],
      confianza: 0.92,
    }),
  );

  const { file } = stagePdf(100);
  const req = makeReq({ params: { ocId: '100' }, file });
  const res = makeRes();

  await controllers.uploadFacturaImagen(req, res);

  assert.equal(
    res.statusCode,
    201,
    `expected 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`,
  );
  assert.equal(res.body.status, 'extracted');
  assert.equal(res.body.sourceType, 'pdf');
  assert.equal(res.body.tipoComprobante, null, 'OCR no setea tipo de comprobante Hacienda');
  assert.equal(res.body.numeroConsecutivo, 'FAC-987654');
  assert.equal(res.body.fechaEmision, '2026-05-10');
  assert.ok(res.body.montoTotal, 'montoTotal serializado');
  assert.equal(res.body.montoTotal.currency, 'CRC');
  assert.equal(Number(res.body.montoTotal.amount), 12345.67);
  assert.equal(res.body.confidenceScore, 0.92);
  assert.ok(res.body.extractedData);
  assert.equal(res.body.extractedData.emisor.nombre, 'EL LAGAR S.A.');
});

test('OCR falla (API error) → status=error, 200 OK, errorMessage poblado', async () => {
  gemini.setError(new Error('quota exceeded'));

  const { file, absolutePath } = stagePdf(100);
  const req = makeReq({ params: { ocId: '100' }, file });
  const res = makeRes();

  await controllers.uploadFacturaImagen(req, res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}`);
  assert.equal(res.body.status, 'error');
  assert.ok(
    res.body.errorMessage && /quota|Gemini/i.test(res.body.errorMessage),
    `errorMessage debe propagar el problema OCR: ${res.body.errorMessage}`,
  );
  assert.ok(existsSync(absolutePath), 'el archivo se conserva para revisión manual');
});

test('upload con ocId inexistente → 404 y archivo limpiado', async () => {
  const { file, absolutePath } = stagePdf(9999);
  const req = makeReq({ params: { ocId: '9999' }, file });
  const res = makeRes();

  await controllers.uploadFacturaImagen(req, res);

  assert.equal(res.statusCode, 404);
  assert.ok(!existsSync(absolutePath), 'archivo limpiado tras OC inexistente');
});

test('OCR sin confidence → default 0.85', async () => {
  gemini.setResponseText(
    JSON.stringify({
      emisor: { nombre: 'X', identificacion: '3101000001' },
      fecha: '2026-05-10',
      moneda: 'CRC',
      total: 100,
      items: [],
      // sin "confianza"
    }),
  );

  const { file } = stagePdf(100);
  const req = makeReq({ params: { ocId: '100' }, file });
  const res = makeRes();

  await controllers.uploadFacturaImagen(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.status, 'extracted');
  assert.equal(res.body.confidenceScore, 0.85, 'fallback confidence cuando el modelo no reporta');
});

test('PUT /:id permite editar numero/fecha/monto en factura extracted', async () => {
  // Subimos primero para tener una factura escaneada extracted.
  gemini.setResponseText(
    JSON.stringify({
      emisor: { nombre: 'Y', identificacion: '3101000001' },
      fecha: '2026-05-10',
      moneda: 'CRC',
      total: 100,
      items: [],
      confianza: 0.7,
    }),
  );
  const { file } = stagePdf(100);
  const upReq = makeReq({ params: { ocId: '100' }, file });
  const upRes = makeRes();
  await controllers.uploadFacturaImagen(upReq, upRes);
  assert.equal(upRes.statusCode, 201);
  const facturaId = upRes.body.id;

  const req = makeReq({
    params: { id: String(facturaId) },
    body: {
      numeroConsecutivo: 'CORREGIDO-001',
      fechaEmision: '2026-05-25',
      montoTotalAmount: '7777.77',
      montoTotalCurrency: 'USD',
    },
  });
  const res = makeRes();
  await controllers.updateFacturaCanonical(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.numeroConsecutivo, 'CORREGIDO-001');
  assert.equal(res.body.fechaEmision, '2026-05-25');
  assert.equal(res.body.montoTotal.currency, 'USD');
  assert.equal(Number(res.body.montoTotal.amount), 7777.77);
});

test('PUT /:id rechaza edición de factura confirmed (409)', async () => {
  // Creamos manualmente una factura confirmed.
  await prisma.factura.create({
    data: {
      ocId: 100n,
      sourceType: 'pdf',
      archivoOriginalPath: 'facturas/2026/05/100/fake.pdf',
      status: 'confirmed',
    },
  });
  const req = makeReq({
    params: { id: '1' },
    body: { numeroConsecutivo: 'NOPE' },
  });
  const res = makeRes();
  await controllers.updateFacturaCanonical(req, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /confirmada/i);
});
