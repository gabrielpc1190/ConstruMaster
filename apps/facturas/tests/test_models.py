from datetime import date
from decimal import Decimal

import pytest
from djmoney.money import Money

pytestmark = pytest.mark.django_db


@pytest.fixture
def oc(db):
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import OrdenCompra
    obra = ObraFactory(nombre="Casa F")
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    return OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="F-OC-0001", fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(1000, "CRC"), estado="autorizada",
    )


def test_factura_creation_pending(oc):
    """Factura recién creada queda en status=pending sin datos canónicos."""
    from apps.facturas.models import Factura
    f = Factura.objects.create(
        oc=oc, source_type="xml",
        archivo_original="dummy.xml",
    )
    assert f.status == "pending"
    assert f.tipo_comprobante == ""
    assert f.extracted_data == {}
    assert f.confidence_score is None
    assert f.clave_numerica == ""
    assert f.medios_pago == []


def test_factura_protege_oc_de_borrado(oc):
    """No se puede borrar OC con facturas (PROTECT)."""
    from apps.facturas.models import Factura
    from django.db.models import ProtectedError
    Factura.objects.create(
        oc=oc, source_type="xml", archivo_original="x.xml",
    )
    with pytest.raises(ProtectedError):
        oc.delete()


def test_factura_clave_numerica_unique_when_present(oc):
    """clave_numerica con valor: UNIQUE constraint. Vacía: pueden repetirse."""
    from apps.facturas.models import Factura
    from django.db import IntegrityError

    # Dos facturas sin clave_numerica (vacía) → ambas OK
    Factura.objects.create(
        oc=oc, source_type="xml", archivo_original="a.xml", clave_numerica="",
    )
    Factura.objects.create(
        oc=oc, source_type="xml", archivo_original="b.xml", clave_numerica="",
    )

    # Dos facturas con misma clave_numerica → IntegrityError
    Factura.objects.create(
        oc=oc, source_type="xml", archivo_original="c.xml",
        clave_numerica="50604052600310169828000100001040000134414127865041",
    )
    with pytest.raises(IntegrityError):
        Factura.objects.create(
            oc=oc, source_type="xml", archivo_original="d.xml",
            clave_numerica="50604052600310169828000100001040000134414127865041",
        )


def test_factura_with_extracted_data(oc):
    """status=extracted con data parseada del XML."""
    from apps.facturas.models import Factura
    f = Factura.objects.create(
        oc=oc, source_type="xml", archivo_original="x.xml",
        status="extracted",
        tipo_comprobante="TE",
        extracted_data={
            "tipo": "TE",
            "clave": "X" * 50,
            "consecutivo": "00100001",
            "fecha": "2026-05-04",
            "items": [{"descripcion": "Item 1"}],
        },
        confidence_score=None,  # XML determinista
    )
    assert f.status == "extracted"
    assert f.extracted_data["tipo"] == "TE"
    assert len(f.extracted_data["items"]) == 1


def test_factura_confirmed_promotes_canonical_fields(oc):
    """Al confirmar, los campos canónicos se llenan."""
    from apps.facturas.models import Factura
    from django.contrib.auth import get_user_model

    user = get_user_model().objects.create_user("u_conf")
    f = Factura.objects.create(
        oc=oc, source_type="xml", archivo_original="z.xml",
        status="confirmed",
        tipo_comprobante="TE",
        clave_numerica="X" * 50,
        numero_consecutivo="00100001040000134414",
        fecha_emision=date(2026, 5, 4),
        monto_total=Money(1769, "CRC"),
        condicion_venta="01",
        medios_pago=[{"tipo": "02", "monto": "1769.31"}],
        confirmada_por=user,
    )
    assert f.status == "confirmed"
    assert f.fecha_emision == date(2026, 5, 4)
    assert f.confirmada_por == user
    assert len(f.medios_pago) == 1


def test_factura_status_choices_valid(oc):
    """Solo 5 valores de status."""
    from apps.facturas.models import Factura

    for status in ("pending", "processing", "extracted", "confirmed", "error"):
        Factura.objects.create(
            oc=oc, source_type="pdf", archivo_original=f"{status}.pdf",
            status=status,
        )
    assert Factura.objects.filter(status="confirmed").exists()


def test_factura_with_ocr_data(oc):
    """source_type=pdf/imagen con confidence_score y _warnings."""
    from apps.facturas.models import Factura
    f = Factura.objects.create(
        oc=oc, source_type="pdf", archivo_original="scan.pdf",
        status="extracted",
        extracted_data={
            "emisor": {"nombre": "X", "identificacion": "3101000001"},
            "total": 100,
            "_warnings": ["total inválido (<=0)"],
        },
        confidence_score=0.85,
    )
    assert f.confidence_score == 0.85
    assert "_warnings" in f.extracted_data


def test_confirm_factura_permission_exists():
    """Custom permission confirm_factura existe."""
    from django.contrib.auth.models import Permission
    assert Permission.objects.filter(codename="confirm_factura").exists()
