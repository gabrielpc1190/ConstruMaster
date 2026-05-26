"""Helpers para exportar reportes a CSV.

PDF (WeasyPrint) queda para iteración posterior — requiere libpango
y assets más pesados.
"""
import csv
from io import StringIO

from django.http import HttpResponse


def csv_response(rows: list, filename: str, headers: list | None = None) -> HttpResponse:
    """Devuelve un HttpResponse con un CSV inline.

    Args:
        rows: lista de listas/tuples con valores por columna.
        filename: nombre del archivo descargado.
        headers: opcional, primera fila como headers.
    """
    buf = StringIO()
    writer = csv.writer(buf)
    if headers:
        writer.writerow(headers)
    for row in rows:
        writer.writerow(row)
    resp = HttpResponse(buf.getvalue(), content_type="text/csv; charset=utf-8")
    resp["Content-Disposition"] = f'attachment; filename="{filename}"'
    return resp
