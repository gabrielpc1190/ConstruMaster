"""Tests de OCR Gemini Flash-Lite con mocks."""
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest


def test_ocr_invoice_happy_path(settings, tmp_path):
    """Gemini retorna JSON conforme al schema → (data, confidence)."""
    from apps.facturas.parsers.ocr_gemini import ocr_invoice_gemini

    settings.GEMINI_API_KEY = "fake-key"

    # Crear un PDF dummy (no se lee porque el cliente está mockeado)
    fake_pdf = tmp_path / "factura.pdf"
    fake_pdf.write_bytes(b"%PDF-1.4 dummy content")

    mock_response = MagicMock()
    mock_response.text = """
    {
      "emisor": {"nombre": "Materiales La Costa", "identificacion": "3101698280"},
      "consecutivo": "00100001040000134414",
      "clave": "50604052600310169828000100001040000134414127865041",
      "fecha": "2026-05-04",
      "moneda": "CRC",
      "items": [
        {
          "descripcion": "CODO LISO PVC 90' 38MM",
          "cantidad": 1,
          "unidad": "Unid",
          "precio_unitario": 1565.76,
          "subtotal": 1565.76,
          "iva": 203.55
        }
      ],
      "subtotal": 1565.76,
      "iva": 203.55,
      "total": 1769.31,
      "confianza": 0.92
    }
    """

    mock_client = MagicMock()
    mock_client.models.generate_content.return_value = mock_response

    with patch("apps.facturas.parsers.ocr_gemini.genai.Client",
               return_value=mock_client):
        data, confidence = ocr_invoice_gemini(str(fake_pdf))

    assert data["emisor"]["nombre"] == "Materiales La Costa"
    assert data["emisor"]["identificacion"] == "3101698280"
    assert data["total"] == 1769.31
    assert len(data["items"]) == 1
    assert confidence == 0.92
    # confianza NO debe estar en data (es separado)
    assert "confianza" not in data


def test_ocr_no_api_key_raises(settings, tmp_path):
    """Sin GEMINI_API_KEY configurada → OCRError."""
    from apps.facturas.parsers.ocr_gemini import ocr_invoice_gemini, OCRError

    settings.GEMINI_API_KEY = ""
    fake = tmp_path / "f.pdf"
    fake.write_bytes(b"x")

    with pytest.raises(OCRError, match="GEMINI_API_KEY"):
        ocr_invoice_gemini(str(fake))


def test_ocr_validates_cedula_warning(settings, tmp_path):
    """Cédula que no matchea regex ^\\d{9,12}$ → warning en _warnings."""
    from apps.facturas.parsers.ocr_gemini import ocr_invoice_gemini

    settings.GEMINI_API_KEY = "fake"

    fake = tmp_path / "f.pdf"
    fake.write_bytes(b"x")

    mock_response = MagicMock()
    mock_response.text = """
    {
      "emisor": {"nombre": "X", "identificacion": "INVALID-CED"},
      "fecha": "2026-05-25",
      "moneda": "CRC",
      "total": 100,
      "items": [],
      "confianza": 0.5
    }
    """
    mock_client = MagicMock()
    mock_client.models.generate_content.return_value = mock_response

    with patch("apps.facturas.parsers.ocr_gemini.genai.Client",
               return_value=mock_client):
        data, _ = ocr_invoice_gemini(str(fake))

    assert "_warnings" in data
    assert any("cédula" in w.lower() for w in data["_warnings"])


def test_ocr_validates_cedula_dimex_accepted(settings, tmp_path):
    """Cédula DIMEX (12 dígitos) NO genera warning — fix del review."""
    from apps.facturas.parsers.ocr_gemini import ocr_invoice_gemini

    settings.GEMINI_API_KEY = "fake"
    fake = tmp_path / "f.pdf"
    fake.write_bytes(b"x")

    mock_response = MagicMock()
    mock_response.text = """
    {
      "emisor": {"nombre": "Extranjero", "identificacion": "123456789012"},
      "fecha": "2026-05-25",
      "moneda": "CRC",
      "total": 100,
      "items": [],
      "confianza": 0.9
    }
    """
    mock_client = MagicMock()
    mock_client.models.generate_content.return_value = mock_response

    with patch("apps.facturas.parsers.ocr_gemini.genai.Client",
               return_value=mock_client):
        data, _ = ocr_invoice_gemini(str(fake))

    # DIMEX 12 dígitos NO debe disparar warning
    warnings = data.get("_warnings", [])
    cedula_warnings = [w for w in warnings if "cédula" in w.lower()]
    assert len(cedula_warnings) == 0


def test_ocr_validates_total_zero_warning(settings, tmp_path):
    """Total <= 0 → warning."""
    from apps.facturas.parsers.ocr_gemini import ocr_invoice_gemini

    settings.GEMINI_API_KEY = "fake"
    fake = tmp_path / "f.pdf"
    fake.write_bytes(b"x")

    mock_response = MagicMock()
    mock_response.text = """
    {
      "emisor": {"nombre": "X", "identificacion": "3101000001"},
      "fecha": "2026-05-25",
      "moneda": "CRC",
      "total": 0,
      "items": [],
      "confianza": 0.3
    }
    """
    mock_client = MagicMock()
    mock_client.models.generate_content.return_value = mock_response

    with patch("apps.facturas.parsers.ocr_gemini.genai.Client",
               return_value=mock_client):
        data, _ = ocr_invoice_gemini(str(fake))

    assert "_warnings" in data
    assert any("total" in w.lower() for w in data["_warnings"])


def test_ocr_uses_settings_model(settings, tmp_path):
    """Gemini se invoca con settings.OCR_MODEL."""
    from apps.facturas.parsers.ocr_gemini import ocr_invoice_gemini

    settings.GEMINI_API_KEY = "fake"
    settings.OCR_MODEL = "gemini-2.5-flash-lite"  # cambiar para verificar
    fake = tmp_path / "f.pdf"
    fake.write_bytes(b"x")

    mock_response = MagicMock()
    mock_response.text = '{"emisor":{"nombre":"X","identificacion":"3101000001"},"fecha":"2026-05-25","moneda":"CRC","total":100,"items":[],"confianza":0.5}'
    mock_client = MagicMock()
    mock_client.models.generate_content.return_value = mock_response

    with patch("apps.facturas.parsers.ocr_gemini.genai.Client",
               return_value=mock_client):
        ocr_invoice_gemini(str(fake))

    # Verificar que el cliente recibió el model correcto
    call_args = mock_client.models.generate_content.call_args
    assert call_args.kwargs.get("model") == "gemini-2.5-flash-lite"
