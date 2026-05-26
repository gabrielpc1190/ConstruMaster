"""Template tags para mostrar montos multi-moneda con conversión opcional."""
from datetime import date as date_type

from babel.numbers import format_currency
from django import template
from djmoney.money import Money

from apps.finance.models import ExchangeRate, NoExchangeRateAvailable
from apps.finance.services import convert

register = template.Library()


@register.simple_tag
def money_display(amount: Money, target_currency: str = "USD", on_date=None) -> str:
    """Renderiza un Money con conversión opcional a target_currency.

    Si `amount.currency == target_currency`, muestra solo el primary
    formateado en locale es_CR.

    Si difieren, intenta convertir. Si la conversión es exitosa, muestra:
        <original> (≈ <convertido> al TC <rate> del <fecha>)

    Si no hay TC disponible (no falla), muestra solo el original. Esto
    permite usar el tag en templates sin tener que verificar TC antes.
    """
    if on_date is None:
        on_date = date_type.today()

    primary = format_currency(
        amount.amount, amount.currency.code, locale="es_CR",
    )

    if amount.currency.code == target_currency:
        return primary

    try:
        converted = convert(amount, target_currency, on_date)
    except (NoExchangeRateAvailable, Exception):
        # Sin TC disponible — solo mostrar original (no romper el template)
        return primary

    converted_str = format_currency(
        converted.amount, converted.currency.code, locale="es_CR",
    )

    # Buscar el TC usado para mostrarlo en el display
    try:
        rate_obj = (
            ExchangeRate.objects
            .filter(currency="USD", date__lte=on_date)
            .order_by("-date")
            .first()
        )
        rate_str = f"{rate_obj.sell:.2f}" if rate_obj else "—"
        rate_date = rate_obj.date.strftime("%d-%b-%Y") if rate_obj else "—"
    except Exception:
        rate_str, rate_date = "—", "—"

    return f"{primary} (≈ {converted_str} al TC ₡{rate_str} del {rate_date})"
