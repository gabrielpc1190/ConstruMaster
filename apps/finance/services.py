"""Servicios de conversión multi-moneda.

REGLA DE ORO (spec §9.3): ninguna otra parte de la app convierte montos
sin pasar por `convert()`. Los lookups de TC vía ExchangeRate.for_date()
en `save()` de modelos (snapshots) son válidos — la regla aplica a
conversiones, no al lookup puro.
"""
from datetime import date as date_type
from decimal import Decimal, ROUND_HALF_UP

from djmoney.money import Money

from .models import ExchangeRate


class UnsupportedConversion(Exception):
    """Par de monedas no soportado."""


def convert(
    amount: Money,
    to_currency: str,
    on_date: date_type,
    side: str = "sell",
) -> Money:
    """Convierte `amount` a `to_currency` usando TC del BCCR vigente en `on_date`.

    `on_date` es OBLIGATORIO — no aceptar default today() silencioso, fuerza
    al caller a decidir explícitamente qué fecha de cambio aplica.

    `side`: 'sell' (default, cumple Hacienda) o 'buy'.

    Lanza:
    - UnsupportedConversion si el par no es {CRC,USD}↔{CRC,USD}.
    - NoExchangeRateAvailable (de ExchangeRate.for_date) si no hay TC en BD.
    """
    if amount.currency.code == to_currency:
        return amount

    if amount.currency.code == "CRC" and to_currency == "USD":
        rate = ExchangeRate.for_date("USD", on_date, side)
        new_amount = (amount.amount / rate).quantize(Decimal("0.01"), ROUND_HALF_UP)
        return Money(new_amount, "USD")

    if amount.currency.code == "USD" and to_currency == "CRC":
        rate = ExchangeRate.for_date("USD", on_date, side)
        new_amount = (amount.amount * rate).quantize(Decimal("0.01"), ROUND_HALF_UP)
        return Money(new_amount, "CRC")

    raise UnsupportedConversion(
        f"{amount.currency.code} → {to_currency} no soportado"
    )
