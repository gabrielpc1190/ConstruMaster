"""Crea Schedule diario para fetch_bccr_rates (8:30 AM L-V hora del servidor)."""
from django.db import migrations


def create_schedule(apps, schema_editor):
    Schedule = apps.get_model("django_q", "Schedule")
    Schedule.objects.update_or_create(
        name="fetch_bccr_rates_diario",
        defaults={
            "func": "apps.finance.tasks.fetch_bccr_rates",
            "schedule_type": "C",   # cron
            "cron": "30 8 * * 1-5",  # 8:30 AM lunes-viernes
            "repeats": -1,
        },
    )


def remove_schedule(apps, schema_editor):
    Schedule = apps.get_model("django_q", "Schedule")
    Schedule.objects.filter(name="fetch_bccr_rates_diario").delete()


class Migration(migrations.Migration):
    dependencies = [
        ("finance", "0001_initial"),
        # django_q migrations no se importan explícitamente — se asume aplicada
    ]
    operations = [
        migrations.RunPython(create_schedule, remove_schedule),
    ]
