"""Factories para tests de apps.core."""
import factory
from factory.django import DjangoModelFactory


class ClienteFactory(DjangoModelFactory):
    class Meta:
        model = "core.Cliente"

    nombre = factory.Sequence(lambda n: f"Cliente {n}")
    identificacion = factory.Sequence(lambda n: f"X-{n:06d}")


class ObraFactory(DjangoModelFactory):
    class Meta:
        model = "core.Obra"

    cliente = factory.SubFactory(ClienteFactory)
    nombre = factory.Sequence(lambda n: f"Obra {n}")
    estado = "en_curso"


class CategoriaPresupuestoFactory(DjangoModelFactory):
    class Meta:
        model = "core.CategoriaPresupuesto"

    obra = factory.SubFactory(ObraFactory)
    nombre = factory.Iterator(["Estructura", "Acabados", "Instalaciones", "Indirectos"])
    orden = factory.Sequence(lambda n: n)


class BodegaFactory(DjangoModelFactory):
    class Meta:
        model = "core.Bodega"

    cliente = factory.SubFactory(ClienteFactory)
    nombre = factory.Sequence(lambda n: f"Bodega {n}")
