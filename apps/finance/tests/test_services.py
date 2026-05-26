from datetime import date
from decimal import Decimal

import pytest
from djmoney.money import Money

pytestmark = pytest.mark.django_db


@pytest.fixture
def tc_22_may():
    from apps.finance.models import ExchangeRate
    return ExchangeRate.objects.create(
        currency="USD", date=date(2026, 5, 22),
        buy=Decimal("447.50000"), sell=Decimal("454.82000"),
    )


def test_convert_same_currency_is_noop(tc_22_may):
    from apps.finance.services import convert
    m = Money(1000, "CRC")
    assert convert(m, "CRC", date(2026, 5, 22)) == m


def test_convert_crc_to_usd_uses_sell_by_default(tc_22_may):
    from apps.finance.services import convert
    # 454,820 CRC / 454.82 = 1000.00 USD
    result = convert(Money(454_820, "CRC"), "USD", date(2026, 5, 22))
    assert result.currency.code == "USD"
    assert result.amount == Decimal("1000.00")


def test_convert_usd_to_crc(tc_22_may):
    from apps.finance.services import convert
    # 100 USD * 454.82 = 45,482.00 CRC
    result = convert(Money(100, "USD"), "CRC", date(2026, 5, 22))
    assert result.currency.code == "CRC"
    assert result.amount == Decimal("45482.00")


def test_convert_uses_buy_side(tc_22_may):
    from apps.finance.services import convert
    # 447,500 CRC / 447.50 = 1000.00 USD
    result = convert(Money(447_500, "CRC"), "USD", date(2026, 5, 22), side="buy")
    assert result.amount == Decimal("1000.00")


def test_convert_carries_forward_weekend(tc_22_may):
    """Si pedimos un domingo (no hábil), debe usar el TC del viernes."""
    from apps.finance.services import convert
    # Domingo 24 → arrastra TC del viernes 22
    result = convert(Money(100, "USD"), "CRC", date(2026, 5, 24))
    assert result.amount == Decimal("45482.00")


def test_convert_raises_unsupported_pair(tc_22_may):
    from apps.finance.services import convert, UnsupportedConversion
    with pytest.raises(UnsupportedConversion):
        convert(Money(100, "USD"), "EUR", date(2026, 5, 22))


def test_convert_raises_when_no_exchange_rate(db):
    """Sin TC en BD → propaga NoExchangeRateAvailable de ExchangeRate.for_date."""
    from apps.finance.services import convert
    from apps.finance.models import NoExchangeRateAvailable
    with pytest.raises(NoExchangeRateAvailable):
        convert(Money(100, "USD"), "CRC", date(2026, 5, 22))


def test_convert_quantizes_to_2_decimals(tc_22_may):
    """Resultado debe estar redondeado a 2 decimales con ROUND_HALF_UP."""
    from apps.finance.services import convert
    # 1 USD * 454.82 = 454.82 (ya exacto)
    result = convert(Money(1, "USD"), "CRC", date(2026, 5, 22))
    assert result.amount == Decimal("454.82")
    # 1.5 USD * 454.82 = 682.23 (1.5 * 454.82 = 682.23)
    result2 = convert(Money(Decimal("1.5"), "USD"), "CRC", date(2026, 5, 22))
    assert result2.amount == Decimal("682.23")
