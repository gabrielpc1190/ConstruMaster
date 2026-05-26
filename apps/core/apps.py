from django.apps import AppConfig


class CoreConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.core"
    verbose_name = "Core"

    def ready(self):
        from auditlog.registry import auditlog
        from . import models
        auditlog.register(models.Cliente)
        auditlog.register(models.Obra)
        auditlog.register(models.CategoriaPresupuesto)
        auditlog.register(models.Presupuesto)
        auditlog.register(models.Bodega)
