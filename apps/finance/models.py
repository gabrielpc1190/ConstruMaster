"""Modelos del módulo finance: tipo de cambio + utilities multi-moneda."""
from datetime import date as date_type
from decimal import Decimal

from django.db import models


class NoExchangeRateAvailable(Exception):
    """Lanzado cuando no hay TC en BD para una moneda/fecha."""


class ExchangeRate(models.Model):
    """Snapshot diario del tipo de cambio del BCCR.

    Códigos del BCCR:
    - 317 = compra (USD/CRC)
    - 318 = venta (USD/CRC) — default para cumplimiento Hacienda
    """

    SOURCE_CHOICES = [("bccr", "BCCR"), ("manual", "Manual")]

    currency = models.CharField(max_length=3)
    date = models.DateField()
    buy = models.DecimalField(max_digits=12, decimal_places=5)
    sell = models.DecimalField(max_digits=12, decimal_places=5)
    fetched_at = models.DateTimeField(auto_now_add=True)
    source = models.CharField(max_length=10, choices=SOURCE_CHOICES, default="bccr")

    class Meta:
        verbose_name = "Tipo de cambio"
        verbose_name_plural = "Tipos de cambio"
        unique_together = [("currency", "date")]
        indexes = [
            models.Index(fields=["currency", "-date"]),
        ]
        ordering = ["-date"]

    def __str__(self):
        return f"{self.currency} {self.date}: compra={self.buy}, venta={self.sell}"

    @classmethod
    def for_date(cls, currency: str, on_date: date_type, side: str = "sell") -> Decimal:
        """Devuelve el TC vigente en `on_date` (arrastra el último día hábil).

        Si no hay TC en o antes de on_date, lanza NoExchangeRateAvailable.
        side: 'sell' (default, cumple Hacienda) o 'buy'.
        """
        rate = (
            cls.objects
            .filter(currency=currency, date__lte=on_date)
            .order_by("-date")
            .first()
        )
        if rate is None:
            raise NoExchangeRateAvailable(
                f"No hay TC para {currency} en o antes de {on_date}"
            )
        return rate.sell if side == "sell" else rate.buy
