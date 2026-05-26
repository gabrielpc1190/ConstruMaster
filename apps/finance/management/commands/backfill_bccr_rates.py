"""Backfill histórico de tipo de cambio del BCCR.

Hace una sola llamada con rango amplio (la API SDDE soporta fechaInicio
y fechaFin arbitrarios) e inserta lo que no exista. Idempotente.
"""
from datetime import date
from decimal import Decimal

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.finance.bccr_client import fetch_series, BCCRError
from apps.finance.models import ExchangeRate


class Command(BaseCommand):
    help = "Descarga histórico de tipo de cambio del BCCR (USD compra+venta)."

    def add_arguments(self, parser):
        parser.add_argument("--desde", type=str, required=True,
                            help="Fecha inicial yyyy-mm-dd")
        parser.add_argument("--hasta", type=str, default=None,
                            help="Fecha final yyyy-mm-dd (default: hoy)")

    def handle(self, *args, **options):
        token = settings.BCCR_TOKEN
        if not token:
            raise CommandError("BCCR_TOKEN no está configurado en .env")

        desde = date.fromisoformat(options["desde"])
        hasta = date.fromisoformat(options["hasta"]) if options["hasta"] else date.today()

        self.stdout.write(f"Backfill {desde} → {hasta}…")

        try:
            compras = dict(fetch_series(317, desde, hasta, token))
            ventas = dict(fetch_series(318, desde, hasta, token))
        except BCCRError as e:
            raise CommandError(f"BCCR: {e}")

        # Unión de fechas presentes en cualquiera de los dos
        all_dates = sorted(set(compras.keys()) | set(ventas.keys()))

        creados = 0
        actualizados = 0
        with transaction.atomic():
            for fecha in all_dates:
                buy = compras.get(fecha)
                sell = ventas.get(fecha)
                if buy is None and sell is None:
                    continue  # día sin datos
                _, created = ExchangeRate.objects.update_or_create(
                    currency="USD", date=fecha,
                    defaults={
                        "buy": Decimal(str(buy)) if buy is not None else Decimal("0"),
                        "sell": Decimal(str(sell)) if sell is not None else Decimal("0"),
                        "source": "bccr",
                    },
                )
                if created:
                    creados += 1
                else:
                    actualizados += 1

        self.stdout.write(self.style.SUCCESS(
            f"\n✓ Creados: {creados}, actualizados: {actualizados}, total: {len(all_dates)}"
        ))
