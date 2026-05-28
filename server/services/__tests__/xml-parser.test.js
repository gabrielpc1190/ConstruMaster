/**
 * Tests del parser polimórfico de comprobantes electrónicos Hacienda CR v4.4.
 *
 * Corre con: `node --test server/services/__tests__/xml-parser.test.js`
 *
 * Mapea los casos del parser Python original
 * (`ConstruMaster-django-old/apps/facturas/tests/test_xml_parser.py`) +
 * extras del task (DIMEX 12 dígitos, cédula 8 dígitos -> flag warning).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseComprobanteXml,
  XmlSyntaxError,
  UnknownComprobanteError,
  NAMESPACE_MAP,
} from '../xml-parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = join(__dirname, 'fixtures');

const TE_XML = readFileSync(join(FIXTURES, 'te_real.xml'), 'utf8');

// ---------------------------------------------------------------------------
// Caso 1: Tiquete Electrónico real (Materiales La Costa)
// ---------------------------------------------------------------------------
test('parse real Tiquete Electrónico XML', () => {
  const data = parseComprobanteXml(TE_XML);

  // Tipo y campos del root
  assert.equal(data.tipo, 'TE');
  assert.equal(data.claveNumerica, '50604052600310169828000100001040000134414127865041');
  assert.equal(data.numeroConsecutivo, '00100001040000134414');
  assert.ok(data.fechaEmision.startsWith('2026-05-04'));
  assert.equal(data.condicionVenta, '01');

  // Emisor
  assert.equal(data.emisor.nombre, 'MATERIALES LA COSTA, S.A.');
  assert.equal(data.emisor.identificacionTipo, '02');
  assert.equal(data.emisor.identificacion, '3101698280');

  // Receptor (TE puede traer solo Nombre)
  assert.ok(data.receptor);
  assert.equal(data.receptor.nombre, 'ROWLEY NICHOLAS CHARLES');

  // Moneda
  assert.equal(data.moneda, 'CRC');

  // Medio de pago
  assert.ok(Array.isArray(data.medioPago));
  assert.equal(data.medioPago.length, 1);
  assert.equal(data.medioPago[0].tipo, '02');
  assert.equal(data.medioPago[0].monto, '1769.30880');

  // Items
  assert.equal(data.items.length, 1);
  const item = data.items[0];
  assert.equal(item.codigoCabys, '3632098010100');
  assert.equal(item.descripcion, "CODO LISO PVC 90' 38MM SCH40 908580");
  assert.equal(item.cantidad, '1.000');
  assert.equal(item.unidad, 'Unid');
  assert.equal(item.precioUnitario, '1565.76000');
  assert.equal(item.subtotal, '1565.76000');
  assert.equal(item.ivaMonto, '203.54880');

  // Totales
  assert.equal(data.totales.totalComprobante, '1769.30880');
  assert.equal(data.totales.totalImpuesto, '203.54880');
  assert.equal(data.totales.mercGravadas, '1565.76000');
  assert.equal(data.totales.servGravados, '0.00000');
});

// ---------------------------------------------------------------------------
// Caso 2: XML malformado → XmlSyntaxError
// ---------------------------------------------------------------------------
test('malformed XML throws XmlSyntaxError', () => {
  assert.throws(
    () => parseComprobanteXml('<not really xml at all >>><<<'),
    (err) => err instanceof XmlSyntaxError,
  );
});

test('empty string throws XmlSyntaxError', () => {
  assert.throws(
    () => parseComprobanteXml(''),
    (err) => err instanceof XmlSyntaxError,
  );
});

// ---------------------------------------------------------------------------
// Caso 3: Namespace desconocido → UnknownComprobanteError
// ---------------------------------------------------------------------------
test('unknown namespace throws UnknownComprobanteError', () => {
  const fake = `<?xml version="1.0"?>
<UnknownRoot xmlns="https://example.com/unknown">
  <Clave>X</Clave>
</UnknownRoot>`;
  assert.throws(
    () => parseComprobanteXml(fake),
    (err) => err instanceof UnknownComprobanteError,
  );
});

test('no namespace at all throws UnknownComprobanteError', () => {
  const fake = `<?xml version="1.0"?>
<Comprobante>
  <Clave>X</Clave>
</Comprobante>`;
  assert.throws(
    () => parseComprobanteXml(fake),
    (err) => err instanceof UnknownComprobanteError,
  );
});

// ---------------------------------------------------------------------------
// Caso 4: Cédulas válidas e inválidas (warning flag, no throw)
// ---------------------------------------------------------------------------
test('DIMEX 12-digit ID does not flag warning', () => {
  // Construir XML mínimo con cédula DIMEX 12 dígitos
  const xml = buildMinimalTeXml({ emisorId: '123456789012', receptorId: null });
  const data = parseComprobanteXml(xml);
  assert.equal(data.emisor.identificacion, '123456789012');
  assert.equal(data.warnings?.length ?? 0, 0, 'no warnings expected for DIMEX');
});

test('cedula juridica 10-digit ID does not flag warning', () => {
  const xml = buildMinimalTeXml({ emisorId: '3101698280', receptorId: null });
  const data = parseComprobanteXml(xml);
  assert.equal(data.emisor.identificacion, '3101698280');
  assert.equal(data.warnings?.length ?? 0, 0);
});

test('cedula 9-digit ID does not flag warning', () => {
  const xml = buildMinimalTeXml({ emisorId: '110450789', receptorId: null });
  const data = parseComprobanteXml(xml);
  assert.equal(data.warnings?.length ?? 0, 0);
});

test('weird 8-digit ID flags warning', () => {
  // 8 dígitos no matchea ^\d{9,12}$ → warning
  const xml = buildMinimalTeXml({ emisorId: '12345678', receptorId: null });
  const data = parseComprobanteXml(xml);
  assert.equal(data.emisor.identificacion, '12345678');
  assert.ok(
    data.warnings && data.warnings.length > 0,
    'expected at least one warning for 8-digit id',
  );
  assert.ok(
    data.warnings.some((w) => w.includes('emisor') && w.includes('identificacion')),
    `expected emisor identificacion warning, got: ${JSON.stringify(data.warnings)}`,
  );
});

test('alphanumeric ID flags warning', () => {
  const xml = buildMinimalTeXml({ emisorId: 'ABC12345', receptorId: null });
  const data = parseComprobanteXml(xml);
  assert.ok(data.warnings && data.warnings.length > 0);
});

// ---------------------------------------------------------------------------
// Caso 5: NAMESPACE_MAP cubre los 6 tipos
// ---------------------------------------------------------------------------
test('NAMESPACE_MAP covers all 6 comprobante types', () => {
  const tipos = new Set(Object.values(NAMESPACE_MAP));
  assert.deepEqual(tipos, new Set(['FE', 'TE', 'NC', 'ND', 'FEC', 'FEE']));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Construye un XML de Tiquete Electrónico mínimo pero válido sintácticamente,
 * con la cédula que se pase. Sirve para testear validación de cédula sin
 * depender de un XML real diferente.
 */
function buildMinimalTeXml({ emisorId, receptorId }) {
  const receptor = receptorId
    ? `<Receptor><Nombre>RX</Nombre><Identificacion><Tipo>01</Tipo><Numero>${receptorId}</Numero></Identificacion></Receptor>`
    : '<Receptor><Nombre>RX</Nombre></Receptor>';

  return `<?xml version="1.0" encoding="utf-8"?>
<TiqueteElectronico xmlns="https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/tiqueteElectronico">
  <Clave>50604052600310169828000100001040000134414127865041</Clave>
  <NumeroConsecutivo>00100001040000134414</NumeroConsecutivo>
  <FechaEmision>2026-05-04T14:16:06-06:00</FechaEmision>
  <Emisor>
    <Nombre>EMISOR SA</Nombre>
    <Identificacion>
      <Tipo>02</Tipo>
      <Numero>${emisorId}</Numero>
    </Identificacion>
  </Emisor>
  ${receptor}
  <CondicionVenta>01</CondicionVenta>
  <DetalleServicio>
    <LineaDetalle>
      <NumeroLinea>1</NumeroLinea>
      <Cantidad>1.000</Cantidad>
      <UnidadMedida>Unid</UnidadMedida>
      <Detalle>ITEM TEST</Detalle>
      <PrecioUnitario>100.00000</PrecioUnitario>
      <SubTotal>100.00000</SubTotal>
      <MontoTotalLinea>100.00000</MontoTotalLinea>
    </LineaDetalle>
  </DetalleServicio>
  <ResumenFactura>
    <CodigoTipoMoneda>
      <CodigoMoneda>CRC</CodigoMoneda>
      <TipoCambio>1.00</TipoCambio>
    </CodigoTipoMoneda>
    <TotalComprobante>100.00</TotalComprobante>
  </ResumenFactura>
</TiqueteElectronico>`;
}
