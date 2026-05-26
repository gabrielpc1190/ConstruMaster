"""Asigna permission cancel_oc a supervisor + todos los permissions de
OrdenCompra/OrdenCompraItem/Hito a los grupos correctos."""
from django.db import migrations


def grant(apps, schema_editor):
    Group = apps.get_model("auth", "Group")
    Permission = apps.get_model("auth", "Permission")
    ContentType = apps.get_model("contenttypes", "ContentType")

    # Asegurar que los permissions del app existan
    from django.contrib.auth.management import create_permissions
    from django.apps import apps as django_apps
    for app_config in django_apps.get_app_configs():
        if app_config.name == "apps.compras":
            create_permissions(app_config, verbosity=0)

    try:
        supervisor = Group.objects.get(name="supervisor")
        operativo = Group.objects.get(name="operativo")
        lector = Group.objects.get(name="lector")
    except Group.DoesNotExist:
        return

    # supervisor: TODO en los 3 modelos nuevos
    for model in ("ordencompra", "ordencompraitem", "hito"):
        try:
            ct = ContentType.objects.get(app_label="compras", model=model)
            for p in Permission.objects.filter(content_type=ct):
                supervisor.permissions.add(p)
            # operativo + lector: view
            view = Permission.objects.filter(content_type=ct, codename__startswith="view_").first()
            if view:
                operativo.permissions.add(view)
                lector.permissions.add(view)
        except ContentType.DoesNotExist:
            pass


def rollback(apps, schema_editor):
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("compras", "0003_ordencompra_ordencompraitem_hito"),
    ]
    operations = [
        migrations.RunPython(grant, rollback),
    ]
