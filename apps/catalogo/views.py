"""Views del módulo catálogo: autocomplete + sugerir item (Task 3.3)."""
from django.contrib.auth.decorators import login_required, permission_required
from django.db.models import Q
from django.shortcuts import render

from .forms import SuggestItemForm
from .models import ItemCatalogo


@login_required
def autocomplete(request):
    """HTMX endpoint para autocomplete de ItemCatalogo.

    GET /catalogo/autocomplete/?q=<query>
    Devuelve fragmento HTML con resultados (<ul><li>) para insertar
    debajo del input via HTMX.

    Solo retorna items con estado=aprobado y activo=True. Query vacía
    no muestra resultados (evita listar todo el catálogo).
    """
    q = request.GET.get("q", "").strip()
    if not q:
        return render(request, "catalogo/_autocomplete_results.html",
                      {"items": [], "q": q})
    items = (
        ItemCatalogo.objects
        .filter(estado="aprobado", activo=True)
        .filter(
            Q(nombre_canonico__icontains=q) |
            Q(alias__icontains=q) |
            Q(slug__icontains=q)
        )[:15]
    )
    return render(request, "catalogo/_autocomplete_results.html",
                  {"items": items, "q": q})


@login_required
@permission_required("catalogo.suggest_item", raise_exception=True)
def suggest_item(request):
    """Operativo (o supervisor) sugiere un nuevo item al catálogo.

    El item queda con estado='pendiente' hasta que un supervisor lo apruebe.
    """
    if request.method == "POST":
        form = SuggestItemForm(request.POST)
        if form.is_valid():
            item = form.save(commit=False)
            item.estado = "pendiente"
            item.sugerido_por = request.user
            item.save()
            return render(request, "catalogo/_suggested_ok.html", {"item": item})
        return render(request, "catalogo/_suggest_form.html",
                      {"form": form}, status=400)
    return render(request, "catalogo/_suggest_form.html",
                  {"form": SuggestItemForm()})
