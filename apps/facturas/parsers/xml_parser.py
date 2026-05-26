"""Parser polimórfico de comprobantes electrónicos de Hacienda CR v4.4.

Detecta el tipo por el namespace del root XML y aplica el XSD
correspondiente. Lanza FacturaExtractionError en cualquier error
permanente (no retry — spec §7.3).

Contrato de retorno (spec §7.1, fix #3 del review externo):
    dict con keys exactas:
    - tipo (str): FE | TE | NC | ND | FEC | FEE
    - clave (str alfanumérica)
    - consecutivo (str)
    - fecha (str ISO)
    - emisor (dict)
    - receptor (dict | None) — puede faltar en TE
    - condicion_venta (str código)
    - items (list[dict])
    - resumen (dict)
"""
from pathlib import Path

from lxml import etree


class FacturaExtractionError(Exception):
    """Error permanente extrayendo datos del comprobante (no retry)."""


SCHEMA_DIR = Path(__file__).resolve().parent.parent / "schemas" / "V4.4"

# Mapeo namespace → (tipo, xsd_filename, root_name)
NAMESPACE_MAP = {
    "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/facturaElectronica":
        ("FE", "FacturaElectronica.xsd", "FacturaElectronica"),
    "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/tiqueteElectronico":
        ("TE", "TiqueteElectronico.xsd", "TiqueteElectronico"),
    "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/notaCreditoElectronica":
        ("NC", "NotaCreditoElectronica.xsd", "NotaCreditoElectronica"),
    "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/notaDebitoElectronica":
        ("ND", "NotaDebitoElectronica.xsd", "NotaDebitoElectronica"),
    "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/facturaElectronicaCompra":
        ("FEC", "FacturaElectronicaCompra.xsd", "FacturaElectronicaCompra"),
    "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/facturaElectronicaExportacion":
        ("FEE", "FacturaElectronicaExportacion.xsd", "FacturaElectronicaExportacion"),
}


def _detect_type(root: etree._Element) -> tuple[str, str, str]:
    """Detecta tipo por el namespace del root."""
    tag_ns = etree.QName(root.tag).namespace
    if tag_ns not in NAMESPACE_MAP:
        raise FacturaExtractionError(f"Versión XML no soportada: {tag_ns}")
    return NAMESPACE_MAP[tag_ns]


def _text(node, path, ns, default=None):
    """XPath shortcut con namespace registrado."""
    if node is None:
        return default
    el = node.find(path, namespaces={"x": ns})
    return el.text if el is not None else default


def parse_comprobante_xml(file_path) -> dict:
    """Parsea un comprobante electrónico Hacienda CR v4.4 y devuelve dict canónico.

    Args:
        file_path: ruta al XML (str o Path).

    Returns:
        dict con keys descritas en el module docstring.

    Raises:
        FacturaExtractionError: XML inválido, namespace no soportado, o
            schema validation falló. Se debe tratar como error permanente
            (no retry).
    """
    file_path = str(file_path)

    # 1. Parsear XML
    try:
        tree = etree.parse(file_path)
    except etree.XMLSyntaxError as e:
        raise FacturaExtractionError(f"XML inválido: {e}")

    root = tree.getroot()

    # 2. Detectar tipo por namespace
    tipo, xsd_filename, _ = _detect_type(root)

    # 3. Validar con XSD (si existe)
    xsd_path = SCHEMA_DIR / xsd_filename
    if xsd_path.exists():
        try:
            schema_tree = etree.parse(str(xsd_path))
            schema = etree.XMLSchema(schema_tree)
            schema.assertValid(tree)
        except etree.XMLSchemaParseError as e:
            raise FacturaExtractionError(f"XSD parse error: {e}")
        except etree.DocumentInvalid as e:
            raise FacturaExtractionError(f"XSD: {e}")

    ns = etree.QName(root.tag).namespace
    nsm = {"x": ns}

    # 4. Extraer Emisor
    emisor_el = root.find("x:Emisor", nsm)
    emisor = {
        "nombre": _text(emisor_el, "x:Nombre", ns),
        "identificacion": {
            "tipo": _text(emisor_el, "x:Identificacion/x:Tipo", ns),
            "numero": _text(emisor_el, "x:Identificacion/x:Numero", ns),
        },
    }

    # 5. Extraer Receptor (puede no existir, o tener solo Nombre en TE)
    receptor_el = root.find("x:Receptor", nsm)
    receptor = None
    if receptor_el is not None:
        receptor = {
            "nombre": _text(receptor_el, "x:Nombre", ns),
            "identificacion": {
                "tipo": _text(receptor_el, "x:Identificacion/x:Tipo", ns),
                "numero": _text(receptor_el, "x:Identificacion/x:Numero", ns),
            },
        }

    # 6. Items: DetalleServicio/LineaDetalle
    items = []
    for ln in root.findall("x:DetalleServicio/x:LineaDetalle", nsm):
        items.append({
            "numero_linea": _text(ln, "x:NumeroLinea", ns),
            "codigo_cabys": _text(ln, "x:CodigoCABYS", ns, default=""),
            "cantidad": _text(ln, "x:Cantidad", ns),
            "unidad_medida": _text(ln, "x:UnidadMedida", ns),
            "detalle": _text(ln, "x:Detalle", ns),
            "precio_unitario": _text(ln, "x:PrecioUnitario", ns),
            "subtotal": _text(ln, "x:SubTotal", ns),
            "iva_monto": _text(ln, "x:Impuesto/x:Monto", ns, default="0"),
            "monto_total_linea": _text(ln, "x:MontoTotalLinea", ns),
        })

    # 7. Resumen
    res = root.find("x:ResumenFactura", nsm)
    medios_pago = []
    if res is not None:
        for mp in res.findall("x:MedioPago", nsm):
            medios_pago.append({
                "tipo": _text(mp, "x:TipoMedioPago", ns),
                "monto": _text(mp, "x:TotalMedioPago", ns),
            })

    resumen = {
        "moneda": _text(res, "x:CodigoTipoMoneda/x:CodigoMoneda", ns, default="CRC"),
        "tipo_cambio": _text(res, "x:CodigoTipoMoneda/x:TipoCambio", ns, default="1"),
        "total_gravado": _text(res, "x:TotalGravado", ns),
        "total_impuesto": _text(res, "x:TotalImpuesto", ns, default="0"),
        "total_comprobante": _text(res, "x:TotalComprobante", ns),
        "medios_pago": medios_pago,
    } if res is not None else {}

    return {
        "tipo": tipo,
        "clave": _text(root, "x:Clave", ns),
        "consecutivo": _text(root, "x:NumeroConsecutivo", ns),
        "fecha": _text(root, "x:FechaEmision", ns),
        "emisor": emisor,
        "receptor": receptor,
        "condicion_venta": _text(root, "x:CondicionVenta", ns),
        "items": items,
        "resumen": resumen,
    }
