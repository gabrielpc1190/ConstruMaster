from datetime import date
from decimal import Decimal

import pytest

pytestmark = pytest.mark.django_db


def test_fetch_bccr_rates_creates_for_today(httpx_mock, settings):
    from apps.finance.bccr_client import BASE_URL
    from apps.finance.models import ExchangeRate
    from apps.finance.tasks import fetch_bccr_rates

    settings.BCCR_TOKEN = "fake"
    today = date.today()
    s = today.strftime("%Y/%m/%d")

    httpx_mock.add_response(
        url=f"{BASE_URL}/indicadoresEconomicos/317/series?fechaInicio={s}&fechaFin={s}&idioma=es",
        json={"estado": True, "mensaje": "ok",
              "datos": [{"codigoIndicador": "317", "nombreIndicador": "x",
                         "series": [{"fecha": today.isoformat(), "valorDatoPorPeriodo": 447.5}]}]},
    )
    httpx_mock.add_response(
        url=f"{BASE_URL}/indicadoresEconomicos/318/series?fechaInicio={s}&fechaFin={s}&idioma=es",
        json={"estado": True, "mensaje": "ok",
              "datos": [{"codigoIndicador": "318", "nombreIndicador": "x",
                         "series": [{"fecha": today.isoformat(), "valorDatoPorPeriodo": 454.82}]}]},
    )

    result = fetch_bccr_rates()
    assert result["created"] is True
    assert result["error"] is None
    r = ExchangeRate.objects.get(currency="USD", date=today)
    assert r.sell == Decimal("454.82000")


def test_fetch_bccr_rates_skips_when_no_data(httpx_mock, settings):
    from apps.finance.bccr_client import BASE_URL
    from apps.finance.models import ExchangeRate
    from apps.finance.tasks import fetch_bccr_rates

    settings.BCCR_TOKEN = "fake"
    today = date.today()
    s = today.strftime("%Y/%m/%d")

    for codigo in (317, 318):
        httpx_mock.add_response(
            url=f"{BASE_URL}/indicadoresEconomicos/{codigo}/series?fechaInicio={s}&fechaFin={s}&idioma=es",
            json={"estado": True, "mensaje": "ok", "datos": []},
        )

    result = fetch_bccr_rates()
    assert result["skipped"] is True
    assert ExchangeRate.objects.filter(currency="USD", date=today).count() == 0


def test_fetch_bccr_rates_no_token(settings):
    from apps.finance.tasks import fetch_bccr_rates
    settings.BCCR_TOKEN = ""
    result = fetch_bccr_rates()
    assert result["skipped"] is True
    assert result["error"] == "no token"


def test_fetch_bccr_rates_bccr_error(httpx_mock, settings):
    from apps.finance.bccr_client import BASE_URL
    from apps.finance.tasks import fetch_bccr_rates

    settings.BCCR_TOKEN = "bad"
    today = date.today()
    s = today.strftime("%Y/%m/%d")

    httpx_mock.add_response(
        url=f"{BASE_URL}/indicadoresEconomicos/317/series?fechaInicio={s}&fechaFin={s}&idioma=es",
        status_code=401,
        text="Unauthorized",
    )

    result = fetch_bccr_rates()
    assert result["skipped"] is False
    assert result["created"] is False
    assert result["error"] is not None
    assert "401" in result["error"] or "Unauthorized" in result["error"]
