"""Servicios atómicos del módulo compras.

Las funciones aquí encapsulan operaciones que requieren transacciones
explícitas (locks, snapshots, transitions de estado). approve_cotizacion
y mark_pago_paid se agregan en Tasks 4.3 y 5.2.
"""
from django.db import transaction

from apps.core.models import Obra


def generate_numero_oc(obra_pk: int) -> str:
    """Genera un numero_oc único y secuencial para la obra dada.

    Formato: <SLUG_OBRA_UPPER>-OC-NNNN (e.g. "LOMAS-OC-0042").

    Usa select_for_update() sobre la fila de Obra para serializar
    aprobaciones concurrentes, previniendo race conditions sobre
    `Obra.next_oc_seq` (spec §6.4 race-fix, fix #9 del review externo).

    Bajo PostgreSQL READ COMMITTED (default), dos transacciones
    concurrentes que solo LEAN next_oc_seq podrían generar el mismo
    valor. select_for_update() bloquea la fila hasta el COMMIT, forzando
    serialización.
    """
    with transaction.atomic():
        obra = Obra.objects.select_for_update().get(pk=obra_pk)
        seq = obra.next_oc_seq
        obra.next_oc_seq = seq + 1
        obra.save(update_fields=["next_oc_seq"])
    return f"{obra.slug.upper()}-OC-{seq:04d}"
