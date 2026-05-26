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


def test_categoria_presupuesto_por_obra():
    from apps.core.models import Cliente, Obra, CategoriaPresupuesto
    c = Cliente.objects.create(nombre="Nicholas", identificacion="A-1")
    o = Obra.objects.create(cliente=c, nombre="Casa Lomas")
    cat = CategoriaPresupuesto.objects.create(obra=o, nombre="Estructura", orden=1)
    assert cat.obra == o
    assert str(cat) == "Estructura (Casa Lomas (Nicholas))"


def test_categoria_unique_per_obra():
    from apps.core.models import Cliente, Obra, CategoriaPresupuesto
    from django.db import IntegrityError
    c = Cliente.objects.create(nombre="N", identificacion="X")
    o = Obra.objects.create(cliente=c, nombre="O")
    CategoriaPresupuesto.objects.create(obra=o, nombre="Estructura", orden=1)
    with pytest.raises(IntegrityError):
        CategoriaPresupuesto.objects.create(obra=o, nombre="Estructura", orden=2)


def test_presupuesto_creation():
    from apps.core.models import Cliente, Obra, CategoriaPresupuesto, Presupuesto
    from djmoney.money import Money
    c = Cliente.objects.create(nombre="Nicholas", identificacion="A-1")
    o = Obra.objects.create(cliente=c, nombre="Casa Lomas")
    cat = CategoriaPresupuesto.objects.create(obra=o, nombre="Estructura", orden=1)
    p = Presupuesto.objects.create(obra=o, categoria=cat, monto=Money(10_000_000, "CRC"))
    assert p.monto.amount == 10_000_000
    assert p.monto.currency.code == "CRC"
    assert "Estructura" in str(p) and "₡" in str(p)


def test_presupuesto_unique_per_obra_categoria():
    from apps.core.models import Cliente, Obra, CategoriaPresupuesto, Presupuesto
    from djmoney.money import Money
    from django.db import IntegrityError
    c = Cliente.objects.create(nombre="N", identificacion="X")
    o = Obra.objects.create(cliente=c, nombre="O")
    cat = CategoriaPresupuesto.objects.create(obra=o, nombre="Cat", orden=1)
    Presupuesto.objects.create(obra=o, categoria=cat, monto=Money(1, "CRC"))
    with pytest.raises(IntegrityError):
        Presupuesto.objects.create(obra=o, categoria=cat, monto=Money(2, "CRC"))


def test_bodega_pertenece_a_cliente():
    from apps.core.models import Cliente, Bodega
    c = Cliente.objects.create(nombre="Nicholas", identificacion="A-1")
    b = Bodega.objects.create(cliente=c, nombre="Cuarto Eléctrico GADI")
    assert b.cliente == c
    assert b.activo is True
    assert str(b) == "Cuarto Eléctrico GADI (Nicholas)"


def test_bodega_unique_per_cliente():
    from apps.core.models import Cliente, Bodega
    from django.db import IntegrityError
    c = Cliente.objects.create(nombre="N", identificacion="X")
    Bodega.objects.create(cliente=c, nombre="B1")
    with pytest.raises(IntegrityError):
        Bodega.objects.create(cliente=c, nombre="B1")


def test_bodega_responsable_optional():
    from apps.core.models import Cliente, Bodega
    c = Cliente.objects.create(nombre="N", identificacion="X")
    b = Bodega.objects.create(cliente=c, nombre="B1")
    assert b.responsable is None  # responsable es nullable


def test_bodega_protege_cliente_de_borrado():
    """No se puede borrar Cliente que tiene Bodegas (PROTECT)."""
    from apps.core.models import Cliente, Bodega
    from django.db.models import ProtectedError
    c = Cliente.objects.create(nombre="N", identificacion="X")
    Bodega.objects.create(cliente=c, nombre="B1")
    with pytest.raises(ProtectedError):
        c.delete()
