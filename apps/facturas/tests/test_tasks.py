"""Tests del task async extract_invoice (Task 8.2).

Verifica fixes críticos #2 y #11 del review externo:
- Errores permanentes (XMLSyntaxError, FacturaExtractionError, OCRError)
  → status='error', return (NO raise) → Django-Q2 NO reintenta
- Errores transitorios (httpx timeout, conexión, 5xx) → SÍ escapan
  para que Q2 reintente hasta max_attempts=3
"""
from datetime import date
from pathlib import Path
from unittest.mock import patch, PropertyMock

import pytest


@pytest.fixture
def oc(db):
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import OrdenCompra
    from djmoney.money import Money
    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    return OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="X-OC-0001", fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(1000, "CRC"), estado="autorizada",
    )


@pytest.fixture
def factura_xml(db, oc, tmp_path):
    """Factura con archivo XML real (de tests/fixtures/te_real.xml)."""
    from django.core.files import File
    from apps.facturas.models import Factura

    # Usar el XML real como source
    real = Path(__file__).parent / "fixtures" / "te_real.xml"
    dst = tmp_path / "te.xml"
    dst.write_bytes(real.read_bytes())

    f = Factura.objects.create(
        oc=oc, source_type="xml",
        archivo_original=str(dst),  # path al archivo
        status="pending",
    )
    return f, dst


def test_extract_invoice_xml_happy_path(factura_xml):
    """XML real válido → status=extracted con data parseada."""
    from apps.facturas.tasks import extract_invoice
    from django.db.models.fields.files import FieldFile
    f, path = factura_xml
    # FileField.path valida contra MEDIA_ROOT y falla para tmp_path.
    # Mockeamos .path en FieldFile + parse_comprobante_xml.
    with patch("apps.facturas.tasks.parse_comprobante_xml") as mock_parse, \
         patch.object(FieldFile, "path", new_callable=PropertyMock,
                      return_value=str(path)):
        mock_parse.return_value = {
            "tipo": "TE",
            "clave": "X" * 50,
            "consecutivo": "00100001040000134414",
            "fecha": "2026-05-04",
            "emisor": {"nombre": "Materiales La Costa"},
            "receptor": None,
            "items": [],
            "resumen": {"moneda": "CRC", "total_comprobante": "1769.31"},
        }
        extract_invoice(f.id)

    f.refresh_from_db()
    assert f.status == "extracted"
    assert f.tipo_comprobante == "TE"
    assert f.extracted_data["clave"] == "X" * 50
    assert f.confidence_score is None  # XML determinista (fix #13)


def test_extract_invoice_xml_syntax_error_no_retry(factura_xml):
    """FIX #2: lxml.etree.XMLSyntaxError → status='error', NO re-lanza."""
    from lxml.etree import XMLSyntaxError
    from apps.facturas.tasks import extract_invoice
    from django.db.models.fields.files import FieldFile

    f, path = factura_xml

    # parse_comprobante_xml normalmente atrapa esto pero por si pasa,
    # asegurarse que el task también lo captura
    with patch("apps.facturas.tasks.parse_comprobante_xml",
               side_effect=XMLSyntaxError("malformed XML", 0, 0, 0)), \
         patch.object(FieldFile, "path", new_callable=PropertyMock,
                      return_value=str(path)):
        # NO debe lanzar — debe retornar limpio con status=error
        extract_invoice(f.id)

    f.refresh_from_db()
    assert f.status == "error"
    assert "malformed" in f.error_message.lower() or "xml" in f.error_message.lower()


def test_extract_invoice_factura_extraction_error_no_retry(factura_xml):
    """FacturaExtractionError → status='error', NO re-lanza (no retry)."""
    from apps.facturas.parsers.xml_parser import FacturaExtractionError
    from apps.facturas.tasks import extract_invoice
    from django.db.models.fields.files import FieldFile

    f, path = factura_xml

    with patch("apps.facturas.tasks.parse_comprobante_xml",
               side_effect=FacturaExtractionError("Versión no soportada: foo")), \
         patch.object(FieldFile, "path", new_callable=PropertyMock,
                      return_value=str(path)):
        extract_invoice(f.id)  # NO raise

    f.refresh_from_db()
    assert f.status == "error"
    assert "no soportada" in f.error_message.lower() or "foo" in f.error_message


def test_extract_invoice_ocr_pdf_happy_path(db, oc):
    """OCR exitoso → extracted con data + confidence."""
    from apps.facturas.models import Factura
    from apps.facturas.tasks import extract_invoice

    f = Factura.objects.create(
        oc=oc, source_type="pdf", archivo_original="dummy.pdf",
        status="pending",
    )

    with patch("apps.facturas.tasks.ocr_invoice_gemini") as mock_ocr:
        mock_ocr.return_value = (
            {"emisor": {"nombre": "X"}, "total": 100, "fecha": "2026-05-25"},
            0.92,
        )
        extract_invoice(f.id)

    f.refresh_from_db()
    assert f.status == "extracted"
    assert f.confidence_score == 0.92
    assert f.extracted_data["total"] == 100


def test_extract_invoice_ocr_error_no_retry(db, oc):
    """OCRError (no API key, etc) → status='error', NO re-lanza."""
    from apps.facturas.models import Factura
    from apps.facturas.parsers.ocr_gemini import OCRError
    from apps.facturas.tasks import extract_invoice

    f = Factura.objects.create(
        oc=oc, source_type="pdf", archivo_original="dummy.pdf",
        status="pending",
    )

    with patch("apps.facturas.tasks.ocr_invoice_gemini",
               side_effect=OCRError("GEMINI_API_KEY missing")):
        extract_invoice(f.id)  # NO raise

    f.refresh_from_db()
    assert f.status == "error"
    assert "gemini" in f.error_message.lower() or "api_key" in f.error_message.lower()


def test_extract_invoice_transient_error_escapes_for_retry(db, oc):
    """FIX #11: errores transitorios (timeout, connection) SÍ escapan."""
    import httpx
    from apps.facturas.models import Factura
    from apps.facturas.tasks import extract_invoice

    f = Factura.objects.create(
        oc=oc, source_type="pdf", archivo_original="dummy.pdf",
        status="pending",
    )

    # Simular timeout — httpx.TimeoutException es transitorio, debe escapar
    with patch("apps.facturas.tasks.ocr_invoice_gemini",
               side_effect=httpx.TimeoutException("API timeout")):
        with pytest.raises(httpx.TimeoutException):
            extract_invoice(f.id)

    # La factura quedó marcada como processing (NO error) para que
    # Django-Q2 reintente
    f.refresh_from_db()
    assert f.status == "processing"


def test_extract_invoice_status_transitions_to_processing(factura_xml):
    """Antes de procesar, status pasa de pending → processing."""
    from apps.facturas.tasks import extract_invoice
    from django.db.models.fields.files import FieldFile

    f, path = factura_xml
    assert f.status == "pending"

    # Mock que verifica el estado en el momento del call
    captured_status = []

    def side_effect(_path):
        # En este punto, el task ya debe haber seteado processing
        f.refresh_from_db()
        captured_status.append(f.status)
        return {
            "tipo": "TE", "clave": "X", "consecutivo": "X", "fecha": "2026-05-04",
            "emisor": {}, "receptor": None, "items": [], "resumen": {"moneda": "CRC"},
        }

    with patch("apps.facturas.tasks.parse_comprobante_xml", side_effect=side_effect), \
         patch.object(FieldFile, "path", new_callable=PropertyMock,
                      return_value=str(path)):
        extract_invoice(f.id)

    assert captured_status == ["processing"]
    f.refresh_from_db()
    assert f.status == "extracted"
