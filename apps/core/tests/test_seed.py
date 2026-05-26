import pytest
from django.core.management import call_command

pytestmark = pytest.mark.django_db


def test_seed_creates_cliente_and_bodegas():
    from apps.core.models import Cliente, Bodega
    call_command("seed_initial_data", verbosity=0)
    nicholas = Cliente.objects.filter(nombre__startswith="Nicholas").first()
    assert nicholas is not None
    assert nicholas.bodegas.count() == 3
    nombres = sorted(nicholas.bodegas.values_list("nombre", flat=True))
    assert nombres == ["Bodega Baches", "Cuarto 4 del Bache", "Cuarto Eléctrico GADI"]


def test_seed_is_idempotent():
    from apps.core.models import Cliente, Bodega
    call_command("seed_initial_data", verbosity=0)
    call_command("seed_initial_data", verbosity=0)  # segunda vez
    assert Cliente.objects.filter(nombre__startswith="Nicholas").count() == 1
    assert Bodega.objects.filter(cliente__nombre__startswith="Nicholas").count() == 3
