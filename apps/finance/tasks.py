"""Tasks async para el módulo finance."""
import logging
from datetime import date
from decimal import Decimal

from django.conf import settings

from .bccr_client import fetch_series, BCCRError
from .models import ExchangeRate

logger = logging.getLogger("construmaster.finance.tasks")


def fetch_bccr_rates(target_date: date = None) -> dict:
    """Descarga TC compra+venta del BCCR para `target_date` (default: hoy).

    Si BCCR retorna vacío (fin de semana/feriado), no hace nada (skipped).
    Si retorna valor, hace update_or_create del ExchangeRate.

    Devuelve {"created": bool, "skipped": bool, "error": Optional[str]}.

    Diseñado para correr via Django-Q2 schedule diario (lunes-viernes
    8:30 AM hora CR — spec §7.4).
    """
    target_date = target_date or date.today()
    token = settings.BCCR_TOKEN
    if not token:
        logger.error("BCCR_TOKEN no configurado")
        return {"created": False, "skipped": True, "error": "no token"}

    try:
        compras = dict(fetch_series(317, target_date, target_date, token))
        ventas = dict(fetch_series(318, target_date, target_date, token))
    except BCCRError as e:
        logger.exception("BCCR error fetching rates")
        return {"created": False, "skipped": False, "error": str(e)}

    buy = compras.get(target_date)
    sell = ventas.get(target_date)
    if buy is None and sell is None:
        logger.info(f"BCCR sin datos para {target_date} (fin de semana/feriado)")
        return {"created": False, "skipped": True, "error": None}

    _, created = ExchangeRate.objects.update_or_create(
        currency="USD", date=target_date,
        defaults={
            "buy": Decimal(str(buy)) if buy is not None else Decimal("0"),
            "sell": Decimal(str(sell)) if sell is not None else Decimal("0"),
            "source": "bccr",
        },
    )
    logger.info(
        f"TC {target_date}: compra={buy}, venta={sell} ({'creado' if created else 'actualizado'})"
    )
    return {"created": created, "skipped": False, "error": None}
