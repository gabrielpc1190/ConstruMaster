from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group

pytestmark = pytest.mark.django_db


def _login(client, group="operativo"):
    User = get_user_model()
    u = User.objects.create_user(username=f"x_{group}", password="pw")
    u.groups.add(Group.objects.get(name=group))
    client.login(username=f"x_{group}", password="pw")
    return u


def test_rfq_create_view_supervisor(client):
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    _login(client, "supervisor")
    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    resp = client.post("/compras/rfq/new/", {
        "obra": obra.pk, "categoria": cat.pk,
        "descripcion": "Compra de cemento",
        "fecha_requerida": "2026-06-01",
        "es_especial": "",
    })
    assert resp.status_code == 302  # redirect a detail


def test_rfq_create_requires_permission(client):
    """Lector no puede crear RFQ."""
    _login(client, "lector")
    resp = client.get("/compras/rfq/new/")
    assert resp.status_code == 403


def test_rfq_detail_view(client):
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.compras.models import SolicitudCotizacion
    u = _login(client, "supervisor")
    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    rfq = SolicitudCotizacion.objects.create(
        obra=obra, categoria=cat, descripcion="Test",
        fecha_requerida=date(2026, 6, 1), creada_por=u,
    )
    resp = client.get(f"/compras/rfq/{rfq.pk}/")
    assert resp.status_code == 200
    assert "Test" in resp.content.decode()


def test_cotizacion_detail_view(client):
    from apps.core.tests.factories import ObraFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import Cotizacion
    from djmoney.money import Money
    _login(client, "supervisor")
    obra = ObraFactory()
    prov = ProveedorFactory()
    cot = Cotizacion.objects.create(
        obra=obra, proveedor=prov, numero_cotizacion="COT-X",
        fecha=date(2026, 5, 25),
        subtotal=Money(100, "CRC"), iva=Money(13, "CRC"), total=Money(113, "CRC"),
    )
    resp = client.get(f"/compras/cotizacion/{cot.pk}/")
    assert resp.status_code == 200
    assert "COT-X" in resp.content.decode()


def test_comparativa_view(client):
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import SolicitudCotizacion, Cotizacion
    from djmoney.money import Money
    u = _login(client, "supervisor")
    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    rfq = SolicitudCotizacion.objects.create(
        obra=obra, categoria=cat, descripcion="X",
        fecha_requerida=date(2026, 6, 1), creada_por=u,
    )
    # 2 cotizaciones
    for i in range(2):
        Cotizacion.objects.create(
            obra=obra, proveedor=ProveedorFactory(),
            rfq=rfq, numero_cotizacion=f"COT-{i}",
            fecha=date(2026, 5, 25),
            subtotal=Money(100, "CRC"), iva=Money(13, "CRC"), total=Money(113, "CRC"),
        )
    resp = client.get(f"/compras/rfq/{rfq.pk}/comparativa/")
    assert resp.status_code == 200
    body = resp.content.decode()
    assert "COT-0" in body
    assert "COT-1" in body


def test_lector_can_view_cotizacion(client):
    """Lector tiene permission view_cotizacion."""
    from apps.core.tests.factories import ObraFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import Cotizacion
    from djmoney.money import Money
    _login(client, "lector")
    obra = ObraFactory()
    prov = ProveedorFactory()
    cot = Cotizacion.objects.create(
        obra=obra, proveedor=prov, numero_cotizacion="VC",
        fecha=date.today(),
        subtotal=Money(1, "CRC"), iva=Money(0, "CRC"), total=Money(1, "CRC"),
    )
    resp = client.get(f"/compras/cotizacion/{cot.pk}/")
    assert resp.status_code == 200
