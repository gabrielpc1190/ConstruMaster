from django.urls import path

from . import views

app_name = "compras"

urlpatterns = [
    path("rfq/new/", views.rfq_create, name="rfq_create"),
    path("rfq/<int:pk>/", views.rfq_detail, name="rfq_detail"),
    path("rfq/<int:rfq_pk>/comparativa/", views.comparativa, name="comparativa"),
    path("cotizacion/new/", views.cotizacion_create, name="cotizacion_create"),
    path("cotizacion/new/<int:rfq_pk>/", views.cotizacion_create, name="cotizacion_from_rfq"),
    path("cotizacion/<int:pk>/", views.cotizacion_detail, name="cotizacion_detail"),
    path("cotizacion/<int:pk>/approve/", views.cotizacion_approve, name="cotizacion_approve"),
    path("oc/<int:pk>/", views.oc_detail, name="oc_detail"),
]
