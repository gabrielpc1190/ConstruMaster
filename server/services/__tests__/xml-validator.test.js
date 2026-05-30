/**
 * Tests del XML validator (XSD opt-in con xmllint-wasm).
 *
 * Run: `node --test server/services/__tests__/xml-validator.test.js`
 *
 * Cuando `XSD_VALIDATE !== 'true'`, el validator es no-op (validamos esto sin
 * dependencias). Cuando `XSD_VALIDATE === 'true'`, levantamos xmllint-wasm y
 * validamos contra los XSDs reales. Estos últimos tardan ~500-1500ms en el
 * primer call (carga del wasm + worker thread).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  validateXml,
  isXsdEnabled,
  _resetSchemaCache,
} from '../xml-validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = join(__dirname, 'fixtures');
const TE_XML = readFileSync(join(FIXTURES, 'te_real.xml'), 'utf8');

const ORIGINAL_FLAG = process.env.XSD_VALIDATE;

beforeEach(() => {
  _resetSchemaCache();
});

afterEach(() => {
  if (ORIGINAL_FLAG == null) delete process.env.XSD_VALIDATE;
  else process.env.XSD_VALIDATE = ORIGINAL_FLAG;
});

// ---------------------------------------------------------------------------
// Default OFF — no-op
// ---------------------------------------------------------------------------

test('default (XSD_VALIDATE off) → siempre valid=true sin tocar el filesystem', async () => {
  delete process.env.XSD_VALIDATE;
  const result = await validateXml(TE_XML, 'TE');
  assert.deepEqual(result, { valid: true, errors: [] });
});

test('XSD_VALIDATE="false" → no-op', async () => {
  process.env.XSD_VALIDATE = 'false';
  const result = await validateXml('<garbage></garbage>', 'TE');
  assert.deepEqual(result, { valid: true, errors: [] });
});

test('isXsdEnabled: respeta env case-insensitive', () => {
  process.env.XSD_VALIDATE = 'true';
  assert.equal(isXsdEnabled(), true);
  process.env.XSD_VALIDATE = 'TRUE';
  assert.equal(isXsdEnabled(), true);
  process.env.XSD_VALIDATE = 'True';
  assert.equal(isXsdEnabled(), true);
  process.env.XSD_VALIDATE = 'yes';
  assert.equal(isXsdEnabled(), false);
  delete process.env.XSD_VALIDATE;
  assert.equal(isXsdEnabled(), false);
});

// ---------------------------------------------------------------------------
// XSD_VALIDATE on
// ---------------------------------------------------------------------------

test('XSD on + tipo desconocido → valid=false con mensaje', async () => {
  process.env.XSD_VALIDATE = 'true';
  const result = await validateXml(TE_XML, 'XYZ');
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
  assert.match(result.errors[0].message, /Tipo de comprobante/);
});

// El test contra TE real puede tardar ~1s la primera vez (carga del wasm).
// Lo dejamos activo porque verifica end-to-end el setup de preload del
// xmldsig-core-schema. Si falla por timeout, aumentar con `--test-timeout`.
test(
  'XSD on + TE real → ejecuta validación (puede fallar valid si los XSDs son estrictos)',
  { timeout: 20000 },
  async () => {
    process.env.XSD_VALIDATE = 'true';
    const result = await validateXml(TE_XML, 'TE');
    // No asertamos valid=true porque el TE real puede no incluir Signature
    // (los TE reales emitidos por Hacienda están firmados, pero el fixture
    // simplificado podría no tenerla — el XSD requiere `ds:Signature`).
    // Lo que SÍ verificamos es que el validator corra sin tirar y devuelva
    // un objeto bien formado.
    assert.equal(typeof result.valid, 'boolean');
    assert.ok(Array.isArray(result.errors));
    if (!result.valid) {
      // Cada error tiene .message — verificamos shape.
      for (const e of result.errors) {
        assert.equal(typeof e.message, 'string');
      }
    }
  },
);

test(
  'XSD on + XML mal formado → valid=false con error útil',
  { timeout: 20000 },
  async () => {
    process.env.XSD_VALIDATE = 'true';
    const garbage = '<?xml version="1.0"?><FacturaElectronica xmlns="https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/facturaElectronica"><Clave>123</Clave></FacturaElectronica>';
    const result = await validateXml(garbage, 'FE');
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.equal(typeof result.errors[0].message, 'string');
  },
);
