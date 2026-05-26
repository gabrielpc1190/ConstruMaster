from django.contrib import admin
from .models import ExchangeRate


@admin.register(ExchangeRate)
class ExchangeRateAdmin(admin.ModelAdmin):
    list_display = ("currency", "date", "buy", "sell", "source", "fetched_at")
    list_filter = ("currency", "source")
    date_hierarchy = "date"
    ordering = ("-date",)
    search_fields = ("currency",)
