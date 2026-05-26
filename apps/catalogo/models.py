from django.contrib.auth import get_user_model
from django.db import models
from django.utils.text import slugify

from apps.core.models import TimestampedModel, CategoriaPresupuesto


class Proveedor(TimestampedModel):
    nombre = models.CharField(max_length=200)
    identificacion = models.CharField(max_length=20, blank=True)  # cédula jurídica/física/DIMEX
    email_facturacion = models.EmailField(blank=True)
    telefono = models.CharField(max_length=30, blank=True)
    notas = models.TextField(blank=True)
    activo = models.BooleanField(default=True)

    class Meta:
        verbose_name = "Proveedor"
        verbose_name_plural = "Proveedores"
        ordering = ["nombre"]

    def __str__(self):
        return self.nombre


class ItemCatalogo(TimestampedModel):
    TIPO_CHOICES = [
        ("material", "Material"),
        ("servicio", "Servicio"),
    ]
    ESTADO_CHOICES = [
        ("pendiente", "Pendiente de aprobación"),
        ("aprobado", "Aprobado"),
        ("inactivo", "Inactivo"),
    ]
    UNIDAD_CHOICES = [
        # Materiales
        ("saco", "Saco"),
        ("kg", "Kg"),
        ("m3", "m³"),
        ("m2", "m²"),
        ("m", "m"),
        ("unidad", "Unidad"),
        ("varilla", "Varilla"),
        ("galon", "Galón"),
        ("litro", "Litro"),
        # Servicios
        ("hora", "Hora"),
        ("dia", "Día"),
        ("visita", "Visita"),
        ("global", "Global"),
        ("mes", "Mes"),
    ]

    tipo = models.CharField(max_length=10, choices=TIPO_CHOICES)
    nombre_canonico = models.CharField(max_length=200)
    unidad = models.CharField(max_length=20, choices=UNIDAD_CHOICES)
    categoria_sugerida = models.ForeignKey(
        CategoriaPresupuesto,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="items_sugeridos",
    )
    slug = models.SlugField(max_length=220)
    alias = models.TextField(
        blank=True,
        help_text="Strings alternativos para autocomplete, uno por línea",
    )
    estado = models.CharField(max_length=10, choices=ESTADO_CHOICES, default="aprobado")
    sugerido_por = models.ForeignKey(
        get_user_model(),
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="items_catalogo_sugeridos",
    )
    activo = models.BooleanField(default=True)

    class Meta:
        verbose_name = "Item del catálogo"
        verbose_name_plural = "Items del catálogo"
        ordering = ["nombre_canonico"]
        indexes = [
            models.Index(fields=["estado"]),
            models.Index(fields=["tipo"]),
            models.Index(fields=["slug"]),
        ]
        permissions = [
            ("suggest_item", "Puede sugerir items al catálogo"),
            ("approve_item", "Puede aprobar/fusionar items del catálogo"),
        ]

    def save(self, *args, **kwargs):
        if not self.slug:
            self.slug = slugify(self.nombre_canonico)[:220]
        super().save(*args, **kwargs)

    def __str__(self):
        return self.nombre_canonico
