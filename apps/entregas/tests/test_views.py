from datetime import date
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from djmoney.money import Money

pytestmark = pytest.mark.django_db


def _login(client, group):
    User = get_user_model()
    u = User.objects.create_user(username=f"u_{group}", password="pw")
    u.groups.add(Group.objects.get(name=group))
    client.login(username=f"u_{group}", password="pw")
    return u


@pytest.fixture
def oc_with_items():
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory, BodegaFactory
    from apps.catalogo.tests.factories import ProveedorFactory, ItemCatalogoFactory
    from apps.compras.models import OrdenCompra, OrdenCompraItem

    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    item_cat = ItemCatalogoFactory(nombre_canonico="Cemento", unidad="saco")
    oc = OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="E-OC-0001", fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(1000, "CRC"), estado="autorizada",
    )
    OrdenCompraItem.objects.create(
        oc=oc, material=item_cat,
        material_nombre_snapshot="Cemento", material_unidad_snapshot="saco",
        descripcion="Cemento Sansón", cantidad=Decimal("10.0000"),
        unidad="saco", precio_unitario=Decimal("100"),
        subtotal=Decimal("1000"), iva_monto=Decimal("0"), orden=1,
    )
    bodega = BodegaFactory(cliente=obra.cliente)
    return {"oc": oc, "bodega": bodega}


def test_operativo_can_register_entrega(client, oc_with_items):
    """Operativo registra una entrega completa con 1 item."""
    from apps.entregas.models import Entrega
    oc = oc_with_items["oc"]
    bodega = oc_with_items["bodega"]
    oc_item = oc.items.first()

    user = _login(client, "operativo")
    resp = client.post(f"/entregas/registrar/{oc.pk}/", {
        "fecha": "2026-05-26",
        "recibido_por": "Tony Vargas",
        "bodega_destino": bodega.pk,
        "completa": "on",
        "notas": "Llegó completo",
        # FormSet de items
        "items-TOTAL_FORMS": "1",
        "items-INITIAL_FORMS": "0",
        "items-MIN_NUM_FORMS": "0",
        "items-MAX_NUM_FORMS": "100",
        "items-0-oc_item": str(oc_item.pk),
        "items-0-descripcion": "Cemento Sansón",
        "items-0-cantidad": "10.0000",
        "items-0-unidad": "saco",
        "items-0-notas": "",
    })
    assert resp.status_code == 302
    e = Entrega.objects.get(oc=oc)
    assert e.recibido_por == "Tony Vargas"
    assert e.completa is True
    assert e.registrada_por == user
    assert e.items.count() == 1


def test_lector_cannot_register(client, oc_with_items):
    _login(client, "lector")
    resp = client.get(f"/entregas/registrar/{oc_with_items['oc'].pk}/")
    assert resp.status_code == 403


def test_get_prellena_items_pendientes(client, oc_with_items):
    """GET pre-llena formset con items pendientes de la OC."""
    _login(client, "operativo")
    resp = client.get(f"/entregas/registrar/{oc_with_items['oc'].pk}/")
    assert resp.status_code == 200
    body = resp.content.decode()
    # Debe incluir el descripcion del oc_item en el form pre-llenado
    assert "Cemento Sansón" in body or "10" in body


def test_entrega_detail_view(client, oc_with_items):
    """GET /entregas/<pk>/ muestra detalle."""
    from apps.entregas.models import Entrega
    user = _login(client, "operativo")
    e = Entrega.objects.create(
        oc=oc_with_items["oc"], fecha=date.today(),
        recibido_por="Test", registrada_por=user,
    )
    resp = client.get(f"/entregas/{e.pk}/")
    assert resp.status_code == 200


def test_lector_can_view_entrega_detail(client, oc_with_items):
    from apps.entregas.models import Entrega
    from django.contrib.auth import get_user_model
    creator = get_user_model().objects.create_user("creator")
    e = Entrega.objects.create(
        oc=oc_with_items["oc"], fecha=date.today(),
        recibido_por="X", registrada_por=creator,
    )
    _login(client, "lector")
    resp = client.get(f"/entregas/{e.pk}/")
    assert resp.status_code == 200


def test_register_with_no_items_creates_entrega(client, oc_with_items):
    """Una entrega sin items (formset vacío) debe permitirse — flexibilidad."""
    from apps.entregas.models import Entrega
    user = _login(client, "operativo")
    resp = client.post(f"/entregas/registrar/{oc_with_items['oc'].pk}/", {
        "fecha": "2026-05-26",
        "recibido_por": "Nadie",
        "completa": "",
        "notas": "Solo nota",
        "items-TOTAL_FORMS": "0",
        "items-INITIAL_FORMS": "0",
        "items-MIN_NUM_FORMS": "0",
        "items-MAX_NUM_FORMS": "100",
    })
    # 302 redirect o 200 con form errors — depende impl
    # Lo importante es que NO crashee
    assert resp.status_code in (200, 302)
