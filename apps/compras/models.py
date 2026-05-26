"""Modelos del módulo compras: RFQ, Cotización, items.

OrdenCompra, Pago, Hito se agregan en Fases 4-5.
"""
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db import models
from djmoney.models.fields import MoneyField

from apps.core.models import TimestampedModel, Obra, CategoriaPresupuesto
from apps.catalogo.models import Proveedor, ItemCatalogo


def cotizacion_upload_path(instance, filename):
    """Layout por obra: obras/<obra_id>-<slug>/cotizaciones/<id>-<hash>.<ext>"""
    import uuid
    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else "bin"
    short = uuid.uuid4().hex[:8]
    obra = instance.obra
    return f"obras/{obra.pk}-{obra.slug}/cotizaciones/{instance.pk or 'tmp'}-{short}.{suffix}"


class SolicitudCotizacion(TimestampedModel):
    ESTADO_CHOICES = [
        ("abierta", "Abierta"),
        ("cerrada", "Cerrada"),
        ("cancelada", "Cancelada"),
    ]

    obra = models.ForeignKey(Obra, on_delete=models.PROTECT, related_name="rfqs")
    categoria = models.ForeignKey(CategoriaPresupuesto, on_delete=models.PROTECT)
    descripcion = models.TextField()
    fecha_requerida = models.DateField(null=True, blank=True)
    creada_por = models.ForeignKey(
        get_user_model(), on_delete=models.PROTECT,
        related_name="rfqs_creadas",
    )
    estado = models.CharField(max_length=20, choices=ESTADO_CHOICES, default="abierta")
    es_especial = models.BooleanField(default=False)
    notas = models.TextField(blank=True)

    class Meta:
        verbose_name = "Solicitud de cotización"
        verbose_name_plural = "Solicitudes de cotización"
        ordering = ["-created_at"]

    def __str__(self):
        return f"RFQ-{self.pk} ({self.obra.nombre})"


class Cotizacion(TimestampedModel):
    ESTADO_CHOICES = [
        ("recibida", "Recibida"),
        ("en_revision", "En revisión"),
        ("aprobada", "Aprobada"),
        ("rechazada", "Rechazada"),
        ("vencida", "Vencida"),
    ]
    MONEDA_CHOICES = [("CRC", "Colones"), ("USD", "Dólares")]

    obra = models.ForeignKey(Obra, on_delete=models.PROTECT, related_name="cotizaciones")
    proveedor = models.ForeignKey(Proveedor, on_delete=models.PROTECT)
    rfq = models.ForeignKey(
        SolicitudCotizacion, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="cotizaciones",
    )
    numero_cotizacion = models.CharField(max_length=80)
    fecha = models.DateField()
    fecha_validez = models.DateField(null=True, blank=True)
    moneda = models.CharField(max_length=3, choices=MONEDA_CHOICES, default="CRC")
    subtotal = MoneyField(max_digits=14, decimal_places=2, default_currency="CRC")
    iva = MoneyField(max_digits=14, decimal_places=2, default_currency="CRC")
    total = MoneyField(max_digits=14, decimal_places=2, default_currency="CRC")
    condiciones_pago = models.CharField(max_length=200, blank=True)
    plazo_entrega_dias = models.PositiveIntegerField(null=True, blank=True)
    pct_anticipo = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    archivo = models.FileField(upload_to=cotizacion_upload_path, null=True, blank=True)
    es_especial = models.BooleanField(default=False)
    estado = models.CharField(max_length=20, choices=ESTADO_CHOICES, default="recibida")
    notas = models.TextField(blank=True)

    class Meta:
        verbose_name = "Cotización"
        verbose_name_plural = "Cotizaciones"
        ordering = ["-fecha", "-pk"]
        permissions = [
            ("approve_cotizacion", "Puede aprobar Cotizacion → crear OrdenCompra"),
        ]

    def __str__(self):
        return f"Cot {self.numero_cotizacion} ({self.proveedor.nombre})"


class CotizacionItem(models.Model):
    cotizacion = models.ForeignKey(
        Cotizacion, on_delete=models.CASCADE, related_name="items",
    )
    material = models.ForeignKey(
        ItemCatalogo, null=True, blank=True, on_delete=models.SET_NULL,
    )
    descripcion = models.CharField(max_length=300)
    cantidad = models.DecimalField(max_digits=12, decimal_places=4)
    unidad = models.CharField(max_length=20)
    precio_unitario = models.DecimalField(max_digits=14, decimal_places=5)
    subtotal = models.DecimalField(max_digits=14, decimal_places=2)
    iva_monto = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    codigo_cabys = models.CharField(max_length=13, blank=True)
    orden = models.PositiveIntegerField(default=0)

    class Meta:
        verbose_name = "Item de cotización"
        verbose_name_plural = "Items de cotización"
        ordering = ["cotizacion", "orden"]
