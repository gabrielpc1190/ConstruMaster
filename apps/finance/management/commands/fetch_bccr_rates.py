"""Wrapper de tasks.fetch_bccr_rates para uso manual via CLI.

Útil para probar el job sin esperar al cron diario.
"""
from django.core.management.base import BaseCommand

from apps.finance.tasks import fetch_bccr_rates


class Command(BaseCommand):
    help = "Ejecuta fetch_bccr_rates manualmente (también corre diario via Schedule)."

    def handle(self, *args, **options):
        result = fetch_bccr_rates()
        self.stdout.write(self.style.SUCCESS(str(result)))
