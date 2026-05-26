from django import forms

from .models import ItemCatalogo


class SuggestItemForm(forms.ModelForm):
    class Meta:
        model = ItemCatalogo
        fields = ["tipo", "nombre_canonico", "unidad", "categoria_sugerida"]
        widgets = {
            "nombre_canonico": forms.TextInput(attrs={"class": "w-full border rounded p-2"}),
            "tipo": forms.Select(attrs={"class": "w-full border rounded p-2"}),
            "unidad": forms.Select(attrs={"class": "w-full border rounded p-2"}),
        }
