from django.urls import path

from . import views

app_name = "catalogo"

urlpatterns = [
    path("autocomplete/", views.autocomplete, name="autocomplete"),
]
