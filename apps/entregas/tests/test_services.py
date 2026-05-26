from datetime import date
from decimal import Decimal

import pytest
from djmoney.money import Money

pytestmark = pytest.mark.django_db


@pytest.fixture
def oc_with_items():
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory, ItemCatalogoFactory
    from apps.compras.models import OrdenCompra, OrdenCompraItem
    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    cemento = ItemCatalogoFactory(nombre_canonico="Cemento", unidad="saco")
    varilla = ItemCatalogoFactory(nombre_canonico="Varilla #4", unidad="varilla")

    oc = OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="R-OC-0001", fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(1000, "CRC"), estado="autorizada",
    )
    oci_cemento = OrdenCompraItem.objects.create(
        oc=oc, material=cemento,
        material_nombre_snapshot="Cemento", material_unidad_snapshot="saco",
        descripcion="Cemento", cantidad=Decimal("100"),
        unidad="saco", precio_unitario=Decimal("5"),
        subtotal=Decimal("500"), iva_monto=Decimal("0"), orden=1,
    )
    oci_varilla = OrdenCompraItem.objects.create(
        oc=oc, material=varilla,
        material_nombre_snapshot="Varilla #4", material_unidad_snapshot="varilla",
        descripcion="Varilla", cantidad=Decimal("50"),
        unidad="varilla", precio_unitario=Decimal("10"),
        subtotal=Decimal("500"), iva_monto=Decimal("0"), orden=2,
    )
    return {
        "obra": obra, "oc": oc,
        "oci_cemento": oci_cemento, "oci_varilla": oci_varilla,
        "cemento": cemento, "varilla": varilla,
    }


def test_pendiente_por_oc_item_sin_entregas(oc_with_items):
    """Sin entregas registradas → pendiente = cantidad total."""
    from apps.entregas.services import pendiente_por_oc_item
    assert pendiente_por_oc_item(oc_with_items["oci_cemento"]) == Decimal("100")


def test_pendiente_por_oc_item_con_entregas_parciales(oc_with_items):
    """Entregas parciales suman y se restan de la cantidad."""
    from apps.entregas.services import pendiente_por_oc_item
    from apps.entregas.models import Entrega, EntregaItem
    from django.contrib.auth import get_user_model

    user = get_user_model().objects.create_user("u_pe")
    e1 = Entrega.objects.create(
        oc=oc_with_items["oc"], fecha=date.today(),
        recibido_por="X", registrada_por=user,
    )
    EntregaItem.objects.create(
        entrega=e1, oc_item=oc_with_items["oci_cemento"],
        descripcion="Cemento", cantidad=Decimal("30"),
        unidad="saco",
    )
    e2 = Entrega.objects.create(
        oc=oc_with_items["oc"], fecha=date.today(),
        recibido_por="Y", registrada_por=user,
    )
    EntregaItem.objects.create(
        entrega=e2, oc_item=oc_with_items["oci_cemento"],
        descripcion="Cemento", cantidad=Decimal("20"),
        unidad="saco",
    )
    # 100 - (30+20) = 50
    assert pendiente_por_oc_item(oc_with_items["oci_cemento"]) == Decimal("50")


def test_pendiente_por_oc_item_completo(oc_with_items):
    """Entrega completa → pendiente = 0."""
    from apps.entregas.services import pendiente_por_oc_item
    from apps.entregas.models import Entrega, EntregaItem
    from django.contrib.auth import get_user_model

    user = get_user_model().objects.create_user("u_co")
    e = Entrega.objects.create(
        oc=oc_with_items["oc"], fecha=date.today(),
        recibido_por="X", registrada_por=user,
    )
    EntregaItem.objects.create(
        entrega=e, oc_item=oc_with_items["oci_cemento"],
        descripcion="Cemento", cantidad=Decimal("100"),
        unidad="saco",
    )
    assert pendiente_por_oc_item(oc_with_items["oci_cemento"]) == Decimal("0")


def test_pendiente_por_oc_item_excedido(oc_with_items):
    """Entrega excedida → pendiente negativo (puede pasar; sobrante)."""
    from apps.entregas.services import pendiente_por_oc_item
    from apps.entregas.models import Entrega, EntregaItem
    from django.contrib.auth import get_user_model

    user = get_user_model().objects.create_user("u_ex")
    e = Entrega.objects.create(
        oc=oc_with_items["oc"], fecha=date.today(),
        recibido_por="X", registrada_por=user,
    )
    EntregaItem.objects.create(
        entrega=e, oc_item=oc_with_items["oci_cemento"],
        descripcion="Cemento", cantidad=Decimal("110"),  # 10 más de lo pedido
        unidad="saco",
    )
    # 100 - 110 = -10
    assert pendiente_por_oc_item(oc_with_items["oci_cemento"]) == Decimal("-10")


def test_compras_vs_entregas_por_material_basic(oc_with_items):
    """Resumen por material × obra."""
    from apps.entregas.services import compras_vs_entregas_por_material
    from apps.entregas.models import Entrega, EntregaItem
    from django.contrib.auth import get_user_model

    user = get_user_model().objects.create_user("u_cv")
    e = Entrega.objects.create(
        oc=oc_with_items["oc"], fecha=date.today(),
        recibido_por="X", registrada_por=user,
    )
    EntregaItem.objects.create(
        entrega=e, oc_item=oc_with_items["oci_cemento"],
        material=oc_with_items["cemento"],
        descripcion="Cemento", cantidad=Decimal("60"),
        unidad="saco",
    )

    result = compras_vs_entregas_por_material(
        oc_with_items["obra"], oc_with_items["cemento"],
    )
    assert result["comprado"] == Decimal("100")
    assert result["entregado"] == Decimal("60")
    assert result["pendiente"] == Decimal("40")


def test_compras_vs_entregas_multiple_ocs(oc_with_items):
    """Suma compras de varias OCs en la misma obra."""
    from apps.entregas.services import compras_vs_entregas_por_material
    from apps.compras.models import OrdenCompra, OrdenCompraItem
    from apps.catalogo.tests.factories import ProveedorFactory

    obra = oc_with_items["obra"]
    cemento = oc_with_items["cemento"]
    prov2 = ProveedorFactory()

    # Otra OC en la misma obra, con más cemento
    cat = obra.categorias.first()
    oc2 = OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov2,
        numero_oc="R-OC-0002", fecha_aprobacion=date(2026, 5, 26),
        monto_total=Money(500, "CRC"), estado="autorizada",
    )
    OrdenCompraItem.objects.create(
        oc=oc2, material=cemento,
        material_nombre_snapshot="Cemento", material_unidad_snapshot="saco",
        descripcion="Cemento", cantidad=Decimal("50"),
        unidad="saco", precio_unitario=Decimal("5"),
        subtotal=Decimal("250"), iva_monto=Decimal("0"), orden=1,
    )

    result = compras_vs_entregas_por_material(obra, cemento)
    # OC1: 100 + OC2: 50 = 150
    assert result["comprado"] == Decimal("150")
    assert result["entregado"] == Decimal("0")
    assert result["pendiente"] == Decimal("150")


def test_compras_vs_entregas_no_data(oc_with_items):
    """Material sin compras en esa obra → ceros."""
    from apps.entregas.services import compras_vs_entregas_por_material
    from apps.catalogo.tests.factories import ItemCatalogoFactory

    nuevo = ItemCatalogoFactory(nombre_canonico="Material nuevo", unidad="unidad")
    result = compras_vs_entregas_por_material(oc_with_items["obra"], nuevo)
    assert result["comprado"] == Decimal("0")
    assert result["entregado"] == Decimal("0")
    assert result["pendiente"] == Decimal("0")


def test_compras_vs_entregas_excludes_cancelled_oc(oc_with_items):
    """OCs canceladas NO cuentan en `comprado`."""
    from apps.entregas.services import compras_vs_entregas_por_material

    # Cancelar la OC con 100 sacos de cemento
    oc_with_items["oc"].estado = "cancelada"
    oc_with_items["oc"].save()

    result = compras_vs_entregas_por_material(
        oc_with_items["obra"], oc_with_items["cemento"],
    )
    assert result["comprado"] == Decimal("0")
