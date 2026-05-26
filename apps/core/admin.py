from django.contrib import admin
from .models import Bodega, Cliente, Obra, CategoriaPresupuesto, Presupuesto


@admin.register(Cliente)
class ClienteAdmin(admin.ModelAdmin):
    list_display = ("nombre", "identificacion", "created_at")
    search_fields = ("nombre", "identificacion")


@admin.register(Obra)
class ObraAdmin(admin.ModelAdmin):
    list_display = ("nombre", "cliente", "estado", "fecha_inicio", "moneda_reporte")
    list_filter = ("estado", "cliente")
    search_fields = ("nombre", "slug")
    prepopulated_fields = {"slug": ("nombre",)}
    readonly_fields = ("next_oc_seq",)


@admin.register(CategoriaPresupuesto)
class CategoriaPresupuestoAdmin(admin.ModelAdmin):
    list_display = ("nombre", "obra", "orden")
    list_filter = ("obra",)
    ordering = ("obra", "orden")


@admin.register(Presupuesto)
class PresupuestoAdmin(admin.ModelAdmin):
    list_display = ("categoria", "obra", "monto")
    list_filter = ("obra",)


@admin.register(Bodega)
class BodegaAdmin(admin.ModelAdmin):
    list_display = ("nombre", "cliente", "responsable", "activo")
    list_filter = ("cliente", "activo")
    search_fields = ("nombre",)
