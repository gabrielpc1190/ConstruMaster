from django.db import models
from django.utils.text import slugify


class TimestampedModel(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Cliente(TimestampedModel):
    nombre = models.CharField(max_length=200)
    identificacion = models.CharField(max_length=50, blank=True)
    notas = models.TextField(blank=True)

    class Meta:
        verbose_name = "Cliente"
        verbose_name_plural = "Clientes"
        ordering = ["nombre"]
        constraints = [
            models.CheckConstraint(
                condition=~models.Q(nombre=""),
                name="cliente_nombre_no_vacio",
            ),
        ]

    def __str__(self):
        return self.nombre


class Obra(TimestampedModel):
    ESTADO_CHOICES = [
        ("planificada", "Planificada"),
        ("en_curso", "En curso"),
        ("pausada", "Pausada"),
        ("finalizada", "Finalizada"),
    ]
    MONEDA_REPORTE_CHOICES = [("CRC", "Colones"), ("USD", "Dólares")]

    cliente = models.ForeignKey(Cliente, on_delete=models.PROTECT, related_name="obras")
    nombre = models.CharField(max_length=200)
    slug = models.SlugField(max_length=80, unique=True)
    direccion = models.TextField(blank=True)
    fecha_inicio = models.DateField(null=True, blank=True)
    fecha_fin_estimada = models.DateField(null=True, blank=True)
    moneda_reporte = models.CharField(
        max_length=3, choices=MONEDA_REPORTE_CHOICES, default="USD"
    )
    estado = models.CharField(
        max_length=20, choices=ESTADO_CHOICES, default="planificada"
    )
    next_oc_seq = models.PositiveIntegerField(default=1)  # ver spec §6.4 race-fix
    notas = models.TextField(blank=True)

    class Meta:
        verbose_name = "Obra"
        verbose_name_plural = "Obras"
        ordering = ["-fecha_inicio", "nombre"]

    def save(self, *args, **kwargs):
        if not self.slug:
            self.slug = slugify(self.nombre)[:80]
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.nombre} ({self.cliente.nombre})"
