"""Vistas del módulo entregas."""
from django.contrib import messages
from django.contrib.auth.decorators import login_required, permission_required
from django.db import transaction
from django.db.models import Sum
from django.forms import inlineformset_factory
from django.shortcuts import get_object_or_404, redirect, render

from apps.compras.models import OrdenCompra

from .forms import EntregaForm
from .models import Entrega, EntregaItem


@login_required
@permission_required("entregas.add_entrega", raise_exception=True)
def entrega_registrar(request, oc_pk):
    """Registra una entrega contra una OC. Pre-llena items pendientes."""
    oc = get_object_or_404(OrdenCompra, pk=oc_pk)

    if request.method == "POST":
        form = EntregaForm(request.POST)
        if form.is_valid():
            with transaction.atomic():
                entrega = form.save(commit=False)
                entrega.oc = oc
                entrega.registrada_por = request.user
                entrega.save()
                FormSet = inlineformset_factory(
                    Entrega, EntregaItem,
                    fields=["oc_item", "material", "descripcion", "cantidad", "unidad", "notas"],
                    extra=0,
                    can_delete=True,
                )
                formset = FormSet(request.POST, instance=entrega, prefix="items")
                if formset.is_valid():
                    formset.save()
                    messages.success(request, f"Entrega #{entrega.pk} registrada")
                    return redirect("entregas:detail", pk=entrega.pk)
                else:
                    transaction.set_rollback(True)
                    # Re-renderizar con errores (entrega no fue guardada por set_rollback)
        else:
            # form inválido — reconstruir formset vacío para re-render
            FormSet = inlineformset_factory(
                Entrega, EntregaItem,
                fields=["oc_item", "material", "descripcion", "cantidad", "unidad", "notas"],
                extra=0,
                can_delete=True,
            )
            formset = FormSet(request.POST, prefix="items")
    else:
        form = EntregaForm()
        # Pre-llenar formset con items pendientes de la OC
        initial_items = []
        for oc_item in oc.items.all():
            # Calcular cantidad pendiente: cantidad OC - SUM(entregas previas para este item)
            entregado = EntregaItem.objects.filter(oc_item=oc_item).aggregate(
                total=Sum("cantidad")
            )["total"] or 0
            pendiente = oc_item.cantidad - entregado
            if pendiente > 0:
                initial_items.append({
                    "oc_item": oc_item.pk,
                    "material": oc_item.material_id,
                    "descripcion": oc_item.descripcion,
                    "cantidad": pendiente,
                    "unidad": oc_item.unidad,
                })

        # Construir formset unbound con initial pre-llenado
        FormSet = inlineformset_factory(
            Entrega, EntregaItem,
            fields=["oc_item", "material", "descripcion", "cantidad", "unidad", "notas"],
            extra=max(len(initial_items), 1),
            can_delete=True,
        )
        formset = FormSet(initial=initial_items, prefix="items")

    return render(request, "entregas/registrar.html", {
        "form": form, "formset": formset, "oc": oc,
    })


@login_required
@permission_required("entregas.view_entrega", raise_exception=True)
def entrega_detail(request, pk):
    entrega = get_object_or_404(Entrega, pk=pk)
    return render(request, "entregas/detail.html", {"entrega": entrega})
