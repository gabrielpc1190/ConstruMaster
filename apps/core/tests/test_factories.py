import pytest

pytestmark = pytest.mark.django_db


def test_cliente_factory():
    from apps.core.tests.factories import ClienteFactory
    c = ClienteFactory()
    assert c.pk is not None
    assert c.nombre.startswith("Cliente ")


def test_obra_factory_creates_cliente_auto():
    from apps.core.tests.factories import ObraFactory
    o = ObraFactory()
    assert o.pk is not None
    assert o.cliente is not None
    assert o.estado == "en_curso"


def test_categoria_presupuesto_factory():
    from apps.core.tests.factories import CategoriaPresupuestoFactory
    cat = CategoriaPresupuestoFactory()
    assert cat.pk is not None
    assert cat.obra is not None
    assert cat.nombre in ["Estructura", "Acabados", "Instalaciones", "Indirectos"]


def test_bodega_factory():
    from apps.core.tests.factories import BodegaFactory
    b = BodegaFactory()
    assert b.pk is not None
    assert b.cliente is not None


def test_factories_create_independent_instances():
    """Verificar que crear 2 factories no genera unique_together collision."""
    from apps.core.tests.factories import ObraFactory
    o1 = ObraFactory()
    o2 = ObraFactory()
    assert o1.cliente != o2.cliente  # SubFactory crea nuevos clientes cada vez
    assert o1.slug != o2.slug
