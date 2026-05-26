from decimal import Decimal
from datetime import date

import pytest

pytestmark = pytest.mark.django_db


def test_exchange_rate_creation():
    from apps.finance.models import ExchangeRate
    r = ExchangeRate.objects.create(
        currency="USD",
        date=date(2026, 5, 25),
        buy=Decimal("448.12"),
        sell=Decimal("455.75"),
    )
    assert r.sell == Decimal("455.75")
    assert r.source == "bccr"  # default


def test_for_date_returns_exact_match():
    from apps.finance.models import ExchangeRate
    ExchangeRate.objects.create(currency="USD", date=date(2026, 5, 23),
                                buy=Decimal("447"), sell=Decimal("455.75"))
    assert ExchangeRate.for_date("USD", date(2026, 5, 23)) == Decimal("455.75")


def test_for_date_carries_forward_weekend():
    """Si pedimos un domingo (no hábil), debe arrastrar el TC del viernes."""
    from apps.finance.models import ExchangeRate
    # Viernes 22
    ExchangeRate.objects.create(currency="USD", date=date(2026, 5, 22),
                                buy=Decimal("447"), sell=Decimal("454.82"))
    # Domingo 24
    assert ExchangeRate.for_date("USD", date(2026, 5, 24)) == Decimal("454.82")


def test_for_date_compra_side():
    from apps.finance.models import ExchangeRate
    ExchangeRate.objects.create(currency="USD", date=date(2026, 5, 22),
                                buy=Decimal("447"), sell=Decimal("454.82"))
    assert ExchangeRate.for_date("USD", date(2026, 5, 22), side="buy") == Decimal("447")


def test_for_date_raises_when_no_data():
    from apps.finance.models import ExchangeRate, NoExchangeRateAvailable
    with pytest.raises(NoExchangeRateAvailable):
        ExchangeRate.for_date("USD", date(2026, 5, 25))


def test_unique_currency_date():
    from apps.finance.models import ExchangeRate
    from django.db import IntegrityError
    ExchangeRate.objects.create(currency="USD", date=date(2026, 5, 25),
                                buy=Decimal("1"), sell=Decimal("2"))
    with pytest.raises(IntegrityError):
        ExchangeRate.objects.create(currency="USD", date=date(2026, 5, 25),
                                    buy=Decimal("3"), sell=Decimal("4"))


def test_str_representation():
    from apps.finance.models import ExchangeRate
    r = ExchangeRate.objects.create(currency="USD", date=date(2026, 5, 25),
                                    buy=Decimal("447.50"), sell=Decimal("454.82"))
    s = str(r)
    assert "USD" in s
    assert "2026-05-25" in s
