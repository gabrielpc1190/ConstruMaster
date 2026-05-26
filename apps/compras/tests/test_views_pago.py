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


@pytest.fixture
def oc(tc):
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import OrdenCompra
    obra = ObraFactory(nombre="Casa V")
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    return OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="V-OC-0001", fecha_aprobacion=date(2026, 5, 25),
        moneda="USD",
        monto_total=Money(1000, "USD"),
        fx_rate_applied=Decimal("454.82"), fx_rate_date=date(2026, 5, 25),
        estado="autorizada",
    )


def test_operativo_can_program_pago(client, oc):
    """Operativo puede crear un Pago programado."""
    from apps.compras.models import Pago

    _login(client, "operativo")
    resp = client.post(f"/compras/oc/{oc.pk}/pago/programar/", {
        "fecha_programada": "2026-05-26",
        "monto_0": "500", "monto_1": "USD",
        "metodo": "transferencia",
        "referencia": "TR-001",
        "notas": "",
    })
    assert resp.status_code == 302
    p = Pago.objects.get(oc=oc, referencia="TR-001")
    assert p.fecha_realizada is None  # programado, no realizado


def test_lector_cannot_program_pago(client, oc):
    _login(client, "lector")
    resp = client.get(f"/compras/oc/{oc.pk}/pago/programar/")
    assert resp.status_code == 403


def test_supervisor_can_mark_pago_paid(client, oc):
    """Supervisor marca un pago programado como realizado y la OC transiciona."""
    from apps.compras.models import Pago

    p = Pago.objects.create(
        oc=oc, fecha_programada=date(2026, 5, 25),
        monto=Money(1000, "USD"), metodo="transferencia",
    )
    _login(client, "supervisor")
    resp = client.post(f"/compras/pago/{p.pk}/marcar-pagado/", {
        "fecha_realizada": "2026-05-26",
        "referencia": "TR-X",
    })
    assert resp.status_code == 302
    p.refresh_from_db()
    oc.refresh_from_db()
    assert p.fecha_realizada == date(2026, 5, 26)
    assert oc.estado == "pagada"


def test_operativo_cannot_mark_pago_paid(client, oc):
    """Operativo NO puede marcar pago como realizado (perm mark_paid solo supervisor)."""
    from apps.compras.models import Pago

    p = Pago.objects.create(
        oc=oc, fecha_programada=date(2026, 5, 25),
        monto=Money(500, "USD"), metodo="transferencia",
    )
    _login(client, "operativo")
    resp = client.get(f"/compras/pago/{p.pk}/marcar-pagado/")
    assert resp.status_code == 403


def test_mark_pago_paid_already_realizado_redirects(client, oc):
    """Si pago ya está realizado, vista redirige con warning (no toca BD)."""
    from apps.compras.models import Pago
    from django.contrib.auth import get_user_model

    user = get_user_model().objects.create_user("u_pre", password="pw")
    p = Pago.objects.create(
        oc=oc, fecha_programada=date(2026, 5, 25),
        fecha_realizada=date(2026, 5, 25),
        marcado_pagado_por=user,
        monto=Money(500, "USD"), metodo="transferencia",
    )
    _login(client, "supervisor")
    resp = client.get(f"/compras/pago/{p.pk}/marcar-pagado/")
    assert resp.status_code == 302  # redirect
