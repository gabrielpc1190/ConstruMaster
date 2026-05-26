from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path("admin/", admin.site.urls),
    path("catalogo/", include("apps.catalogo.urls", namespace="catalogo")),
    path("compras/", include("apps.compras.urls", namespace="compras")),
    path("facturas/", include("apps.facturas.urls", namespace="facturas")),
]
