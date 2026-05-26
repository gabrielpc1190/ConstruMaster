from django.apps import AppConfig


class ComprasConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.compras"
    verbose_name = "Compras"

    def ready(self):
        from auditlog.registry import auditlog
        from . import models
        if hasattr(models, "SolicitudCotizacion"):
            auditlog.register(models.SolicitudCotizacion)
        if hasattr(models, "Cotizacion"):
            auditlog.register(models.Cotizacion)
