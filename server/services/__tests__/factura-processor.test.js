/**
 * Tests del `factura-processor` — la función pura que comparten el path inline
 * (controller) y el path async (worker).
 *
 * Estrategia: mockeamos el cliente Prisma con un objeto simple in-memory. El
 * processor solo necesita `factura.findUnique` + `factura.update`. Esto es más
 * rápido y determinístico que usar la DB real, y captura el contrato exacto
 * sin acoplarnos al schema concreto.
 *
 * Run: `node --test server/services/__tests__/factura-processor.test.js`
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { processFacturaXml, processFacturaImagen } from '../factura-processor.js';
import { geminiClientFactory } from '../gemini-ocr.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Mock Prisma (in-memory) — solo las methods que processor usa.
// ---------------------------------------------------------------------------

function mockPrisma(initialFactura) {
  const store = new Map();
  if (initialFactura) store.set(initialFactura.id, { ...initialFactura });

  return {
    factura: {
      async findUnique({ where: { id } }) {
        return store.get(id) ? { ...store.get(id) } : null;
      },
      async update({ where: { id }, data }) {
        const existing = store.get(id);
        if (!existing) {
          const err = new Error('Record to update not found');
          err.code = 'P2025';
          throw err;
        }
        const merged = { ...existing, ...data, updatedAt: new Date() };
        store.set(id, merged);
        return { ...merged };
      },
    },
    _store: store,
  };
}

// ---------------------------------------------------------------------------
// Tmp file helpers — los archivos viven dentro de `uploads/` del proyecto para
// que `absoluteFromUploads` los resuelva igual que en prod.
// ---------------------------------------------------------------------------

const UPLOADS_ROOT = resolve(__dirname, '..', '..', '..', 'uploads');
const TEST_SUBDIR = join('test-factura-processor');

async function writeUploadFile(name, contents) {
  const dir = join(UPLOADS_ROOT, TEST_SUBDIR);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  const fullPath = join(dir, name);
  await writeFile(fullPath, contents);
  return join(TEST_SUBDIR, name); // relativa a uploads/
}

async function cleanupUploads() {
  const dir = join(UPLOADS_ROOT, TEST_SUBDIR);
  await rm(dir, { recursive: true, force: true });
  // También limpiar leftover dirs `test-factura-processor-*` de runs previos
  // (en caso de versiones antiguas con mkdtemp).
  const { readdir } = await import('node:fs/promises');
  try {
    const entries = await readdir(UPLOADS_ROOT);
    for (const e of entries) {
      if (e.startsWith('test-factura-processor-')) {
        await rm(join(UPLOADS_ROOT, e), { recursive: true, force: true });
      }
    }
  } catch {
    // ignore
  }
}

afterEach(async () => {
  await cleanupUploads();
});

// ---------------------------------------------------------------------------
// XML — happy path
// ---------------------------------------------------------------------------

const TE_XML_FIXTURE = resolve(__dirname, 'fixtures', 'te_real.xml');

test('processFacturaXml: happy path → status=extracted con canonical fields', async () => {
  const { readFile } = await import('node:fs/promises');
  const xml = await readFile(TE_XML_FIXTURE, 'utf8');
  const relPath = await writeUploadFile('factura-ok.xml', xml);

  const prisma = mockPrisma({
    id: 1n,
    ocId: 100n,
    sourceType: 'xml',
    archivoOriginalPath: relPath,
    status: 'pending',
  });

  const result = await processFacturaXml(prisma, 1n);

  assert.equal(result.status, 'extracted');
  assert.equal(result.tipoComprobante, 'TE');
  assert.equal(result.claveNumerica, '50604052600310169828000100001040000134414127865041');
  assert.equal(result.numeroConsecutivo, '00100001040000134414');
  assert.ok(result.fechaEmision instanceof Date);
  assert.equal(result.montoTotalAmount, '1769.30880');
  assert.equal(result.montoTotalCurrency, 'CRC');
  assert.equal(result.confidenceScore, null);
  assert.equal(result.errorMessage, null);
  assert.ok(result.extractedData);
  assert.equal(result.extractedData.tipo, 'TE');
});

// ---------------------------------------------------------------------------
// XML — malformed → status=error con errorMessage poblado
// ---------------------------------------------------------------------------

test('processFacturaXml: XML mal formado → status=error', async () => {
  const relPath = await writeUploadFile('mal.xml', '<broken xml >>><<<');

  const prisma = mockPrisma({
    id: 2n,
    ocId: 100n,
    sourceType: 'xml',
    archivoOriginalPath: relPath,
    status: 'pending',
  });

  const result = await processFacturaXml(prisma, 2n);

  assert.equal(result.status, 'error');
  assert.ok(result.errorMessage);
  assert.match(result.errorMessage, /XML inválido|fast-xml-parser/);
});

test('processFacturaXml: XML con namespace desconocido → status=error', async () => {
  const xml = `<?xml version="1.0"?><Foo xmlns="https://example.com/unknown"><Bar/></Foo>`;
  const relPath = await writeUploadFile('unknown.xml', xml);

  const prisma = mockPrisma({
    id: 3n,
    ocId: 100n,
    sourceType: 'xml',
    archivoOriginalPath: relPath,
    status: 'pending',
  });

  const result = await processFacturaXml(prisma, 3n);
  assert.equal(result.status, 'error');
  assert.match(result.errorMessage, /Namespace|root/);
});

// ---------------------------------------------------------------------------
// XML — idempotencia
// ---------------------------------------------------------------------------

test('processFacturaXml: idempotente — si ya está extracted, no la reprocesa', async () => {
  const prisma = mockPrisma({
    id: 4n,
    ocId: 100n,
    sourceType: 'xml',
    archivoOriginalPath: 'cualquier-cosa.xml',
    status: 'extracted',
    tipoComprobante: 'TE',
    extractedData: { tipo: 'TE', custom: 'data' },
    errorMessage: null,
  });

  const result = await processFacturaXml(prisma, 4n);
  assert.equal(result.status, 'extracted');
  assert.equal(result.extractedData.custom, 'data'); // no se sobrescribió
});

test('processFacturaXml: idempotente — si ya está confirmed, no la reprocesa', async () => {
  const prisma = mockPrisma({
    id: 5n,
    ocId: 100n,
    sourceType: 'xml',
    archivoOriginalPath: 'whatever.xml',
    status: 'confirmed',
    confirmadaPorId: 1n,
  });

  const result = await processFacturaXml(prisma, 5n);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.confirmadaPorId, 1n);
});

// ---------------------------------------------------------------------------
// XML — sin archivo en disco
// ---------------------------------------------------------------------------

test('processFacturaXml: archivo no existe → status=error', async () => {
  const prisma = mockPrisma({
    id: 6n,
    ocId: 100n,
    sourceType: 'xml',
    archivoOriginalPath: 'no-existe/factura.xml',
    status: 'pending',
  });

  const result = await processFacturaXml(prisma, 6n);
  assert.equal(result.status, 'error');
  assert.match(result.errorMessage, /No se pudo leer archivo|ENOENT/);
});

// ---------------------------------------------------------------------------
// XML — factura no encontrada
// ---------------------------------------------------------------------------

test('processFacturaXml: factura inexistente tira NOT_FOUND', async () => {
  const prisma = mockPrisma();
  await assert.rejects(
    () => processFacturaXml(prisma, 999n),
    (err) => err.code === 'NOT_FOUND',
  );
});

test('processFacturaXml: sourceType incorrecto tira WRONG_SOURCE', async () => {
  const prisma = mockPrisma({
    id: 7n,
    ocId: 100n,
    sourceType: 'pdf',
    archivoOriginalPath: 'x.pdf',
    status: 'pending',
  });

  await assert.rejects(
    () => processFacturaXml(prisma, 7n),
    (err) => err.code === 'WRONG_SOURCE',
  );
});

// ---------------------------------------------------------------------------
// OCR / Imagen — happy path con SDK mockeado
// ---------------------------------------------------------------------------

function installGeminiMock(responseObj) {
  const original = geminiClientFactory.create;
  geminiClientFactory.create = function () {
    return {
      models: {
        async generateContent() {
          return { text: JSON.stringify(responseObj) };
        },
      },
    };
  };
  return () => {
    geminiClientFactory.create = original;
  };
}

test('processFacturaImagen: happy path → status=extracted con confidence', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  const restore = installGeminiMock({
    emisor: { nombre: 'PROVEEDOR X', identificacion: '3101123456' },
    fecha: '2026-05-25',
    total: 50000,
    moneda: 'CRC',
    consecutivo: 'F-001',
    confianza: 0.92,
  });

  try {
    const relPath = await writeUploadFile('factura.jpg', Buffer.from([0xff, 0xd8, 0xff])); // fake JPG

    const prisma = mockPrisma({
      id: 10n,
      ocId: 200n,
      sourceType: 'imagen',
      archivoOriginalPath: relPath,
      status: 'pending',
    });

    const result = await processFacturaImagen(prisma, 10n);

    assert.equal(result.status, 'extracted');
    assert.equal(result.confidenceScore, 0.92);
    assert.equal(result.montoTotalAmount, 50000);
    assert.equal(result.montoTotalCurrency, 'CRC');
    assert.equal(result.numeroConsecutivo, 'F-001');
    assert.ok(result.fechaEmision instanceof Date);
  } finally {
    restore();
  }
});

test('processFacturaImagen: OCR error → status=error', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  const original = geminiClientFactory.create;
  geminiClientFactory.create = function () {
    return {
      models: {
        async generateContent() {
          throw new Error('boom');
        },
      },
    };
  };

  try {
    const relPath = await writeUploadFile('factura-err.jpg', Buffer.from([0xff]));

    const prisma = mockPrisma({
      id: 11n,
      ocId: 200n,
      sourceType: 'imagen',
      archivoOriginalPath: relPath,
      status: 'pending',
    });

    const result = await processFacturaImagen(prisma, 11n);
    assert.equal(result.status, 'error');
    assert.match(result.errorMessage, /Gemini|OCR|boom/i);
  } finally {
    geminiClientFactory.create = original;
  }
});

test('processFacturaImagen: idempotente — si ya está extracted, no reprocesa', async () => {
  const prisma = mockPrisma({
    id: 12n,
    ocId: 200n,
    sourceType: 'imagen',
    archivoOriginalPath: 'x.jpg',
    status: 'extracted',
    confidenceScore: 0.8,
  });

  const result = await processFacturaImagen(prisma, 12n);
  assert.equal(result.status, 'extracted');
  assert.equal(result.confidenceScore, 0.8);
});
