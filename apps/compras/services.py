"""Servicios atómicos del módulo compras.

Las funciones aquí encapsulan operaciones que requieren transacciones
explícitas (locks, snapshots, transitions de estado). approve_cotizacion
y mark_pago_paid se agregan en Tasks 4.3 y 5.2.
"""
from datetime import date as date_type
from decimal import Decimal

from django.db import transaction
from djmoney.money import Money

from apps.core.models import Obra, Presupuesto
from apps.finance.models import ExchangeRate, NoExchangeRateAvailable
from apps.finance.services import convert


class AlreadyApproved(Exception):
    """La cotización ya está en estado terminal (aprobada/rechazada/vencida)."""


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


@transaction.atomic
def approve_cotizacion(
    cotizacion,
    categoria,
    approver,
    fecha_aprobacion: date_type,
):
    """Aprueba una Cotizacion y crea su OrdenCompra snapshot (spec §6.4).

    Operación atómica:
    1. Validar que la cotización no esté en estado terminal
    2. Lockear obra (via generate_numero_oc) y generar numero_oc
    3. Snapshot del TC si la moneda no es CRC
    4. Crear OrdenCompra + OrdenCompraItem por cada CotizacionItem
    5. Marcar Cotizacion.estado='aprobada' y cerrar RFQ si existe

    Returns la OrdenCompra creada.
    Raises AlreadyApproved si la cotización ya está en estado terminal.
    """
    from .models import OrdenCompra, OrdenCompraItem

    cotizacion.refresh_from_db()
    if cotizacion.estado in ("aprobada", "rechazada", "vencida"):
        raise AlreadyApproved(
            f"Cotizacion {cotizacion.pk} ya está en estado {cotizacion.estado}"
        )

    numero_oc = generate_numero_oc(cotizacion.obra_id)

    # Snapshot del TC si la moneda no es CRC
    fx_rate, fx_date = None, None
    if cotizacion.moneda != "CRC":
        try:
            fx_rate = ExchangeRate.for_date(cotizacion.moneda, fecha_aprobacion, side="sell")
            fx_date = fecha_aprobacion
        except NoExchangeRateAvailable:
            # No bloqueamos; el supervisor puede editar manualmente luego
            pass

    oc = OrdenCompra.objects.create(
        obra=cotizacion.obra,
        categoria=categoria,
        cotizacion_origen=cotizacion,
        proveedor=cotizacion.proveedor,
        numero_oc=numero_oc,
        fecha_aprobacion=fecha_aprobacion,
        aprobada_por=approver,
        moneda=cotizacion.moneda,
        monto_total=cotizacion.total,
        fx_rate_applied=fx_rate,
        fx_rate_date=fx_date,
        es_especial=cotizacion.es_especial,
        tiempo_estimado_dias=cotizacion.plazo_entrega_dias,
        pct_anticipo=cotizacion.pct_anticipo,
        estado="autorizada",
    )

    # Snapshot inmutable de items: copia descriptores y snapshots de material
    for ci in cotizacion.items.all():
        OrdenCompraItem.objects.create(
            oc=oc,
            material=ci.material,
            material_nombre_snapshot=ci.material.nombre_canonico if ci.material else "",
            material_unidad_snapshot=(
                ci.material.unidad if ci.material else ci.unidad
            ),
            descripcion=ci.descripcion,
            cantidad=ci.cantidad,
            unidad=ci.unidad,
            precio_unitario=ci.precio_unitario,
            subtotal=ci.subtotal,
            iva_monto=ci.iva_monto,
            codigo_cabys=ci.codigo_cabys,
            orden=ci.orden,
        )

    cotizacion.estado = "aprobada"
    cotizacion.save(update_fields=["estado"])

    # Cerrar RFQ si aplica
    if cotizacion.rfq_id:
        rfq = cotizacion.rfq
        rfq.estado = "cerrada"
        rfq.save(update_fields=["estado"])

    return oc


def presupuesto_status(obra, categoria) -> dict | None:
    """Devuelve el estado del presupuesto para (obra, categoria).

    Semáforo según porcentaje consumido (spec §6.4):
    - <= 70%: verde
    - > 70%: amarillo
    - > 90%: naranja
    - > 100%: rojo (exceso, no bloquea pero alerta)

    Suma todas las OCs no canceladas. Normaliza moneda usando convert()
    con TC del día de cada OC (fix #12 del review externo).

    Returns dict con `presupuesto`, `consumido`, `disponible`, `porcentaje`,
    `semaforo`. Retorna None si no hay presupuesto definido (no error).
    """
    from .models import OrdenCompra

    try:
        p = Presupuesto.objects.get(obra=obra, categoria=categoria)
    except Presupuesto.DoesNotExist:
        return None

    target_ccy = p.monto.currency.code
    total_consumido = Money(0, target_ccy)

    for oc in OrdenCompra.objects.filter(
        obra=obra, categoria=categoria,
    ).exclude(estado="cancelada"):
        monto = oc.monto_total
        if monto.currency.code != target_ccy:
            try:
                monto = convert(monto, target_ccy, oc.fx_rate_date or date_type.today())
            except (NoExchangeRateAvailable, Exception):
                # Si no hay TC, ignorar esta OC en el cálculo (mejor underreport
                # que blocking)
                continue
        total_consumido += monto

    if p.monto.amount > 0:
        pct = float(total_consumido.amount / p.monto.amount * 100)
    else:
        pct = 0.0

    if pct > 100:
        semaforo = "rojo"
    elif pct > 90:
        semaforo = "naranja"
    elif pct > 70:
        semaforo = "amarillo"
    else:
        semaforo = "verde"

    return {
        "presupuesto": p.monto,
        "consumido": total_consumido,
        "disponible": p.monto - total_consumido,
        "porcentaje": pct,
        "semaforo": semaforo,
    }
