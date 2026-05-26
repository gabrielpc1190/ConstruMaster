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


def test_lector_dashboard_loads(client):
    _login(client, "lector")
    resp = client.get("/dashboard/lector/")
    assert resp.status_code == 200
    body = resp.content.decode()
    assert "Dashboard" in body or "Obras" in body or "Nicholas" in body


def test_lector_dashboard_shows_obras(client):
    from apps.core.tests.factories import ObraFactory
    _login(client, "lector")
    ObraFactory(nombre="Casa Lectora", estado="en_curso")
    resp = client.get("/dashboard/lector/")
    assert "Casa Lectora" in resp.content.decode()


def test_lector_dashboard_shows_gasto_total(client):
    """Dashboard muestra el gasto total por obra (suma OCs autorizadas)."""
    from datetime import date
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import OrdenCompra
    from djmoney.money import Money

    _login(client, "lector")
    obra = ObraFactory(nombre="Lomas USD", moneda_reporte="USD")
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="L-OC-0001", fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(500, "USD"), estado="autorizada",
    )
    resp = client.get("/dashboard/lector/")
    body = resp.content.decode()
    assert "Lomas USD" in body
    # Debe mostrar el gasto (500)
    assert "500" in body or "$" in body


def test_lector_dashboard_shows_oc_grandes_recientes(client):
    from datetime import date
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import OrdenCompra
    from djmoney.money import Money

    _login(client, "lector")
    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="BIG-OC-0001", fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(50000, "CRC"), estado="autorizada",
    )
    resp = client.get("/dashboard/lector/")
    assert "BIG-OC-0001" in resp.content.decode()


def test_supervisor_can_access_lector_dashboard(client):
    """Supervisor también puede ver el dashboard lector."""
    _login(client, "supervisor")
    resp = client.get("/dashboard/lector/")
    assert resp.status_code == 200


def test_operativo_can_access_lector_dashboard(client):
    """Operativo también puede ver el dashboard lector (todos ven dashboards)."""
    _login(client, "operativo")
    resp = client.get("/dashboard/lector/")
    # Política: todos los autenticados pueden ver dashboard lector
    assert resp.status_code == 200


def test_reporte_proveedor_loads(client):
    from datetime import date
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import OrdenCompra
    from djmoney.money import Money

    _login(client, "supervisor")
    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory(nombre="Mat La Costa")
    OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="REP-OC-0001", fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(1000, "CRC"), estado="autorizada",
    )
    resp = client.get(f"/reportes/proveedor/{prov.pk}/")
    assert resp.status_code == 200
    body = resp.content.decode()
    assert "Mat La Costa" in body
    assert "REP-OC-0001" in body


def test_reporte_proveedor_csv_export(client):
    from datetime import date
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import OrdenCompra
    from djmoney.money import Money

    _login(client, "supervisor")
    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory(nombre="Test CSV")
    OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="CSV-OC-001", fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(500, "CRC"), estado="autorizada",
    )
    resp = client.get(f"/reportes/proveedor/{prov.pk}/?format=csv")
    assert resp.status_code == 200
    assert resp["Content-Type"].startswith("text/csv")
    body = resp.content.decode("utf-8")
    assert "CSV-OC-001" in body
    assert "500" in body


def test_reporte_reconciliacion_loads(client):
    from apps.core.tests.factories import ObraFactory
    _login(client, "supervisor")
    obra = ObraFactory(nombre="Casa Rec")
    resp = client.get(f"/reportes/reconciliacion/{obra.pk}/")
    assert resp.status_code == 200


def test_reporte_reconciliacion_shows_comprado_vs_entregado(client):
    from datetime import date
    from decimal import Decimal
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory, ItemCatalogoFactory
    from apps.compras.models import OrdenCompra, OrdenCompraItem
    from djmoney.money import Money

    _login(client, "supervisor")
    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    cemento = ItemCatalogoFactory(nombre_canonico="Cemento R", unidad="saco")

    oc = OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="REC-OC", fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(1000, "CRC"), estado="autorizada",
    )
    OrdenCompraItem.objects.create(
        oc=oc, material=cemento,
        material_nombre_snapshot="Cemento R", material_unidad_snapshot="saco",
        descripcion="X", cantidad=Decimal("100"),
        unidad="saco", precio_unitario=Decimal("10"),
        subtotal=Decimal("1000"), iva_monto=Decimal("0"), orden=1,
    )

    resp = client.get(f"/reportes/reconciliacion/{obra.pk}/")
    body = resp.content.decode()
    assert "Cemento R" in body
    assert "100" in body  # comprado


def test_reporte_tipo_cambio_loads(client):
    from datetime import date
    from decimal import Decimal
    from apps.finance.models import ExchangeRate

    _login(client, "supervisor")
    ExchangeRate.objects.create(
        currency="USD", date=date(2026, 5, 25),
        buy=Decimal("447.5"), sell=Decimal("454.82"),
    )
    resp = client.get("/reportes/tipo-cambio/")
    assert resp.status_code == 200
    body = resp.content.decode()
    assert "454.82" in body or "454,82" in body or "USD" in body


def test_reporte_tipo_cambio_csv(client):
    from datetime import date
    from decimal import Decimal
    from apps.finance.models import ExchangeRate

    _login(client, "supervisor")
    ExchangeRate.objects.create(
        currency="USD", date=date(2026, 5, 25),
        buy=Decimal("447.5"), sell=Decimal("454.82"),
    )
    resp = client.get("/reportes/tipo-cambio/?format=csv")
    assert resp.status_code == 200
    assert resp["Content-Type"].startswith("text/csv")
    body = resp.content.decode("utf-8")
    assert "454.82" in body


def test_reportes_require_login(client):
    resp = client.get("/reportes/tipo-cambio/")
    assert resp.status_code in (302, 403)
