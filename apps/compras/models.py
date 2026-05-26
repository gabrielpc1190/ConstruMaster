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


from django.core.exceptions import ValidationError


class OrdenCompra(TimestampedModel):
    """Orden de compra: snapshot inmutable de Cotizacion aprobada.

    Sus items, montos y fx_rate_applied son inmutables después de creada
    (el estado SÍ transiciona por su máquina de estados). Ver spec §4.3.
    """
    ESTADO_CHOICES = [
        ("autorizada", "Autorizada"),
        ("pagada_parcial", "Pagada parcial"),
        ("pagada", "Pagada"),
        ("entregada_parcial", "Entregada parcial"),
        ("completada", "Completada"),
        ("cancelada", "Cancelada"),
    ]
    MONEDA_CHOICES = [("CRC", "Colones"), ("USD", "Dólares")]

    obra = models.ForeignKey(Obra, on_delete=models.PROTECT, related_name="ordenes_compra")
    categoria = models.ForeignKey(CategoriaPresupuesto, on_delete=models.PROTECT)
    cotizacion_origen = models.ForeignKey(
        Cotizacion, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="ocs",
    )
    proveedor = models.ForeignKey(Proveedor, on_delete=models.PROTECT)
    numero_oc = models.CharField(
        max_length=80, unique=True,
        help_text="Formato: <SLUG_OBRA>-OC-NNNN. Generado por compras.services.generate_numero_oc.",
    )
    fecha_aprobacion = models.DateField()
    aprobada_por = models.ForeignKey(
        get_user_model(), null=True, blank=True,
        on_delete=models.PROTECT, related_name="ocs_aprobadas",
    )
    moneda = models.CharField(max_length=3, choices=MONEDA_CHOICES, default="CRC")
    monto_total = MoneyField(max_digits=14, decimal_places=2, default_currency="CRC")
    fx_rate_applied = models.DecimalField(
        max_digits=12, decimal_places=5, null=True, blank=True,
    )
    fx_rate_date = models.DateField(null=True, blank=True)
    es_especial = models.BooleanField(default=False)
    tiempo_estimado_dias = models.PositiveIntegerField(null=True, blank=True)
    pct_anticipo = models.DecimalField(
        max_digits=5, decimal_places=2, null=True, blank=True,
    )
    estado = models.CharField(
        max_length=20, choices=ESTADO_CHOICES, default="autorizada",
    )
    notas = models.TextField(blank=True)

    class Meta:
        verbose_name = "Orden de compra"
        verbose_name_plural = "Órdenes de compra"
        ordering = ["-fecha_aprobacion", "-pk"]
        permissions = [
            ("cancel_oc", "Puede cancelar/anular una OrdenCompra autorizada"),
        ]

    def __str__(self):
        return self.numero_oc


class OrdenCompraItem(models.Model):
    """Snapshot inmutable de un CotizacionItem al aprobar la OC.

    Las copias defensivas material_nombre_snapshot/material_unidad_snapshot
    aseguran que renombrar el ItemCatalogo maestro NO afecta el historial
    de la OC.
    """
    oc = models.ForeignKey(OrdenCompra, on_delete=models.CASCADE, related_name="items")
    material = models.ForeignKey(
        ItemCatalogo, null=True, blank=True, on_delete=models.SET_NULL,
    )
    material_nombre_snapshot = models.CharField(max_length=200, blank=True)
    material_unidad_snapshot = models.CharField(max_length=20, blank=True)
    descripcion = models.CharField(max_length=300)
    cantidad = models.DecimalField(max_digits=12, decimal_places=4)
    unidad = models.CharField(max_length=20)
    precio_unitario = models.DecimalField(max_digits=14, decimal_places=5)
    subtotal = models.DecimalField(max_digits=14, decimal_places=2)
    iva_monto = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    codigo_cabys = models.CharField(max_length=13, blank=True)
    orden = models.PositiveIntegerField(default=0)

    class Meta:
        verbose_name = "Item de OC"
        verbose_name_plural = "Items de OC"
        ordering = ["oc", "orden"]


class Hito(TimestampedModel):
    """Hito de un servicio dentro de una OrdenCompra.

    Solo aplica a OrdenCompraItem cuyo material.tipo == 'servicio'.
    Validación en clean(). Spec §4.3.
    """
    oc_item = models.ForeignKey(
        OrdenCompraItem, on_delete=models.CASCADE, related_name="hitos",
    )
    nombre = models.CharField(max_length=200)
    monto = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    fecha_estimada = models.DateField(null=True, blank=True)
    completado = models.BooleanField(default=False)
    fecha_completado = models.DateField(null=True, blank=True)
    notas = models.TextField(blank=True)
    orden = models.PositiveIntegerField(default=0)

    class Meta:
        verbose_name = "Hito"
        verbose_name_plural = "Hitos"
        ordering = ["oc_item", "orden"]

    def clean(self):
        if (
            self.oc_item_id
            and self.oc_item.material
            and self.oc_item.material.tipo != "servicio"
        ):
            raise ValidationError("Hito solo aplica a items de tipo servicio.")

    def __str__(self):
        return f"{self.nombre} ({self.oc_item.descripcion[:40]})"
