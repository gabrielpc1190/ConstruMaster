from django.contrib import admin
from .models import Cliente, Obra


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
