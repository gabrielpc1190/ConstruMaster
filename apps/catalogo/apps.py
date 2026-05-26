from django.apps import AppConfig


class CatalogoConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.catalogo"
    verbose_name = "Catálogo"

    def ready(self):
        from auditlog.registry import auditlog
        from . import models
        auditlog.register(models.Proveedor)
        auditlog.register(models.ItemCatalogo)
