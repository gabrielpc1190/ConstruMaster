"""Asigna permisos de Factura a los grupos."""
from django.db import migrations


def grant(apps, schema_editor):
    Group = apps.get_model("auth", "Group")
    Permission = apps.get_model("auth", "Permission")
    ContentType = apps.get_model("contenttypes", "ContentType")

    # Crear permissions si no existen
    from django.contrib.auth.management import create_permissions
    from django.apps import apps as django_apps
    for app_config in django_apps.get_app_configs():
        if app_config.name == "apps.facturas":
            create_permissions(app_config, verbosity=0)

    try:
        supervisor = Group.objects.get(name="supervisor")
        operativo = Group.objects.get(name="operativo")
        lector = Group.objects.get(name="lector")
    except Group.DoesNotExist:
        return

    try:
        ct = ContentType.objects.get(app_label="facturas", model="factura")
    except ContentType.DoesNotExist:
        return

    # supervisor: TODO + confirm_factura
    for p in Permission.objects.filter(content_type=ct):
        supervisor.permissions.add(p)

    # operativo: view + add + change (puede subir, pero NO confirmar)
    for codename in ("view_factura", "add_factura", "change_factura"):
        p = Permission.objects.filter(content_type=ct, codename=codename).first()
        if p:
            operativo.permissions.add(p)

    # lector: solo view
    view = Permission.objects.filter(content_type=ct, codename="view_factura").first()
    if view:
        lector.permissions.add(view)


def rollback(apps, schema_editor):
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("facturas", "0001_initial"),
    ]
    operations = [
        migrations.RunPython(grant, rollback),
    ]
