import pytest

pytestmark = pytest.mark.django_db


def test_generate_numero_oc_secuencial():
    """Secuencia 0001, 0002, 0003 para la misma obra."""
    from apps.core.tests.factories import ObraFactory
    from apps.compras.services import generate_numero_oc

    obra = ObraFactory(nombre="Casa Lomas")
    n1 = generate_numero_oc(obra.pk)
    n2 = generate_numero_oc(obra.pk)
    n3 = generate_numero_oc(obra.pk)
    obra.refresh_from_db()
    assert n1.endswith("-OC-0001")
    assert n2.endswith("-OC-0002")
    assert n3.endswith("-OC-0003")
    assert obra.next_oc_seq == 4


def test_generate_numero_oc_separado_por_obra():
    """Cada obra tiene su propia secuencia independiente."""
    from apps.core.tests.factories import ObraFactory
    from apps.compras.services import generate_numero_oc

    o1 = ObraFactory(nombre="Lomas")
    o2 = ObraFactory(nombre="Baches")
    n1a = generate_numero_oc(o1.pk)
    n2a = generate_numero_oc(o2.pk)
    n1b = generate_numero_oc(o1.pk)

    # Cada obra arranca en 0001
    assert n1a.endswith("-OC-0001")
    assert n2a.endswith("-OC-0001")
    # Lomas se incrementa a 0002
    assert n1b.endswith("-OC-0002")
    # Los slug en uppercase deben aparecer
    assert "LOMAS" in n1a.upper()
    assert "BACHES" in n2a.upper()


def test_generate_numero_oc_format():
    """Formato debe ser <SLUG_UPPER>-OC-NNNN con padding 4 dígitos."""
    from apps.core.tests.factories import ObraFactory
    from apps.compras.services import generate_numero_oc

    obra = ObraFactory(nombre="Casa Lomas 2026")
    n = generate_numero_oc(obra.pk)
    # slug: casa-lomas-2026 → CASA-LOMAS-2026
    assert n == "CASA-LOMAS-2026-OC-0001"


def test_generate_numero_oc_uses_select_for_update():
    """Smoke test: la función está dentro de transaction.atomic + select_for_update.

    No es un test de race real (eso requiere threading), solo verifica que
    el incremento es persistente en BD (Obra.next_oc_seq sube).
    """
    from apps.core.tests.factories import ObraFactory
    from apps.compras.services import generate_numero_oc

    obra = ObraFactory(nombre="Test Lock")
    initial_seq = obra.next_oc_seq
    generate_numero_oc(obra.pk)
    obra.refresh_from_db()
    assert obra.next_oc_seq == initial_seq + 1
