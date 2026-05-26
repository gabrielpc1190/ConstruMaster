"""Cliente HTTP para la API REST SDDE del BCCR.

API REST nueva en https://apim.bccr.fi.cr/SDDE/... El backend SOAP viejo
(gee.bccr.fi.cr/.../wsindicadoreseconomicos.asmx) se apaga el 30-jun-2026.

Auth: header `Authorization: Bearer <token>`. Token se obtiene desde:
https://sdd.bccr.fi.cr/ → Mi perfil → Generar token.

Códigos relevantes:
- 317 = tipo de cambio compra (USD/CRC)
- 318 = tipo de cambio venta (USD/CRC) — default para cumplimiento Hacienda
"""
from datetime import date
from typing import Optional

import httpx

BASE_URL = "https://apim.bccr.fi.cr/SDDE/api/Bccr.GE.SDDE.Publico.Indicadores.API"


class BCCRError(Exception):
    """Error retornado por el BCCR con mensaje legible."""


def fetch_series(
    codigo: int,
    desde: date,
    hasta: date,
    token: str,
    timeout: float = 20.0,
) -> list[tuple[date, Optional[float]]]:
    """Consulta la serie de un indicador económico del BCCR.

    Devuelve lista de (fecha, valor). Valor puede ser None si BCCR retornó
    null (fin de semana, feriado, dato no publicado). Lista vacía si
    `series` viene vacío en la respuesta.

    Lanza BCCRError en HTTP 4xx/5xx (con mensaje del body si es JSON) o
    cuando `estado=False` en la respuesta.
    """
    r = httpx.get(
        f"{BASE_URL}/indicadoresEconomicos/{codigo}/series",
        params={
            "fechaInicio": desde.strftime("%Y/%m/%d"),
            "fechaFin": hasta.strftime("%Y/%m/%d"),
            "idioma": "es",
        },
        headers={"Authorization": f"Bearer {token}"},
        timeout=timeout,
    )
    # NO usar r.raise_for_status() — necesitamos leer el cuerpo de error
    # antes de levantar excepción (spec §7.4)
    if r.status_code >= 400:
        try:
            err = r.json()
            raise BCCRError(
                f"HTTP {r.status_code}: {err.get('Mensaje', r.text[:200])}"
            )
        except ValueError:
            # Cuerpo no es JSON (ej: HTML 401)
            raise BCCRError(f"HTTP {r.status_code}: {r.text[:200]}")

    data = r.json()
    if not data.get("estado"):
        raise BCCRError(data.get("mensaje", "Error desconocido del BCCR"))

    if not data.get("datos"):
        return []
    series = data["datos"][0].get("series", [])
    return [
        (date.fromisoformat(s["fecha"][:10]), s.get("valorDatoPorPeriodo"))
        for s in series
    ]
