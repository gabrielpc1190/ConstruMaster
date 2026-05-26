from django.contrib import admin
from .models import SolicitudCotizacion, Cotizacion, CotizacionItem, OrdenCompra, OrdenCompraItem, Hito


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


class OrdenCompraItemInline(admin.TabularInline):
    model = OrdenCompraItem
    extra = 0
    fields = (
        "orden", "descripcion", "material",
        "material_nombre_snapshot", "material_unidad_snapshot",
        "cantidad", "unidad", "precio_unitario", "subtotal", "iva_monto",
    )
    readonly_fields = ("material_nombre_snapshot", "material_unidad_snapshot")


@admin.register(OrdenCompra)
class OrdenCompraAdmin(admin.ModelAdmin):
    list_display = (
        "numero_oc", "proveedor", "obra", "fecha_aprobacion",
        "monto_total", "estado", "es_especial",
    )
    list_filter = ("estado", "obra", "es_especial")
    search_fields = ("numero_oc",)
    inlines = [OrdenCompraItemInline]
    readonly_fields = (
        "numero_oc", "fx_rate_applied", "fx_rate_date",
    )


@admin.register(Hito)
class HitoAdmin(admin.ModelAdmin):
    list_display = ("__str__", "monto", "fecha_estimada", "completado")
    list_filter = ("completado",)
