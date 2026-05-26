from django.contrib import admin

from .models import Entrega, EntregaItem, EntregaFoto


class EntregaItemInline(admin.TabularInline):
    model = EntregaItem
    extra = 0
    fields = ("oc_item", "material", "descripcion", "cantidad", "unidad", "notas")


class EntregaFotoInline(admin.TabularInline):
    model = EntregaFoto
    extra = 0
    fields = ("archivo", "subida_por", "fecha")
    readonly_fields = ("fecha",)


@admin.register(Entrega)
class EntregaAdmin(admin.ModelAdmin):
    list_display = ("__str__", "oc", "bodega_destino", "fecha", "completa", "registrada_por")
    list_filter = ("completa", "bodega_destino")
    search_fields = ("oc__numero_oc", "recibido_por")
    inlines = [EntregaItemInline, EntregaFotoInline]
