"""Modelos de Entrega: material/servicio recibido contra una OrdenCompra.

Spec §4.3, §6.8: una Entrega puede ser parcial (varias entregas por OC)
o total. EntregaItem.oc_item enlaza con OrdenCompraItem para
reconciliación pedido-vs-entregado por material × obra.

EXIF preservado en EntregaFoto (geolocalización = evidencia útil de que
el material llegó a obra; decisión spec §8.4).
"""
import uuid

from django.contrib.auth import get_user_model
from django.db import models

from apps.core.models import TimestampedModel, Bodega
from apps.catalogo.models import ItemCatalogo
from apps.compras.models import OrdenCompra, OrdenCompraItem


def entrega_foto_upload_path(instance, filename):
    """Layout: obras/<obra_id>-<slug>/ordenes_compra/<oc_id>-<numero_oc>/entregas/<entrega_id>/<id>-<hash>.<ext>"""
    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else "bin"
    short = uuid.uuid4().hex[:8]
    obra = instance.entrega.oc.obra
    oc = instance.entrega.oc
    return (
        f"obras/{obra.pk}-{obra.slug}/ordenes_compra/"
        f"{oc.pk}-{oc.numero_oc}/entregas/{instance.entrega.pk}/"
        f"{instance.pk or 'tmp'}-{short}.{suffix}"
    )


class Entrega(TimestampedModel):
    """Registro físico de material/servicio recibido contra una OC.

    Múltiples entregas por OC permitidas (parciales). `completa=True`
    indica que esta entrega cerró el ítem (la app de Fase 10 sugiere
    auto-marcarla cuando suma de entregas iguala cantidad de la OC).
    """
    oc = models.ForeignKey(
        OrdenCompra, on_delete=models.PROTECT, related_name="entregas",
    )
    bodega_destino = models.ForeignKey(
        Bodega, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="entregas",
        help_text=(
            "Bodega donde se almacenó. Nullable en MVP (obligatorio "
            "cuando llegue módulo inventario en roadmap)."
        ),
    )
    fecha = models.DateField()
    recibido_por = models.CharField(
        max_length=120,
        help_text="Texto libre — nombre de quien recibió en obra.",
    )
    registrada_por = models.ForeignKey(
        get_user_model(), on_delete=models.PROTECT,
        related_name="entregas_registradas",
    )
    completa = models.BooleanField(
        default=False,
        help_text="Marcar True si esta entrega cierra la OC.",
    )
    notas = models.TextField(blank=True)

    class Meta:
        verbose_name = "Entrega"
        verbose_name_plural = "Entregas"
        ordering = ["-fecha", "-pk"]

    def __str__(self):
        return f"Entrega #{self.pk} ({self.oc.numero_oc}, {self.fecha})"


class EntregaItem(models.Model):
    """Item entregado físicamente. Link opcional a OrdenCompraItem para
    reconciliación pedido-vs-entregado."""
    entrega = models.ForeignKey(
        Entrega, on_delete=models.CASCADE, related_name="items",
    )
    oc_item = models.ForeignKey(
        OrdenCompraItem, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="entregas_items",
        help_text="Link al item de la OC para reconciliación. Nullable.",
    )
    material = models.ForeignKey(
        ItemCatalogo, null=True, blank=True, on_delete=models.SET_NULL,
    )
    descripcion = models.CharField(max_length=300)
    cantidad = models.DecimalField(max_digits=12, decimal_places=4)
    unidad = models.CharField(max_length=20)
    notas = models.TextField(blank=True)

    class Meta:
        verbose_name = "Item de entrega"
        verbose_name_plural = "Items de entrega"
        ordering = ["entrega", "pk"]


class EntregaFoto(models.Model):
    """Foto de evidencia de una entrega. EXIF preservado (geolocalización
    es evidencia útil — spec §8.4)."""
    entrega = models.ForeignKey(
        Entrega, on_delete=models.CASCADE, related_name="fotos",
    )
    archivo = models.ImageField(upload_to=entrega_foto_upload_path)
    subida_por = models.ForeignKey(
        get_user_model(), on_delete=models.PROTECT,
        related_name="entrega_fotos",
    )
    fecha = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "Foto de entrega"
        verbose_name_plural = "Fotos de entrega"
        ordering = ["entrega", "-fecha"]
