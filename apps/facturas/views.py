"""Vistas de Factura: upload, status (HTMX polling), confirm, detail."""
from django.contrib import messages
from django.contrib.auth.decorators import login_required, permission_required
from django.shortcuts import get_object_or_404, redirect, render
from django_q.tasks import async_task

from apps.compras.models import OrdenCompra

from .forms import FacturaUploadForm, FacturaConfirmForm
from .models import Factura


@login_required
@permission_required("facturas.add_factura", raise_exception=True)
def factura_upload(request, oc_pk):
    """Sube una Factura nueva contra una OC. Encola extract_invoice."""
    oc = get_object_or_404(OrdenCompra, pk=oc_pk)
    if request.method == "POST":
        form = FacturaUploadForm(request.POST, request.FILES)
        if form.is_valid():
            f = form.save(commit=False)
            f.oc = oc
            f.status = "pending"
            f.save()
            # Encolar extract_invoice async (Django-Q2)
            async_task("apps.facturas.tasks.extract_invoice", f.id)
            messages.success(
                request,
                f"Factura subida. Procesamiento en curso (Factura #{f.pk}).",
            )
            return redirect("facturas:detail", pk=f.pk)
    else:
        form = FacturaUploadForm()
    return render(request, "facturas/upload.html", {"form": form, "oc": oc})


@login_required
@permission_required("facturas.view_factura", raise_exception=True)
def factura_status(request, pk):
    """HTMX endpoint: retorna partial con status actual.

    Si status terminal (extracted/confirmed/error), el partial NO incluye
    hx-trigger → polling se detiene automáticamente.
    """
    f = get_object_or_404(Factura, pk=pk)
    if f.status in ("extracted", "confirmed", "error"):
        return render(request, "facturas/_status_final.html", {"factura": f})
    return render(request, "facturas/_status_polling.html", {"factura": f})


@login_required
@permission_required("facturas.confirm_factura", raise_exception=True)
def factura_confirm(request, pk):
    """Supervisor revisa extracted_data y confirma. Promueve a campos canónicos."""
    f = get_object_or_404(Factura, pk=pk)
    if f.status == "confirmed":
        messages.warning(request, "Esta factura ya fue confirmada.")
        return redirect("facturas:detail", pk=f.pk)
    if f.status != "extracted":
        messages.error(
            request,
            f"No se puede confirmar en estado {f.get_status_display()}.",
        )
        return redirect("facturas:detail", pk=f.pk)

    if request.method == "POST":
        form = FacturaConfirmForm(request.POST, instance=f)
        if form.is_valid():
            confirmed = form.save(commit=False)
            confirmed.status = "confirmed"
            confirmed.confirmada_por = request.user
            confirmed.save()
            messages.success(request, "Factura confirmada.")
            return redirect("facturas:detail", pk=f.pk)
    else:
        # Pre-llenar form con extracted_data
        initial = {}
        ed = f.extracted_data or {}
        if ed.get("tipo"):
            initial["tipo_comprobante"] = ed["tipo"]
        if ed.get("clave"):
            initial["clave_numerica"] = ed["clave"]
        if ed.get("consecutivo"):
            initial["numero_consecutivo"] = ed["consecutivo"]
        if ed.get("fecha"):
            initial["fecha_emision"] = ed["fecha"][:10] if isinstance(ed["fecha"], str) else ed["fecha"]
        if ed.get("condicion_venta"):
            initial["condicion_venta"] = ed["condicion_venta"]
        form = FacturaConfirmForm(instance=f, initial=initial)

    return render(request, "facturas/confirm.html", {"factura": f, "form": form})


@login_required
@permission_required("facturas.view_factura", raise_exception=True)
def factura_detail(request, pk):
    f = get_object_or_404(Factura, pk=pk)
    return render(request, "facturas/detail.html", {"factura": f})


import mimetypes

from django.http import FileResponse, Http404


@login_required
@permission_required("facturas.view_factura", raise_exception=True)
def factura_archivo(request, pk):
    """Descarga autenticada del archivo de una Factura.

    Permission check vía decorator: facturas.view_factura A NIVEL DE MODELO
    (sin obj). Esto es importante (fix #1 del review externo):
    ModelBackend nativo de Django devuelve False cuando has_perm() recibe
    un objeto, así que `has_perm('view_factura', factura)` SIEMPRE
    retornaría 403. La regla de "todos pueden ver" se aplica con permission
    model-level — es suficiente en MVP donde todos los operativos/lectores
    ven todas las obras. django-guardian queda en roadmap para
    segregación per-obra.

    Devuelve FileResponse streaming (no carga a memoria). Si el archivo
    no existe en disk o el FileField está vacío, lanza Http404.
    """
    f = get_object_or_404(Factura, pk=pk)
    if not f.archivo_original:
        raise Http404("Factura sin archivo adjunto")
    try:
        file_handle = f.archivo_original.open("rb")
    except (FileNotFoundError, OSError):
        raise Http404("Archivo no encontrado en disk")

    filename = f.archivo_original.name.split("/")[-1]
    content_type, _ = mimetypes.guess_type(filename)
    response = FileResponse(
        file_handle,
        content_type=content_type or "application/octet-stream",
    )
    response["Content-Disposition"] = f'inline; filename="{filename}"'
    return response
