/**
 * Tests del OCR Gemini para COTIZACIONES con mocks del SDK.
 *
 * Run: node --test server/services/__tests__/gemini-cotizacion-ocr.test.js
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractCotizacion,
  CotizacionOcrError,
  geminiClientFactory,
} from '../gemini-cotizacion-ocr.js';

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
  tempDir = await mkdtemp(join(tmpdir(), 'gemini-cot-ocr-test-'));
  sdk = installSdkMock();
  process.env.GEMINI_API_KEY = 'fake-test-key';
  delete process.env.OCR_MODEL;
});

afterEach(async () => {
  sdk.restore();
  await rm(tempDir, { recursive: true, force: true });
  delete process.env.GEMINI_API_KEY;
  delete process.env.OCR_MODEL;
});

// ---------------------------------------------------------------------------

test('extractCotizacion: happy path → { data, model, raw, warnings:[] }', async () => {
  const filePath = join(tempDir, 'cot.pdf');
  await writeFile(filePath, Buffer.from('%PDF-1.4 dummy'));

  sdk.setResponseText(
    JSON.stringify({
      proveedor: {
        nombre: 'Materiales La Costa S.A.',
        identificacion: '3101698280',
        telefono: '2222-3333',
        email: 'ventas@mlc.cr',
      },
      numeroCotizacion: 'COT-2026-0451',
      fecha: '2026-05-20',
      fechaValidez: '2026-06-20',
      moneda: 'CRC',
      condicionesPago: '50% anticipo, 50% contra entrega',
      plazoEntregaDias: 7,
      pctAnticipo: 50,
      items: [
        {
          descripcion: 'CEMENTO HOLCIM SACO 50KG',
          cantidad: 20,
          unidad: 'saco',
          precioUnitario: 9500,
          subtotal: 190000,
          ivaMonto: 24700,
        },
      ],
      subtotal: 190000,
      iva: 24700,
      total: 214700,
      notas: 'Precios sujetos a confirmación de stock',
    }),
  );

  const result = await extractCotizacion(filePath);

  assert.equal(result.data.proveedor.nombre, 'Materiales La Costa S.A.');
  assert.equal(result.data.proveedor.identificacion, '3101698280');
  assert.equal(result.data.numeroCotizacion, 'COT-2026-0451');
  assert.equal(result.data.fechaValidez, '2026-06-20');
  assert.equal(result.data.pctAnticipo, 50);
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.total, 214700);
  assert.equal(result.model, 'gemini-3.1-flash-lite');
  assert.deepEqual(result.warnings, []);
  assert.ok(typeof result.raw === 'string');
});

test('extractCotizacion: items sin precio → warning', async () => {
  const filePath = join(tempDir, 'cot.pdf');
  await writeFile(filePath, Buffer.from('x'));

  sdk.setResponseText(
    JSON.stringify({
      proveedor: { nombre: 'Proveedor X' },
      fecha: '2026-05-20',
      moneda: 'CRC',
      items: [
        { descripcion: 'item ok', cantidad: 1, precioUnitario: 100 },
        { descripcion: 'item sin precio', cantidad: 5, precioUnitario: 0 },
      ],
      total: 100,
    }),
  );

  const { warnings } = await extractCotizacion(filePath);
  assert.ok(warnings.some((w) => /sin precio/.test(w)));
});

test('extractCotizacion: file not found → CotizacionOcrError', async () => {
  const missing = join(tempDir, 'no-existe.pdf');

  await assert.rejects(
    () => extractCotizacion(missing),
    (err) =>
      err instanceof CotizacionOcrError && /no encontrado/i.test(err.message),
  );
});

test('extractCotizacion: GEMINI_API_KEY ausente → CotizacionOcrError', async () => {
  delete process.env.GEMINI_API_KEY;
  const filePath = join(tempDir, 'x.pdf');
  await writeFile(filePath, Buffer.from('x'));

  await assert.rejects(
    () => extractCotizacion(filePath),
    (err) =>
      err instanceof CotizacionOcrError && /GEMINI_API_KEY/.test(err.message),
  );
});

test('extractCotizacion: MIME no soportado → CotizacionOcrError', async () => {
  const filePath = join(tempDir, 'cot.docx');
  await writeFile(filePath, Buffer.from('x'));

  await assert.rejects(
    () => extractCotizacion(filePath),
    (err) =>
      err instanceof CotizacionOcrError && /no soportado/i.test(err.message),
  );
});

test('extractCotizacion: cédula inválida → warning (pero no falla)', async () => {
  const filePath = join(tempDir, 'cot.pdf');
  await writeFile(filePath, Buffer.from('x'));

  sdk.setResponseText(
    JSON.stringify({
      proveedor: { nombre: 'X', identificacion: 'NOT-VALID-123' },
      items: [{ descripcion: 'a', cantidad: 1, precioUnitario: 10 }],
      total: 10,
    }),
  );

  const { warnings } = await extractCotizacion(filePath);
  assert.ok(warnings.some((w) => /c[eé]dula/i.test(w)));
});

test('extractCotizacion: respuesta no-JSON → CotizacionOcrError', async () => {
  const filePath = join(tempDir, 'cot.pdf');
  await writeFile(filePath, Buffer.from('x'));

  sdk.setResponseText('no soy json {{{');

  await assert.rejects(
    () => extractCotizacion(filePath),
    (err) =>
      err instanceof CotizacionOcrError && /JSON/i.test(err.message),
  );
});

test('extractCotizacion: SDK lanza error → CotizacionOcrError envuelve causa', async () => {
  const filePath = join(tempDir, 'cot.pdf');
  await writeFile(filePath, Buffer.from('x'));

  const apiErr = new Error('quota exceeded');
  sdk.setError(apiErr);

  await assert.rejects(
    () => extractCotizacion(filePath),
    (err) =>
      err instanceof CotizacionOcrError &&
      /Gemini API error/.test(err.message) &&
      err.cause === apiErr,
  );
});

test('extractCotizacion: OCR_MODEL override + config correcta (schema, temp)', async () => {
  process.env.OCR_MODEL = 'gemini-2.5-flash-lite';
  const filePath = join(tempDir, 'cot.jpg');
  await writeFile(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

  sdk.setResponseText(
    JSON.stringify({
      proveedor: { nombre: 'Y' },
      items: [{ descripcion: 'b', cantidad: 1, precioUnitario: 10 }],
      total: 10,
    }),
  );

  const result = await extractCotizacion(filePath);
  assert.equal(result.model, 'gemini-2.5-flash-lite');
  assert.equal(sdk.calls.length, 1);
  const call = sdk.calls[0];
  assert.equal(call.config.responseMimeType, 'application/json');
  assert.equal(call.config.temperature, 0.1);
  assert.equal(call.config.responseSchema.type, 'object');
  assert.deepEqual(call.config.responseSchema.required, [
    'proveedor',
    'items',
    'total',
  ]);
  assert.equal(call.contents[0].parts[0].inlineData.mimeType, 'image/jpeg');
});

test('extractCotizacion: respuesta sin items → warning', async () => {
  const filePath = join(tempDir, 'cot.pdf');
  await writeFile(filePath, Buffer.from('x'));

  sdk.setResponseText(
    JSON.stringify({
      proveedor: { nombre: 'Z' },
      items: [],
      total: 0,
    }),
  );

  const { warnings } = await extractCotizacion(filePath);
  assert.ok(warnings.some((w) => /items/.test(w)));
  assert.ok(warnings.some((w) => /total/.test(w)));
});
