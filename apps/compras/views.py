"""Views del módulo compras: RFQ, Cotización, comparativa, aprobación."""
from datetime import date as date_type

from django.contrib import messages
from django.contrib.auth.decorators import login_required, permission_required
from django.db import transaction
from django.shortcuts import get_object_or_404, redirect, render

from apps.core.models import CategoriaPresupuesto

from .forms import (
    SolicitudCotizacionForm,
    CotizacionForm,
    CotizacionItemFormSet,
    PagoProgramarForm,
    PagoMarcarPagadoForm,
)
from .models import SolicitudCotizacion, Cotizacion, OrdenCompra, Pago
from .services import approve_cotizacion, presupuesto_status, AlreadyApproved, mark_pago_paid


@login_required
@permission_required("compras.add_solicitudcotizacion", raise_exception=True)
def rfq_create(request):
    if request.method == "POST":
        form = SolicitudCotizacionForm(request.POST)
        if form.is_valid():
            s = form.save(commit=False)
            s.creada_por = request.user
            s.save()
            messages.success(request, f"RFQ creado: {s}")
            return redirect("compras:rfq_detail", pk=s.pk)
    else:
        form = SolicitudCotizacionForm()
    return render(request, "compras/rfq_form.html", {"form": form})


@login_required
@permission_required("compras.view_solicitudcotizacion", raise_exception=True)
def rfq_detail(request, pk):
    rfq = get_object_or_404(SolicitudCotizacion, pk=pk)
    return render(request, "compras/rfq_detail.html", {"rfq": rfq})


@login_required
@permission_required("compras.add_cotizacion", raise_exception=True)
def cotizacion_create(request, rfq_pk=None):
    initial = {}
    rfq = None
    if rfq_pk:
        rfq = get_object_or_404(SolicitudCotizacion, pk=rfq_pk)
        initial = {"obra": rfq.obra, "rfq": rfq, "es_especial": rfq.es_especial}

    if request.method == "POST":
        form = CotizacionForm(request.POST, request.FILES, initial=initial)
        if form.is_valid():
            with transaction.atomic():
                cot = form.save()
                formset = CotizacionItemFormSet(request.POST, instance=cot)
                if formset.is_valid():
                    formset.save()
                    messages.success(request, f"Cotización {cot.numero_cotizacion} creada")
                    return redirect("compras:cotizacion_detail", pk=cot.pk)
                else:
                    transaction.set_rollback(True)
        else:
            formset = CotizacionItemFormSet()
    else:
        form = CotizacionForm(initial=initial)
        formset = CotizacionItemFormSet()

    return render(request, "compras/cotizacion_form.html",
                  {"form": form, "formset": formset, "rfq": rfq})


@login_required
@permission_required("compras.view_cotizacion", raise_exception=True)
def cotizacion_detail(request, pk):
    cot = get_object_or_404(Cotizacion, pk=pk)
    return render(request, "compras/cotizacion_detail.html", {"cotizacion": cot})


@login_required
@permission_required("compras.view_cotizacion", raise_exception=True)
def comparativa(request, rfq_pk):
    """Vista comparativa lado a lado de todas las cotizaciones de un RFQ."""
    rfq = get_object_or_404(SolicitudCotizacion, pk=rfq_pk)
    cotizaciones = (
        rfq.cotizaciones
        .exclude(estado="rechazada")
        .select_related("proveedor")
        .prefetch_related("items")
    )
    return render(request, "compras/comparativa.html",
                  {"rfq": rfq, "cotizaciones": cotizaciones})


@login_required
@permission_required("compras.approve_cotizacion", raise_exception=True)
def cotizacion_approve(request, pk):
    """Vista de aprobación de cotización con semáforo de presupuesto (spec §6.4)."""
    cot = get_object_or_404(Cotizacion, pk=pk)

    if request.method == "GET":
        categoria_id = request.GET.get("categoria") or (
            cot.rfq.categoria_id if cot.rfq else None
        )
        categoria = None
        status = None
        if categoria_id:
            categoria = get_object_or_404(CategoriaPresupuesto, pk=categoria_id)
            status = presupuesto_status(cot.obra, categoria)
        return render(request, "compras/cotizacion_approve.html", {
            "cotizacion": cot, "categoria": categoria, "status": status,
        })

    # POST = aprobar
    categoria = get_object_or_404(
        CategoriaPresupuesto, pk=request.POST.get("categoria")
    )
    try:
        oc = approve_cotizacion(
            cot, categoria=categoria, approver=request.user,
            fecha_aprobacion=date_type.today(),
        )
    except AlreadyApproved as e:
        messages.error(request, str(e))
        return redirect("compras:cotizacion_detail", pk=cot.pk)

    messages.success(request, f"Cotización aprobada → {oc.numero_oc}")
    return redirect("compras:oc_detail", pk=oc.pk)


@login_required
@permission_required("compras.view_ordencompra", raise_exception=True)
def oc_detail(request, pk):
    """Detalle de una OrdenCompra con items snapshot y hitos."""
    oc = get_object_or_404(OrdenCompra, pk=pk)
    return render(request, "compras/oc_detail.html", {"oc": oc})


@login_required
@permission_required("compras.add_pago", raise_exception=True)
def pago_programar(request, oc_pk):
    """Crea un Pago programado para una OC (spec §6.5)."""
    oc = get_object_or_404(OrdenCompra, pk=oc_pk)
    if request.method == "POST":
        form = PagoProgramarForm(request.POST)
        if form.is_valid():
            p = form.save(commit=False)
            p.oc = oc
            p.registrado_por = request.user
            p.save()
            messages.success(request, f"Pago programado por {p.monto}")
            return redirect("compras:oc_detail", pk=oc.pk)
    else:
        form = PagoProgramarForm()
    return render(request, "compras/pago_programar.html", {"oc": oc, "form": form})


@login_required
@permission_required("compras.mark_paid", raise_exception=True)
def pago_marcar_pagado(request, pk):
    """Marca un Pago programado como realizado (spec §6.5). Solo supervisor."""
    pago = get_object_or_404(Pago, pk=pk)
    if pago.fecha_realizada:
        messages.warning(request, "Este pago ya está marcado como realizado.")
        return redirect("compras:oc_detail", pk=pago.oc.pk)

    if request.method == "POST":
        form = PagoMarcarPagadoForm(request.POST, request.FILES, instance=pago)
        if form.is_valid():
            pago = form.save(commit=False)
            mark_pago_paid(
                pago, by=request.user, on=form.cleaned_data["fecha_realizada"],
            )
            messages.success(request, "Pago marcado como realizado")
            return redirect("compras:oc_detail", pk=pago.oc.pk)
    else:
        form = PagoMarcarPagadoForm(
            instance=pago,
            initial={"fecha_realizada": date_type.today()},
        )
    return render(request, "compras/pago_marcar_pagado.html",
                  {"pago": pago, "form": form})
