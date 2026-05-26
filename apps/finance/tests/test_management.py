from datetime import date
from decimal import Decimal
from io import StringIO

import pytest
from django.core.management import call_command

pytestmark = pytest.mark.django_db


def test_backfill_creates_records(httpx_mock, settings):
    from apps.finance.bccr_client import BASE_URL
    from apps.finance.models import ExchangeRate
    settings.BCCR_TOKEN = "fake-token"

    # Mock compras (317)
    httpx_mock.add_response(
        url=(
            f"{BASE_URL}/indicadoresEconomicos/317/series"
            "?fechaInicio=2026/05/20&fechaFin=2026/05/22&idioma=es"
        ),
        json={
            "estado": True, "mensaje": "ok",
            "datos": [{"codigoIndicador": "317", "nombreIndicador": "TC compra",
                       "series": [
                           {"fecha": "2026-05-20", "valorDatoPorPeriodo": 446.85},
                           {"fecha": "2026-05-21", "valorDatoPorPeriodo": 447.95},
                           {"fecha": "2026-05-22", "valorDatoPorPeriodo": 447.50},
                       ]}],
        },
    )
    # Mock ventas (318)
    httpx_mock.add_response(
        url=(
            f"{BASE_URL}/indicadoresEconomicos/318/series"
            "?fechaInicio=2026/05/20&fechaFin=2026/05/22&idioma=es"
        ),
        json={
            "estado": True, "mensaje": "ok",
            "datos": [{"codigoIndicador": "318", "nombreIndicador": "TC venta",
                       "series": [
                           {"fecha": "2026-05-20", "valorDatoPorPeriodo": 454.22},
                           {"fecha": "2026-05-21", "valorDatoPorPeriodo": 455.10},
                           {"fecha": "2026-05-22", "valorDatoPorPeriodo": 454.82},
                       ]}],
        },
    )

    out = StringIO()
    call_command("backfill_bccr_rates", "--desde", "2026-05-20", "--hasta", "2026-05-22", stdout=out)

    assert ExchangeRate.objects.count() == 3
    r = ExchangeRate.objects.get(date=date(2026, 5, 22))
    assert r.buy == Decimal("447.50000")
    assert r.sell == Decimal("454.82000")


def test_backfill_idempotent(httpx_mock, settings):
    """Correr backfill dos veces no duplica registros."""
    from apps.finance.bccr_client import BASE_URL
    from apps.finance.models import ExchangeRate
    settings.BCCR_TOKEN = "fake"

    for codigo, val in [(317, 446.85), (318, 454.22)]:
        httpx_mock.add_response(
            url=(
                f"{BASE_URL}/indicadoresEconomicos/{codigo}/series"
                "?fechaInicio=2026/05/20&fechaFin=2026/05/20&idioma=es"
            ),
            is_reusable=True,
            json={"estado": True, "mensaje": "ok",
                  "datos": [{"codigoIndicador": str(codigo), "nombreIndicador": "x",
                             "series": [{"fecha": "2026-05-20", "valorDatoPorPeriodo": val}]}]},
        )

    call_command("backfill_bccr_rates", "--desde", "2026-05-20", "--hasta", "2026-05-20", stdout=StringIO())
    call_command("backfill_bccr_rates", "--desde", "2026-05-20", "--hasta", "2026-05-20", stdout=StringIO())

    assert ExchangeRate.objects.count() == 1


def test_verify_bccr_token_raises_when_no_token(settings):
    """verify_bccr_token con BCCR_TOKEN vacío debe levantar CommandError."""
    from django.core.management.base import CommandError
    settings.BCCR_TOKEN = ""
    with pytest.raises(CommandError, match="BCCR_TOKEN no está configurado"):
        call_command("verify_bccr_token", stdout=StringIO())
