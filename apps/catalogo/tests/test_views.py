import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group

pytestmark = pytest.mark.django_db


def _login_as(client, group_name="operativo"):
    User = get_user_model()
    u = User.objects.create_user(username=f"t_{group_name}", password="pw")
    u.groups.add(Group.objects.get(name=group_name))
    client.login(username=f"t_{group_name}", password="pw")
    return u


def test_autocomplete_returns_matching_items(client):
    from apps.catalogo.tests.factories import ItemCatalogoFactory
    _login_as(client)
    ItemCatalogoFactory(nombre_canonico="Cemento Sansón 50kg", estado="aprobado")
    ItemCatalogoFactory(nombre_canonico="Cemento Holcim 50kg", estado="aprobado")
    ItemCatalogoFactory(nombre_canonico="Varilla #4", estado="aprobado")
    resp = client.get("/catalogo/autocomplete/?q=cemento")
    assert resp.status_code == 200
    body = resp.content.decode()
    assert "Cemento Sansón" in body
    assert "Cemento Holcim" in body
    assert "Varilla" not in body


def test_autocomplete_excludes_pendientes_e_inactivos(client):
    from apps.catalogo.tests.factories import ItemCatalogoFactory
    _login_as(client)
    ItemCatalogoFactory(nombre_canonico="Aprobado X", estado="aprobado")
    ItemCatalogoFactory(nombre_canonico="Pendiente X", estado="pendiente")
    ItemCatalogoFactory(nombre_canonico="Inactivo X", estado="inactivo", activo=False)
    resp = client.get("/catalogo/autocomplete/?q=x")
    body = resp.content.decode()
    assert "Aprobado X" in body
    assert "Pendiente X" not in body
    assert "Inactivo X" not in body


def test_autocomplete_requires_login(client):
    resp = client.get("/catalogo/autocomplete/?q=x")
    assert resp.status_code in (302, 403)


def test_autocomplete_empty_query_returns_no_results(client):
    from apps.catalogo.tests.factories import ItemCatalogoFactory
    _login_as(client)
    ItemCatalogoFactory(nombre_canonico="Cemento")
    resp = client.get("/catalogo/autocomplete/?q=")
    assert resp.status_code == 200
    # No debe mostrar resultados si la query está vacía (evita listar todo el catálogo)
    body = resp.content.decode()
    assert "Cemento" not in body


def test_autocomplete_searches_alias(client):
    from apps.catalogo.tests.factories import ItemCatalogoFactory
    _login_as(client)
    item = ItemCatalogoFactory(
        nombre_canonico="Cemento Sansón Tipo I 50kg",
        alias="san\nsanson\nCEM-SAN-50",
        estado="aprobado",
    )
    resp = client.get("/catalogo/autocomplete/?q=san")
    body = resp.content.decode()
    assert "Cemento Sansón" in body
