from django.apps import AppConfig


class ComprasConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.compras"
    verbose_name = "Compras"

    def ready(self):
        from auditlog.registry import auditlog
        from .models import SolicitudCotizacion, Cotizacion
        auditlog.register(SolicitudCotizacion)
        auditlog.register(Cotizacion)
