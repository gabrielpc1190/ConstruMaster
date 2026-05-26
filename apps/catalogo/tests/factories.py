"""Factories para tests de apps.catalogo."""
import factory
from factory.django import DjangoModelFactory


class ProveedorFactory(DjangoModelFactory):
    class Meta:
        model = "catalogo.Proveedor"

    nombre = factory.Sequence(lambda n: f"Proveedor {n}")
    identificacion = factory.Sequence(lambda n: f"3101{n:06d}")


class ItemCatalogoFactory(DjangoModelFactory):
    class Meta:
        model = "catalogo.ItemCatalogo"

    tipo = "material"
    nombre_canonico = factory.Sequence(lambda n: f"Item {n}")
    unidad = "unidad"
    estado = "aprobado"
