"""Root conftest.py para los tests de ConstruMaster.

Fixture de sesión que garantiza que los grupos supervisor/operativo/lector
tienen sus permisos correctamente asignados en la base de datos de tests.

Contexto: Django crea los objetos Permission via el signal post_migrate,
que se dispara DESPUÉS de que las migraciones terminan. La migración de datos
0004_create_groups crea los permisos explícitamente, pero si el test DB
fue creado con una versión anterior de la migración, este fixture garantiza
idempotencia en cualquier estado del test DB.
"""
import pytest


@pytest.fixture(scope="session", autouse=True)
def setup_groups_permissions(django_db_setup, django_db_blocker):
    """Garantiza que los grupos tienen sus permisos asignados antes de los tests."""
    with django_db_blocker.unblock():
        from django.contrib.auth.models import Group, Permission
        from django.contrib.contenttypes.models import ContentType

        LOCAL_APPS = ["core", "catalogo", "compras"]
        ITEMCATALOGO_CUSTOM_PERMISSIONS = [
            ("suggest_item", "Puede sugerir items al catálogo"),
            ("approve_item", "Puede aprobar/fusionar items del catálogo"),
        ]

        STANDARD_ACTIONS = [
            ("add", "Can add"),
            ("change", "Can change"),
            ("delete", "Can delete"),
            ("view", "Can view"),
        ]

        # Crear permisos standard si no existen (post_migrate puede no haber corrido)
        for app_label in LOCAL_APPS:
            for ct in ContentType.objects.filter(app_label=app_label):
                for action, prefix in STANDARD_ACTIONS:
                    codename = f"{action}_{ct.model}"
                    Permission.objects.get_or_create(
                        content_type=ct,
                        codename=codename,
                        defaults={"name": f"{prefix} {ct.model}"},
                    )

        # Crear custom permissions de ItemCatalogo
        try:
            item_ct = ContentType.objects.get(app_label="catalogo", model="itemcatalogo")
            for codename, name in ITEMCATALOGO_CUSTOM_PERMISSIONS:
                Permission.objects.get_or_create(
                    content_type=item_ct,
                    codename=codename,
                    defaults={"name": name},
                )
        except ContentType.DoesNotExist:
            pass

        # Crear custom permissions de Cotizacion
        try:
            cot_ct = ContentType.objects.get(app_label="compras", model="cotizacion")
            Permission.objects.get_or_create(
                content_type=cot_ct,
                codename="approve_cotizacion",
                defaults={"name": "Puede aprobar Cotizacion → crear OrdenCompra"},
            )
        except ContentType.DoesNotExist:
            pass

        # Crear custom permission cancel_oc en OrdenCompra
        try:
            oc_ct = ContentType.objects.get(app_label="compras", model="ordencompra")
            Permission.objects.get_or_create(
                content_type=oc_ct,
                codename="cancel_oc",
                defaults={"name": "Puede cancelar/anular una OrdenCompra autorizada"},
            )
        except ContentType.DoesNotExist:
            pass

        supervisor, _ = Group.objects.get_or_create(name="supervisor")
        operativo, _ = Group.objects.get_or_create(name="operativo")
        lector, _ = Group.objects.get_or_create(name="lector")

        # Supervisor: todos los permisos de apps locales
        for app_label in LOCAL_APPS:
            for ct in ContentType.objects.filter(app_label=app_label):
                for perm in Permission.objects.filter(content_type=ct):
                    supervisor.permissions.add(perm)

        # Operativo y lector: view en todo
        for app_label in LOCAL_APPS:
            for ct in ContentType.objects.filter(app_label=app_label):
                view = Permission.objects.filter(
                    content_type=ct, codename__startswith="view_"
                ).first()
                if view:
                    operativo.permissions.add(view)
                    lector.permissions.add(view)

        # Operativo: add/change Proveedor
        try:
            proveedor_ct = ContentType.objects.get(app_label="catalogo", model="proveedor")
            for codename in ("add_proveedor", "change_proveedor"):
                p = Permission.objects.filter(
                    content_type=proveedor_ct, codename=codename
                ).first()
                if p:
                    operativo.permissions.add(p)
        except ContentType.DoesNotExist:
            pass

        # Operativo: add/change SolicitudCotizacion + Cotizacion
        for model in ("solicitudcotizacion", "cotizacion"):
            try:
                ct = ContentType.objects.get(app_label="compras", model=model)
                for codename in (f"add_{model}", f"change_{model}"):
                    p = Permission.objects.filter(content_type=ct, codename=codename).first()
                    if p:
                        operativo.permissions.add(p)
            except ContentType.DoesNotExist:
                pass

        # suggest_item: operativo
        suggest = Permission.objects.filter(codename="suggest_item").first()
        if suggest:
            operativo.permissions.add(suggest)
