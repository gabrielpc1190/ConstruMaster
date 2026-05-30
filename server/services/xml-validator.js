/**
 * Validación XSD opt-in para comprobantes electrónicos Hacienda CR v4.4.
 *
 * Backend: `xmllint-wasm` — libxml2 compilado a WebAssembly. NO requiere
 * compilar bindings nativos (libxmljs2 sí), zero-dep en el host.
 *
 * Opt-in via env `XSD_VALIDATE=true`. Default OFF: `validateXml` retorna
 * `{ valid: true, errors: [] }` sin abrir ni leer schemas. Esto preserva el
 * comportamiento histórico (parser solo, sin validación XSD).
 *
 * XSDs:
 *  - Viven en `server/schemas/V4.4/*.xsd` (copiados de los specs públicos de
 *    Hacienda v4.4).
 *  - El xmldsig-core-schema.xsd vive en `server/schemas/xmldsig-core-schema.xsd`
 *    porque los XSDs lo importan con `schemaLocation="../../xmldsig-core-schema.xsd"`.
 *    A xmllint-wasm le da igual el path real — lo precargamos vía `preload`
 *    matcheando el `fileName` esperado.
 *
 * Schemas se cargan **lazy + cache en memoria** la primera vez que se valida
 * cada tipo. Esto evita leer el filesystem en el startup cuando XSD_VALIDATE
 * está off.
 *
 * NOTA: xmllint-wasm corre en un Worker thread propio (los exit() del wasm no
 * tumban el proceso host). Esto agrega ~100-300ms de overhead al primer call;
 * sucesivos calls reutilizan la worker pool interna del package.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMAS_DIR = resolve(__dirname, '..', 'schemas');

// Mapa tipo comprobante → nombre de archivo XSD principal.
const XSD_BY_TIPO = Object.freeze({
  FE: 'FacturaElectronica.xsd',
  TE: 'TiqueteElectronico.xsd',
  NC: 'NotaCreditoElectronica.xsd',
  ND: 'NotaDebitoElectronica.xsd',
  FEC: 'FacturaElectronicaCompra.xsd',
  FEE: 'FacturaElectronicaExportacion.xsd',
});

// Cache de schemas cargados (key = tipo). Value = { schema: string, preload: [{fileName, contents}] }
const schemaCache = new Map();

// Cache lazy del módulo xmllint-wasm (import dinámico para evitar cargar el
// wasm cuando XSD_VALIDATE=false).
let xmllintModule = null;

async function getXmllint() {
  if (xmllintModule) return xmllintModule;
  const mod = await import('xmllint-wasm');
  // El package exporta `default` en algunos entornos y named en otros — handle both.
  xmllintModule = mod.validateXML ? mod : mod.default;
  return xmllintModule;
}

/**
 * Carga (con cache) el XSD principal + el xmldsig-core-schema (dependencia
 * común de todos los comprobantes).
 */
async function loadSchemaFor(tipo) {
  if (schemaCache.has(tipo)) return schemaCache.get(tipo);

  const filename = XSD_BY_TIPO[tipo];
  if (!filename) {
    throw new Error(`XSD desconocido para tipo de comprobante "${tipo}"`);
  }

  const [main, dsig] = await Promise.all([
    readFile(resolve(SCHEMAS_DIR, 'V4.4', filename), 'utf8'),
    readFile(resolve(SCHEMAS_DIR, 'xmldsig-core-schema.xsd'), 'utf8'),
  ]);

  // El XSD principal hace `<xs:import ... schemaLocation="../../xmldsig-core-schema.xsd"/>`.
  // xmllint-wasm matchea preload por `fileName` exacto (string que aparece en
  // el schemaLocation, sin la barra inicial). Pasamos ambos paths posibles para
  // robustez.
  const entry = {
    schema: main,
    preload: [
      { fileName: '../../xmldsig-core-schema.xsd', contents: dsig },
      { fileName: 'xmldsig-core-schema.xsd', contents: dsig },
    ],
  };
  schemaCache.set(tipo, entry);
  return entry;
}

/**
 * True si XSD_VALIDATE=true (case-insensitive). Cualquier otro valor → false.
 */
export function isXsdEnabled() {
  const v = process.env.XSD_VALIDATE;
  return typeof v === 'string' && v.toLowerCase() === 'true';
}

/**
 * Valida un XML contra el XSD oficial de Hacienda v4.4 para el tipo dado.
 *
 * @param {string} xmlString — contenido XML.
 * @param {'FE'|'TE'|'NC'|'ND'|'FEC'|'FEE'} comprobanteType — tipo detectado.
 * @returns {Promise<{valid: boolean, errors: Array<{line?: number, message: string}>}>}
 *
 * Si XSD_VALIDATE no está `true`, retorna `{valid: true, errors: []}` sin
 * trabajo (no-op).
 *
 * Si el schema no existe para el tipo (raro), retorna `{valid: false}` con un
 * error explicando.
 */
export async function validateXml(xmlString, comprobanteType) {
  if (!isXsdEnabled()) {
    return { valid: true, errors: [] };
  }
  if (!comprobanteType || !XSD_BY_TIPO[comprobanteType]) {
    return {
      valid: false,
      errors: [
        {
          message: `Tipo de comprobante inválido o no soportado para XSD: "${comprobanteType}"`,
        },
      ],
    };
  }

  const xmllint = await getXmllint();
  const { schema, preload } = await loadSchemaFor(comprobanteType);

  let result;
  try {
    result = await xmllint.validateXML({
      xml: [{ fileName: 'comprobante.xml', contents: xmlString }],
      schema: [schema],
      preload,
    });
  } catch (err) {
    return {
      valid: false,
      errors: [{ message: `XSD runtime error: ${err.message}` }],
    };
  }

  if (result.valid) return { valid: true, errors: [] };

  // xmllint-wasm devuelve errors como array de strings o objetos. Normalizamos.
  const errors = (result.errors || []).map((e) => {
    if (typeof e === 'string') {
      // Formato típico: "comprobante.xml:42: element ...: Schemas validity error : ..."
      const match = e.match(/:(\d+):/);
      return {
        line: match ? Number(match[1]) : undefined,
        message: e,
      };
    }
    return {
      line: typeof e.loc?.line === 'number' ? e.loc.line : undefined,
      message: e.message || String(e),
    };
  });

  return { valid: false, errors };
}

/**
 * Limpia el cache de schemas. Útil para tests que cambian el filesystem.
 */
export function _resetSchemaCache() {
  schemaCache.clear();
}
