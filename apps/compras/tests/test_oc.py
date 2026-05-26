from datetime import date
from decimal import Decimal

import pytest
from djmoney.money import Money

pytestmark = pytest.mark.django_db


@pytest.fixture
def tc_today(db):
    """TC para que conversiones funcionen."""
    from apps.finance.models import ExchangeRate
    return ExchangeRate.objects.create(
        currency="USD", date=date.today(),
        buy=Decimal("447.5"), sell=Decimal("454.82"),
    )


def test_oc_creation_with_snapshot_fields():
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import OrdenCompra

    obra = ObraFactory(nombre="Casa Lomas")
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    oc = OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="LOMAS-OC-0001",
        fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(1_000_000, "CRC"),
        estado="autorizada",
    )
    assert oc.estado == "autorizada"
    assert oc.numero_oc == "LOMAS-OC-0001"
    assert oc.fx_rate_applied is None  # no es USD


def test_oc_with_fx_snapshot():
    """OC en USD captura fx_rate_applied."""
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import OrdenCompra

    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    oc = OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="X-OC-0001", fecha_aprobacion=date(2026, 5, 25),
        moneda="USD",
        monto_total=Money(1000, "USD"),
        fx_rate_applied=Decimal("454.82000"),
        fx_rate_date=date(2026, 5, 25),
        estado="autorizada",
    )
    assert oc.fx_rate_applied == Decimal("454.82000")
    assert oc.fx_rate_date == date(2026, 5, 25)


def test_oc_item_snapshot_denormaliza_nombre_unidad():
    """OrdenCompraItem captura snapshot del nombre y unidad del material al aprobar.

    Renombrar el material maestro NO debe afectar el snapshot histórico.
    """
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory, ItemCatalogoFactory
    from apps.compras.models import OrdenCompra, OrdenCompraItem

    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    item = ItemCatalogoFactory(nombre_canonico="Cemento Sansón 50kg", unidad="saco")
    oc = OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="X-OC-0001", fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(1000, "CRC"), estado="autorizada",
    )
    line = OrdenCompraItem.objects.create(
        oc=oc, material=item,
        material_nombre_snapshot=item.nombre_canonico,
        material_unidad_snapshot=item.unidad,
        descripcion="Cemento Sansón 50kg",
        cantidad=Decimal("10"), unidad="saco",
        precio_unitario=Decimal("100"), subtotal=Decimal("1000"),
        iva_monto=Decimal("0"), orden=1,
    )
    item.nombre_canonico = "Cemento OTRO nombre"
    item.unidad = "kg"
    item.save()
    line.refresh_from_db()
    assert line.material_nombre_snapshot == "Cemento Sansón 50kg"
    assert line.material_unidad_snapshot == "saco"


def test_hito_solo_para_servicios():
    """Hito.clean() rechaza items de tipo material."""
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory, ItemCatalogoFactory
    from apps.compras.models import OrdenCompra, OrdenCompraItem, Hito
    from django.core.exceptions import ValidationError

    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    material = ItemCatalogoFactory(tipo="material", nombre_canonico="Cemento", unidad="saco")
    servicio = ItemCatalogoFactory(tipo="servicio", nombre_canonico="Instalación", unidad="global")

    oc = OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="Y-OC-0001", fecha_aprobacion=date.today(),
        monto_total=Money(1000, "CRC"), estado="autorizada",
    )
    line_servicio = OrdenCompraItem.objects.create(
        oc=oc, material=servicio,
        material_nombre_snapshot=servicio.nombre_canonico,
        material_unidad_snapshot=servicio.unidad,
        descripcion="Instalación", cantidad=Decimal("1"),
        unidad="global", precio_unitario=Decimal("1000"),
        subtotal=Decimal("1000"), iva_monto=Decimal("0"), orden=1,
    )
    # Hito sobre servicio: OK
    h = Hito(oc_item=line_servicio, nombre="Anticipo 50%", monto=Decimal("500"))
    h.full_clean()  # no levanta
    h.save()
    assert h.completado is False

    # Hito sobre material: ValidationError
    line_material = OrdenCompraItem.objects.create(
        oc=oc, material=material,
        material_nombre_snapshot=material.nombre_canonico,
        material_unidad_snapshot=material.unidad,
        descripcion="Cemento", cantidad=Decimal("1"),
        unidad="saco", precio_unitario=Decimal("1000"),
        subtotal=Decimal("1000"), iva_monto=Decimal("0"), orden=2,
    )
    h_invalid = Hito(oc_item=line_material, nombre="X", monto=Decimal("1"))
    with pytest.raises(ValidationError):
        h_invalid.full_clean()


def test_cancel_oc_permission_exists():
    """Custom permission 'cancel_oc' definida en Meta de OrdenCompra."""
    from django.contrib.auth.models import Permission
    assert Permission.objects.filter(codename="cancel_oc").exists()
