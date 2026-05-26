import pytest

pytestmark = pytest.mark.django_db


def test_proveedor_creation():
    from apps.catalogo.models import Proveedor
    p = Proveedor.objects.create(
        nombre="Materiales La Costa, S.A.",
        identificacion="3101698280",
        email_facturacion="fe@grupomateriales.com",
    )
    assert p.activo is True
    assert str(p) == "Materiales La Costa, S.A."


def test_item_catalogo_lazy_creation():
    from apps.catalogo.models import ItemCatalogo
    item = ItemCatalogo.objects.create(
        tipo="material",
        nombre_canonico="Cemento Sansón Tipo I 50kg",
        unidad="saco",
    )
    assert item.estado == "aprobado"  # default cuando lo crea supervisor
    assert item.slug == "cemento-sanson-tipo-i-50kg"


def test_item_catalogo_pendiente_por_operativo():
    from apps.catalogo.models import ItemCatalogo
    item = ItemCatalogo.objects.create(
        tipo="material",
        nombre_canonico="Varilla #4 grado 40",
        unidad="varilla",
        estado="pendiente",
    )
    assert item.estado == "pendiente"


def test_item_catalogo_tipo_servicio():
    from apps.catalogo.models import ItemCatalogo
    s = ItemCatalogo.objects.create(
        tipo="servicio",
        nombre_canonico="Instalación eléctrica (hora)",
        unidad="hora",
    )
    assert s.tipo == "servicio"


def test_item_catalogo_categoria_sugerida_optional():
    from apps.catalogo.models import ItemCatalogo
    from apps.core.models import Cliente, Obra, CategoriaPresupuesto
    cli = Cliente.objects.create(nombre="N", identificacion="X")
    o = Obra.objects.create(cliente=cli, nombre="O")
    cat = CategoriaPresupuesto.objects.create(obra=o, nombre="Estructura", orden=1)
    item = ItemCatalogo.objects.create(
        tipo="material", nombre_canonico="X", unidad="saco",
        categoria_sugerida=cat,
    )
    assert item.categoria_sugerida == cat


def test_item_catalogo_alias_blank_default():
    from apps.catalogo.models import ItemCatalogo
    item = ItemCatalogo.objects.create(
        tipo="material", nombre_canonico="Y", unidad="kg",
    )
    assert item.alias == ""
