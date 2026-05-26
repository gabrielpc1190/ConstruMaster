"""Forms del módulo entregas."""
from django import forms
from django.forms import inlineformset_factory

from .models import Entrega, EntregaItem


class EntregaForm(forms.ModelForm):
    class Meta:
        model = Entrega
        fields = ["fecha", "bodega_destino", "recibido_por", "completa", "notas"]
        widgets = {
            "fecha": forms.DateInput(attrs={"type": "date"}),
            "notas": forms.Textarea(attrs={"rows": 2}),
        }


EntregaItemFormSet = inlineformset_factory(
    Entrega,
    EntregaItem,
    fields=["oc_item", "material", "descripcion", "cantidad", "unidad", "notas"],
    extra=0,
    can_delete=True,
)
