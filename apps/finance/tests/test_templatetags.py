from datetime import date
from decimal import Decimal

import pytest
from djmoney.money import Money

pytestmark = pytest.mark.django_db


@pytest.fixture
def tc():
    from apps.finance.models import ExchangeRate
    return ExchangeRate.objects.create(
        currency="USD", date=date(2026, 5, 22),
        buy=Decimal("447.5"), sell=Decimal("454.82"),
    )


def test_money_display_same_currency_no_conversion(tc):
    from apps.finance.templatetags.money_extras import money_display
    out = money_display(Money(1000, "USD"), "USD", on_date=date(2026, 5, 22))
    # No "≈" porque mismo currency
    assert "≈" not in out
    # es_CR locale usa NBSP como separador de miles: "1\xa0000"
    assert "1\xa0000" in out


def test_money_display_crc_to_usd_includes_conversion(tc):
    from apps.finance.templatetags.money_extras import money_display
    # 454,820 CRC ≈ 1,000 USD al TC 454.82
    out = money_display(Money(454_820, "CRC"), "USD", on_date=date(2026, 5, 22))
    assert "≈" in out
    # Tiene "454" del CRC original y "1\xa0000" del USD convertido (es_CR)
    assert "454" in out
    assert "1\xa0000" in out
    # Tiene el TC
    assert "454.82" in out or "454,82" in out


def test_money_display_usd_to_crc(tc):
    from apps.finance.templatetags.money_extras import money_display
    out = money_display(Money(100, "USD"), "CRC", on_date=date(2026, 5, 22))
    assert "≈" in out
    assert "100" in out  # USD original
    # es_CR: "₡45\xa0482,00"
    assert "45\xa0482" in out


def test_money_display_no_tc_returns_only_original(db):
    """Sin TC en BD, NO falla — devuelve solo el monto original."""
    from apps.finance.templatetags.money_extras import money_display
    out = money_display(Money(100, "USD"), "CRC", on_date=date(2026, 5, 22))
    # No tiene "≈" porque no pudo convertir
    assert "≈" not in out
    assert "100" in out


def test_money_display_no_on_date_uses_today(tc):
    """Si on_date es None, usa today() (acepta default por compatibilidad de template)."""
    from apps.finance.templatetags.money_extras import money_display
    # Test simple — no falla con on_date=None
    out = money_display(Money(100, "USD"), "USD", on_date=None)
    assert "100" in out
