from django.urls import path

from . import views

app_name = "reportes"

urlpatterns = [
    path("dashboard/supervisor/", views.dashboard_supervisor, name="dashboard_supervisor"),
    path("dashboard/operativo/", views.dashboard_operativo, name="dashboard_operativo"),
    path("dashboard/lector/", views.dashboard_lector, name="dashboard_lector"),
]
