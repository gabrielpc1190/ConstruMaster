from django import forms
from django.conf import settings
from django.forms import inlineformset_factory

from .models import SolicitudCotizacion, Cotizacion, CotizacionItem


class SolicitudCotizacionForm(forms.ModelForm):
    class Meta:
        model = SolicitudCotizacion
        fields = ["obra", "categoria", "descripcion", "fecha_requerida", "es_especial"]
        widgets = {
            "fecha_requerida": forms.DateInput(attrs={"type": "date"}),
            "descripcion": forms.Textarea(attrs={"rows": 4}),
        }


class CotizacionForm(forms.ModelForm):
    class Meta:
        model = Cotizacion
        fields = [
            "obra", "proveedor", "rfq", "numero_cotizacion", "fecha", "fecha_validez",
            "moneda", "subtotal", "iva", "total",
            "condiciones_pago", "plazo_entrega_dias", "pct_anticipo",
            "archivo", "es_especial", "notas",
        ]
        widgets = {
            "fecha": forms.DateInput(attrs={"type": "date"}),
            "fecha_validez": forms.DateInput(attrs={"type": "date"}),
            "notas": forms.Textarea(attrs={"rows": 3}),
        }

    def clean_archivo(self):
        f = self.cleaned_data.get("archivo")
        if f and f.size > settings.MAX_UPLOAD_SIZE:
            raise forms.ValidationError(
                f"Archivo excede {settings.MAX_UPLOAD_SIZE // 1024 // 1024} MB."
            )
        return f


CotizacionItemFormSet = inlineformset_factory(
    Cotizacion,
    CotizacionItem,
    fields=[
        "orden", "material", "descripcion", "cantidad", "unidad",
        "precio_unitario", "subtotal", "iva_monto", "codigo_cabys",
    ],
    extra=1,
    can_delete=True,
)


from .models import Pago  # noqa: E402


class PagoProgramarForm(forms.ModelForm):
    class Meta:
        model = Pago
        fields = ["fecha_programada", "monto", "metodo", "referencia", "notas"]
        widgets = {
            "fecha_programada": forms.DateInput(attrs={"type": "date"}),
            "notas": forms.Textarea(attrs={"rows": 2}),
        }


class PagoMarcarPagadoForm(forms.ModelForm):
    fecha_realizada = forms.DateField(widget=forms.DateInput(attrs={"type": "date"}))

    class Meta:
        model = Pago
        fields = ["fecha_realizada", "referencia", "comprobante", "notas"]
        widgets = {
            "notas": forms.Textarea(attrs={"rows": 2}),
        }

    def clean_comprobante(self):
        from django.conf import settings
        f = self.cleaned_data.get("comprobante")
        if f and f.size > settings.MAX_UPLOAD_SIZE:
            raise forms.ValidationError(
                f"Archivo excede {settings.MAX_UPLOAD_SIZE // 1024 // 1024} MB."
            )
        return f
