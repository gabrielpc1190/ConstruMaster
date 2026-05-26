from django.contrib import admin
from .models import SolicitudCotizacion, Cotizacion, CotizacionItem


class CotizacionItemInline(admin.TabularInline):
    model = CotizacionItem
    extra = 0
    fields = (
        "orden", "descripcion", "material", "cantidad", "unidad",
        "precio_unitario", "subtotal", "iva_monto",
    )


@admin.register(SolicitudCotizacion)
class SolicitudCotizacionAdmin(admin.ModelAdmin):
    list_display = ("__str__", "categoria", "estado", "es_especial", "fecha_requerida", "creada_por")
    list_filter = ("estado", "es_especial", "obra")
    search_fields = ("descripcion",)


@admin.register(Cotizacion)
class CotizacionAdmin(admin.ModelAdmin):
    list_display = ("numero_cotizacion", "proveedor", "obra", "fecha", "total", "estado")
    list_filter = ("estado", "obra", "moneda")
    search_fields = ("numero_cotizacion",)
    inlines = [CotizacionItemInline]
