from django.urls import path

from . import views

app_name = "facturas"

urlpatterns = [
    path("upload/<int:oc_pk>/", views.factura_upload, name="upload"),
    path("<int:pk>/", views.factura_detail, name="detail"),
    path("<int:pk>/status/", views.factura_status, name="status"),
    path("<int:pk>/confirm/", views.factura_confirm, name="confirm"),
]
