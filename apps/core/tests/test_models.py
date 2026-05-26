import pytest
from django.db import IntegrityError

pytestmark = pytest.mark.django_db


def test_cliente_creation():
    from apps.core.models import Cliente
    c = Cliente.objects.create(
        nombre="Nicholas Charles Rowley",
        identificacion="A-1234567",
    )
    assert c.pk is not None
    assert str(c) == "Nicholas Charles Rowley"


def test_cliente_nombre_required():
    from apps.core.models import Cliente
    with pytest.raises(IntegrityError):
        Cliente.objects.create(nombre="", identificacion="A-001")


def test_obra_auto_slug():
    from apps.core.models import Cliente, Obra
    c = Cliente.objects.create(nombre="Nicholas", identificacion="A-1")
    o = Obra.objects.create(cliente=c, nombre="Casa Lomas 2026")
    assert o.slug == "casa-lomas-2026"


def test_obra_next_oc_seq_starts_at_1():
    from apps.core.models import Cliente, Obra
    c = Cliente.objects.create(nombre="Nicholas", identificacion="A-1")
    o = Obra.objects.create(cliente=c, nombre="Casa Bache")
    assert o.next_oc_seq == 1


def test_obra_str_includes_cliente():
    from apps.core.models import Cliente, Obra
    c = Cliente.objects.create(nombre="Nicholas", identificacion="A-1")
    o = Obra.objects.create(cliente=c, nombre="Casa Lomas")
    assert str(o) == "Casa Lomas (Nicholas)"
