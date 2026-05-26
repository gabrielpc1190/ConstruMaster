import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group

pytestmark = pytest.mark.django_db


def _fresh_user(username, group_name):
    """Crea un usuario, asigna grupo y retorna una instancia fresca desde DB
    para que has_perm() no use caché vacía pre-asignación."""
    User = get_user_model()
    u = User.objects.create_user(username=username)
    u.groups.add(Group.objects.get(name=group_name))
    return User.objects.get(pk=u.pk)


def test_grupos_existen():
    for name in ("supervisor", "operativo", "lector"):
        assert Group.objects.filter(name=name).exists(), f"Falta grupo {name}"


def test_supervisor_puede_aprobar_items():
    u = _fresh_user("diana", "supervisor")
    assert u.has_perm("catalogo.approve_item")


def test_supervisor_puede_sugerir_items():
    u = _fresh_user("diana2", "supervisor")
    assert u.has_perm("catalogo.suggest_item")


def test_operativo_puede_sugerir_pero_no_aprobar():
    u = _fresh_user("tony", "operativo")
    assert u.has_perm("catalogo.suggest_item")
    assert not u.has_perm("catalogo.approve_item")


def test_operativo_puede_crear_proveedor():
    u = _fresh_user("tony2", "operativo")
    assert u.has_perm("catalogo.add_proveedor")
    assert u.has_perm("catalogo.change_proveedor")


def test_lector_solo_view():
    u = _fresh_user("nicholas", "lector")
    assert u.has_perm("core.view_obra")
    assert not u.has_perm("core.add_obra")
    assert not u.has_perm("catalogo.suggest_item")


def test_lector_no_puede_crear_nada():
    u = _fresh_user("nicholas2", "lector")
    assert not u.has_perm("core.add_cliente")
    assert not u.has_perm("core.add_obra")
    assert not u.has_perm("catalogo.add_proveedor")
