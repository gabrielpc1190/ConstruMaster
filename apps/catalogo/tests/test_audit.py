import pytest
from auditlog.models import LogEntry

pytestmark = pytest.mark.django_db


def test_proveedor_creation_logged():
    from apps.catalogo.models import Proveedor
    p = Proveedor.objects.create(nombre="Materiales La Costa", identificacion="3101698280")
    logs = LogEntry.objects.get_for_object(p)
    assert logs.count() >= 1
    assert logs.first().action == LogEntry.Action.CREATE


def test_item_catalogo_logged():
    from apps.catalogo.models import ItemCatalogo
    item = ItemCatalogo.objects.create(
        tipo="material", nombre_canonico="Cemento X", unidad="saco",
    )
    logs = LogEntry.objects.get_for_object(item)
    assert logs.count() >= 1
