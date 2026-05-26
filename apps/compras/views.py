"""Views del módulo compras: RFQ, Cotización, comparativa."""
from django.contrib import messages
from django.contrib.auth.decorators import login_required, permission_required
from django.db import transaction
from django.shortcuts import get_object_or_404, redirect, render

from .forms import (
    SolicitudCotizacionForm,
    CotizacionForm,
    CotizacionItemFormSet,
)
from .models import SolicitudCotizacion, Cotizacion


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
