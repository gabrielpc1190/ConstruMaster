"""Servicios de reconciliación pedido-vs-entregado.

Per spec §6.8: dada una OC y sus entregas, calcular pendiente. Y dado
un material en una obra (potencialmente en varias OCs), comparar
comprado vs entregado.
"""
from decimal import Decimal

from django.db.models import Sum

from apps.compras.models import OrdenCompraItem
from .models import EntregaItem


def pendiente_por_oc_item(oc_item) -> Decimal:
    """Cantidad pendiente por entregar para un OrdenCompraItem.

    pendiente = oc_item.cantidad - SUM(EntregaItem.cantidad WHERE oc_item=X)

    Puede ser negativo si las entregas excedieron la cantidad pedida
    (sobrante aceptado por el supervisor).
    """
    entregado = EntregaItem.objects.filter(oc_item=oc_item).aggregate(
        total=Sum("cantidad"),
    )["total"] or Decimal("0")
    return oc_item.cantidad - entregado


def compras_vs_entregas_por_material(obra, material) -> dict:
    """Resumen comprado vs entregado para un material en una obra.

    `comprado`: suma de cantidad en OrdenCompraItem (excluye OCs canceladas)
    `entregado`: suma de cantidad en EntregaItem (filtrado por
        EntregaItem.material y la obra de la OC)
    `pendiente`: comprado - entregado

    Returns dict con Decimals.
    """
    comprado = OrdenCompraItem.objects.filter(
        oc__obra=obra,
        material=material,
    ).exclude(oc__estado="cancelada").aggregate(
        total=Sum("cantidad"),
    )["total"] or Decimal("0")

    entregado = EntregaItem.objects.filter(
        entrega__oc__obra=obra,
        material=material,
    ).aggregate(
        total=Sum("cantidad"),
    )["total"] or Decimal("0")

    return {
        "comprado": comprado,
        "entregado": entregado,
        "pendiente": comprado - entregado,
    }
