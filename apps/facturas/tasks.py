"""Tasks async para apps.facturas.

extract_invoice maneja el ciclo upload → procesado de comprobantes:
- XML: parser determinista lxml + XSD (spec §7.1)
- PDF/imagen: OCR Gemini Flash-Lite (spec §7.2)

Manejo de errores per spec §7.3 + fixes #2 y #11 del review externo:

- Errores permanentes (XML corrupto, schema desconocido, OCR API key
  faltante): set status='error', return (NO raise). Django-Q2 NO
  reintenta porque no escapa la excepción de la task.

- Errores transitorios (httpx timeout, conexión, 5xx Gemini): NO
  atrapar — dejar que escapen para que Django-Q2 los reintente
  según max_attempts del Q_CLUSTER (default 3).
"""
import logging

from lxml.etree import XMLSyntaxError

from .models import Factura
from .parsers.xml_parser import parse_comprobante_xml, FacturaExtractionError
from .parsers.ocr_gemini import ocr_invoice_gemini, OCRError

logger = logging.getLogger("construmaster.facturas.tasks")


def extract_invoice(factura_id: int) -> None:
    """Procesa una Factura subida: parsea XML o invoca OCR Gemini.

    Args:
        factura_id: PK de la Factura en estado pending.

    Returns:
        None. Side effect: actualiza la Factura en BD.

    Error handling (fixes #2 + #11):
        - FacturaExtractionError, XMLSyntaxError, OCRError → status='error'
          + return (sin re-raise) → Django-Q2 NO reintenta
        - httpx errors, OS errors transitorios → NO atrapados, escapan
          para que Django-Q2 reintente

    No re-lanza errores permanentes para evitar el bug del spec original
    documentado en el review externo (fix #2 + #11).
    """
    f = Factura.objects.get(id=factura_id)
    f.status = "processing"
    f.save(update_fields=["status"])

    try:
        if f.source_type == "xml":
            # Parser determinista
            data = parse_comprobante_xml(f.archivo_original.path)
            f.tipo_comprobante = data.get("tipo", "")
            f.extracted_data = data
            f.confidence_score = None  # XML determinista (fix #13 del review)
        else:
            # OCR Gemini para PDF/imagen
            data, confidence = ocr_invoice_gemini(f.archivo_original.path)
            f.extracted_data = data
            f.confidence_score = confidence

        f.status = "extracted"
        f.save()
        logger.info(f"Factura {factura_id} extracted via {f.source_type}")

    except (FacturaExtractionError, XMLSyntaxError, OCRError) as e:
        # Errores PERMANENTES: archivo corrupto, schema desconocido,
        # OCR no configurado. NO re-lanzamos — Django-Q2 atrapa cualquier
        # excepción que escape y la reintenta según max_attempts.
        logger.warning(
            f"Factura {factura_id} extraction failed permanently: {e}"
        )
        f.status = "error"
        f.error_message = str(e)
        f.save(update_fields=["status", "error_message"])
        return  # NO raise

    # Cualquier otra excepción (httpx.HTTPError, TimeoutError, OSError
    # transitorio, etc.) escapa naturalmente. Django-Q2 la reintenta.
