/**
 * Tests del flujo de archivo de evidencia para cotizaciones.
 *
 * Run: `node --test server/routes/__tests__/cotizaciones-archivo.test.js`
 *
 * Estrategia (igual que `facturas.test.js`):
 *  - NO usar supertest.
 *  - Invocar los controllers + el middleware multer DIRECTAMENTE con
 *    req/res mocks (multer corre como middleware express estándar).
 *  - Stubbear Prisma con un cliente en memoria minimal (Map por modelo).
 *
 * Casos cubiertos:
 *  1. Upload PDF válido → `archivoPath` seteado, archivo existe en disco.
 *  2. Upload imagen JPG → ok.
 *  3. Upload MIME no permitido (txt) → 415.
 *  4. Upload > 20 MiB → 413.
 *  5. Upload sobre cotización con archivo previo → reemplaza, viejo borrado.
 *  6. Download de archivo existente → 200 + bytes correctos + content-type.
 *  7. Download de cotización sin archivo → 404.
 *  8. Delete → archivo borrado del disco y archivoPath = null.
 *  9. Delete sin permisos (operativo) → 403.
 * 10. Upload sin permisos (lector) → 403 + archivo limpiado.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import prisma from '../../db.js';
import {
  UPLOADS_ROOT,
  cotizacionArchivoStoragePath,
  cotizacionArchivoUpload,
} from '../../lib/uploads.js';

// Mismo polyfill que server/index.js para template literals con BigInt.
BigInt.prototype.toJSON = function () { return Number(this); };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let controllers;
let originalPrismaMethods;
const stagedPaths = []; // archivos creados durante el test, para cleanup final

// ---------------------------------------------------------------------------
// In-memory Prisma store
// ---------------------------------------------------------------------------

const store = {
  cotizaciones: new Map(), // id (string) -> Cotizacion
  nextId: 1n,
};

function makeCotizacion(overrides = {}) {
  const id = store.nextId++;
  const row = {
    id,
    obraId: 1n,
    proveedorId: 1n,
    rfqId: null,
    numeroCotizacion: `COT-${id}`,
    fecha: new Date(),
    fechaValidez: null,
    moneda: 'CRC',
    subtotalAmount: '100',
    subtotalCurrency: 'CRC',
    ivaAmount: '13',
    ivaCurrency: 'CRC',
    totalAmount: '113',
    totalCurrency: 'CRC',
    condicionesPago: null,
    plazoEntregaDias: null,
    pctAnticipo: null,
    esEspecial: false,
    archivoPath: null,
    estado: 'recibida',
    notas: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  store.cotizaciones.set(String(id), row);
  return row;
}

function installPrismaMock() {
  originalPrismaMethods = {
    cotizacion: prisma.cotizacion,
  };

  prisma.cotizacion = {
    async findUnique({ where, select }) {
      const row = store.cotizaciones.get(String(where.id));
      if (!row) return null;
      if (select) {
        const out = {};
        for (const k of Object.keys(select)) out[k] = row[k];
        return out;
      }
      return { ...row };
    },
    async update({ where, data, select }) {
      const row = store.cotizaciones.get(String(where.id));
      if (!row) {
        throw Object.assign(new Error('Not found'), { code: 'P2025' });
      }
      Object.assign(row, data, { updatedAt: new Date() });
      if (select) {
        const out = {};
        for (const k of Object.keys(select)) out[k] = row[k];
        return out;
      }
      return { ...row };
    },
  };
}

function restorePrismaMock() {
  prisma.cotizacion = originalPrismaMethods.cotizacion;
}

// ---------------------------------------------------------------------------
// req / res mocks
// ---------------------------------------------------------------------------

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    headersSent: false,
    _chunks: [],
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.headersSent = true; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    write(chunk) { this._chunks.push(chunk); return true; },
    end(chunk) { if (chunk) this._chunks.push(chunk); this.headersSent = true; return this; },
    on() {},
    once() {},
    emit() {},
  };
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

/**
 * Corre el middleware multer real como si fuera express. Devuelve una promesa
 * que resuelve cuando multer llama a `next` o a `next(err)`.
 *
 * Multer espera un IncomingMessage real para poder hacer `req.pipe(busboy)`.
 * Para tests, simulamos un upload "multipart-like" usando una request
 * fabricada — la forma más simple es generar un cuerpo multipart binario
 * y wrappear todo en una stream Readable.
 */
import { Readable } from 'node:stream';

function buildMultipartBody({ field = 'archivo', filename, mime, content }) {
  const boundary = '----testboundary' + Math.random().toString(16).slice(2);
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const parts = [
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n`),
    Buffer.from(`Content-Type: ${mime}\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  return { body: Buffer.concat(parts), boundary };
}

function makeMultipartReq({ params, user, multipart }) {
  const { body, boundary } = multipart;
  const stream = Readable.from([body]);
  // Asignamos props para que parezca un IncomingMessage de Express.
  stream.params = params;
  stream.user = user ?? { id: 1, username: 'admin', role: 'admin' };
  stream.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(body.length),
  };
  stream.method = 'POST';
  stream.url = '/';
  return stream;
}

function runMulter(req, res) {
  return new Promise((resolve) => {
    cotizacionArchivoUpload(req, res, (err) => resolve(err || null));
  });
}

// ---------------------------------------------------------------------------
// PDF fixture (mínimo válido — solo cabecera %PDF-)
// ---------------------------------------------------------------------------

const MINIMAL_PDF = Buffer.from(
  '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF',
  'binary',
);

// Mínimo "JPEG" (basta con los magic bytes para que el filtro por extensión pase).
const MINIMAL_JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  store.cotizaciones.clear();
  store.nextId = 1n;
  installPrismaMock();
  controllers = await import('../../controllers/cotizaciones.controller.js');
});

afterEach(() => {
  restorePrismaMock();
  while (stagedPaths.length) {
    const p = stagedPaths.pop();
    try { rmSync(p, { force: true }); } catch { /* noop */ }
  }
});

// ---------------------------------------------------------------------------
// Helper: stage un archivo directamente (sin pasar por multer) y arma el
// `req.file` que el controller espera. Equivalente a `stageXmlAsync` de
// facturas.test.js.
// ---------------------------------------------------------------------------

function stageFileSync({ cotizacionId, originalName, content, mimetype }) {
  const { absolutePath, relativePath, filename } = cotizacionArchivoStoragePath({
    cotizacionId,
    originalName,
  });
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  stagedPaths.push(absolutePath);
  return {
    file: {
      path: absolutePath,
      originalname: originalName,
      mimetype,
      filename,
      size: content.length,
    },
    absolutePath,
    relativePath,
  };
}

// =========================================================================
// TESTS
// =========================================================================

test('upload PDF válido → archivoPath seteado, archivo existe en disco', async () => {
  const cot = makeCotizacion();
  const { file, absolutePath, relativePath } = stageFileSync({
    cotizacionId: cot.id,
    originalName: 'cotizacion-proveedor.pdf',
    content: MINIMAL_PDF,
    mimetype: 'application/pdf',
  });

  const req = makeReq({ params: { id: String(cot.id) }, file });
  const res = makeRes();

  await controllers.uploadArchivoCotizacion(req, res);

  assert.equal(res.statusCode, 200, `body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.archivoPath, relativePath);
  assert.ok(existsSync(absolutePath), 'el archivo debe seguir en disco tras un upload exitoso');

  const stored = store.cotizaciones.get(String(cot.id));
  assert.equal(stored.archivoPath, relativePath);
});

test('upload JPG válido → ok', async () => {
  const cot = makeCotizacion();
  const { file, absolutePath } = stageFileSync({
    cotizacionId: cot.id,
    originalName: 'foto-evidencia.jpg',
    content: MINIMAL_JPG,
    mimetype: 'image/jpeg',
  });

  const req = makeReq({ params: { id: String(cot.id) }, file });
  const res = makeRes();
  await controllers.uploadArchivoCotizacion(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.archivoPath);
  assert.match(res.body.archivoPath, /\.jpg$/);
  assert.ok(existsSync(absolutePath));
});

test('upload MIME no permitido (txt) → 415 (via multer fileFilter)', async () => {
  const cot = makeCotizacion();
  const multipart = buildMultipartBody({
    filename: 'fake.txt',
    mime: 'text/plain',
    content: 'not a pdf',
  });
  const req = makeMultipartReq({ params: { id: String(cot.id) }, multipart });
  const res = makeRes();
  const err = await runMulter(req, res);

  assert.ok(err, 'multer debe haber rechazado el archivo');
  assert.equal(err.code, 'INVALID_FILE_TYPE');
  assert.equal(err.status, 415);
});

test('upload > 20 MiB → 413 (LIMIT_FILE_SIZE)', async () => {
  const cot = makeCotizacion();
  // 21 MiB de zeros (suficiente para que multer lo aborte).
  const huge = Buffer.alloc(21 * 1024 * 1024, 0);
  // Anteponemos la cabecera %PDF para no caer en el fileFilter primero.
  huge[0] = 0x25; huge[1] = 0x50; huge[2] = 0x44; huge[3] = 0x46;
  const multipart = buildMultipartBody({
    filename: 'enorme.pdf',
    mime: 'application/pdf',
    content: huge,
  });
  const req = makeMultipartReq({ params: { id: String(cot.id) }, multipart });
  const res = makeRes();
  const err = await runMulter(req, res);

  assert.ok(err, 'multer debe haber abortado por tamaño');
  assert.equal(err.code, 'LIMIT_FILE_SIZE');
});

test('upload reemplaza archivo viejo: el anterior se borra del disco', async () => {
  const cot = makeCotizacion();

  // Primer upload
  const first = stageFileSync({
    cotizacionId: cot.id,
    originalName: 'cot-v1.pdf',
    content: MINIMAL_PDF,
    mimetype: 'application/pdf',
  });
  await controllers.uploadArchivoCotizacion(
    makeReq({ params: { id: String(cot.id) }, file: first.file }),
    makeRes(),
  );
  assert.ok(existsSync(first.absolutePath));

  // Segundo upload (reemplazo)
  const second = stageFileSync({
    cotizacionId: cot.id,
    originalName: 'cot-v2.pdf',
    content: MINIMAL_PDF,
    mimetype: 'application/pdf',
  });
  const res2 = makeRes();
  await controllers.uploadArchivoCotizacion(
    makeReq({ params: { id: String(cot.id) }, file: second.file }),
    res2,
  );

  assert.equal(res2.statusCode, 200);
  assert.equal(res2.body.archivoPath, second.relativePath);
  assert.ok(existsSync(second.absolutePath), 'el archivo nuevo debe estar en disco');
  assert.ok(!existsSync(first.absolutePath), 'el archivo viejo debe haber sido borrado');

  const stored = store.cotizaciones.get(String(cot.id));
  assert.equal(stored.archivoPath, second.relativePath);
});

test('upload con cotización inexistente → 404 y archivo limpiado', async () => {
  const { file, absolutePath } = stageFileSync({
    cotizacionId: 9999,
    originalName: 'huerfano.pdf',
    content: MINIMAL_PDF,
    mimetype: 'application/pdf',
  });
  const req = makeReq({ params: { id: '9999' }, file });
  const res = makeRes();
  await controllers.uploadArchivoCotizacion(req, res);

  assert.equal(res.statusCode, 404);
  assert.ok(!existsSync(absolutePath), 'el archivo debe haberse limpiado');
});

test('upload sin permisos (rol lector) → 403 + archivo limpiado', async () => {
  const cot = makeCotizacion();
  const { file, absolutePath } = stageFileSync({
    cotizacionId: cot.id,
    originalName: 'cot.pdf',
    content: MINIMAL_PDF,
    mimetype: 'application/pdf',
  });
  const req = makeReq({
    params: { id: String(cot.id) },
    user: { id: 4, username: 'nicholas', role: 'lector' },
    file,
  });
  const res = makeRes();
  await controllers.uploadArchivoCotizacion(req, res);

  assert.equal(res.statusCode, 403);
  assert.ok(!existsSync(absolutePath));
});

test('GET /:id/archivo devuelve bytes correctos + content-type inline', async () => {
  const cot = makeCotizacion();
  const { file, absolutePath, relativePath } = stageFileSync({
    cotizacionId: cot.id,
    originalName: 'cotizacion.pdf',
    content: MINIMAL_PDF,
    mimetype: 'application/pdf',
  });

  await controllers.uploadArchivoCotizacion(
    makeReq({ params: { id: String(cot.id) }, file }),
    makeRes(),
  );

  // Capturamos el stream del download
  const req = makeReq({ params: { id: String(cot.id) } });
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
    on() {}, once() {}, emit() {},
  };

  await controllers.downloadArchivoCotizacion(req, res);
  await donePromise;

  const captured = Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))));
  const expected = readFileSync(absolutePath);
  assert.equal(captured.equals(expected), true, 'los bytes deben coincidir');
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition'] || '', /^inline/);
  // Asegurarnos de que NO es attachment
  assert.doesNotMatch(res.headers['content-disposition'] || '', /attachment/);

  // Sanity: el archivo en disco es el mismo que la DB apuntó.
  const stored = store.cotizaciones.get(String(cot.id));
  assert.equal(stored.archivoPath, relativePath);
});

test('GET /:id/archivo de cotización sin archivo → 404', async () => {
  const cot = makeCotizacion(); // sin archivoPath
  const req = makeReq({ params: { id: String(cot.id) } });
  const res = makeRes();
  await controllers.downloadArchivoCotizacion(req, res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error || '', /sin archivo/i);
});

test('GET /:id/archivo de cotización inexistente → 404', async () => {
  const req = makeReq({ params: { id: '99999' } });
  const res = makeRes();
  await controllers.downloadArchivoCotizacion(req, res);
  assert.equal(res.statusCode, 404);
});

test('DELETE /:id/archivo borra archivo del disco + archivoPath=null', async () => {
  const cot = makeCotizacion();
  const { file, absolutePath } = stageFileSync({
    cotizacionId: cot.id,
    originalName: 'cot.pdf',
    content: MINIMAL_PDF,
    mimetype: 'application/pdf',
  });
  await controllers.uploadArchivoCotizacion(
    makeReq({ params: { id: String(cot.id) }, file }),
    makeRes(),
  );
  assert.ok(existsSync(absolutePath));

  const req = makeReq({
    params: { id: String(cot.id) },
    user: { id: 1, username: 'admin', role: 'admin' },
  });
  const res = makeRes();
  await controllers.deleteArchivoCotizacion(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.archivoPath, null);
  assert.ok(!existsSync(absolutePath), 'el archivo se borró del disco');

  const stored = store.cotizaciones.get(String(cot.id));
  assert.equal(stored.archivoPath, null);
});

test('DELETE /:id/archivo con rol operativo → 403', async () => {
  const cot = makeCotizacion({ archivoPath: 'cotizaciones/2026/05/1/foo.pdf' });
  const req = makeReq({
    params: { id: String(cot.id) },
    user: { id: 2, username: 'tony', role: 'operativo' },
  });
  const res = makeRes();
  await controllers.deleteArchivoCotizacion(req, res);
  assert.equal(res.statusCode, 403);

  // No debe haber tocado la DB
  const stored = store.cotizaciones.get(String(cot.id));
  assert.equal(stored.archivoPath, 'cotizaciones/2026/05/1/foo.pdf');
});

test('DELETE /:id/archivo idempotente: cotización sin archivo → 200', async () => {
  const cot = makeCotizacion(); // sin archivoPath
  const req = makeReq({ params: { id: String(cot.id) } });
  const res = makeRes();
  await controllers.deleteArchivoCotizacion(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.archivoPath, null);
});

// Tras todos los tests del archivo, cerramos prisma para que node:test termine.
// (no usamos `after` del módulo `node:test` porque rompe el harness en versiones
// viejas; lo encadenamos al final con `process.on`.)
process.on('exit', () => {
  // Asegurar limpieza de UPLOADS_ROOT/cotizaciones/* creado durante tests.
  // (Best-effort — los stagedPaths ya se borraron file-by-file en afterEach.)
  try {
    // No hace falta tocar UPLOADS_ROOT aquí: dejamos los directorios vacíos
    // como artefactos inocuos.
    void UPLOADS_ROOT;
  } catch { /* noop */ }
});
