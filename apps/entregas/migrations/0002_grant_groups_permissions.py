"""Asigna permisos de Entrega/EntregaItem/EntregaFoto a los grupos."""
from django.db import migrations


def grant(apps, schema_editor):
    Group = apps.get_model("auth", "Group")
    Permission = apps.get_model("auth", "Permission")
    ContentType = apps.get_model("contenttypes", "ContentType")

    from django.contrib.auth.management import create_permissions
    from django.apps import apps as django_apps
    for app_config in django_apps.get_app_configs():
        if app_config.name == "apps.entregas":
            create_permissions(app_config, verbosity=0)

    try:
        supervisor = Group.objects.get(name="supervisor")
        operativo = Group.objects.get(name="operativo")
        lector = Group.objects.get(name="lector")
    except Group.DoesNotExist:
        return

    for model in ("entrega", "entregaitem", "entregafoto"):
        try:
            ct = ContentType.objects.get(app_label="entregas", model=model)
        except ContentType.DoesNotExist:
            continue
        # supervisor: TODO
        for p in Permission.objects.filter(content_type=ct):
            supervisor.permissions.add(p)
        # operativo: view + add + change (puede registrar entregas; spec §5)
        for codename in (f"view_{model}", f"add_{model}", f"change_{model}"):
            p = Permission.objects.filter(content_type=ct, codename=codename).first()
            if p:
                operativo.permissions.add(p)
        # lector: solo view
        view = Permission.objects.filter(content_type=ct, codename=f"view_{model}").first()
        if view:
            lector.permissions.add(view)


def rollback(apps, schema_editor):
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("entregas", "0001_initial"),
    ]
    operations = [
        migrations.RunPython(grant, rollback),
    ]
