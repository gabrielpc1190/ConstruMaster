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
def tc(db):
    from apps.finance.models import ExchangeRate
    return ExchangeRate.objects.create(
        currency="USD", date=date(2026, 5, 25),
        buy=Decimal("447.5"), sell=Decimal("454.82"),
    )


def test_supervisor_can_approve_cotizacion(client, tc):
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import Cotizacion, OrdenCompra

    obra = ObraFactory(nombre="Casa Lomas")
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    cot = Cotizacion.objects.create(
        obra=obra, proveedor=prov, numero_cotizacion="C-APPR",
        fecha=date(2026, 5, 25),
        subtotal=Money(100, "CRC"), iva=Money(13, "CRC"), total=Money(113, "CRC"),
    )

    _login(client, "supervisor")
    resp = client.post(f"/compras/cotizacion/{cot.pk}/approve/", {"categoria": cat.pk})
    assert resp.status_code == 302
    cot.refresh_from_db()
    assert cot.estado == "aprobada"
    assert OrdenCompra.objects.filter(cotizacion_origen=cot).exists()


def test_operativo_cannot_approve(client):
    from apps.core.tests.factories import ObraFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import Cotizacion

    obra = ObraFactory()
    prov = ProveedorFactory()
    cot = Cotizacion.objects.create(
        obra=obra, proveedor=prov, numero_cotizacion="X",
        fecha=date.today(),
        subtotal=Money(1, "CRC"), iva=Money(0, "CRC"), total=Money(1, "CRC"),
    )

    _login(client, "operativo")
    resp = client.get(f"/compras/cotizacion/{cot.pk}/approve/")
    assert resp.status_code == 403


def test_approve_get_renders_form_with_semaforo(client, tc):
    """GET muestra form con semáforo si hay presupuesto."""
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.core.models import Presupuesto
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import Cotizacion

    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    Presupuesto.objects.create(obra=obra, categoria=cat, monto=Money(1_000_000, "CRC"))
    prov = ProveedorFactory()
    cot = Cotizacion.objects.create(
        obra=obra, proveedor=prov, numero_cotizacion="GFS",
        fecha=date(2026, 5, 25),
        subtotal=Money(100, "CRC"), iva=Money(13, "CRC"), total=Money(113, "CRC"),
    )

    _login(client, "supervisor")
    resp = client.get(f"/compras/cotizacion/{cot.pk}/approve/?categoria={cat.pk}")
    assert resp.status_code == 200
    body = resp.content.decode()
    assert "Presupuesto" in body or "presupuesto" in body


def test_oc_detail_view(client, tc):
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import OrdenCompra

    obra = ObraFactory(nombre="LomaA")
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    oc = OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="LOMAA-OC-0001",
        fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(1000, "CRC"), estado="autorizada",
    )

    _login(client, "supervisor")
    resp = client.get(f"/compras/oc/{oc.pk}/")
    assert resp.status_code == 200
    assert "LOMAA-OC-0001" in resp.content.decode()


def test_already_approved_redirects_with_error(client, tc):
    """Si la cotización ya está aprobada, POST → redirect con mensaje."""
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import Cotizacion

    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    cot = Cotizacion.objects.create(
        obra=obra, proveedor=prov, numero_cotizacion="DUP",
        fecha=date(2026, 5, 25),
        subtotal=Money(1, "CRC"), iva=Money(0, "CRC"), total=Money(1, "CRC"),
        estado="aprobada",
    )
    _login(client, "supervisor")
    resp = client.post(f"/compras/cotizacion/{cot.pk}/approve/", {"categoria": cat.pk})
    # Redirect (no error 500)
    assert resp.status_code == 302
