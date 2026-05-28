/**
 * Tests del OCR Gemini Flash-Lite con mocks del SDK.
 *
 * Run: node --test server/services/__tests__/gemini-ocr.test.js
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractInvoice,
  OCRError,
  geminiClientFactory,
} from '../gemini-ocr.js';

// Helpers ---------------------------------------------------------------

/**
 * Sustituye `geminiClientFactory.create` por una función que retorna un
 * mock-client. Captura las llamadas a `generateContent` para asserts.
 *
 * @returns {{
 *   restore: () => void,
 *   calls: Array<object>,
 *   setResponseText: (text: string) => void,
 *   setError: (err: Error) => void,
 * }}
 */
function installSdkMock() {
  const original = geminiClientFactory.create;
  const calls = [];
  let responseText = '{}';
  let throwErr = null;

  geminiClientFactory.create = function mockedCreate(apiKey) {
    return {
      _apiKey: apiKey,
      models: {
        async generateContent(params) {
          calls.push(params);
          if (throwErr) throw throwErr;
          return { text: responseText };
        },
      },
    };
  };

  return {
    restore() {
      geminiClientFactory.create = original;
    },
    calls,
    setResponseText(text) {
      responseText = text;
    },
    setError(err) {
      throwErr = err;
    },
  };
}

let tempDir;
let sdk;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'gemini-ocr-test-'));
  sdk = installSdkMock();
  // Default env
  process.env.GEMINI_API_KEY = 'fake-test-key';
  delete process.env.OCR_MODEL;
});

afterEach(async () => {
  sdk.restore();
  await rm(tempDir, { recursive: true, force: true });
  delete process.env.GEMINI_API_KEY;
  delete process.env.OCR_MODEL;
});

// Tests -----------------------------------------------------------------

test('extractInvoice: happy path → { data, confidence, model, raw }', async () => {
  const filePath = join(tempDir, 'factura.pdf');
  await writeFile(filePath, Buffer.from('%PDF-1.4 dummy'));

  sdk.setResponseText(JSON.stringify({
    emisor: {
      nombre: 'Materiales La Costa',
      identificacion: '3101698280',
    },
    consecutivo: '00100001040000134414',
    clave: '50604052600310169828000100001040000134414127865041',
    fecha: '2026-05-04',
    moneda: 'CRC',
    items: [
      {
        descripcion: "CODO LISO PVC 90' 38MM",
        cantidad: 1,
        unidad: 'Unid',
        precio_unitario: 1565.76,
        subtotal: 1565.76,
        iva: 203.55,
      },
    ],
    subtotal: 1565.76,
    iva: 203.55,
    total: 1769.31,
    confianza: 0.92,
  }));

  const result = await extractInvoice(filePath);

  assert.equal(result.data.emisor.nombre, 'Materiales La Costa');
  assert.equal(result.data.emisor.identificacion, '3101698280');
  assert.equal(result.data.total, 1769.31);
  assert.equal(result.data.items.length, 1);
  assert.equal(result.confidence, 0.92);
  // confianza fue extraída → no debe quedar en data
  assert.equal(result.data.confianza, undefined);
  // modelo por default
  assert.equal(result.model, 'gemini-3.1-flash-lite');
  // raw es el JSON string crudo
  assert.equal(typeof result.raw, 'string');
  assert.ok(result.raw.includes('Materiales La Costa'));
  // sin warnings ni status (todo limpio)
  assert.equal(result.data._warnings, undefined);
  assert.equal(result.data.status, undefined);
});

test('extractInvoice: file not found → OCRError', async () => {
  const missing = join(tempDir, 'no-existe.pdf');

  await assert.rejects(
    () => extractInvoice(missing),
    (err) => err instanceof OCRError && /no encontrado/i.test(err.message),
  );
});

test('extractInvoice: GEMINI_API_KEY ausente → OCRError', async () => {
  delete process.env.GEMINI_API_KEY;
  const filePath = join(tempDir, 'x.pdf');
  await writeFile(filePath, Buffer.from('x'));

  await assert.rejects(
    () => extractInvoice(filePath),
    (err) => err instanceof OCRError && /GEMINI_API_KEY/.test(err.message),
  );
});

test('extractInvoice: cédula no matchea regex → _warnings + status low_confidence', async () => {
  const filePath = join(tempDir, 'f.pdf');
  await writeFile(filePath, Buffer.from('x'));

  sdk.setResponseText(JSON.stringify({
    emisor: { nombre: 'X', identificacion: 'INVALID-CED' },
    fecha: '2026-05-25',
    moneda: 'CRC',
    total: 100,
    items: [],
    confianza: 0.5,
  }));

  const { data } = await extractInvoice(filePath);

  assert.ok(Array.isArray(data._warnings));
  assert.ok(data._warnings.some((w) => /c[eé]dula/i.test(w)));
  assert.equal(data.status, 'low_confidence');
});

test('extractInvoice: cédula DIMEX 12 dígitos → SIN warning (fix #12)', async () => {
  const filePath = join(tempDir, 'f.pdf');
  await writeFile(filePath, Buffer.from('x'));

  sdk.setResponseText(JSON.stringify({
    emisor: { nombre: 'Extranjero', identificacion: '123456789012' },
    fecha: '2026-05-25',
    moneda: 'CRC',
    total: 100,
    items: [],
    confianza: 0.9,
  }));

  const { data } = await extractInvoice(filePath);

  const warnings = data._warnings || [];
  const cedulaWarnings = warnings.filter((w) => /c[eé]dula/i.test(w));
  assert.equal(cedulaWarnings.length, 0);
});

test('extractInvoice: total <= 0 → warning', async () => {
  const filePath = join(tempDir, 'f.pdf');
  await writeFile(filePath, Buffer.from('x'));

  sdk.setResponseText(JSON.stringify({
    emisor: { nombre: 'X', identificacion: '3101000001' },
    fecha: '2026-05-25',
    moneda: 'CRC',
    total: 0,
    items: [],
    confianza: 0.3,
  }));

  const { data } = await extractInvoice(filePath);

  assert.ok(Array.isArray(data._warnings));
  assert.ok(data._warnings.some((w) => /total/i.test(w)));
  assert.equal(data.status, 'low_confidence');
});

test('extractInvoice: OCR_MODEL env var override pasa al SDK', async () => {
  process.env.OCR_MODEL = 'gemini-2.5-flash-lite';
  const filePath = join(tempDir, 'f.pdf');
  await writeFile(filePath, Buffer.from('x'));

  sdk.setResponseText(JSON.stringify({
    emisor: { nombre: 'X', identificacion: '3101000001' },
    fecha: '2026-05-25',
    moneda: 'CRC',
    total: 100,
    items: [],
    confianza: 0.5,
  }));

  const result = await extractInvoice(filePath);

  assert.equal(result.model, 'gemini-2.5-flash-lite');
  assert.equal(sdk.calls.length, 1);
  assert.equal(sdk.calls[0].model, 'gemini-2.5-flash-lite');
});

test('extractInvoice: MIME se detecta por extensión (jpg → image/jpeg)', async () => {
  const filePath = join(tempDir, 'foto.jpg');
  await writeFile(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

  sdk.setResponseText(JSON.stringify({
    emisor: { nombre: 'X', identificacion: '3101000001' },
    fecha: '2026-05-25',
    moneda: 'CRC',
    total: 100,
    items: [],
    confianza: 0.7,
  }));

  await extractInvoice(filePath);

  assert.equal(sdk.calls.length, 1);
  const inlinePart = sdk.calls[0].contents[0].parts[0];
  assert.equal(inlinePart.inlineData.mimeType, 'image/jpeg');
  assert.equal(typeof inlinePart.inlineData.data, 'string');
});

test('extractInvoice: structured output config (responseSchema + JSON mime)', async () => {
  const filePath = join(tempDir, 'f.png');
  await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  sdk.setResponseText(JSON.stringify({
    emisor: { nombre: 'X', identificacion: '3101000001' },
    fecha: '2026-05-25',
    moneda: 'CRC',
    total: 100,
    items: [],
    confianza: 0.6,
  }));

  await extractInvoice(filePath);

  const call = sdk.calls[0];
  assert.equal(call.config.responseMimeType, 'application/json');
  assert.equal(call.config.temperature, 0);
  assert.equal(call.config.responseSchema.type, 'object');
  assert.deepEqual(call.config.responseSchema.required, [
    'emisor',
    'fecha',
    'total',
  ]);
  // MIME por extensión
  assert.equal(call.contents[0].parts[0].inlineData.mimeType, 'image/png');
});

test('extractInvoice: respuesta no-JSON → OCRError', async () => {
  const filePath = join(tempDir, 'f.pdf');
  await writeFile(filePath, Buffer.from('x'));

  sdk.setResponseText('no soy json {{{');

  await assert.rejects(
    () => extractInvoice(filePath),
    (err) => err instanceof OCRError && /JSON/i.test(err.message),
  );
});

test('extractInvoice: SDK lanza error → OCRError envuelve causa', async () => {
  const filePath = join(tempDir, 'f.pdf');
  await writeFile(filePath, Buffer.from('x'));

  const apiErr = new Error('quota exceeded');
  sdk.setError(apiErr);

  await assert.rejects(
    () => extractInvoice(filePath),
    (err) =>
      err instanceof OCRError &&
      /Gemini API error/.test(err.message) &&
      err.cause === apiErr,
  );
});
