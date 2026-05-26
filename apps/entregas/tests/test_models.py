from datetime import date
from decimal import Decimal

import pytest
from djmoney.money import Money

pytestmark = pytest.mark.django_db


@pytest.fixture
def oc_with_items(db):
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
    oc_item = OrdenCompraItem.objects.create(
        oc=oc, material=item_cat,
        material_nombre_snapshot="Cemento", material_unidad_snapshot="saco",
        descripcion="Cemento Sansón", cantidad=Decimal("10.0000"),
        unidad="saco", precio_unitario=Decimal("100"),
        subtotal=Decimal("1000"), iva_monto=Decimal("0"), orden=1,
    )
    bodega = BodegaFactory(cliente=obra.cliente)
    return {"oc": oc, "oc_item": oc_item, "bodega": bodega, "obra": obra}


def test_entrega_creation(oc_with_items):
    from apps.entregas.models import Entrega
    from django.contrib.auth import get_user_model

    user = get_user_model().objects.create_user("u_ent")
    e = Entrega.objects.create(
        oc=oc_with_items["oc"],
        bodega_destino=oc_with_items["bodega"],
        fecha=date(2026, 5, 26),
        recibido_por="Juan Pérez",
        registrada_por=user,
    )
    assert e.completa is False
    assert e.bodega_destino == oc_with_items["bodega"]


def test_entrega_protege_oc_de_borrado(oc_with_items):
    from apps.entregas.models import Entrega
    from django.db.models import ProtectedError
    from django.contrib.auth import get_user_model

    user = get_user_model().objects.create_user("u_p")
    Entrega.objects.create(
        oc=oc_with_items["oc"], fecha=date.today(),
        recibido_por="X", registrada_por=user,
    )
    with pytest.raises(ProtectedError):
        oc_with_items["oc"].delete()


def test_entrega_bodega_nullable(oc_with_items):
    """bodega_destino es nullable en MVP."""
    from apps.entregas.models import Entrega
    from django.contrib.auth import get_user_model

    user = get_user_model().objects.create_user("u_nb")
    e = Entrega.objects.create(
        oc=oc_with_items["oc"], fecha=date.today(),
        recibido_por="X", registrada_por=user,
    )
    assert e.bodega_destino is None


def test_entrega_item_with_oc_item_link(oc_with_items):
    """EntregaItem.oc_item FK opcional para reconciliación."""
    from apps.entregas.models import Entrega, EntregaItem
    from django.contrib.auth import get_user_model

    user = get_user_model().objects.create_user("u_ei")
    e = Entrega.objects.create(
        oc=oc_with_items["oc"], fecha=date.today(),
        recibido_por="X", registrada_por=user,
    )
    line = EntregaItem.objects.create(
        entrega=e,
        oc_item=oc_with_items["oc_item"],
        material=oc_with_items["oc_item"].material,
        descripcion="Cemento Sansón",
        cantidad=Decimal("5.0000"),
        unidad="saco",
    )
    assert line.oc_item == oc_with_items["oc_item"]
    assert line.entrega == e


def test_entrega_item_oc_item_nullable(oc_with_items):
    """EntregaItem puede no tener oc_item (item recibido sin matching)."""
    from apps.entregas.models import Entrega, EntregaItem
    from django.contrib.auth import get_user_model

    user = get_user_model().objects.create_user("u_eis")
    e = Entrega.objects.create(
        oc=oc_with_items["oc"], fecha=date.today(),
        recibido_por="X", registrada_por=user,
    )
    line = EntregaItem.objects.create(
        entrega=e, oc_item=None,
        descripcion="Item desconocido",
        cantidad=Decimal("1"),
        unidad="unidad",
    )
    assert line.oc_item is None


def test_entrega_foto_creation(oc_with_items):
    """EntregaFoto con archivo ImageField + subida_por."""
    from apps.entregas.models import Entrega, EntregaFoto
    from django.contrib.auth import get_user_model

    user = get_user_model().objects.create_user("u_ef")
    e = Entrega.objects.create(
        oc=oc_with_items["oc"], fecha=date.today(),
        recibido_por="X", registrada_por=user,
    )
    foto = EntregaFoto.objects.create(
        entrega=e,
        archivo="fake.jpg",
        subida_por=user,
    )
    assert foto.entrega == e
    assert foto.subida_por == user
    assert foto.fecha is not None  # auto_now_add


def test_entrega_completa_default_false(oc_with_items):
    from apps.entregas.models import Entrega
    from django.contrib.auth import get_user_model

    user = get_user_model().objects.create_user("u_cd")
    e = Entrega.objects.create(
        oc=oc_with_items["oc"], fecha=date.today(),
        recibido_por="X", registrada_por=user,
    )
    assert e.completa is False


def test_entrega_foto_cascade_with_entrega(oc_with_items):
    """Al borrar Entrega, sus EntregaFoto se borran (CASCADE)."""
    from apps.entregas.models import Entrega, EntregaFoto
    from django.contrib.auth import get_user_model

    user = get_user_model().objects.create_user("u_fc")
    e = Entrega.objects.create(
        oc=oc_with_items["oc"], fecha=date.today(),
        recibido_por="X", registrada_por=user,
    )
    EntregaFoto.objects.create(entrega=e, archivo="x.jpg", subida_por=user)
    foto_id = EntregaFoto.objects.first().pk
    e.delete()
    assert not EntregaFoto.objects.filter(pk=foto_id).exists()
