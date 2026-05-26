"""Migración de datos: crea grupos supervisor/operativo/lector y asigna permisos.

IMPORTANTE: Los objetos Permission para modelos Django son creados por el signal
post_migrate, que se dispara DESPUÉS de que todas las migraciones terminan.
Durante RunPython los permisos standard (add_, change_, delete_, view_) pueden
NO existir aún. Este migración los crea explícitamente via get_or_create para
garantizar idempotencia tanto en producción como en test DB.
"""
from django.db import migrations


LOCAL_APPS = ["core", "catalogo"]

# Permisos standard por modelo (codename_suffix, verbose_name_prefix)
STANDARD_ACTIONS = [
    ("add", "Can add"),
    ("change", "Can change"),
    ("delete", "Can delete"),
    ("view", "Can view"),
]

# Permisos custom de ItemCatalogo declarados en Meta.permissions
ITEMCATALOGO_CUSTOM_PERMISSIONS = [
    ("suggest_item", "Puede sugerir items al catálogo"),
    ("approve_item", "Puede aprobar/fusionar items del catálogo"),
]


def ensure_permissions(Permission, ContentType):
    """Crea todos los permisos que necesitamos (standard + custom) si no existen."""
    for app_label in LOCAL_APPS:
        cts = ContentType.objects.filter(app_label=app_label)
        for ct in cts:
            for action, prefix in STANDARD_ACTIONS:
                codename = f"{action}_{ct.model}"
                name = f"{prefix} {ct.model}"
                Permission.objects.get_or_create(
                    content_type=ct,
                    codename=codename,
                    defaults={"name": name},
                )

    # Custom permissions para ItemCatalogo
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


def create_groups(apps, schema_editor):
    Group = apps.get_model("auth", "Group")
    Permission = apps.get_model("auth", "Permission")
    ContentType = apps.get_model("contenttypes", "ContentType")

    # Garantizar que todos los permisos existen antes de asignarlos
    ensure_permissions(Permission, ContentType)

    supervisor, _ = Group.objects.get_or_create(name="supervisor")
    operativo, _ = Group.objects.get_or_create(name="operativo")
    lector, _ = Group.objects.get_or_create(name="lector")

    # Supervisor: TODOS los permisos sobre modelos de las apps locales (incluye custom permissions)
    for app_label in LOCAL_APPS:
        cts = ContentType.objects.filter(app_label=app_label)
        for ct in cts:
            for perm in Permission.objects.filter(content_type=ct):
                supervisor.permissions.add(perm)

    # Operativo y lector: view en todo
    for app_label in LOCAL_APPS:
        cts = ContentType.objects.filter(app_label=app_label)
        for ct in cts:
            view = Permission.objects.filter(content_type=ct, codename__startswith="view_").first()
            if view:
                operativo.permissions.add(view)
                lector.permissions.add(view)

    # Operativo: add/change Proveedor
    try:
        proveedor_ct = ContentType.objects.get(app_label="catalogo", model="proveedor")
        for codename in ("add_proveedor", "change_proveedor"):
            p = Permission.objects.filter(content_type=proveedor_ct, codename=codename).first()
            if p:
                operativo.permissions.add(p)
    except ContentType.DoesNotExist:
        pass

    # suggest_item: operativo (supervisor ya lo tiene del bloque de arriba)
    suggest = Permission.objects.filter(codename="suggest_item").first()
    if suggest:
        operativo.permissions.add(suggest)


def remove_groups(apps, schema_editor):
    Group = apps.get_model("auth", "Group")
    Group.objects.filter(name__in=["supervisor", "operativo", "lector"]).delete()


class Migration(migrations.Migration):
    dependencies = [
        # IMPORTANTE: depende de la última migration de core Y de la nueva de catalogo (0002 con permissions)
        ("core", "0003_bodega"),
        ("catalogo", "0002_alter_itemcatalogo_options"),
    ]
    operations = [
        migrations.RunPython(create_groups, remove_groups),
    ]
