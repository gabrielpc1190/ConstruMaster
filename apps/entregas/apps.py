from django.apps import AppConfig


class EntregasConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.entregas"
    verbose_name = "Entregas"

    def ready(self):
        from auditlog.registry import auditlog
        from .models import Entrega, EntregaItem
        auditlog.register(Entrega)
        auditlog.register(EntregaItem)
