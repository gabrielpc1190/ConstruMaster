from django.contrib import admin
from .models import Proveedor, ItemCatalogo


@admin.register(Proveedor)
class ProveedorAdmin(admin.ModelAdmin):
    list_display = ("nombre", "identificacion", "email_facturacion", "activo")
    list_filter = ("activo",)
    search_fields = ("nombre", "identificacion")


@admin.register(ItemCatalogo)
class ItemCatalogoAdmin(admin.ModelAdmin):
    list_display = ("nombre_canonico", "tipo", "unidad", "estado", "sugerido_por")
    list_filter = ("tipo", "estado", "activo")
    search_fields = ("nombre_canonico", "alias")
    prepopulated_fields = {"slug": ("nombre_canonico",)}
    actions = ["aprobar_items", "desactivar_items"]

    @admin.action(description="Aprobar items seleccionados")
    def aprobar_items(self, request, queryset):
        queryset.update(estado="aprobado")

    @admin.action(description="Desactivar items seleccionados")
    def desactivar_items(self, request, queryset):
        queryset.update(estado="inactivo", activo=False)
