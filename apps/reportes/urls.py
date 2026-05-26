from django.urls import path

from . import views

app_name = "reportes"

urlpatterns = [
    path("dashboard/supervisor/", views.dashboard_supervisor, name="dashboard_supervisor"),
    path("dashboard/operativo/", views.dashboard_operativo, name="dashboard_operativo"),
    path("dashboard/lector/", views.dashboard_lector, name="dashboard_lector"),
    path("reportes/proveedor/<int:proveedor_pk>/", views.reporte_proveedor, name="reporte_proveedor"),
    path("reportes/reconciliacion/<int:obra_pk>/", views.reporte_reconciliacion, name="reporte_reconciliacion"),
    path("reportes/tipo-cambio/", views.reporte_tipo_cambio, name="reporte_tipo_cambio"),
]
