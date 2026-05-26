from django.contrib import admin
from django.urls import include, path

from apps.reportes.views import landing

urlpatterns = [
    path("", landing, name="landing"),
    path("admin/", admin.site.urls),
    path("catalogo/", include("apps.catalogo.urls", namespace="catalogo")),
    path("compras/", include("apps.compras.urls", namespace="compras")),
    path("facturas/", include("apps.facturas.urls", namespace="facturas")),
    path("entregas/", include("apps.entregas.urls", namespace="entregas")),
    path("", include("apps.reportes.urls", namespace="reportes")),
]
