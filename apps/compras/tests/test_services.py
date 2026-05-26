import pytest

from datetime import date
from decimal import Decimal
from djmoney.money import Money

pytestmark = pytest.mark.django_db


def test_generate_numero_oc_secuencial():
    """Secuencia 0001, 0002, 0003 para la misma obra."""
    from apps.core.tests.factories import ObraFactory
    from apps.compras.services import generate_numero_oc

    obra = ObraFactory(nombre="Casa Lomas")
    n1 = generate_numero_oc(obra.pk)
    n2 = generate_numero_oc(obra.pk)
    n3 = generate_numero_oc(obra.pk)
    obra.refresh_from_db()
    assert n1.endswith("-OC-0001")
    assert n2.endswith("-OC-0002")
    assert n3.endswith("-OC-0003")
    assert obra.next_oc_seq == 4


def test_generate_numero_oc_separado_por_obra():
    """Cada obra tiene su propia secuencia independiente."""
    from apps.core.tests.factories import ObraFactory
    from apps.compras.services import generate_numero_oc

    o1 = ObraFactory(nombre="Lomas")
    o2 = ObraFactory(nombre="Baches")
    n1a = generate_numero_oc(o1.pk)
    n2a = generate_numero_oc(o2.pk)
    n1b = generate_numero_oc(o1.pk)

    # Cada obra arranca en 0001
    assert n1a.endswith("-OC-0001")
    assert n2a.endswith("-OC-0001")
    # Lomas se incrementa a 0002
    assert n1b.endswith("-OC-0002")
    # Los slug en uppercase deben aparecer
    assert "LOMAS" in n1a.upper()
    assert "BACHES" in n2a.upper()


def test_generate_numero_oc_format():
    """Formato debe ser <SLUG_UPPER>-OC-NNNN con padding 4 dígitos."""
    from apps.core.tests.factories import ObraFactory
    from apps.compras.services import generate_numero_oc

    obra = ObraFactory(nombre="Casa Lomas 2026")
    n = generate_numero_oc(obra.pk)
    # slug: casa-lomas-2026 → CASA-LOMAS-2026
    assert n == "CASA-LOMAS-2026-OC-0001"


def test_generate_numero_oc_uses_select_for_update():
    """Smoke test: la función está dentro de transaction.atomic + select_for_update.

    No es un test de race real (eso requiere threading), solo verifica que
    el incremento es persistente en BD (Obra.next_oc_seq sube).
    """
    from apps.core.tests.factories import ObraFactory
    from apps.compras.services import generate_numero_oc

    obra = ObraFactory(nombre="Test Lock")
    initial_seq = obra.next_oc_seq
    generate_numero_oc(obra.pk)
    obra.refresh_from_db()
    assert obra.next_oc_seq == initial_seq + 1


@pytest.fixture
def tc_25_may(db):
    """TC USD para snapshot al aprobar."""
    from apps.finance.models import ExchangeRate
    return ExchangeRate.objects.create(
        currency="USD", date=date(2026, 5, 25),
        buy=Decimal("447.5"), sell=Decimal("454.82"),
    )


def test_approve_cotizacion_creates_oc_with_snapshot(tc_25_may):
    """Approve aprobaba: crea OC + items snapshot + fx snapshot + estado=aprobada."""
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory, ItemCatalogoFactory
    from apps.compras.models import Cotizacion, CotizacionItem
    from apps.compras.services import approve_cotizacion
    from django.contrib.auth import get_user_model

    obra = ObraFactory(nombre="Casa Lomas")
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    item_cat = ItemCatalogoFactory(nombre_canonico="Cemento", unidad="saco")

    c = Cotizacion.objects.create(
        obra=obra, proveedor=prov,
        numero_cotizacion="X", fecha=date(2026, 5, 25),
        moneda="USD",
        subtotal=Money(1000, "USD"), iva=Money(130, "USD"), total=Money(1130, "USD"),
    )
    CotizacionItem.objects.create(
        cotizacion=c, material=item_cat,
        descripcion="Cemento Sansón", cantidad=Decimal("10"),
        unidad="saco", precio_unitario=Decimal("100"),
        subtotal=Decimal("1000"), iva_monto=Decimal("130"), orden=1,
    )

    user = get_user_model().objects.create_user("diana_approve")
    oc = approve_cotizacion(c, categoria=cat, approver=user, fecha_aprobacion=date(2026, 5, 25))

    assert oc.numero_oc.endswith("-OC-0001")
    assert oc.estado == "autorizada"
    assert oc.fx_rate_applied == Decimal("454.82000")
    assert oc.fx_rate_date == date(2026, 5, 25)
    assert oc.aprobada_por == user
    assert oc.cotizacion_origen == c
    assert oc.items.count() == 1
    line = oc.items.first()
    assert line.material_nombre_snapshot == "Cemento"
    assert line.material_unidad_snapshot == "saco"
    assert line.descripcion == "Cemento Sansón"

    c.refresh_from_db()
    assert c.estado == "aprobada"


def test_approve_cotizacion_inherits_es_especial(tc_25_may):
    """Si la cotización es_especial=True, la OC también."""
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import Cotizacion
    from apps.compras.services import approve_cotizacion
    from django.contrib.auth import get_user_model

    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    c = Cotizacion.objects.create(
        obra=obra, proveedor=prov, numero_cotizacion="Y",
        fecha=date(2026, 5, 25),
        subtotal=Money(1, "CRC"), iva=Money(0, "CRC"), total=Money(1, "CRC"),
        es_especial=True,
        plazo_entrega_dias=30,
        pct_anticipo=Decimal("50.00"),
    )
    user = get_user_model().objects.create_user("u_especial")
    oc = approve_cotizacion(c, categoria=cat, approver=user, fecha_aprobacion=date(2026, 5, 25))
    assert oc.es_especial is True
    assert oc.tiempo_estimado_dias == 30
    assert oc.pct_anticipo == Decimal("50.00")


def test_approve_cotizacion_already_approved_raises(tc_25_may):
    """No re-aprobar una cotización ya aprobada/rechazada/vencida."""
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import Cotizacion
    from apps.compras.services import approve_cotizacion, AlreadyApproved
    from django.contrib.auth import get_user_model

    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    c = Cotizacion.objects.create(
        obra=obra, proveedor=prov, numero_cotizacion="Z",
        fecha=date(2026, 5, 25),
        subtotal=Money(1, "CRC"), iva=Money(0, "CRC"), total=Money(1, "CRC"),
        estado="aprobada",
    )
    user = get_user_model().objects.create_user("u_repe")
    with pytest.raises(AlreadyApproved):
        approve_cotizacion(c, categoria=cat, approver=user, fecha_aprobacion=date.today())


def test_approve_cotizacion_closes_rfq(tc_25_may):
    """Si la cotización viene de un RFQ, cerrar el RFQ al aprobar."""
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import SolicitudCotizacion, Cotizacion
    from apps.compras.services import approve_cotizacion
    from django.contrib.auth import get_user_model

    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    user = get_user_model().objects.create_user("u_rfq_close")
    rfq = SolicitudCotizacion.objects.create(
        obra=obra, categoria=cat, descripcion="X",
        fecha_requerida=date(2026, 6, 1), creada_por=user,
    )
    c = Cotizacion.objects.create(
        obra=obra, proveedor=ProveedorFactory(), rfq=rfq,
        numero_cotizacion="A", fecha=date(2026, 5, 25),
        subtotal=Money(1, "CRC"), iva=Money(0, "CRC"), total=Money(1, "CRC"),
    )
    approve_cotizacion(c, categoria=cat, approver=user, fecha_aprobacion=date(2026, 5, 25))
    rfq.refresh_from_db()
    assert rfq.estado == "cerrada"


def test_approve_cotizacion_crc_no_fx_snapshot(tc_25_may):
    """Cotización en CRC NO captura fx_rate (no aplica)."""
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import Cotizacion
    from apps.compras.services import approve_cotizacion
    from django.contrib.auth import get_user_model

    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    c = Cotizacion.objects.create(
        obra=obra, proveedor=prov, numero_cotizacion="W",
        fecha=date(2026, 5, 25),
        moneda="CRC",
        subtotal=Money(100, "CRC"), iva=Money(13, "CRC"), total=Money(113, "CRC"),
    )
    user = get_user_model().objects.create_user("u_crc")
    oc = approve_cotizacion(c, categoria=cat, approver=user, fecha_aprobacion=date(2026, 5, 25))
    assert oc.fx_rate_applied is None
    assert oc.fx_rate_date is None


def test_presupuesto_status_verde(tc_25_may):
    """0% consumido → semaforo verde."""
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.core.models import Presupuesto
    from apps.compras.services import presupuesto_status

    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    Presupuesto.objects.create(obra=obra, categoria=cat, monto=Money(1_000_000, "CRC"))

    status = presupuesto_status(obra, cat)
    assert status is not None
    assert status["semaforo"] == "verde"
    assert status["porcentaje"] == 0.0


def test_presupuesto_status_amarillo_naranja_rojo(tc_25_may):
    """Semáforos 70/90/100 según porcentaje."""
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.core.models import Presupuesto
    from apps.compras.models import OrdenCompra
    from apps.compras.services import presupuesto_status

    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    Presupuesto.objects.create(obra=obra, categoria=cat, monto=Money(1000, "CRC"))
    prov = ProveedorFactory()

    # 800/1000 = 80% → amarillo (>70%)
    OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="A-OC-0001", fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(800, "CRC"), estado="autorizada",
    )
    status = presupuesto_status(obra, cat)
    assert status["semaforo"] == "amarillo"
    assert 70 < status["porcentaje"] < 90

    # +150 = 950/1000 = 95% → naranja (>90%)
    OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="A-OC-0002", fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(150, "CRC"), estado="autorizada",
    )
    status = presupuesto_status(obra, cat)
    assert status["semaforo"] == "naranja"

    # +100 = 1050/1000 = 105% → rojo (>100%)
    OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="A-OC-0003", fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(100, "CRC"), estado="autorizada",
    )
    status = presupuesto_status(obra, cat)
    assert status["semaforo"] == "rojo"
    assert status["porcentaje"] > 100


def test_presupuesto_status_excludes_cancelled(tc_25_may):
    """OCs canceladas NO cuentan."""
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.core.models import Presupuesto
    from apps.compras.models import OrdenCompra
    from apps.compras.services import presupuesto_status

    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    Presupuesto.objects.create(obra=obra, categoria=cat, monto=Money(1000, "CRC"))
    prov = ProveedorFactory()
    # OC autorizada que SÍ cuenta
    OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="X-OC-0001", fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(500, "CRC"), estado="autorizada",
    )
    # OC cancelada NO cuenta
    OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="X-OC-0002", fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(500, "CRC"), estado="cancelada",
    )
    status = presupuesto_status(obra, cat)
    assert status["porcentaje"] == 50.0  # solo 500/1000


def test_presupuesto_status_no_budget_returns_none():
    """Sin presupuesto definido para esa categoría → None (no error)."""
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.compras.services import presupuesto_status

    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    status = presupuesto_status(obra, cat)
    assert status is None


def test_presupuesto_status_normaliza_moneda(tc_25_may):
    """OC en USD se normaliza a CRC (moneda del presupuesto) via convert()."""
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.core.models import Presupuesto
    from apps.compras.models import OrdenCompra
    from apps.compras.services import presupuesto_status

    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    Presupuesto.objects.create(obra=obra, categoria=cat, monto=Money(1_000_000, "CRC"))
    prov = ProveedorFactory()
    # OC USD: 1000 USD * 454.82 = 454820 CRC = 45.48% del presupuesto
    OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="U-OC-0001", fecha_aprobacion=date(2026, 5, 25),
        moneda="USD",
        monto_total=Money(1000, "USD"),
        fx_rate_applied=Decimal("454.82"),
        fx_rate_date=date(2026, 5, 25),
        estado="autorizada",
    )
    status = presupuesto_status(obra, cat)
    # Debe estar cerca de 45.48%
    assert 45.0 < status["porcentaje"] < 46.0
    assert status["semaforo"] == "verde"
