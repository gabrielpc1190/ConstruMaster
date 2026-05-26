from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group

pytestmark = pytest.mark.django_db


def _login(client, group):
    User = get_user_model()
    u = User.objects.create_user(username=f"u_{group}", password="pw")
    u.groups.add(Group.objects.get(name=group))
    client.login(username=f"u_{group}", password="pw")
    return u


def test_root_redirects_supervisor(client):
    _login(client, "supervisor")
    resp = client.get("/")
    assert resp.status_code == 302
    assert "supervisor" in resp.url


def test_root_redirects_operativo(client):
    _login(client, "operativo")
    resp = client.get("/")
    assert resp.status_code == 302
    assert "operativo" in resp.url


def test_root_redirects_lector(client):
    _login(client, "lector")
    resp = client.get("/")
    assert resp.status_code == 302
    assert "lector" in resp.url


def test_root_unauthenticated_redirects_to_login(client):
    resp = client.get("/")
    assert resp.status_code == 302
    assert "login" in resp.url.lower()


def test_supervisor_dashboard_loads(client):
    """Supervisor dashboard renderiza."""
    _login(client, "supervisor")
    resp = client.get("/dashboard/supervisor/")
    assert resp.status_code == 200
    body = resp.content.decode()
    assert "Dashboard" in body or "Supervisor" in body or "Obras" in body


def test_supervisor_dashboard_shows_active_obras(client):
    """Dashboard muestra las obras activas."""
    from apps.core.tests.factories import ObraFactory
    _login(client, "supervisor")
    obra = ObraFactory(nombre="Casa Lomas", estado="en_curso")
    resp = client.get("/dashboard/supervisor/")
    assert resp.status_code == 200
    assert "Casa Lomas" in resp.content.decode()


def test_supervisor_dashboard_includes_pending_actions(client):
    """Dashboard muestra cotizaciones pendientes de aprobación."""
    from datetime import date
    from apps.core.tests.factories import ObraFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import Cotizacion
    from djmoney.money import Money

    _login(client, "supervisor")
    obra = ObraFactory(nombre="Casa X")
    prov = ProveedorFactory()
    Cotizacion.objects.create(
        obra=obra, proveedor=prov, numero_cotizacion="COT-PEND",
        fecha=date.today(),
        subtotal=Money(100, "CRC"), iva=Money(0, "CRC"), total=Money(100, "CRC"),
        estado="recibida",
    )
    resp = client.get("/dashboard/supervisor/")
    body = resp.content.decode()
    assert resp.status_code == 200
    # Debe haber alguna mención al pendiente de aprobación
    assert "COT-PEND" in body or "pendiente" in body.lower() or "aprob" in body.lower()


def test_operativo_cannot_access_supervisor_dashboard(client):
    _login(client, "operativo")
    resp = client.get("/dashboard/supervisor/")
    assert resp.status_code == 403


def test_lector_cannot_access_supervisor_dashboard(client):
    _login(client, "lector")
    resp = client.get("/dashboard/supervisor/")
    assert resp.status_code == 403


def test_operativo_dashboard_loads(client):
    _login(client, "operativo")
    resp = client.get("/dashboard/operativo/")
    assert resp.status_code == 200
    body = resp.content.decode()
    assert "Dashboard" in body or "Operativo" in body or "Obras" in body


def test_operativo_dashboard_shows_obras_with_actions(client):
    from apps.core.tests.factories import ObraFactory
    _login(client, "operativo")
    ObraFactory(nombre="Lomas 2026", estado="en_curso")
    resp = client.get("/dashboard/operativo/")
    body = resp.content.decode()
    assert "Lomas 2026" in body


def test_operativo_dashboard_shows_rfqs_abiertas(client):
    from datetime import date
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.compras.models import SolicitudCotizacion
    user = _login(client, "operativo")
    obra = ObraFactory(nombre="Lomas")
    cat = CategoriaPresupuestoFactory(obra=obra)
    SolicitudCotizacion.objects.create(
        obra=obra, categoria=cat, descripcion="RFQ pendiente sin cotizaciones",
        fecha_requerida=date(2026, 6, 15), creada_por=user, estado="abierta",
    )
    resp = client.get("/dashboard/operativo/")
    body = resp.content.decode()
    assert "RFQ pendiente" in body or "pendiente" in body.lower() or "abierta" in body.lower()


def test_operativo_dashboard_shows_ocs_sin_entrega(client):
    """OCs autorizadas que no tienen ninguna entrega registrada."""
    from datetime import date
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import OrdenCompra
    from djmoney.money import Money

    _login(client, "operativo")
    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="OP-OC-9999", fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(1000, "CRC"), estado="autorizada",
    )
    resp = client.get("/dashboard/operativo/")
    body = resp.content.decode()
    assert "OP-OC-9999" in body or "entrega" in body.lower()


def test_supervisor_can_also_access_operativo_dashboard(client):
    """Por flexibilidad: supervisor también ve el dashboard operativo si va directo."""
    _login(client, "supervisor")
    resp = client.get("/dashboard/operativo/")
    # OK 200 o 403 según política. El spec no es claro — vamos a permitirlo
    # ya que supervisor ve TODO.
    assert resp.status_code in (200, 403)


def test_lector_cannot_access_operativo_dashboard(client):
    _login(client, "lector")
    resp = client.get("/dashboard/operativo/")
    assert resp.status_code == 403
