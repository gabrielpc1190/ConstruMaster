"""Asigna approve_cotizacion a supervisor."""
from django.db import migrations


def grant(apps, schema_editor):
    Group = apps.get_model("auth", "Group")
    Permission = apps.get_model("auth", "Permission")
    try:
        supervisor = Group.objects.get(name="supervisor")
    except Group.DoesNotExist:
        return
    perm = Permission.objects.filter(codename="approve_cotizacion").first()
    if perm:
        supervisor.permissions.add(perm)


def rollback(apps, schema_editor):
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("compras", "0004_grant_cancel_oc_to_supervisor"),
        ("core", "0004_create_groups"),
    ]
    operations = [
        migrations.RunPython(grant, rollback),
    ]
