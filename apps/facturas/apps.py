from django.apps import AppConfig


class FacturasConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.facturas"
    verbose_name = "Facturas"

    def ready(self):
        from auditlog.registry import auditlog
        from .models import Factura
        auditlog.register(Factura)
