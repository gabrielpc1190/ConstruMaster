/**
 * Parser polimórfico de comprobantes electrónicos Hacienda Costa Rica v4.4.
 *
 * Port directo del parser Python original
 * (`ConstruMaster-django-old/apps/facturas/parsers/xml_parser.py`) a Node 22.
 *
 * Detecta el tipo de comprobante por el namespace del element raíz y extrae
 * los campos canónicos comunes + lista de líneas + resumen. Los 6 tipos
 * cubiertos (FE / TE / NC / ND / FEC / FEE) comparten estructura suficiente
 * para una única función polimórfica.
 *
 * Decisiones del review externo aplicadas (fix #3, fix #12):
 *  - Retorna un dict con key `tipo` (canónico).
 *  - El extractor de cédula usa regex `^\d{9,12}$` (cubre física 9, jurídica
 *    10, DIMEX 12). Cualquier formato que no matchee emite un warning en el
 *    output (no throw — permite que el caller decida).
 *
 * Errores:
 *  - `XmlSyntaxError`: XML mal formado.
 *  - `UnknownComprobanteError`: XML válido pero con namespace no reconocido.
 *
 * Ambos son "permanentes" en el sentido del task pipeline original — el
 * caller (futuro `extract_invoice` Node-side) NO debe re-lanzar para que el
 * worker no reintente.
 *
 * TODO: validación XSD. `fast-xml-parser` no valida contra XSD. Si necesitamos
 * validación estricta (campos requeridos por el XSD oficial), evaluar:
 *  - `xsd-schema-validator` (depende de Java runtime, no ideal en Docker).
 *  - Validación ad-hoc en el código (chequeo de presencia de campos clave).
 *  - Mover validación a un job pre-procesamiento separado.
 */

import { XMLParser, XMLValidator } from 'fast-xml-parser';

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class XmlSyntaxError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'XmlSyntaxError';
    if (cause !== undefined) this.cause = cause;
  }
}

export class UnknownComprobanteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnknownComprobanteError';
  }
}

// ---------------------------------------------------------------------------
// Namespace → tipo de comprobante
// ---------------------------------------------------------------------------

/**
 * Mapeo namespace → tipo canónico. Hacienda CR usa `cdn.comprobanteselectronicos.go.cr`
 * (NO `www.hacienda.go.cr` como pone alguna doc vieja).
 */
export const NAMESPACE_MAP = Object.freeze({
  'https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/facturaElectronica': 'FE',
  'https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/tiqueteElectronico': 'TE',
  'https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/notaCreditoElectronica': 'NC',
  'https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/notaDebitoElectronica': 'ND',
  'https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/facturaElectronicaCompra': 'FEC',
  'https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/facturaElectronicaExportacion': 'FEE',
});

/**
 * Mapeo root-element-name → tipo. Backup para el caso en que `xmlns` venga
 * declarado en un prefijo en vez del default — fast-xml-parser no resuelve
 * namespaces, así que también miramos el local name del root.
 */
const ROOT_NAME_MAP = Object.freeze({
  FacturaElectronica: 'FE',
  TiqueteElectronico: 'TE',
  NotaCreditoElectronica: 'NC',
  NotaDebitoElectronica: 'ND',
  FacturaElectronicaCompra: 'FEC',
  FacturaElectronicaExportacion: 'FEE',
});

// ---------------------------------------------------------------------------
// Validación de identificación (fix #12 review externo)
// ---------------------------------------------------------------------------

/** Cubre cédula física (9), jurídica (10), DIMEX (11-12). */
const CEDULA_REGEX = /^\d{9,12}$/;

function validateCedula(numero) {
  if (numero == null || numero === '') return false;
  return CEDULA_REGEX.test(String(numero));
}

// ---------------------------------------------------------------------------
// Helpers de extracción
// ---------------------------------------------------------------------------

/**
 * fast-xml-parser representa text content como string en el campo cuando
 * el nodo es leaf, o como objeto con `#text` cuando tiene atributos.
 * Esto normaliza ambos casos y siempre devuelve string (o `defaultValue`).
 */
function textOf(node, defaultValue = null) {
  if (node == null) return defaultValue;
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return String(node);
  }
  if (typeof node === 'object') {
    if ('#text' in node) {
      const t = node['#text'];
      return t == null ? defaultValue : String(t);
    }
    return defaultValue;
  }
  return defaultValue;
}

/** Asegura que un campo que en el XSD puede ser repetible siempre sea array. */
function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

// ---------------------------------------------------------------------------
// Detección de tipo de comprobante
// ---------------------------------------------------------------------------

/**
 * Dado el objeto root parseado por fast-xml-parser (que es el OBJETO raíz que
 * envuelve al elemento root) devuelve `{ tipo, rootName, rootNode }`.
 *
 * fast-xml-parser, configurado sin `ignoreAttributes`, devuelve el namespace
 * declarado en `xmlns` como un atributo del elemento root: `@_xmlns`.
 */
function detectType(parsed) {
  // El parsed tiene una sola key top-level: el root element name.
  // Puede venir como `TiqueteElectronico` (default ns) o `prefijo:Tiquete...`
  // — descartamos los pseudo-keys que pueda agregar fast-xml-parser.
  const rootKeys = Object.keys(parsed).filter(
    (k) => k !== '?xml' && !k.startsWith('@_'),
  );
  if (rootKeys.length === 0) {
    throw new UnknownComprobanteError('XML sin element root reconocible');
  }
  const rootKey = rootKeys[0];
  const rootNode = parsed[rootKey];

  // 1. Intentar por namespace del xmlns default
  if (rootNode && typeof rootNode === 'object') {
    const ns = rootNode['@_xmlns'];
    if (ns && Object.prototype.hasOwnProperty.call(NAMESPACE_MAP, ns)) {
      return { tipo: NAMESPACE_MAP[ns], rootName: rootKey, rootNode };
    }
  }

  // 2. Fallback: local name del root (sin prefijo)
  const localName = rootKey.includes(':') ? rootKey.split(':').pop() : rootKey;
  if (Object.prototype.hasOwnProperty.call(ROOT_NAME_MAP, localName)) {
    // Solo aceptamos esta ruta si NO había xmlns declarado o si era de Hacienda.
    // Si el xmlns es de otro dominio, no es un comprobante CR.
    const ns = rootNode && typeof rootNode === 'object' ? rootNode['@_xmlns'] : null;
    if (!ns || ns.includes('comprobanteselectronicos.go.cr')) {
      return { tipo: ROOT_NAME_MAP[localName], rootName: rootKey, rootNode };
    }
  }

  throw new UnknownComprobanteError(
    `Namespace o root element no reconocido: ${rootKey}` +
      (rootNode && rootNode['@_xmlns'] ? ` (xmlns=${rootNode['@_xmlns']})` : ''),
  );
}

// ---------------------------------------------------------------------------
// Extractores parciales
// ---------------------------------------------------------------------------

function extractIdentificacion(node) {
  if (!node || typeof node !== 'object') {
    return { tipo: null, numero: null };
  }
  const idNode = node.Identificacion;
  if (!idNode || typeof idNode !== 'object') {
    return { tipo: null, numero: null };
  }
  return {
    tipo: textOf(idNode.Tipo),
    numero: textOf(idNode.Numero),
  };
}

function extractEmisor(rootNode, warnings) {
  const emisorNode = rootNode.Emisor;
  if (!emisorNode || typeof emisorNode !== 'object') {
    warnings.push('emisor missing');
    return { nombre: null, identificacion: null, identificacionTipo: null };
  }
  const { tipo, numero } = extractIdentificacion(emisorNode);
  if (numero != null && !validateCedula(numero)) {
    warnings.push(
      `emisor identificacion "${numero}" no matchea /^\\d{9,12}$/`,
    );
  }
  return {
    nombre: textOf(emisorNode.Nombre),
    identificacion: numero,
    identificacionTipo: tipo,
  };
}

function extractReceptor(rootNode, warnings) {
  const receptorNode = rootNode.Receptor;
  if (!receptorNode || typeof receptorNode !== 'object') {
    return null;
  }
  const { tipo, numero } = extractIdentificacion(receptorNode);
  // En TE el receptor puede traer solo Nombre — no es warning.
  if (numero != null && numero !== '' && !validateCedula(numero)) {
    warnings.push(
      `receptor identificacion "${numero}" no matchea /^\\d{9,12}$/`,
    );
  }
  return {
    nombre: textOf(receptorNode.Nombre),
    identificacion: numero,
    identificacionTipo: tipo,
  };
}

function extractItems(rootNode) {
  const detalle = rootNode.DetalleServicio;
  if (!detalle || typeof detalle !== 'object') return [];
  const lineas = asArray(detalle.LineaDetalle);
  return lineas.map((ln) => {
    // Impuesto puede ser un objeto (1 impuesto) o un array (múltiples).
    // Para el output canónico tomamos el monto total como suma simple.
    const impuestos = asArray(ln.Impuesto);
    let ivaMonto = '0';
    if (impuestos.length === 1) {
      ivaMonto = textOf(impuestos[0].Monto, '0');
    } else if (impuestos.length > 1) {
      // Suma con cuidado de no perder precisión: las cifras vienen como
      // string decimal, las sumamos como Number y devolvemos string fixed-5.
      const total = impuestos.reduce((acc, imp) => {
        const m = parseFloat(textOf(imp.Monto, '0'));
        return acc + (Number.isFinite(m) ? m : 0);
      }, 0);
      ivaMonto = total.toFixed(5);
    }

    return {
      numeroLinea: textOf(ln.NumeroLinea),
      codigoCabys: textOf(ln.CodigoCABYS, ''),
      descripcion: textOf(ln.Detalle),
      cantidad: textOf(ln.Cantidad),
      unidad: textOf(ln.UnidadMedida),
      precioUnitario: textOf(ln.PrecioUnitario),
      subtotal: textOf(ln.SubTotal),
      ivaMonto,
      montoTotalLinea: textOf(ln.MontoTotalLinea),
    };
  });
}

function extractResumen(rootNode) {
  const res = rootNode.ResumenFactura;
  if (!res || typeof res !== 'object') {
    return {
      moneda: 'CRC',
      tipoCambio: '1',
      medioPago: [],
      totales: {},
    };
  }

  // Moneda
  let moneda = 'CRC';
  let tipoCambio = '1';
  const cm = res.CodigoTipoMoneda;
  if (cm && typeof cm === 'object') {
    moneda = textOf(cm.CodigoMoneda, 'CRC');
    tipoCambio = textOf(cm.TipoCambio, '1');
  }

  // Medios de pago (repetible)
  const medioPago = asArray(res.MedioPago).map((mp) => ({
    tipo: textOf(mp.TipoMedioPago),
    monto: textOf(mp.TotalMedioPago),
  }));

  const totales = {
    servGravados: textOf(res.TotalServGravados),
    servExentos: textOf(res.TotalServExentos),
    mercGravadas: textOf(res.TotalMercanciasGravadas),
    mercExentas: textOf(res.TotalMercanciasExentas),
    totalGravado: textOf(res.TotalGravado),
    totalExento: textOf(res.TotalExento),
    totalVenta: textOf(res.TotalVenta),
    totalDescuentos: textOf(res.TotalDescuentos),
    totalVentaNeta: textOf(res.TotalVentaNeta),
    subtotal: textOf(res.TotalVentaNeta), // alias canónico
    totalImpuesto: textOf(res.TotalImpuesto, '0'),
    totalIvaDevuelto: textOf(res.TotalIVADevuelto),
    totalOtrosCargos: textOf(res.TotalOtrosCargos),
    totalComprobante: textOf(res.TotalComprobante),
  };

  return { moneda, tipoCambio, medioPago, totales };
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * Parsea un comprobante electrónico Hacienda CR v4.4 (XML) y devuelve un
 * objeto canónico.
 *
 * @param {string} xmlString — contenido XML completo.
 * @returns {{
 *   tipo: 'FE'|'TE'|'NC'|'ND'|'FEC'|'FEE',
 *   claveNumerica: string|null,
 *   numeroConsecutivo: string|null,
 *   fechaEmision: string|null,
 *   emisor: { nombre: string|null, identificacion: string|null, identificacionTipo: string|null },
 *   receptor: { nombre: string|null, identificacion: string|null, identificacionTipo: string|null } | null,
 *   condicionVenta: string|null,
 *   medioPago: Array<{ tipo: string|null, monto: string|null }>,
 *   moneda: string,
 *   tipoCambio: string,
 *   totales: object,
 *   items: Array<object>,
 *   warnings: string[],
 * }}
 *
 * @throws {XmlSyntaxError}            XML mal formado.
 * @throws {UnknownComprobanteError}   namespace / root element no reconocido.
 */
export function parseComprobanteXml(xmlString) {
  if (typeof xmlString !== 'string') {
    throw new XmlSyntaxError(
      `xmlString must be a string, got ${typeof xmlString}`,
    );
  }
  if (xmlString.length === 0) {
    throw new XmlSyntaxError('xmlString is empty');
  }

  // 1. Validar sintaxis primero. fast-xml-parser tolera XML mal formado en
  //    muchos casos (por defecto). XMLValidator es estricto.
  const validation = XMLValidator.validate(xmlString, {
    allowBooleanAttributes: true,
  });
  if (validation !== true) {
    // validation es { err: { code, msg, line, col } }
    const err = validation && validation.err;
    const msg = err
      ? `XML inválido [${err.code}] línea ${err.line}: ${err.msg}`
      : 'XML inválido';
    throw new XmlSyntaxError(msg);
  }

  // 2. Parsear
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false, // mantenemos números como string (precisión Decimal)
    parseAttributeValue: false,
    trimValues: true,
    // Mantener el texto en `#text` cuando el nodo tiene atributos
    textNodeName: '#text',
    // No transformar nombres de tags — los necesitamos exactos
    removeNSPrefix: false,
  });

  let parsed;
  try {
    parsed = parser.parse(xmlString);
  } catch (e) {
    throw new XmlSyntaxError(`fast-xml-parser falló: ${e.message}`, e);
  }

  // 3. Detectar tipo por namespace
  const { tipo, rootNode } = detectType(parsed);

  // 4. Extraer campos
  const warnings = [];
  const emisor = extractEmisor(rootNode, warnings);
  const receptor = extractReceptor(rootNode, warnings);
  const items = extractItems(rootNode);
  const { moneda, tipoCambio, medioPago, totales } = extractResumen(rootNode);

  return {
    tipo,
    claveNumerica: textOf(rootNode.Clave),
    numeroConsecutivo: textOf(rootNode.NumeroConsecutivo),
    fechaEmision: textOf(rootNode.FechaEmision),
    emisor,
    receptor,
    condicionVenta: textOf(rootNode.CondicionVenta),
    medioPago,
    moneda,
    tipoCambio,
    totales,
    items,
    warnings,
  };
}
