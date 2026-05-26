"""OCR de facturas no-electrónicas via Gemini Flash-Lite con structured output.

Spec §7.2: modelo default `gemini-3.1-flash-lite` (preview, override por
env var OCR_MODEL para fallback a `gemini-2.5-flash-lite` stable).

Costo aproximado: ~$0.30/mes para 900 facturas/mes (Flash-Lite). Datos
salen a Google API.
"""
import json
import re
from pathlib import Path

from django.conf import settings
from google import genai
from google.genai import types


# JSON Schema constrained output (spec §7.2, fix #12 regex DIMEX)
INVOICE_SCHEMA = {
    "type": "object",
    "properties": {
        "emisor": {
            "type": "object",
            "properties": {
                "nombre": {"type": "string"},
                "identificacion": {"type": "string"},
            },
            "required": ["nombre"],
        },
        "consecutivo": {"type": "string"},
        "clave": {"type": "string"},
        "fecha": {"type": "string", "format": "date"},
        "moneda": {"type": "string", "enum": ["CRC", "USD"]},
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "descripcion": {"type": "string"},
                    "cantidad": {"type": "number"},
                    "unidad": {"type": "string"},
                    "precio_unitario": {"type": "number"},
                    "subtotal": {"type": "number"},
                    "iva": {"type": "number"},
                },
                "required": ["descripcion"],
            },
        },
        "subtotal": {"type": "number"},
        "iva": {"type": "number"},
        "total": {"type": "number"},
        "confianza": {"type": "number", "minimum": 0, "maximum": 1},
    },
    "required": ["emisor", "fecha", "total"],
}

PROMPT = """Extraé los datos de esta factura costarricense.
Si un campo no es legible, dejalo vacío en lugar de inventar.
Reportá tu confianza self-assessment (0.0-1.0) en el campo "confianza".
La moneda es CRC (colones costarricenses) o USD (dólares).
La cédula del emisor puede ser jurídica CR (10 dígitos), física CR (9 dígitos),
o DIMEX (11-12 dígitos para residentes extranjeros).
"""


# Cédula CR jurídica/física/DIMEX: 9-12 dígitos (fix #12 del review externo)
CEDULA_REGEX = re.compile(r"^\d{9,12}$")


class OCRError(Exception):
    """Error en proceso OCR (config faltante, network, etc)."""


def ocr_invoice_gemini(file_path: str) -> tuple[dict, float]:
    """OCR de una factura (PDF/imagen) via Gemini Flash-Lite.

    Args:
        file_path: ruta absoluta al archivo (PDF/JPG/PNG/WebP/HEIC).

    Returns:
        (extracted_data dict, confidence float).

        `extracted_data` puede contener `_warnings` (list[str]) con
        validaciones blandas que pasaron (cédula no estándar, total <= 0,
        etc). Estas no impiden el resultado — el supervisor las revisa
        al confirmar.

    Raises:
        OCRError: GEMINI_API_KEY no configurado, error parseando JSON
            de respuesta, error de red de Gemini.
    """
    if not settings.GEMINI_API_KEY:
        raise OCRError("GEMINI_API_KEY no configurado en settings")

    client = genai.Client(api_key=settings.GEMINI_API_KEY)

    path = Path(file_path)
    mime_type = {
        ".pdf": "application/pdf",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".heic": "image/heic",
    }.get(path.suffix.lower(), "application/octet-stream")

    file_bytes = path.read_bytes()

    try:
        response = client.models.generate_content(
            model=settings.OCR_MODEL,
            contents=[
                types.Part.from_bytes(data=file_bytes, mime_type=mime_type),
                PROMPT,
            ],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=INVOICE_SCHEMA,
                temperature=0,
            ),
        )
    except Exception as e:
        raise OCRError(f"Gemini API error: {e}") from e

    try:
        data = json.loads(response.text)
    except (ValueError, TypeError) as e:
        raise OCRError(f"Respuesta no parseable como JSON: {e}") from e

    confidence = float(data.pop("confianza", 0.0))

    # Validaciones blandas (no levantan; agregan _warnings)
    warnings = []

    # Total > 0
    if data.get("total", 0) <= 0:
        warnings.append("total inválido (<=0)")

    # Cédula CR/DIMEX
    ced = (data.get("emisor") or {}).get("identificacion", "")
    if ced and not CEDULA_REGEX.match(str(ced)):
        warnings.append(
            f"cédula no matchea regex 9-12 dígitos (CR física/jurídica/DIMEX): {ced}"
        )

    if warnings:
        data["_warnings"] = warnings

    return data, confidence
