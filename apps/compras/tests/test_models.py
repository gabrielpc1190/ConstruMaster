from decimal import Decimal
from datetime import date

import pytest
from djmoney.money import Money

pytestmark = pytest.mark.django_db


def test_solicitud_cotizacion_creation():
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.compras.models import SolicitudCotizacion
    from django.contrib.auth import get_user_model
    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    user = get_user_model().objects.create_user("u_rfq")
    s = SolicitudCotizacion.objects.create(
        obra=obra, categoria=cat,
        descripcion="Necesito cemento y varilla",
        fecha_requerida=date(2026, 6, 15),
        creada_por=user,
    )
    assert s.estado == "abierta"
    assert s.es_especial is False
    assert str(s) == f"RFQ-{s.pk} ({obra.nombre})"


def test_cotizacion_can_be_standalone():
    """Una Cotizacion puede crearse sin RFQ previo."""
    from apps.core.tests.factories import ObraFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import Cotizacion
    o = ObraFactory()
    p = ProveedorFactory()
    c = Cotizacion.objects.create(
        obra=o, proveedor=p, rfq=None,
        numero_cotizacion="COT-001", fecha=date.today(),
        total=Money(100_000, "CRC"),
        subtotal=Money(88_496, "CRC"), iva=Money(11_504, "CRC"),
    )
    assert c.rfq is None
    assert c.estado == "recibida"
    assert c.es_especial is False  # default


def test_cotizacion_es_especial_can_be_inherited_from_rfq():
    """Si RFQ es_especial=True, la cotización captura el flag al crearse."""
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import SolicitudCotizacion, Cotizacion
    from django.contrib.auth import get_user_model
    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    user = get_user_model().objects.create_user("u_esp")
    rfq = SolicitudCotizacion.objects.create(
        obra=obra, categoria=cat, descripcion="custom",
        fecha_requerida=date(2026, 6, 1), creada_por=user,
        es_especial=True,
    )
    p = ProveedorFactory()
    c = Cotizacion.objects.create(
        obra=obra, proveedor=p, rfq=rfq,
        numero_cotizacion="X", fecha=date.today(),
        total=Money(1, "CRC"), subtotal=Money(1, "CRC"), iva=Money(0, "CRC"),
        es_especial=rfq.es_especial,
    )
    assert c.es_especial is True


def test_cotizacion_item_with_catalogo():
    from apps.core.tests.factories import ObraFactory
    from apps.catalogo.tests.factories import ProveedorFactory, ItemCatalogoFactory
    from apps.compras.models import Cotizacion, CotizacionItem
    o = ObraFactory()
    p = ProveedorFactory()
    item_cat = ItemCatalogoFactory(nombre_canonico="Cemento Sansón 50kg", unidad="saco")
    c = Cotizacion.objects.create(
        obra=o, proveedor=p, numero_cotizacion="C1", fecha=date.today(),
        total=Money(100, "CRC"), subtotal=Money(100, "CRC"), iva=Money(0, "CRC"),
    )
    line = CotizacionItem.objects.create(
        cotizacion=c, material=item_cat,
        descripcion="Cemento Sansón 50kg",
        cantidad=Decimal("100.0000"),
        unidad="saco",
        precio_unitario=Decimal("8500.00000"),
        subtotal=Decimal("850000.00"),
        iva_monto=Decimal("110500.00"),
        orden=1,
    )
    assert line.material == item_cat
    assert line.precio_unitario == Decimal("8500.00000")


def test_cotizacion_item_custom_without_catalogo():
    """Items custom no requieren FK a ItemCatalogo (material nullable)."""
    from apps.core.tests.factories import ObraFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import Cotizacion, CotizacionItem
    o = ObraFactory()
    p = ProveedorFactory()
    c = Cotizacion.objects.create(
        obra=o, proveedor=p, numero_cotizacion="C2", fecha=date.today(),
        total=Money(1, "CRC"), subtotal=Money(1, "CRC"), iva=Money(0, "CRC"),
    )
    line = CotizacionItem.objects.create(
        cotizacion=c, material=None,
        descripcion="Puerta hecha a la medida 1.20x2.10m",
        cantidad=Decimal("1.0000"),
        unidad="unidad",
        precio_unitario=Decimal("250000.00000"),
        subtotal=Decimal("250000.00"),
        iva_monto=Decimal("32500.00"),
        orden=1,
    )
    assert line.material is None


def test_cotizacion_approve_permission_exists():
    """Custom permission 'approve_cotizacion' definida en Meta."""
    from django.contrib.auth.models import Permission
    assert Permission.objects.filter(codename="approve_cotizacion").exists()
