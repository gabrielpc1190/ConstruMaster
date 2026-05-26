from django.contrib import admin

from .models import Factura


@admin.register(Factura)
class FacturaAdmin(admin.ModelAdmin):
    list_display = (
        "__str__", "oc", "source_type", "tipo_comprobante",
        "status", "monto_total", "fecha_emision",
    )
    list_filter = ("status", "source_type", "tipo_comprobante")
    search_fields = ("clave_numerica", "numero_consecutivo", "oc__numero_oc")
    readonly_fields = (
        "extracted_data", "confidence_score",
        "fx_rate_applied", "fx_rate_date",
        "error_message", "created_at", "updated_at",
    )
