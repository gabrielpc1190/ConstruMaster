from datetime import date
from decimal import Decimal

import pytest
from djmoney.money import Money

pytestmark = pytest.mark.django_db


@pytest.fixture
def tc_today(db):
    from apps.finance.models import ExchangeRate
    return ExchangeRate.objects.create(
        currency="USD", date=date(2026, 5, 25),
        buy=Decimal("447.5"), sell=Decimal("454.82"),
    )


@pytest.fixture
def oc_simple(tc_today):
    """OC en USD para tests de pagos."""
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import OrdenCompra
    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    return OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="X-OC-0001",
        fecha_aprobacion=date(2026, 5, 25),
        moneda="USD",
        monto_total=Money(1000, "USD"),
        fx_rate_applied=Decimal("454.82"),
        fx_rate_date=date(2026, 5, 25),
        estado="autorizada",
    )


def test_pago_creation(oc_simple):
    from apps.compras.models import Pago
    p = Pago.objects.create(
        oc=oc_simple,
        fecha_programada=date(2026, 5, 25),
        monto=Money(500, "USD"),
        metodo="transferencia",
        referencia="TR-001",
    )
    assert p.fecha_realizada is None
    assert p.marcado_pagado_por is None
    assert p.metodo == "transferencia"
    # django-money formatea según locale configurado (ej. USD500,00 en es)
    assert str(p).startswith(f"Pago {p.pk} (programado,")
    assert "500" in str(p)


def test_pago_str_realizado(oc_simple):
    """Pago con fecha_realizada → str dice 'realizado'."""
    from apps.compras.models import Pago
    from django.contrib.auth import get_user_model
    user = get_user_model().objects.create_user("u_realizado")
    p = Pago.objects.create(
        oc=oc_simple,
        fecha_programada=date(2026, 5, 25),
        fecha_realizada=date(2026, 5, 25),
        marcado_pagado_por=user,
        monto=Money(500, "USD"),
        metodo="transferencia",
    )
    assert "realizado" in str(p)


def test_pago_metodo_choices(oc_simple):
    """Todos los metodos: transferencia | cheque | efectivo | tarjeta | otro."""
    from apps.compras.models import Pago
    for m in ("transferencia", "cheque", "efectivo", "tarjeta", "otro"):
        p = Pago.objects.create(
            oc=oc_simple,
            fecha_programada=date(2026, 5, 25),
            monto=Money(100, "USD"),
            metodo=m,
        )
        assert p.metodo == m


def test_pago_with_hitos_m2m(oc_simple):
    """Un pago puede vincularse a uno o más hitos (M:N)."""
    from apps.compras.models import OrdenCompraItem, Hito, Pago
    from apps.catalogo.tests.factories import ItemCatalogoFactory
    servicio = ItemCatalogoFactory(tipo="servicio", nombre_canonico="Inst", unidad="global")
    item = OrdenCompraItem.objects.create(
        oc=oc_simple, material=servicio,
        material_nombre_snapshot="Inst", material_unidad_snapshot="global",
        descripcion="Instalación", cantidad=Decimal("1"),
        unidad="global", precio_unitario=Decimal("1000"),
        subtotal=Decimal("1000"), iva_monto=Decimal("0"), orden=1,
    )
    h1 = Hito.objects.create(oc_item=item, nombre="Anticipo 50%", monto=Decimal("500"))
    h2 = Hito.objects.create(oc_item=item, nombre="Saldo 50%", monto=Decimal("500"))

    p = Pago.objects.create(
        oc=oc_simple, fecha_programada=date(2026, 5, 25),
        monto=Money(500, "USD"), metodo="transferencia",
    )
    p.hitos_relacionados.add(h1)
    assert h1 in p.hitos_relacionados.all()
    assert h2 not in p.hitos_relacionados.all()

    # Un hito puede tener varios pagos (related_name="pagos")
    assert p in h1.pagos.all()


def test_pago_protege_oc_de_borrado(oc_simple):
    """No se puede borrar una OC que tiene pagos (PROTECT)."""
    from apps.compras.models import Pago
    from django.db.models import ProtectedError
    Pago.objects.create(
        oc=oc_simple, fecha_programada=date(2026, 5, 25),
        monto=Money(100, "USD"), metodo="transferencia",
    )
    with pytest.raises(ProtectedError):
        oc_simple.delete()


def test_mark_paid_permission_exists():
    """Custom permission mark_paid existe."""
    from django.contrib.auth.models import Permission
    assert Permission.objects.filter(codename="mark_paid").exists()


def test_pago_fx_snapshot_fields(oc_simple):
    """Pago tiene fx_rate_applied y fx_rate_date para snapshot."""
    from apps.compras.models import Pago
    p = Pago.objects.create(
        oc=oc_simple, fecha_programada=date(2026, 5, 25),
        monto=Money(100, "USD"), metodo="transferencia",
        fx_rate_applied=Decimal("454.82"),
        fx_rate_date=date(2026, 5, 25),
    )
    assert p.fx_rate_applied == Decimal("454.82")
    assert p.fx_rate_date == date(2026, 5, 25)
