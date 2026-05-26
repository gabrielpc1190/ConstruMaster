"""Seed inicial de datos: Cliente Nicholas + 3 bodegas iniciales del cliente."""
from django.core.management.base import BaseCommand
from django.db import transaction

from apps.core.models import Cliente, Bodega


BODEGAS_INICIALES = [
    "Cuarto Eléctrico GADI",
    "Cuarto 4 del Bache",
    "Bodega Baches",
]


class Command(BaseCommand):
    help = "Crea el cliente Nicholas Rowley y sus bodegas iniciales (idempotente)."

    def handle(self, *args, **options):
        with transaction.atomic():
            cliente, created = Cliente.objects.get_or_create(
                nombre="Nicholas Charles Rowley",
                defaults={"identificacion": "", "notas": "Cliente principal (semilla inicial)."},
            )
            if created:
                self.stdout.write(self.style.SUCCESS(f"✓ Creado cliente: {cliente.nombre}"))
            else:
                self.stdout.write(f"= Cliente ya existía: {cliente.nombre}")

            for nombre in BODEGAS_INICIALES:
                bodega, b_created = Bodega.objects.get_or_create(
                    cliente=cliente, nombre=nombre,
                )
                if b_created:
                    self.stdout.write(self.style.SUCCESS(f"✓ Creada bodega: {nombre}"))
                else:
                    self.stdout.write(f"= Bodega ya existía: {nombre}")

        self.stdout.write(self.style.SUCCESS("\nSeed completado."))
