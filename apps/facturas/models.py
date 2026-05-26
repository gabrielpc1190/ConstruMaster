"""Modelo Factura: comprobantes electrónicos (FE/TE/NC/ND/FEC/FEE) o
facturas físicas (PDF/imagen) con workflow extracted → confirmed.

Diseñado para que un solo modelo soporte ambos flujos: parser XML
determinista y OCR Gemini para no-electrónicas (spec §4.3, §6.6, §6.7).
"""
import uuid

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import models
from djmoney.models.fields import MoneyField

from apps.core.models import TimestampedModel
from apps.compras.models import OrdenCompra


def factura_upload_path(instance, filename):
    """Layout: obras/<obra_id>-<slug>/ordenes_compra/<oc_id>-<numero_oc>/facturas/<id>-<hash>.<ext>"""
    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else "bin"
    short = uuid.uuid4().hex[:8]
    obra = instance.oc.obra
    return (
        f"obras/{obra.pk}-{obra.slug}/ordenes_compra/"
        f"{instance.oc.pk}-{instance.oc.numero_oc}/facturas/"
        f"{instance.pk or 'tmp'}-{short}.{suffix}"
    )


class Factura(TimestampedModel):
    """Comprobante electrónico (FE/TE/NC/ND/FEC/FEE) o factura física.

    Workflow:
      1. pending (upload inicial)
      2. processing (worker async corriendo)
      3. extracted (parser/OCR completó; supervisor debe revisar)
      4. confirmed (supervisor revisó y aceptó; campos canónicos llenos)
      5. error (parsing/OCR falló — error permanente, no retry)
    """

    SOURCE_TYPE_CHOICES = [
        ("xml", "XML"),
        ("pdf", "PDF"),
        ("imagen", "Imagen"),
    ]
    TIPO_CHOICES = [
        ("FE", "Factura Electrónica"),
        ("TE", "Tiquete Electrónico"),
        ("NC", "Nota de Crédito"),
        ("ND", "Nota de Débito"),
        ("FEC", "Factura Electrónica de Compra"),
        ("FEE", "Factura Electrónica de Exportación"),
    ]
    STATUS_CHOICES = [
        ("pending", "Pendiente"),
        ("processing", "Procesando"),
        ("extracted", "Extraída"),
        ("confirmed", "Confirmada"),
        ("error", "Error"),
    ]

    oc = models.ForeignKey(
        OrdenCompra, on_delete=models.PROTECT, related_name="facturas",
    )
    source_type = models.CharField(max_length=10, choices=SOURCE_TYPE_CHOICES)
    tipo_comprobante = models.CharField(
        max_length=5, choices=TIPO_CHOICES, blank=True,
    )
    archivo_original = models.FileField(upload_to=factura_upload_path)
    status = models.CharField(
        max_length=20, choices=STATUS_CHOICES, default="pending",
    )

    # Datos crudos del parser XML o OCR Gemini
    extracted_data = models.JSONField(default=dict, blank=True)
    confidence_score = models.FloatField(null=True, blank=True)

    # Campos canónicos (promovidos al confirmar)
    clave_numerica = models.CharField(
        max_length=50, blank=True, db_index=True,
        help_text="Alfanumérica en v4.4 (no integer).",
    )
    numero_consecutivo = models.CharField(max_length=80, blank=True)
    fecha_emision = models.DateField(null=True, blank=True)
    monto_total = MoneyField(
        max_digits=14, decimal_places=2,
        null=True, blank=True, default_currency="CRC",
    )
    condicion_venta = models.CharField(max_length=2, blank=True)
    medios_pago = models.JSONField(default=list, blank=True)

    # Snapshots fx_rate (al confirmar si moneda != CRC)
    fx_rate_applied = models.DecimalField(
        max_digits=12, decimal_places=5, null=True, blank=True,
    )
    fx_rate_date = models.DateField(null=True, blank=True)

    confirmada_por = models.ForeignKey(
        get_user_model(), null=True, blank=True,
        on_delete=models.PROTECT, related_name="facturas_confirmadas",
    )
    error_message = models.TextField(blank=True)
    notas = models.TextField(blank=True)

    class Meta:
        verbose_name = "Factura"
        verbose_name_plural = "Facturas"
        ordering = ["-created_at"]
        permissions = [
            ("confirm_factura", "Puede confirmar una Factura extraída"),
        ]
        constraints = [
            # UNIQUE clave_numerica solo si no vacía (Hacienda exige uniqueness
            # del Comprobante Electrónico — la clave es única por sistema-emisor-
            # tipo-consecutivo). Excluímos vacía para permitir múltiples Facturas
            # pre-parseo.
            models.UniqueConstraint(
                fields=["clave_numerica"],
                name="factura_clave_unique",
                condition=~models.Q(clave_numerica=""),
            ),
        ]

    def __str__(self):
        if self.clave_numerica:
            return f"Factura {self.clave_numerica[:10]}... ({self.get_status_display()})"
        return f"Factura {self.pk} ({self.get_status_display()})"
