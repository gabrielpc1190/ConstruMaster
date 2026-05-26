import pytest
from auditlog.models import LogEntry

pytestmark = pytest.mark.django_db


def test_obra_creation_logged():
    from apps.core.models import Cliente, Obra
    c = Cliente.objects.create(nombre="Nicholas", identificacion="A-1")
    o = Obra.objects.create(cliente=c, nombre="Casa Lomas")
    logs = LogEntry.objects.get_for_object(o)
    assert logs.count() >= 1
    assert logs.first().action == LogEntry.Action.CREATE


def test_cliente_update_logged():
    from apps.core.models import Cliente
    c = Cliente.objects.create(nombre="Nicholas", identificacion="A-1")
    c.notas = "actualización de prueba"
    c.save()
    logs = LogEntry.objects.get_for_object(c)
    # 2 entries: CREATE + UPDATE
    assert logs.count() >= 2
    assert any(le.action == LogEntry.Action.UPDATE for le in logs)


def test_bodega_creation_logged():
    from apps.core.models import Cliente, Bodega
    c = Cliente.objects.create(nombre="N", identificacion="X")
    b = Bodega.objects.create(cliente=c, nombre="Cuarto X")
    logs = LogEntry.objects.get_for_object(b)
    assert logs.count() >= 1


def test_categoria_presupuesto_logged():
    from apps.core.models import Cliente, Obra, CategoriaPresupuesto
    c = Cliente.objects.create(nombre="N", identificacion="X")
    o = Obra.objects.create(cliente=c, nombre="O")
    cat = CategoriaPresupuesto.objects.create(obra=o, nombre="Estructura", orden=1)
    logs = LogEntry.objects.get_for_object(cat)
    assert logs.count() >= 1
