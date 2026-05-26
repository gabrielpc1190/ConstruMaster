from datetime import date

import pytest


def test_fetch_series_success(httpx_mock):
    from apps.finance.bccr_client import fetch_series, BASE_URL
    httpx_mock.add_response(
        url=(
            f"{BASE_URL}/indicadoresEconomicos/318/series"
            "?fechaInicio=2026/05/22&fechaFin=2026/05/22&idioma=es"
        ),
        json={
            "estado": True,
            "mensaje": "Consulta exitosa",
            "datos": [{
                "codigoIndicador": "318",
                "nombreIndicador": "Tipo cambio venta",
                "series": [{"fecha": "2026-05-22", "valorDatoPorPeriodo": 454.82}],
            }],
        },
    )
    result = fetch_series(318, date(2026, 5, 22), date(2026, 5, 22), token="t")
    assert result == [(date(2026, 5, 22), 454.82)]


def test_fetch_series_empty_weekend(httpx_mock):
    from apps.finance.bccr_client import fetch_series, BASE_URL
    httpx_mock.add_response(
        url=(
            f"{BASE_URL}/indicadoresEconomicos/318/series"
            "?fechaInicio=2026/05/24&fechaFin=2026/05/24&idioma=es"
        ),
        json={"estado": True, "mensaje": "Consulta exitosa", "datos": []},
    )
    result = fetch_series(318, date(2026, 5, 24), date(2026, 5, 24), token="t")
    assert result == []


def test_fetch_series_null_value(httpx_mock):
    """BCCR a veces retorna series con valorDatoPorPeriodo=null (feriado)."""
    from apps.finance.bccr_client import fetch_series, BASE_URL
    httpx_mock.add_response(
        url=(
            f"{BASE_URL}/indicadoresEconomicos/318/series"
            "?fechaInicio=2026/01/01&fechaFin=2026/01/01&idioma=es"
        ),
        json={
            "estado": True, "mensaje": "ok",
            "datos": [{"codigoIndicador": "318", "nombreIndicador": "x",
                       "series": [{"fecha": "2026-01-01", "valorDatoPorPeriodo": None}]}],
        },
    )
    result = fetch_series(318, date(2026, 1, 1), date(2026, 1, 1), token="t")
    assert result == [(date(2026, 1, 1), None)]


def test_fetch_series_raises_on_400(httpx_mock):
    from apps.finance.bccr_client import fetch_series, BCCRError, BASE_URL
    httpx_mock.add_response(
        url=(
            f"{BASE_URL}/indicadoresEconomicos/318/series"
            "?fechaInicio=2026/05/22&fechaFin=2026/05/22&idioma=es"
        ),
        status_code=400,
        json={"CodigoError": "400", "Mensaje": "Parámetros inválidos"},
    )
    with pytest.raises(BCCRError, match="Parámetros inválidos"):
        fetch_series(318, date(2026, 5, 22), date(2026, 5, 22), token="t")


def test_fetch_series_raises_on_401_unauthorized(httpx_mock):
    from apps.finance.bccr_client import fetch_series, BCCRError, BASE_URL
    httpx_mock.add_response(
        url=(
            f"{BASE_URL}/indicadoresEconomicos/318/series"
            "?fechaInicio=2026/05/22&fechaFin=2026/05/22&idioma=es"
        ),
        status_code=401,
        text="Unauthorized",
    )
    with pytest.raises(BCCRError, match="HTTP 401"):
        fetch_series(318, date(2026, 5, 22), date(2026, 5, 22), token="bad")


def test_fetch_series_estado_false(httpx_mock):
    from apps.finance.bccr_client import fetch_series, BCCRError, BASE_URL
    httpx_mock.add_response(
        url=(
            f"{BASE_URL}/indicadoresEconomicos/318/series"
            "?fechaInicio=2026/05/22&fechaFin=2026/05/22&idioma=es"
        ),
        json={"estado": False, "mensaje": "Indicador no disponible", "datos": []},
    )
    with pytest.raises(BCCRError, match="Indicador no disponible"):
        fetch_series(318, date(2026, 5, 22), date(2026, 5, 22), token="t")


def test_fetch_series_includes_authorization_header(httpx_mock):
    from apps.finance.bccr_client import fetch_series, BASE_URL
    httpx_mock.add_response(
        url=(
            f"{BASE_URL}/indicadoresEconomicos/318/series"
            "?fechaInicio=2026/05/22&fechaFin=2026/05/22&idioma=es"
        ),
        json={"estado": True, "mensaje": "ok",
              "datos": [{"codigoIndicador": "318", "nombreIndicador": "x",
                         "series": [{"fecha": "2026-05-22", "valorDatoPorPeriodo": 1.0}]}]},
    )
    fetch_series(318, date(2026, 5, 22), date(2026, 5, 22), token="abc123")
    req = httpx_mock.get_requests()[0]
    assert req.headers.get("Authorization") == "Bearer abc123"
