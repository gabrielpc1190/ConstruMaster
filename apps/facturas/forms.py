"""Forms para subida y confirmación de Factura."""
from django import forms
from django.conf import settings

from .models import Factura


class FacturaUploadForm(forms.ModelForm):
    """Form para subir una Factura inicial. status=pending automático.

    Valida tamaño máximo del archivo (fix #10 del review externo —
    validación explícita en form porque settings.FILE_UPLOAD_MAX_MEMORY_SIZE
    NO es un tope real, es umbral memoria/disco).
    """
    class Meta:
        model = Factura
        fields = ["source_type", "archivo_original"]
        widgets = {
            "source_type": forms.Select(attrs={"class": "border rounded p-2"}),
        }

    def clean_archivo_original(self):
        f = self.cleaned_data.get("archivo_original")
        if f and f.size > settings.MAX_UPLOAD_SIZE:
            raise forms.ValidationError(
                f"Archivo excede {settings.MAX_UPLOAD_SIZE // 1024 // 1024} MB."
            )
        return f


class FacturaConfirmForm(forms.ModelForm):
    """Form para confirmar Factura extracted → promover campos canónicos."""
    class Meta:
        model = Factura
        fields = [
            "tipo_comprobante",
            "clave_numerica",
            "numero_consecutivo",
            "fecha_emision",
            "monto_total",
            "condicion_venta",
            "notas",
        ]
        widgets = {
            "fecha_emision": forms.DateInput(attrs={"type": "date"}),
            "notas": forms.Textarea(attrs={"rows": 2}),
        }
