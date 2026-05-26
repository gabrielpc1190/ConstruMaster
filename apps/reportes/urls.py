from django.urls import path

from . import views

app_name = "reportes"

urlpatterns = [
    path("dashboard/supervisor/", views.dashboard_supervisor, name="dashboard_supervisor"),
]
