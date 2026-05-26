from django.urls import path

from . import views

app_name = "entregas"

urlpatterns = [
    path("registrar/<int:oc_pk>/", views.entrega_registrar, name="registrar"),
    path("<int:pk>/", views.entrega_detail, name="detail"),
]
