"""Tests del parser polimórfico de comprobantes electrónicos Hacienda v4.4."""
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


def test_parse_real_tiquete():
    """Parsea el XML real de Tiquete Electrónico (Materiales La Costa)."""
    from apps.facturas.parsers.xml_parser import parse_comprobante_xml

    data = parse_comprobante_xml(FIXTURES / "te_real.xml")

    # Tipo y campos del root
    assert data["tipo"] == "TE"
    assert data["clave"] == "50604052600310169828000100001040000134414127865041"
    assert data["consecutivo"] == "00100001040000134414"
    assert data["fecha"].startswith("2026-05-04")
    assert data["condicion_venta"] == "01"  # contado

    # Emisor
    assert data["emisor"]["nombre"] == "MATERIALES LA COSTA, S.A."
    assert data["emisor"]["identificacion"]["tipo"] == "02"
    assert data["emisor"]["identificacion"]["numero"] == "3101698280"

    # Items
    assert len(data["items"]) == 1
    item = data["items"][0]
    assert item["codigo_cabys"] == "3632098010100"
    assert item["detalle"] == "CODO LISO PVC 90' 38MM SCH40 908580"
    assert item["cantidad"] == "1.000"
    assert item["unidad_medida"] == "Unid"
    assert item["precio_unitario"] == "1565.76000"

    # Resumen
    assert data["resumen"]["moneda"] == "CRC"
    assert "total_comprobante" in data["resumen"]
    assert "medios_pago" in data["resumen"]


def test_parse_unknown_namespace_raises():
    """XML con namespace desconocido (no es v4.4) → FacturaExtractionError."""
    import tempfile
    from apps.facturas.parsers.xml_parser import (
        parse_comprobante_xml, FacturaExtractionError,
    )

    fake = """<?xml version="1.0"?>
<UnknownRoot xmlns="https://example.com/unknown">
  <Clave>X</Clave>
</UnknownRoot>"""

    with tempfile.NamedTemporaryFile(mode="w", suffix=".xml", delete=False) as f:
        f.write(fake)
        path = f.name

    with pytest.raises(FacturaExtractionError, match="no soportada"):
        parse_comprobante_xml(path)


def test_parse_corrupted_xml_raises():
    """XML malformado → FacturaExtractionError (no XMLSyntaxError sin envoltura)."""
    import tempfile
    from apps.facturas.parsers.xml_parser import (
        parse_comprobante_xml, FacturaExtractionError,
    )

    with tempfile.NamedTemporaryFile(mode="w", suffix=".xml", delete=False) as f:
        f.write("<not really xml at all >>><<<")
        path = f.name

    with pytest.raises(FacturaExtractionError, match="XML inválido"):
        parse_comprobante_xml(path)


def test_namespace_map_has_six_types():
    """El mapeo de namespaces debe cubrir los 6 tipos."""
    from apps.facturas.parsers.xml_parser import NAMESPACE_MAP

    tipos = [t for t, _, _ in NAMESPACE_MAP.values()]
    assert set(tipos) == {"FE", "TE", "NC", "ND", "FEC", "FEE"}


def test_te_receptor_can_be_minimal():
    """En Tiquete Electrónico, Receptor solo tiene Nombre (sin Identificacion)."""
    from apps.facturas.parsers.xml_parser import parse_comprobante_xml

    data = parse_comprobante_xml(FIXTURES / "te_real.xml")
    # El XML real tiene Receptor con solo Nombre
    assert data["receptor"] is not None
    assert data["receptor"]["nombre"] == "ROWLEY NICHOLAS CHARLES"
    # Identificacion puede no estar o tener tipo/numero None
    ident = data["receptor"].get("identificacion", {})
    assert ident.get("numero") in (None, "")


def test_xsd_validation_failure_raises():
    """XML válido pero que viola el XSD (campo requerido faltante) → FacturaExtractionError."""
    import tempfile
    from apps.facturas.parsers.xml_parser import (
        parse_comprobante_xml, FacturaExtractionError,
    )

    # XML estructuralmente válido pero sin campos required del XSD
    fake = """<?xml version="1.0" encoding="utf-8"?>
<TiqueteElectronico xmlns="https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/tiqueteElectronico">
  <Clave>00000</Clave>
</TiqueteElectronico>"""

    with tempfile.NamedTemporaryFile(mode="w", suffix=".xml", delete=False) as f:
        f.write(fake)
        path = f.name

    with pytest.raises(FacturaExtractionError):
        parse_comprobante_xml(path)
