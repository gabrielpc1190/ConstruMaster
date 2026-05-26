"""Smoke test del token BCCR — consulta endpoint real de series.

No usamos POST /Usuario/ValideSuscripcion porque en testing 2026-05-25
ese endpoint devolvía HTTP 500 (bug del lado del BCCR). El endpoint de
series es el que vamos a usar en producción, así que es el smoke test
correcto (spec §7.4).
"""
from datetime import date, timedelta

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from apps.finance.bccr_client import fetch_series, BCCRError


class Command(BaseCommand):
    help = "Verifica que el token de BCCR funcione (consulta TC venta de los últimos 7 días)."

    def handle(self, *args, **options):
        token = settings.BCCR_TOKEN
        if not token:
            raise CommandError("BCCR_TOKEN no está configurado en .env")

        hoy = date.today()
        hace_7 = hoy - timedelta(days=7)

        self.stdout.write(f"Consultando TC venta (318) desde {hace_7} hasta {hoy}…")
        try:
            results = fetch_series(318, hace_7, hoy, token=token)
        except BCCRError as e:
            raise CommandError(f"Token rechazado o error BCCR: {e}")
        except Exception as e:
            raise CommandError(f"Error de red: {e}")

        self.stdout.write(self.style.SUCCESS(f"\n✓ Token válido. {len(results)} datos:"))
        for fecha, valor in results:
            self.stdout.write(f"  {fecha}: {valor}")
