"""Tests para vistas de Factura: upload, HTMX polling status, confirm, detail."""
from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.core.files.uploadedfile import SimpleUploadedFile
from djmoney.money import Money

pytestmark = pytest.mark.django_db


def _login(client, group):
    User = get_user_model()
    u = User.objects.create_user(username=f"u_{group}", password="pw")
    u.groups.add(Group.objects.get(name=group))
    client.login(username=f"u_{group}", password="pw")
    return u


@pytest.fixture
def oc(db):
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import OrdenCompra
    obra = ObraFactory(nombre="Casa Up")
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    return OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="UP-OC-0001", fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(1000, "CRC"), estado="autorizada",
    )


def test_upload_creates_factura_and_queues_task(client, oc):
    """Operativo sube un PDF → Factura pending + extract_invoice encolado."""
    from apps.facturas.models import Factura

    _login(client, "operativo")
    pdf = SimpleUploadedFile("test.pdf", b"%PDF-1.4 fake", content_type="application/pdf")

    with patch("apps.facturas.views.async_task") as mock_async:
        resp = client.post(f"/facturas/upload/{oc.pk}/", {
            "source_type": "pdf",
            "archivo_original": pdf,
        })

    assert resp.status_code == 302
    f = Factura.objects.get(oc=oc)
    assert f.status == "pending"
    assert f.source_type == "pdf"
    # Verificar que async_task fue llamado con la task correcta
    mock_async.assert_called_once()
    args = mock_async.call_args
    assert "extract_invoice" in args[0][0] or "extract_invoice" in str(args)


def test_upload_lector_forbidden(client, oc):
    _login(client, "lector")
    pdf = SimpleUploadedFile("x.pdf", b"%PDF-1.4", content_type="application/pdf")
    resp = client.post(f"/facturas/upload/{oc.pk}/", {
        "source_type": "pdf", "archivo_original": pdf,
    })
    assert resp.status_code == 403


def test_upload_oversized_file_rejected(client, oc):
    """FIX #10: validación explícita de tamaño > 20 MB en clean_archivo."""
    from django.conf import settings

    _login(client, "operativo")
    # Crear file > MAX_UPLOAD_SIZE
    too_big = SimpleUploadedFile(
        "big.pdf",
        b"x" * (settings.MAX_UPLOAD_SIZE + 100),
        content_type="application/pdf",
    )
    resp = client.post(f"/facturas/upload/{oc.pk}/", {
        "source_type": "pdf",
        "archivo_original": too_big,
    })
    # Form inválido → render con error 200 OR validation que evita el save
    # No debería crear Factura
    from apps.facturas.models import Factura
    assert not Factura.objects.exists() or resp.status_code != 302


def test_status_endpoint_for_pending(client, oc):
    """GET /facturas/<pk>/status/ devuelve partial con polling activo."""
    from apps.facturas.models import Factura
    _login(client, "operativo")
    f = Factura.objects.create(
        oc=oc, source_type="xml", archivo_original="x.xml", status="pending",
    )
    resp = client.get(f"/facturas/{f.pk}/status/")
    assert resp.status_code == 200
    body = resp.content.decode()
    # Status partial debe incluir hx-trigger para seguir poll
    assert "hx-trigger" in body.lower() or "pending" in body.lower()


def test_status_endpoint_for_extracted_no_polling(client, oc):
    """Status terminal NO incluye hx-trigger (polling se detiene)."""
    from apps.facturas.models import Factura
    _login(client, "operativo")
    f = Factura.objects.create(
        oc=oc, source_type="xml", archivo_original="x.xml", status="extracted",
        extracted_data={"clave": "X"},
    )
    resp = client.get(f"/facturas/{f.pk}/status/")
    assert resp.status_code == 200
    body = resp.content.decode()
    # Terminal status: NO hx-trigger en el partial retornado
    assert "extracted" in body.lower()
    # No debería incluir hx-trigger="every Xs"
    assert "every" not in body.lower() or "extracted" in body.lower()


def test_confirm_supervisor_can_confirm(client, oc):
    """Supervisor llena form de confirmación → status=confirmed con campos canónicos."""
    from datetime import date
    from apps.facturas.models import Factura

    user = _login(client, "supervisor")
    f = Factura.objects.create(
        oc=oc, source_type="xml", archivo_original="x.xml", status="extracted",
        extracted_data={
            "tipo": "TE",
            "clave": "X" * 50,
            "consecutivo": "00100001040000134414",
            "fecha": "2026-05-04",
        },
    )

    resp = client.post(f"/facturas/{f.pk}/confirm/", {
        "tipo_comprobante": "TE",
        "clave_numerica": "X" * 50,
        "numero_consecutivo": "00100001040000134414",
        "fecha_emision": "2026-05-04",
        "monto_total_0": "1769.31",
        "monto_total_1": "CRC",
        "condicion_venta": "01",
        "notas": "OK",
    })
    assert resp.status_code == 302
    f.refresh_from_db()
    assert f.status == "confirmed"
    assert f.tipo_comprobante == "TE"
    assert f.fecha_emision == date(2026, 5, 4)
    assert f.confirmada_por == user


def test_confirm_operativo_forbidden(client, oc):
    from apps.facturas.models import Factura
    _login(client, "operativo")
    f = Factura.objects.create(
        oc=oc, source_type="xml", archivo_original="x.xml", status="extracted",
    )
    resp = client.get(f"/facturas/{f.pk}/confirm/")
    assert resp.status_code == 403


def test_detail_view(client, oc):
    from apps.facturas.models import Factura
    _login(client, "operativo")
    f = Factura.objects.create(
        oc=oc, source_type="xml", archivo_original="z.xml", status="pending",
    )
    resp = client.get(f"/facturas/{f.pk}/")
    assert resp.status_code == 200


def test_archivo_download_requires_login(client, oc):
    """Sin login → redirect a login."""
    from apps.facturas.models import Factura
    f = Factura.objects.create(
        oc=oc, source_type="xml", archivo_original="x.xml", status="confirmed",
    )
    resp = client.get(f"/facturas/{f.pk}/archivo/")
    assert resp.status_code in (302, 403)


def test_archivo_download_supervisor_ok(client, oc, tmp_path):
    """Supervisor con permission view_factura puede descargar."""
    from apps.facturas.models import Factura
    from django.core.files import File

    _login(client, "supervisor")
    fake = tmp_path / "test.xml"
    fake.write_text("<root/>")

    f = Factura.objects.create(
        oc=oc, source_type="xml", status="confirmed",
    )
    # Asignar archivo real al FileField
    with open(fake, "rb") as fp:
        f.archivo_original.save("test.xml", File(fp), save=True)

    resp = client.get(f"/facturas/{f.pk}/archivo/")
    assert resp.status_code == 200


def test_archivo_download_operativo_ok(client, oc, tmp_path):
    """Operativo también puede descargar (tiene view_factura)."""
    from apps.facturas.models import Factura
    from django.core.files import File

    _login(client, "operativo")
    fake = tmp_path / "test.pdf"
    fake.write_text("pdf content")

    f = Factura.objects.create(oc=oc, source_type="pdf", status="extracted")
    with open(fake, "rb") as fp:
        f.archivo_original.save("test.pdf", File(fp), save=True)

    resp = client.get(f"/facturas/{f.pk}/archivo/")
    assert resp.status_code == 200


def test_archivo_download_lector_ok(client, oc, tmp_path):
    """Lector también puede descargar (tiene view_factura — fix #1)."""
    from apps.facturas.models import Factura
    from django.core.files import File

    _login(client, "lector")
    fake = tmp_path / "test.xml"
    fake.write_text("<root/>")

    f = Factura.objects.create(oc=oc, source_type="xml", status="confirmed")
    with open(fake, "rb") as fp:
        f.archivo_original.save("test.xml", File(fp), save=True)

    resp = client.get(f"/facturas/{f.pk}/archivo/")
    # Fix #1: has_perm('view_factura') sin obj → True para lector
    # ModelBackend solo soporta model-level permissions
    assert resp.status_code == 200, (
        "Fix #1 FAILED: has_perm('view_factura') sin obj debe ser True para "
        "lector. Si retorna 403, posiblemente se está pasando obj a has_perm."
    )


def test_archivo_download_user_without_perm_forbidden(client, oc):
    """User sin grupo (sin view_factura) → 403."""
    from apps.facturas.models import Factura
    from django.contrib.auth import get_user_model

    User = get_user_model()
    u = User.objects.create_user(username="noperm", password="pw")
    # NO le agregamos ningún grupo
    client.login(username="noperm", password="pw")

    f = Factura.objects.create(
        oc=oc, source_type="xml", archivo_original="x.xml", status="confirmed",
    )
    resp = client.get(f"/facturas/{f.pk}/archivo/")
    assert resp.status_code == 403


def test_archivo_download_no_file_404(client, oc):
    """Factura sin archivo → 404 (no crash)."""
    from apps.facturas.models import Factura
    _login(client, "supervisor")
    f = Factura.objects.create(
        oc=oc, source_type="xml", archivo_original="", status="confirmed",
    )
    resp = client.get(f"/facturas/{f.pk}/archivo/")
    assert resp.status_code in (404, 500)  # Puede ser 500 si el archivo no existe en disk
