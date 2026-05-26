"""Vistas de dashboards por rol + landing redirect."""
from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied
from django.db.models import Count
from django.shortcuts import redirect, render

from apps.core.models import Obra
from apps.compras.models import Cotizacion, OrdenCompra, Pago, SolicitudCotizacion
from apps.entregas.models import Entrega
from apps.facturas.models import Factura
from apps.catalogo.models import ItemCatalogo
from apps.compras.services import presupuesto_status


def _user_is_supervisor(user):
    return user.is_authenticated and user.groups.filter(name="supervisor").exists()


def _user_is_operativo(user):
    return user.is_authenticated and user.groups.filter(name="operativo").exists()


def _user_is_lector(user):
    return user.is_authenticated and user.groups.filter(name="lector").exists()


@login_required
def landing(request):
    """Root URL — redirige al dashboard según rol del usuario."""
    if _user_is_supervisor(request.user):
        return redirect("reportes:dashboard_supervisor")
    if _user_is_operativo(request.user):
        return redirect("/dashboard/operativo/")
    if _user_is_lector(request.user):
        return redirect("/dashboard/lector/")
    # Sin rol: redirect al admin (probablemente staff/superuser)
    return redirect("/admin/")


@login_required
def dashboard_supervisor(request):
    """Dashboard para supervisores (Diana, Gabriel)."""
    if not _user_is_supervisor(request.user):
        raise PermissionDenied

    obras_activas = Obra.objects.filter(
        estado__in=("planificada", "en_curso", "pausada"),
    ).select_related("cliente").prefetch_related("categorias")

    # Compute semáforo per obra (worst categoria)
    obras_data = []
    for obra in obras_activas:
        worst_semaforo = "verde"
        worst_pct = 0.0
        total_categorias_con_presupuesto = 0
        for cat in obra.categorias.all():
            status = presupuesto_status(obra, cat)
            if status is None:
                continue
            total_categorias_con_presupuesto += 1
            if status["porcentaje"] > worst_pct:
                worst_pct = status["porcentaje"]
                worst_semaforo = status["semaforo"]
        obras_data.append({
            "obra": obra,
            "worst_semaforo": worst_semaforo,
            "worst_pct": worst_pct,
            "num_categorias": total_categorias_con_presupuesto,
        })

    # Pendientes de acción del supervisor
    cotizaciones_pendientes = Cotizacion.objects.filter(
        estado__in=("recibida", "en_revision"),
    ).select_related("proveedor", "obra").order_by("-fecha")[:10]

    facturas_extracted = Factura.objects.filter(
        status="extracted",
    ).select_related("oc").order_by("-created_at")[:10]

    pagos_sin_marcar = Pago.objects.filter(
        fecha_realizada__isnull=True,
    ).select_related("oc").order_by("fecha_programada")[:10]

    items_pendientes_aprobacion = ItemCatalogo.objects.filter(
        estado="pendiente",
    ).order_by("-created_at")[:10]

    return render(request, "reportes/dashboard_supervisor.html", {
        "obras_data": obras_data,
        "cotizaciones_pendientes": cotizaciones_pendientes,
        "facturas_extracted": facturas_extracted,
        "pagos_sin_marcar": pagos_sin_marcar,
        "items_pendientes": items_pendientes_aprobacion,
    })


from datetime import date as date_type

from djmoney.money import Money

from apps.finance.models import NoExchangeRateAvailable
from apps.finance.services import convert


def _user_is_operativo_or_supervisor(user):
    return user.is_authenticated and user.groups.filter(
        name__in=("operativo", "supervisor"),
    ).exists()


@login_required
def dashboard_operativo(request):
    """Dashboard para usuarios operativos (ADITA: Tony, Adrián).

    Supervisor también puede acceder (ve todo).
    """
    if not _user_is_operativo_or_supervisor(request.user):
        raise PermissionDenied

    obras_activas = Obra.objects.filter(
        estado__in=("planificada", "en_curso", "pausada"),
    ).select_related("cliente").order_by("nombre")

    # RFQs abiertas — anotadas con número de cotizaciones ya recibidas
    rfqs_abiertas = SolicitudCotizacion.objects.filter(
        estado="abierta",
    ).select_related("obra", "categoria").annotate(
        num_cot=Count("cotizaciones"),
    ).order_by("-created_at")[:10]

    # OCs autorizadas sin ninguna entrega registrada
    ocs_sin_entrega = OrdenCompra.objects.filter(
        estado="autorizada",
    ).annotate(
        num_entregas=Count("entregas"),
    ).filter(num_entregas=0).select_related("obra", "proveedor")[:10]

    # OCs pagadas sin ninguna factura subida
    ocs_pagadas_sin_factura = OrdenCompra.objects.filter(
        estado="pagada",
    ).annotate(
        num_facturas=Count("facturas"),
    ).filter(num_facturas=0).select_related("obra", "proveedor")[:10]

    # Cotizaciones recibidas recientes (globales — operativo registra para todas las obras)
    mis_cotizaciones = Cotizacion.objects.filter(
        estado="recibida",
    ).select_related("obra", "proveedor").order_by("-created_at")[:5]

    # Últimas entregas registradas por este usuario
    mis_entregas = Entrega.objects.filter(
        registrada_por=request.user,
    ).select_related("oc").order_by("-fecha")[:5]

    return render(request, "reportes/dashboard_operativo.html", {
        "obras_activas": obras_activas,
        "rfqs_abiertas": rfqs_abiertas,
        "ocs_sin_entrega": ocs_sin_entrega,
        "ocs_pagadas_sin_factura": ocs_pagadas_sin_factura,
        "mis_cotizaciones": mis_cotizaciones,
        "mis_entregas": mis_entregas,
    })


from django.shortcuts import get_object_or_404

from apps.catalogo.models import Proveedor
from apps.entregas.services import compras_vs_entregas_por_material
from apps.finance.models import ExchangeRate

from .exporters import csv_response


@login_required
def reporte_proveedor(request, proveedor_pk):
    """Estado de cuenta por proveedor: OCs + Pagos.

    Si ?format=csv, devuelve CSV; sino HTML.
    """
    proveedor = get_object_or_404(Proveedor, pk=proveedor_pk)
    ocs = OrdenCompra.objects.filter(
        proveedor=proveedor,
    ).select_related("obra").order_by("-fecha_aprobacion")

    if request.GET.get("format") == "csv":
        rows = []
        for oc in ocs:
            total_pagado = sum(
                (p.monto.amount for p in oc.pagos.filter(fecha_realizada__isnull=False)),
                start=0,
            )
            rows.append([
                oc.numero_oc,
                oc.obra.nombre,
                oc.fecha_aprobacion.isoformat(),
                str(oc.monto_total),
                str(total_pagado),
                oc.get_estado_display(),
            ])
        return csv_response(
            rows,
            filename=f"proveedor_{proveedor.pk}_estado_cuenta.csv",
            headers=["OC", "Obra", "Fecha", "Monto OC", "Pagado", "Estado"],
        )

    return render(request, "reportes/proveedor.html", {
        "proveedor": proveedor,
        "ocs": ocs,
    })


@login_required
def reporte_reconciliacion(request, obra_pk):
    """Reconciliación material × obra: comprado vs entregado."""
    from apps.catalogo.models import ItemCatalogo
    from apps.compras.models import OrdenCompraItem

    obra = get_object_or_404(Obra, pk=obra_pk)

    # Encontrar todos los materiales que aparecen en OCs de esta obra
    materiales_pks = OrdenCompraItem.objects.filter(
        oc__obra=obra, material__isnull=False,
    ).values_list("material", flat=True).distinct()
    materiales = ItemCatalogo.objects.filter(pk__in=materiales_pks)

    reconciliacion = []
    for material in materiales:
        data = compras_vs_entregas_por_material(obra, material)
        reconciliacion.append({
            "material": material,
            "comprado": data["comprado"],
            "entregado": data["entregado"],
            "pendiente": data["pendiente"],
        })

    if request.GET.get("format") == "csv":
        rows = [
            [r["material"].nombre_canonico, r["material"].unidad, r["comprado"], r["entregado"], r["pendiente"]]
            for r in reconciliacion
        ]
        return csv_response(
            rows,
            filename=f"reconciliacion_obra_{obra.pk}.csv",
            headers=["Material", "Unidad", "Comprado", "Entregado", "Pendiente"],
        )

    return render(request, "reportes/reconciliacion.html", {
        "obra": obra,
        "reconciliacion": reconciliacion,
    })


@login_required
def reporte_tipo_cambio(request):
    """Histórico de tipo de cambio del BCCR."""
    rates = ExchangeRate.objects.filter(currency="USD").order_by("-date")[:90]

    if request.GET.get("format") == "csv":
        rows = [
            [r.date.isoformat(), str(r.buy), str(r.sell), r.source]
            for r in rates
        ]
        return csv_response(
            rows,
            filename="tipo_cambio_usd.csv",
            headers=["Fecha", "Compra", "Venta", "Fuente"],
        )

    return render(request, "reportes/tipo_cambio.html", {"rates": rates})


@login_required
def dashboard_lector(request):
    """Dashboard de solo lectura para Don Nicholas (lector).

    Todos los usuarios autenticados pueden acceder (lector, operativo,
    supervisor) — es solo lectura. Muestra resumen de cada obra activa
    con totales en la moneda_reporte de la obra (modo histórico: usa
    fx_rate_applied snapshot de cada OC).
    """
    obras_activas = Obra.objects.filter(
        estado__in=("planificada", "en_curso", "pausada"),
    ).select_related("cliente")

    obras_data = []
    for obra in obras_activas:
        target_ccy = obra.moneda_reporte
        # Sumar OCs no canceladas, convertidas a la moneda de reporte
        total_consumido = Money(0, target_ccy)
        for oc in obra.ordenes_compra.exclude(estado="cancelada"):
            monto = oc.monto_total
            if monto.currency.code != target_ccy:
                try:
                    # Modo histórico: usar fx_rate_date de la OC (snapshot)
                    monto = convert(
                        monto, target_ccy,
                        oc.fx_rate_date or oc.fecha_aprobacion,
                    )
                except (NoExchangeRateAvailable, Exception):
                    continue
            total_consumido += monto

        # Presupuesto total (sumar todos los Presupuesto de esta obra)
        from apps.core.models import Presupuesto
        total_presupuesto = Money(0, target_ccy)
        for p in obra.presupuestos.all():
            monto = p.monto
            if monto.currency.code != target_ccy:
                try:
                    monto = convert(monto, target_ccy, date_type.today())
                except (NoExchangeRateAvailable, Exception):
                    continue
            total_presupuesto += monto

        pct = (
            float(total_consumido.amount / total_presupuesto.amount * 100)
            if total_presupuesto.amount > 0
            else 0.0
        )

        obras_data.append({
            "obra": obra,
            "moneda_reporte": target_ccy,
            "total_consumido": total_consumido,
            "total_presupuesto": total_presupuesto,
            "porcentaje": pct,
        })

    # OCs grandes recientes (top 10 por monto_total)
    ocs_grandes = OrdenCompra.objects.filter(
        estado__in=(
            "autorizada", "pagada_parcial", "pagada",
            "entregada_parcial", "completada",
        ),
    ).select_related("obra", "proveedor").order_by("-monto_total")[:10]

    return render(request, "reportes/dashboard_lector.html", {
        "obras_data": obras_data,
        "ocs_grandes": ocs_grandes,
    })
