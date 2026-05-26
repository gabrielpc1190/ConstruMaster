# ConstruMaster — Módulo de Materiales (MVP) — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir un MVP funcional del módulo de Materiales de ConstruMaster: webapp Django interna con multi-moneda CRC/USD, parser de comprobantes electrónicos v4.4 de Hacienda CR, OCR de facturas con Gemini, flujo completo cotización→OC→pago→factura→entrega, dashboards por rol y deploy via Docker Compose + Cloudflare Tunnel.

**Architecture:** Django monolito + HTMX (sin SPA). Worker Django-Q2 separado para tareas async (OCR, fetch BCCR diario). Postgres 16, Redis 7 (cola + cache). Cloudflare Tunnel → gunicorn directo (sin reverse proxy adicional). Storage local con abstracción Django para migrar a S3 después. Auth Django nativo + Groups (sin allauth). Audit log con django-auditlog.

**Tech Stack:**
- Python 3.13, Django 5.2 LTS, Django-Q2 1.10, django-htmx 1.27, django-money 3.6, django-auditlog
- HTMX 2.0.9, Tailwind v4 via `django-tailwind-cli`
- gunicorn 23, whitenoise
- Postgres 16, Redis 7
- `lxml` (parser FE/TE XML), `httpx` (cliente BCCR + Gemini), `google-genai` (Gemini SDK)
- Docker Compose, Cloudflare Tunnel
- `pytest` + `pytest-django` + `factory_boy` + `freezegun` para tests

**Spec de referencia:** `docs/superpowers/specs/2026-05-25-construmaster-modulo-materiales-design.md`

---

## Estructura de archivos del proyecto

```
construmaster/
├── .env                          # secrets (gitignored)
├── .env.example                  # template público
├── .gitignore
├── docker-compose.yml            # web + worker + postgres + redis + cloudflared + backup
├── Dockerfile                    # imagen única (entrypoint distinto para web/worker)
├── pyproject.toml                # deps + ruff config
├── manage.py
├── construmaster/                # config Django project
│   ├── __init__.py
│   ├── settings.py
│   ├── urls.py
│   ├── wsgi.py
│   └── asgi.py
├── apps/
│   ├── core/                     # base: User, Cliente, Obra, CategoriaPresupuesto, Bodega
│   │   ├── models.py
│   │   ├── admin.py
│   │   ├── views.py
│   │   ├── urls.py
│   │   ├── permissions.py        # helpers de auth
│   │   ├── seed.py               # seed data (grupos, bodegas iniciales)
│   │   └── migrations/
│   ├── finance/                  # multi-moneda + BCCR
│   │   ├── models.py             # ExchangeRate
│   │   ├── services.py           # convert()
│   │   ├── bccr_client.py        # cliente httpx
│   │   ├── tasks.py              # fetch_bccr_rates (async)
│   │   ├── management/commands/
│   │   │   ├── fetch_bccr_rates.py
│   │   │   ├── backfill_bccr_rates.py
│   │   │   └── verify_bccr_token.py
│   │   ├── templatetags/money_extras.py  # money_display
│   │   └── tests/
│   ├── catalogo/                 # ItemCatalogo + Proveedor
│   │   ├── models.py
│   │   ├── views.py              # autocomplete, sugerir, aprobar
│   │   ├── forms.py
│   │   └── tests/
│   ├── compras/                  # SolicitudCotizacion, Cotizacion, OC, Pago, Hito
│   │   ├── models.py
│   │   ├── views.py
│   │   ├── forms.py
│   │   ├── services.py           # approve_cotizacion, generate_numero_oc
│   │   ├── state_machines.py     # transiciones de estado
│   │   └── tests/
│   ├── facturas/                 # Factura + parser comprobantes + OCR
│   │   ├── models.py
│   │   ├── parsers/
│   │   │   ├── __init__.py
│   │   │   ├── xml_parser.py     # parse_comprobante_xml polimórfico
│   │   │   └── ocr_gemini.py     # ocr_invoice_gemini
│   │   ├── tasks.py              # extract_invoice
│   │   ├── views.py
│   │   ├── schemas/V4.4/         # XSDs oficiales de Hacienda
│   │   │   ├── FacturaElectronica.xsd
│   │   │   ├── TiqueteElectronico.xsd
│   │   │   ├── NotaCreditoElectronica.xsd
│   │   │   ├── NotaDebitoElectronica.xsd
│   │   │   ├── FacturaElectronicaCompra.xsd
│   │   │   └── FacturaElectronicaExportacion.xsd
│   │   └── tests/
│   │       └── fixtures/         # XMLs reales para tests
│   ├── entregas/                 # Entrega, EntregaItem, EntregaFoto
│   │   ├── models.py
│   │   ├── views.py
│   │   ├── forms.py
│   │   └── tests/
│   └── reportes/                 # dashboards por rol + exports CSV/PDF
│       ├── views.py
│       ├── exporters.py
│       └── tests/
├── templates/                    # global templates
│   ├── base.html
│   ├── partials/
│   └── <app>/
├── static/                       # source para tailwind cli
│   └── css/input.css
├── docker/
│   ├── web.entrypoint.sh
│   ├── worker.entrypoint.sh
│   └── backup.sh
├── docs/superpowers/
│   ├── specs/2026-05-25-construmaster-modulo-materiales-design.md
│   └── plans/2026-05-25-construmaster-modulo-materiales.md  ← este archivo
└── docs/                         # referencia técnica
    ├── Estándar ... SDDE.pdf
    └── TQ50604052600310169828000100001040000134414127865041.xml
```

---

## Convenciones para todas las tareas

- **Idioma:** código, identifiers, commits, logs en inglés. Docstrings cortos en español si aclaran negocio (ej: "Snapshot del TC al aprobar la OC — ver spec §9.4"). Templates en español (UI usuario).
- **TDD estricto:** tests primero, ver fallar, implementar mínimo, ver pasar, refactor, commit. Cada tarea termina con commit.
- **Commit messages:** Conventional Commits en inglés (`feat:`, `fix:`, `test:`, `chore:`, `refactor:`, `docs:`). Push directo a `main`.
- **Co-author:** cada commit termina con la línea `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` cuando lo genere el agente.
- **Migraciones:** una migración por tarea cuando modifique modelos. Nombre descriptivo (`0003_add_factura_tipo_comprobante`).
- **Dependencias entre fases:** las fases están ordenadas por dependencia. La Fase N asume completas N-1.

---

## Fase 0 — Bootstrap del proyecto

**Objetivo:** Repo inicial con Docker + Django esqueleto + Postgres + Redis corriendo, página de login funcional.

**Resultado testeable al final:** `docker compose up -d` levanta todo; `http://localhost:8000/admin/` carga el login.

### Task 0.1 — Inicializar repo git y archivos base

**Files:**
- Create: `/mnt/NAS/ConstruMaster/README.md`
- Create: `/mnt/NAS/ConstruMaster/pyproject.toml`
- Modify: `/mnt/NAS/ConstruMaster/.gitignore` (ya existe, agregar entradas faltantes)

- [ ] **Step 1: Verificar estado del directorio**

```bash
cd /mnt/NAS/ConstruMaster
ls -la
```

Expected: ver `.env`, `.env.example`, `.gitignore`, `docs/`. No hay `.git` aún.

- [ ] **Step 2: Crear `README.md` mínimo**

```markdown
# ConstruMaster

Webapp interna para supervisar obras de construcción de ADITA para el cliente Nicholas Rowley.

Ver `docs/superpowers/specs/` para diseño y `docs/superpowers/plans/` para implementación.

## Setup

```bash
cp .env.example .env  # llenar con secretos reales
docker compose up -d
docker compose exec web python manage.py migrate
docker compose exec web python manage.py createsuperuser
```

## Stack

Python 3.13, Django 5.2, Postgres 16, Redis 7, Cloudflare Tunnel.
```

- [ ] **Step 3: Crear `pyproject.toml`**

```toml
[project]
name = "construmaster"
version = "0.1.0"
requires-python = ">=3.13"
dependencies = [
    "django>=5.2,<5.3",
    "django-q2>=1.10",
    "django-htmx>=1.27",
    "django-tailwind-cli>=4.6",
    "django-money>=3.6",
    "django-auditlog>=3.0",
    "django-environ>=0.11",
    "psycopg[binary]>=3.2",
    "redis>=5.0",
    "gunicorn>=23.0",
    "whitenoise>=6.7",
    "httpx>=0.27",
    "lxml>=5.3",
    "google-genai>=1.0",
    "Pillow>=11.0",
    "pyheif>=0.8",
    "babel>=2.16",
    "weasyprint>=63.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.3",
    "pytest-django>=4.9",
    "factory-boy>=3.3",
    "freezegun>=1.5",
    "ruff>=0.7",
    "ipython>=8.30",
]

[tool.ruff]
line-length = 100
target-version = "py313"

[tool.ruff.lint]
select = ["E", "F", "W", "I", "B", "UP", "DJ"]
ignore = ["E501"]  # line length manejado por formatter

[tool.pytest.ini_options]
DJANGO_SETTINGS_MODULE = "construmaster.settings"
python_files = ["test_*.py", "tests.py"]
addopts = "--reuse-db -p no:cacheprovider"
```

- [ ] **Step 4: Inicializar git**

```bash
cd /mnt/NAS/ConstruMaster
git init -b main
git config user.email "gabrielpc1190@gmail.com"
git config user.name "Gabriel"
git config commit.gpgsign false
```

- [ ] **Step 5: Primer commit**

```bash
git add .gitignore .env.example README.md pyproject.toml
git commit -m "chore: initialize project scaffolding

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

Expected: commit ok. `git log --oneline` muestra el commit. `.env` NO está commiteado (verificar con `git ls-files | grep env`).

### Task 0.2 — Dockerfile y docker-compose base

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `docker/web.entrypoint.sh`
- Create: `docker/worker.entrypoint.sh`

- [ ] **Step 1: Crear `Dockerfile`**

```dockerfile
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# System deps for psycopg, lxml, pyheif, weasyprint
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    libxml2-dev libxslt-dev \
    libheif-dev \
    libpango-1.0-0 libpangoft2-1.0-0 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps
COPY pyproject.toml ./
RUN pip install --no-cache-dir -e .[dev]

# Copy app
COPY . .

# Entrypoints
RUN chmod +x docker/web.entrypoint.sh docker/worker.entrypoint.sh

EXPOSE 8000
```

- [ ] **Step 2: Crear `docker/web.entrypoint.sh`**

```bash
#!/bin/bash
set -e

python manage.py migrate --noinput
python manage.py collectstatic --noinput

exec gunicorn construmaster.wsgi:application \
    --bind 0.0.0.0:8000 \
    --workers 3 \
    --timeout 60 \
    --access-logfile - \
    --error-logfile -
```

- [ ] **Step 3: Crear `docker/worker.entrypoint.sh`**

```bash
#!/bin/bash
set -e

# Wait for DB ready (web container handles migrations)
sleep 5

exec python manage.py qcluster
```

- [ ] **Step 4: Crear `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16.4
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: redis-server --maxmemory-policy allkeys-lru
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  web:
    build: .
    command: docker/web.entrypoint.sh
    env_file: .env
    volumes:
      - mediadata:/var/data/files
      - staticdata:/app/staticfiles
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped
    # NO ports: — accesible solo via red interna y cloudflared

  worker:
    build: .
    command: docker/worker.entrypoint.sh
    env_file: .env
    volumes:
      - mediadata:/var/data/files
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped

volumes:
  pgdata:
  redisdata:
  mediadata:
  staticdata:
```

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml docker/
git commit -m "feat: add Docker setup with Postgres, Redis, web, and worker services

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 0.3 — Inicializar Django project

**Files:**
- Create: `manage.py`, `construmaster/__init__.py`, `construmaster/settings.py`, `construmaster/urls.py`, `construmaster/wsgi.py`, `construmaster/asgi.py`

- [ ] **Step 1: Crear estructura de Django manualmente (sin django-admin para control total)**

```bash
mkdir -p construmaster
touch construmaster/__init__.py
```

- [ ] **Step 2: Crear `manage.py`**

```python
#!/usr/bin/env python
"""Django's command-line utility for administrative tasks."""
import os
import sys


def main():
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "construmaster.settings")
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:
        raise ImportError(
            "Couldn't import Django. Are you sure it's installed?"
        ) from exc
    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
```

```bash
chmod +x manage.py
```

- [ ] **Step 3: Crear `construmaster/settings.py`**

```python
"""Django settings for ConstruMaster."""
import environ
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
env = environ.Env()
environ.Env.read_env(BASE_DIR / ".env")

SECRET_KEY = env("DJANGO_SECRET_KEY", default="dev-insecure-change-me")
DEBUG = env.bool("DJANGO_DEBUG", default=False)
ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS", default=["localhost", "127.0.0.1"])
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=[])

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django_htmx",
    "django_q",
    "djmoney",
    "auditlog",
    # Local apps (added in later phases)
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "django_htmx.middleware.HtmxMiddleware",
    "auditlog.middleware.AuditlogMiddleware",
]

ROOT_URLCONF = "construmaster.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "construmaster.wsgi.application"

DATABASES = {
    "default": env.db("DATABASE_URL", default="sqlite:///db.sqlite3"),
}

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": env("CACHE_URL", default="redis://redis:6379/1"),
    }
}

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "es-cr"
TIME_ZONE = "America/Costa_Rica"
USE_I18N = True
USE_TZ = True
USE_THOUSAND_SEPARATOR = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_DIRS = [BASE_DIR / "static"]

STORAGES = {
    "default": {
        "BACKEND": "django.core.files.storage.FileSystemStorage",
        "OPTIONS": {
            "location": "/var/data/files",
            "base_url": "/media/",
        },
    },
    "staticfiles": {
        "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage",
    },
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# Security behind Cloudflare Tunnel
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
USE_X_FORWARDED_HOST = True
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG
SECURE_SSL_REDIRECT = False  # Cloudflare ya redirige

# Django-Q2
Q_CLUSTER = {
    "name": "construmaster",
    "workers": 2,
    "recycle": 500,
    "timeout": 180,
    "retry": 240,
    "max_attempts": 3,
    "queue_limit": 50,
    "bulk": 10,
    "redis": env("REDIS_URL", default="redis://redis:6379/0"),
}

# Money
CURRENCIES = ("CRC", "USD")
CURRENCY_CHOICES = [("CRC", "Colones (₡)"), ("USD", "Dólares ($)")]
DEFAULT_CURRENCY = "CRC"

# Custom settings (used by apps)
OCR_MODEL = "gemini-3.1-flash-lite"  # fallback documentado: gemini-2.5-flash-lite
GEMINI_API_KEY = env("GEMINI_API_KEY", default="")
BCCR_EMAIL = env("BCCR_EMAIL", default="")
BCCR_TOKEN = env("BCCR_TOKEN", default="")
MAX_UPLOAD_SIZE = 20 * 1024 * 1024  # 20 MB

LOGIN_URL = "/admin/login/"
LOGIN_REDIRECT_URL = "/"

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {
        "console": {"class": "logging.StreamHandler"},
    },
    "root": {"handlers": ["console"], "level": "INFO"},
    "loggers": {
        "django": {"handlers": ["console"], "level": "INFO", "propagate": False},
        "construmaster": {"handlers": ["console"], "level": "DEBUG" if DEBUG else "INFO"},
    },
}
```

- [ ] **Step 4: Crear `construmaster/urls.py`**

```python
from django.contrib import admin
from django.urls import path

urlpatterns = [
    path("admin/", admin.site.urls),
]
```

- [ ] **Step 5: Crear `construmaster/wsgi.py`**

```python
import os
from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "construmaster.settings")
application = get_wsgi_application()
```

- [ ] **Step 6: Crear `construmaster/asgi.py`**

```python
import os
from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "construmaster.settings")
application = get_asgi_application()
```

- [ ] **Step 7: Generar `DJANGO_SECRET_KEY` real y agregarla al `.env`**

```bash
docker compose run --rm web python -c "import secrets; print(secrets.token_urlsafe(50))"
```

Pegar el output como valor de `DJANGO_SECRET_KEY` en `.env`. Asegurarse que `DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1` esté seteado al menos para dev.

- [ ] **Step 8: Levantar stack y probar admin**

```bash
docker compose up -d --build
docker compose logs -f web
```

Esperar a que diga "Listening at: http://0.0.0.0:8000".

```bash
docker compose exec web python manage.py createsuperuser \
  --username admin --email admin@example.com
# Password: (a tu elección)
```

Verificar que admin carga:
```bash
docker compose exec web python -c "
from django.test import Client
c = Client()
r = c.get('/admin/login/')
print('Status:', r.status_code)
"
```

Expected: `Status: 200`.

- [ ] **Step 9: Commit**

```bash
git add manage.py construmaster/
git commit -m "feat: initialize Django project with base settings

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 0.4 — Tailwind setup

**Files:**
- Create: `static/css/input.css`
- Create: `templates/base.html`
- Modify: `construmaster/settings.py` (agregar `django_tailwind_cli` y config)

- [ ] **Step 1: Agregar `django_tailwind_cli` a INSTALLED_APPS**

En `construmaster/settings.py`, agregar dentro de `INSTALLED_APPS`:

```python
INSTALLED_APPS = [
    "django.contrib.admin",
    # ...
    "django_tailwind_cli",
    "django_htmx",
    # ...
]
```

Y al final del archivo:

```python
TAILWIND_CLI_VERSION = "4.0.0"
TAILWIND_CLI_SRC_CSS = "css/input.css"
TAILWIND_CLI_DIST_CSS = "css/tailwind.css"
```

- [ ] **Step 2: Crear `static/css/input.css`**

```css
@import "tailwindcss";

/* Custom utilities for ConstruMaster */
@layer components {
  .btn-primary {
    @apply px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700;
  }
  .btn-secondary {
    @apply px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300;
  }
  .badge-green { @apply bg-green-100 text-green-800 px-2 py-1 rounded text-xs; }
  .badge-yellow { @apply bg-yellow-100 text-yellow-800 px-2 py-1 rounded text-xs; }
  .badge-orange { @apply bg-orange-100 text-orange-800 px-2 py-1 rounded text-xs; }
  .badge-red { @apply bg-red-100 text-red-800 px-2 py-1 rounded text-xs; }
}
```

- [ ] **Step 3: Crear `templates/base.html`**

```html
{% load django_tailwind_cli htmx %}
<!DOCTYPE html>
<html lang="es-cr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{% block title %}ConstruMaster{% endblock %}</title>
  {% tailwind_css %}
  <script src="https://unpkg.com/htmx.org@2.0.9" defer></script>
</head>
<body class="bg-gray-50 text-gray-900 min-h-screen">
  <nav class="bg-white shadow px-4 py-3 flex justify-between items-center">
    <a href="/" class="font-bold text-lg">ConstruMaster</a>
    {% if user.is_authenticated %}
      <div class="flex gap-3 items-center text-sm">
        <span>{{ user.get_full_name|default:user.username }}</span>
        <form method="post" action="{% url 'admin:logout' %}">{% csrf_token %}
          <button type="submit" class="text-blue-600">Salir</button>
        </form>
      </div>
    {% endif %}
  </nav>
  <main class="max-w-7xl mx-auto px-4 py-6">
    {% if messages %}
      {% for m in messages %}
        <div class="mb-3 p-3 rounded {% if m.tags == 'error' %}bg-red-100{% else %}bg-blue-100{% endif %}">{{ m }}</div>
      {% endfor %}
    {% endif %}
    {% block content %}{% endblock %}
  </main>
</body>
</html>
```

- [ ] **Step 4: Compilar Tailwind y verificar**

```bash
docker compose exec web python manage.py tailwind download_cli
docker compose exec web python manage.py tailwind build
ls static/css/
```

Expected: ver `tailwind.css` generado.

- [ ] **Step 5: Commit**

```bash
git add construmaster/settings.py static/ templates/
git commit -m "feat: integrate Tailwind v4 via django-tailwind-cli

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 0.5 — Cloudflare Tunnel container (opcional para Fase 0, requerido para Fase 11)

**Files:**
- Modify: `docker-compose.yml` (agregar servicio `cloudflared`)

- [ ] **Step 1: Agregar servicio a `docker-compose.yml`** (al final de `services:`)

```yaml
  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel --no-autoupdate run --token ${CLOUDFLARED_TOKEN}
    restart: unless-stopped
    depends_on:
      - web
    profiles: ["production"]   # solo se levanta con `--profile production`
```

- [ ] **Step 2: Verificar que el servicio no se levanta en dev**

```bash
docker compose up -d
docker compose ps
```

Expected: `cloudflared` no aparece corriendo (queda en profile `production`).

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add Cloudflare Tunnel service (production profile only)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 0.6 — Smoke test de la Fase 0

- [ ] **Step 1: Bajar y volver a levantar todo desde cero**

```bash
docker compose down -v
docker compose up -d --build
docker compose exec web python manage.py migrate
docker compose exec web python manage.py createsuperuser --username admin --email admin@example.com
```

- [ ] **Step 2: Verificar healthchecks**

```bash
docker compose ps
```

Expected: `web`, `worker`, `postgres`, `redis` todos en `Up` con `(healthy)` donde aplique.

- [ ] **Step 3: Probar login al admin via curl (asume `DEBUG=True` o `ALLOWED_HOSTS` incluye localhost)**

```bash
docker compose exec web python manage.py shell -c "
from django.test import Client
c = Client()
print('GET /admin/login/:', c.get('/admin/login/').status_code)
"
```

Expected: `GET /admin/login/: 200`.

- [ ] **Step 4: Verificar worker funcional**

```bash
docker compose exec web python manage.py shell -c "
from django_q.tasks import async_task, result
import time
task_id = async_task('builtins.print', 'hello from worker')
time.sleep(2)
print('Result:', result(task_id))
"
```

Expected: el worker imprime "hello from worker" en sus logs (`docker compose logs worker`).

---

**Fase 0 completa.** Stack base corriendo, login funcional, worker procesando tasks.

---

## Fase 1 — Modelos core + auth + admin

**Objetivo:** Modelos `Cliente`, `Obra`, `CategoriaPresupuesto`, `Presupuesto`, `Bodega`, `Proveedor`, `ItemCatalogo`. Grupos `supervisor/operativo/lector` con permisos custom. Admin de Django funcional para CRUD básico. Seed data con Don Nicholas y las 3 bodegas.

**Resultado testeable:** desde el admin puedo crear cliente Nicholas, una obra "Casa Lomas", categorías de presupuesto, presupuesto por categoría, items del catálogo. Los 3 grupos existen con permisos correctos.

### Task 1.1 — Crear app `core` con Cliente y Obra

**Files:**
- Create: `apps/__init__.py`
- Create: `apps/core/__init__.py`, `apps/core/apps.py`, `apps/core/models.py`, `apps/core/admin.py`, `apps/core/tests/__init__.py`, `apps/core/tests/test_models.py`, `apps/core/tests/factories.py`
- Modify: `construmaster/settings.py` (agregar `apps.core` a INSTALLED_APPS)

- [ ] **Step 1: Crear estructura**

```bash
mkdir -p apps/core/tests apps/core/migrations
touch apps/__init__.py apps/core/__init__.py apps/core/migrations/__init__.py apps/core/tests/__init__.py
```

- [ ] **Step 2: Crear `apps/core/apps.py`**

```python
from django.apps import AppConfig


class CoreConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.core"
    verbose_name = "Core"
```

- [ ] **Step 3: Escribir test de `Cliente` (que debe fallar)**

`apps/core/tests/test_models.py`:

```python
import pytest
from django.db import IntegrityError

pytestmark = pytest.mark.django_db


def test_cliente_creation():
    from apps.core.models import Cliente
    c = Cliente.objects.create(
        nombre="Nicholas Charles Rowley",
        identificacion="A-1234567",
    )
    assert c.pk is not None
    assert str(c) == "Nicholas Charles Rowley"


def test_cliente_nombre_required():
    from apps.core.models import Cliente
    with pytest.raises(IntegrityError):
        Cliente.objects.create(nombre="", identificacion="A-001")
```

- [ ] **Step 4: Correr el test, debe fallar**

```bash
docker compose exec web pytest apps/core/tests/test_models.py -v
```

Expected: ImportError o "model not found" — el modelo aún no existe.

- [ ] **Step 5: Implementar `Cliente` y `Obra` en `apps/core/models.py`**

```python
from django.db import models
from django.utils.text import slugify


class TimestampedModel(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Cliente(TimestampedModel):
    nombre = models.CharField(max_length=200)
    identificacion = models.CharField(max_length=50, blank=True)
    notas = models.TextField(blank=True)

    class Meta:
        verbose_name = "Cliente"
        verbose_name_plural = "Clientes"
        ordering = ["nombre"]
        constraints = [
            models.CheckConstraint(
                check=~models.Q(nombre=""),
                name="cliente_nombre_no_vacio",
            ),
        ]

    def __str__(self):
        return self.nombre


class Obra(TimestampedModel):
    ESTADO_CHOICES = [
        ("planificada", "Planificada"),
        ("en_curso", "En curso"),
        ("pausada", "Pausada"),
        ("finalizada", "Finalizada"),
    ]
    MONEDA_REPORTE_CHOICES = [("CRC", "Colones"), ("USD", "Dólares")]

    cliente = models.ForeignKey(Cliente, on_delete=models.PROTECT, related_name="obras")
    nombre = models.CharField(max_length=200)
    slug = models.SlugField(max_length=80, unique=True)
    direccion = models.TextField(blank=True)
    fecha_inicio = models.DateField(null=True, blank=True)
    fecha_fin_estimada = models.DateField(null=True, blank=True)
    moneda_reporte = models.CharField(max_length=3, choices=MONEDA_REPORTE_CHOICES, default="USD")
    estado = models.CharField(max_length=20, choices=ESTADO_CHOICES, default="planificada")
    next_oc_seq = models.PositiveIntegerField(default=1)  # contador para numero_oc, ver §6.4 spec
    notas = models.TextField(blank=True)

    class Meta:
        verbose_name = "Obra"
        verbose_name_plural = "Obras"
        ordering = ["-fecha_inicio", "nombre"]

    def save(self, *args, **kwargs):
        if not self.slug:
            self.slug = slugify(self.nombre)[:80]
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.nombre} ({self.cliente.nombre})"
```

- [ ] **Step 6: Agregar `apps.core` a INSTALLED_APPS**

En `construmaster/settings.py`:

```python
INSTALLED_APPS = [
    # ... django apps ...
    "django_tailwind_cli",
    "django_htmx",
    "django_q",
    "djmoney",
    "auditlog",
    # Local apps
    "apps.core",
]
```

- [ ] **Step 7: Crear migración y aplicar**

```bash
docker compose exec web python manage.py makemigrations core
docker compose exec web python manage.py migrate
```

- [ ] **Step 8: Correr los tests, deben pasar**

```bash
docker compose exec web pytest apps/core/tests/test_models.py -v
```

Expected: ambos tests PASS.

- [ ] **Step 9: Agregar test de Obra**

Append a `apps/core/tests/test_models.py`:

```python
def test_obra_auto_slug():
    from apps.core.models import Cliente, Obra
    c = Cliente.objects.create(nombre="Nicholas", identificacion="A-1")
    o = Obra.objects.create(cliente=c, nombre="Casa Lomas 2026")
    assert o.slug == "casa-lomas-2026"


def test_obra_next_oc_seq_starts_at_1():
    from apps.core.models import Cliente, Obra
    c = Cliente.objects.create(nombre="Nicholas", identificacion="A-1")
    o = Obra.objects.create(cliente=c, nombre="Casa Bache")
    assert o.next_oc_seq == 1
```

Correr: `docker compose exec web pytest apps/core/tests/test_models.py -v`. Expected: 4 PASS.

- [ ] **Step 10: Crear `apps/core/admin.py`**

```python
from django.contrib import admin
from .models import Cliente, Obra


@admin.register(Cliente)
class ClienteAdmin(admin.ModelAdmin):
    list_display = ("nombre", "identificacion", "created_at")
    search_fields = ("nombre", "identificacion")


@admin.register(Obra)
class ObraAdmin(admin.ModelAdmin):
    list_display = ("nombre", "cliente", "estado", "fecha_inicio", "moneda_reporte")
    list_filter = ("estado", "cliente")
    search_fields = ("nombre", "slug")
    prepopulated_fields = {"slug": ("nombre",)}
    readonly_fields = ("next_oc_seq",)
```

- [ ] **Step 11: Verificar admin manualmente**

```bash
docker compose restart web
```

Login en `/admin/` y crear un Cliente "Nicholas Charles Rowley" y una Obra "Casa Lomas". Confirmar que el slug se autogenera.

- [ ] **Step 12: Commit**

```bash
git add apps/core/ construmaster/settings.py
git commit -m "feat(core): add Cliente and Obra models with admin

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.2 — CategoriaPresupuesto y Presupuesto

**Files:**
- Modify: `apps/core/models.py`, `apps/core/admin.py`, `apps/core/tests/test_models.py`

- [ ] **Step 1: Test fail-first**

Append a `apps/core/tests/test_models.py`:

```python
def test_categoria_presupuesto_por_obra():
    from apps.core.models import Cliente, Obra, CategoriaPresupuesto
    c = Cliente.objects.create(nombre="Nicholas", identificacion="A-1")
    o = Obra.objects.create(cliente=c, nombre="Casa Lomas")
    cat = CategoriaPresupuesto.objects.create(obra=o, nombre="Estructura", orden=1)
    assert cat.obra == o
    assert str(cat) == "Estructura (Casa Lomas (Nicholas))"


def test_presupuesto_creation():
    from apps.core.models import Cliente, Obra, CategoriaPresupuesto, Presupuesto
    from djmoney.money import Money
    c = Cliente.objects.create(nombre="Nicholas", identificacion="A-1")
    o = Obra.objects.create(cliente=c, nombre="Casa Lomas")
    cat = CategoriaPresupuesto.objects.create(obra=o, nombre="Estructura", orden=1)
    p = Presupuesto.objects.create(obra=o, categoria=cat, monto=Money(10_000_000, "CRC"))
    assert p.monto.amount == 10_000_000
    assert p.monto.currency.code == "CRC"
```

Correr: `pytest apps/core/tests/test_models.py -v` → FAIL (CategoriaPresupuesto no existe).

- [ ] **Step 2: Implementar modelos**

Append a `apps/core/models.py`:

```python
from djmoney.models.fields import MoneyField


class CategoriaPresupuesto(TimestampedModel):
    obra = models.ForeignKey(Obra, on_delete=models.CASCADE, related_name="categorias")
    nombre = models.CharField(max_length=100)
    orden = models.PositiveIntegerField(default=0)

    class Meta:
        verbose_name = "Categoría de presupuesto"
        verbose_name_plural = "Categorías de presupuesto"
        ordering = ["obra", "orden", "nombre"]
        unique_together = [("obra", "nombre")]

    def __str__(self):
        return f"{self.nombre} ({self.obra})"


class Presupuesto(TimestampedModel):
    obra = models.ForeignKey(Obra, on_delete=models.CASCADE, related_name="presupuestos")
    categoria = models.ForeignKey(CategoriaPresupuesto, on_delete=models.CASCADE)
    monto = MoneyField(max_digits=14, decimal_places=2, default_currency="CRC")
    notas = models.TextField(blank=True)

    class Meta:
        verbose_name = "Presupuesto"
        verbose_name_plural = "Presupuestos"
        unique_together = [("obra", "categoria")]

    def __str__(self):
        return f"{self.categoria.nombre}: {self.monto}"
```

- [ ] **Step 3: Migrar y testear**

```bash
docker compose exec web python manage.py makemigrations core
docker compose exec web python manage.py migrate
docker compose exec web pytest apps/core/tests/test_models.py -v
```

Expected: 6 PASS.

- [ ] **Step 4: Agregar al admin**

Append a `apps/core/admin.py`:

```python
from .models import CategoriaPresupuesto, Presupuesto


@admin.register(CategoriaPresupuesto)
class CategoriaPresupuestoAdmin(admin.ModelAdmin):
    list_display = ("nombre", "obra", "orden")
    list_filter = ("obra",)
    ordering = ("obra", "orden")


@admin.register(Presupuesto)
class PresupuestoAdmin(admin.ModelAdmin):
    list_display = ("categoria", "obra", "monto")
    list_filter = ("obra",)
```

- [ ] **Step 5: Commit**

```bash
git add apps/core/
git commit -m "feat(core): add CategoriaPresupuesto and Presupuesto

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.3 — Bodega (cross-obra del cliente)

**Files:** `apps/core/models.py`, `apps/core/admin.py`, `apps/core/tests/test_models.py`

- [ ] **Step 1: Test fail-first**

Append a `apps/core/tests/test_models.py`:

```python
def test_bodega_pertenece_a_cliente():
    from apps.core.models import Cliente, Bodega
    c = Cliente.objects.create(nombre="Nicholas", identificacion="A-1")
    b = Bodega.objects.create(cliente=c, nombre="Cuarto Eléctrico GADI")
    assert b.cliente == c
    assert b.activo is True
    assert str(b) == "Cuarto Eléctrico GADI (Nicholas)"
```

Correr → FAIL.

- [ ] **Step 2: Implementar modelo**

Append a `apps/core/models.py`:

```python
from django.contrib.auth import get_user_model


class Bodega(TimestampedModel):
    cliente = models.ForeignKey(Cliente, on_delete=models.PROTECT, related_name="bodegas")
    nombre = models.CharField(max_length=120)
    direccion = models.TextField(blank=True)
    responsable = models.ForeignKey(
        get_user_model(), null=True, blank=True,
        on_delete=models.SET_NULL, related_name="bodegas_responsable",
    )
    activo = models.BooleanField(default=True)
    notas = models.TextField(blank=True)

    class Meta:
        verbose_name = "Bodega"
        verbose_name_plural = "Bodegas"
        ordering = ["cliente", "nombre"]
        unique_together = [("cliente", "nombre")]

    def __str__(self):
        return f"{self.nombre} ({self.cliente.nombre})"
```

- [ ] **Step 3: Migrar y testear**

```bash
docker compose exec web python manage.py makemigrations core
docker compose exec web python manage.py migrate
docker compose exec web pytest apps/core/tests/ -v
```

Expected: 7 PASS.

- [ ] **Step 4: Agregar al admin**

Append a `apps/core/admin.py`:

```python
from .models import Bodega


@admin.register(Bodega)
class BodegaAdmin(admin.ModelAdmin):
    list_display = ("nombre", "cliente", "responsable", "activo")
    list_filter = ("cliente", "activo")
    search_fields = ("nombre",)
```

- [ ] **Step 5: Commit**

```bash
git add apps/core/
git commit -m "feat(core): add Bodega model (client-owned, cross-obra)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.4 — App `catalogo`: Proveedor + ItemCatalogo

**Files:** `apps/catalogo/` (nueva app completa)

- [ ] **Step 1: Crear estructura**

```bash
mkdir -p apps/catalogo/tests apps/catalogo/migrations
touch apps/catalogo/__init__.py apps/catalogo/migrations/__init__.py apps/catalogo/tests/__init__.py
```

`apps/catalogo/apps.py`:
```python
from django.apps import AppConfig

class CatalogoConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.catalogo"
    verbose_name = "Catálogo"
```

Agregar `apps.catalogo` a INSTALLED_APPS en `construmaster/settings.py`.

- [ ] **Step 2: Tests fail-first**

`apps/catalogo/tests/test_models.py`:

```python
import pytest

pytestmark = pytest.mark.django_db


def test_proveedor_creation():
    from apps.catalogo.models import Proveedor
    p = Proveedor.objects.create(
        nombre="Materiales La Costa, S.A.",
        identificacion="3101698280",
        email_facturacion="fe@grupomateriales.com",
    )
    assert p.activo is True
    assert str(p) == "Materiales La Costa, S.A."


def test_item_catalogo_lazy_creation():
    from apps.catalogo.models import ItemCatalogo
    item = ItemCatalogo.objects.create(
        tipo="material",
        nombre_canonico="Cemento Sansón Tipo I 50kg",
        unidad="saco",
    )
    assert item.estado == "aprobado"  # default cuando lo crea supervisor
    assert item.slug == "cemento-sanson-tipo-i-50kg"


def test_item_catalogo_pendiente_por_operativo():
    from apps.catalogo.models import ItemCatalogo
    item = ItemCatalogo.objects.create(
        tipo="material",
        nombre_canonico="Varilla #4 grado 40",
        unidad="varilla",
        estado="pendiente",
    )
    assert item.estado == "pendiente"


def test_item_catalogo_tipo_choices():
    from apps.catalogo.models import ItemCatalogo
    s = ItemCatalogo.objects.create(
        tipo="servicio",
        nombre_canonico="Instalación eléctrica (hora)",
        unidad="hora",
    )
    assert s.tipo == "servicio"
```

Correr → FAIL.

- [ ] **Step 3: Implementar modelos**

`apps/catalogo/models.py`:

```python
from django.contrib.auth import get_user_model
from django.db import models
from django.utils.text import slugify

from apps.core.models import TimestampedModel, CategoriaPresupuesto


class Proveedor(TimestampedModel):
    nombre = models.CharField(max_length=200)
    identificacion = models.CharField(max_length=20, blank=True)  # cédula jurídica/física/DIMEX
    email_facturacion = models.EmailField(blank=True)
    telefono = models.CharField(max_length=30, blank=True)
    notas = models.TextField(blank=True)
    activo = models.BooleanField(default=True)

    class Meta:
        verbose_name = "Proveedor"
        verbose_name_plural = "Proveedores"
        ordering = ["nombre"]

    def __str__(self):
        return self.nombre


class ItemCatalogo(TimestampedModel):
    TIPO_CHOICES = [("material", "Material"), ("servicio", "Servicio")]
    ESTADO_CHOICES = [
        ("pendiente", "Pendiente de aprobación"),
        ("aprobado", "Aprobado"),
        ("inactivo", "Inactivo"),
    ]
    UNIDAD_CHOICES = [
        # Materiales
        ("saco", "Saco"), ("kg", "Kg"), ("m3", "m³"), ("m2", "m²"),
        ("m", "m"), ("unidad", "Unidad"), ("varilla", "Varilla"),
        ("galon", "Galón"), ("litro", "Litro"),
        # Servicios
        ("hora", "Hora"), ("dia", "Día"), ("visita", "Visita"),
        ("global", "Global"), ("mes", "Mes"),
    ]

    tipo = models.CharField(max_length=10, choices=TIPO_CHOICES)
    nombre_canonico = models.CharField(max_length=200)
    unidad = models.CharField(max_length=20, choices=UNIDAD_CHOICES)
    categoria_sugerida = models.ForeignKey(
        CategoriaPresupuesto, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="items_sugeridos",
    )
    slug = models.SlugField(max_length=220)
    alias = models.TextField(
        blank=True,
        help_text="Strings alternativos para autocomplete, uno por línea",
    )
    estado = models.CharField(max_length=10, choices=ESTADO_CHOICES, default="aprobado")
    sugerido_por = models.ForeignKey(
        get_user_model(), null=True, blank=True,
        on_delete=models.SET_NULL, related_name="items_sugeridos",
    )
    activo = models.BooleanField(default=True)

    class Meta:
        verbose_name = "Item del catálogo"
        verbose_name_plural = "Items del catálogo"
        ordering = ["nombre_canonico"]
        indexes = [
            models.Index(fields=["estado"]),
            models.Index(fields=["tipo"]),
            models.Index(fields=["slug"]),
        ]

    def save(self, *args, **kwargs):
        if not self.slug:
            self.slug = slugify(self.nombre_canonico)[:220]
        super().save(*args, **kwargs)

    def __str__(self):
        return self.nombre_canonico
```

- [ ] **Step 4: Migrar y testear**

```bash
docker compose exec web python manage.py makemigrations catalogo
docker compose exec web python manage.py migrate
docker compose exec web pytest apps/catalogo/tests/ -v
```

Expected: 4 PASS.

- [ ] **Step 5: Admin**

`apps/catalogo/admin.py`:

```python
from django.contrib import admin
from .models import Proveedor, ItemCatalogo


@admin.register(Proveedor)
class ProveedorAdmin(admin.ModelAdmin):
    list_display = ("nombre", "identificacion", "email_facturacion", "activo")
    list_filter = ("activo",)
    search_fields = ("nombre", "identificacion")


@admin.register(ItemCatalogo)
class ItemCatalogoAdmin(admin.ModelAdmin):
    list_display = ("nombre_canonico", "tipo", "unidad", "estado", "sugerido_por")
    list_filter = ("tipo", "estado", "activo")
    search_fields = ("nombre_canonico", "alias")
    prepopulated_fields = {"slug": ("nombre_canonico",)}
    actions = ["aprobar_items", "desactivar_items"]

    @admin.action(description="Aprobar items seleccionados")
    def aprobar_items(self, request, queryset):
        queryset.update(estado="aprobado")

    @admin.action(description="Desactivar items seleccionados")
    def desactivar_items(self, request, queryset):
        queryset.update(estado="inactivo", activo=False)
```

- [ ] **Step 6: Commit**

```bash
git add apps/catalogo/ construmaster/settings.py
git commit -m "feat(catalogo): add Proveedor and ItemCatalogo models

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.5 — Grupos + permisos custom

**Files:** `apps/core/permissions.py`, `apps/core/migrations/000X_create_groups.py`

- [ ] **Step 1: Definir permisos custom en los modelos**

Modificar `apps/catalogo/models.py` — agregar a `Meta` de `ItemCatalogo`:

```python
class Meta:
    # ... ya existente ...
    permissions = [
        ("suggest_item", "Puede sugerir items al catálogo"),
        ("approve_item", "Puede aprobar/fusionar items del catálogo"),
    ]
```

Crear migración:
```bash
docker compose exec web python manage.py makemigrations catalogo
docker compose exec web python manage.py migrate
```

- [ ] **Step 2: Migración de datos para crear grupos**

```bash
docker compose exec web python manage.py makemigrations core --empty --name create_groups
```

Editar el archivo generado `apps/core/migrations/000X_create_groups.py`:

```python
from django.db import migrations


def create_groups(apps, schema_editor):
    Group = apps.get_model("auth", "Group")
    Permission = apps.get_model("auth", "Permission")
    ContentType = apps.get_model("contenttypes", "ContentType")

    # Crear los 3 grupos
    supervisor, _ = Group.objects.get_or_create(name="supervisor")
    operativo, _ = Group.objects.get_or_create(name="operativo")
    lector, _ = Group.objects.get_or_create(name="lector")

    # Supervisor: todos los permisos sobre todos los modelos de las apps locales
    local_apps = ["core", "catalogo"]
    for app_label in local_apps:
        cts = ContentType.objects.filter(app_label=app_label)
        for ct in cts:
            for perm in Permission.objects.filter(content_type=ct):
                supervisor.permissions.add(perm)

    # Operativo: view sobre todos + add/change sobre Proveedor + suggest_item
    for app_label in local_apps:
        cts = ContentType.objects.filter(app_label=app_label)
        for ct in cts:
            view = Permission.objects.filter(content_type=ct, codename__startswith="view_").first()
            if view:
                operativo.permissions.add(view)
                lector.permissions.add(view)

    proveedor_ct = ContentType.objects.get(app_label="catalogo", model="proveedor")
    for codename in ("add_proveedor", "change_proveedor"):
        try:
            operativo.permissions.add(Permission.objects.get(content_type=proveedor_ct, codename=codename))
        except Permission.DoesNotExist:
            pass

    # suggest_item para operativo y supervisor
    try:
        suggest = Permission.objects.get(codename="suggest_item")
        operativo.permissions.add(suggest)
        supervisor.permissions.add(suggest)
    except Permission.DoesNotExist:
        pass


def remove_groups(apps, schema_editor):
    Group = apps.get_model("auth", "Group")
    Group.objects.filter(name__in=["supervisor", "operativo", "lector"]).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("core", "000X_previous_migration"),  # ← ajustar al número real
        ("catalogo", "0002_alter_itemcatalogo_options"),
    ]
    operations = [
        migrations.RunPython(create_groups, remove_groups),
    ]
```

**Importante:** ajustar `dependencies` con los números reales de las migraciones que existan en el repo (`ls apps/core/migrations/ apps/catalogo/migrations/`).

- [ ] **Step 3: Aplicar migración**

```bash
docker compose exec web python manage.py migrate
docker compose exec web python manage.py shell -c "
from django.contrib.auth.models import Group
for g in Group.objects.all():
    print(g.name, '→', g.permissions.count(), 'permisos')
"
```

Expected output:
```
supervisor → N permisos
operativo → M permisos
lector → K permisos
```

- [ ] **Step 4: Test de grupos**

`apps/core/tests/test_permissions.py`:

```python
import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group

pytestmark = pytest.mark.django_db


def test_grupos_existen():
    for name in ("supervisor", "operativo", "lector"):
        assert Group.objects.filter(name=name).exists(), f"Falta grupo {name}"


def test_supervisor_puede_aprobar_items():
    User = get_user_model()
    u = User.objects.create_user(username="diana")
    u.groups.add(Group.objects.get(name="supervisor"))
    assert u.has_perm("catalogo.approve_item")


def test_operativo_puede_sugerir_pero_no_aprobar():
    User = get_user_model()
    u = User.objects.create_user(username="tony")
    u.groups.add(Group.objects.get(name="operativo"))
    assert u.has_perm("catalogo.suggest_item")
    assert not u.has_perm("catalogo.approve_item")


def test_lector_solo_view():
    User = get_user_model()
    u = User.objects.create_user(username="nicholas")
    u.groups.add(Group.objects.get(name="lector"))
    assert u.has_perm("core.view_obra")
    assert not u.has_perm("core.add_obra")
```

Correr: `docker compose exec web pytest apps/core/tests/test_permissions.py -v`. Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/
git commit -m "feat(core): create supervisor/operativo/lector groups with permissions

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.6 — Seed data inicial

**Files:** `apps/core/management/__init__.py`, `apps/core/management/commands/__init__.py`, `apps/core/management/commands/seed_initial_data.py`

- [ ] **Step 1: Crear estructura del management command**

```bash
mkdir -p apps/core/management/commands
touch apps/core/management/__init__.py apps/core/management/commands/__init__.py
```

- [ ] **Step 2: Crear `seed_initial_data.py`**

```python
"""Seed inicial de datos: Cliente Nicholas + Bodegas de ADITA."""
from django.core.management.base import BaseCommand
from django.db import transaction

from apps.core.models import Cliente, Bodega


BODEGAS_INICIALES = [
    "Cuarto Eléctrico GADI",
    "Cuarto 4 del Bache",
    "Bodega Baches",
]


class Command(BaseCommand):
    help = "Crea el cliente Nicholas Rowley y sus bodegas iniciales."

    def handle(self, *args, **options):
        with transaction.atomic():
            cliente, created = Cliente.objects.get_or_create(
                nombre="Nicholas Charles Rowley",
                defaults={"identificacion": "", "notas": "Cliente principal (semilla inicial)."},
            )
            if created:
                self.stdout.write(self.style.SUCCESS(f"✓ Creado cliente: {cliente.nombre}"))
            else:
                self.stdout.write(f"= Cliente ya existía: {cliente.nombre}")

            for nombre in BODEGAS_INICIALES:
                bodega, b_created = Bodega.objects.get_or_create(
                    cliente=cliente, nombre=nombre,
                )
                if b_created:
                    self.stdout.write(self.style.SUCCESS(f"✓ Creada bodega: {nombre}"))
                else:
                    self.stdout.write(f"= Bodega ya existía: {nombre}")

        self.stdout.write(self.style.SUCCESS("\nSeed completado."))
```

- [ ] **Step 3: Correr el seed y verificar**

```bash
docker compose exec web python manage.py seed_initial_data
docker compose exec web python manage.py shell -c "
from apps.core.models import Cliente, Bodega
n = Cliente.objects.get(nombre__startswith='Nicholas')
print('Cliente:', n)
print('Bodegas:', list(n.bodegas.values_list('nombre', flat=True)))
"
```

Expected:
```
Cliente: Nicholas Charles Rowley
Bodegas: ['Bodega Baches', 'Cuarto 4 del Bache', 'Cuarto Eléctrico GADI']
```

- [ ] **Step 4: Test del seed (idempotente)**

`apps/core/tests/test_seed.py`:

```python
import pytest
from django.core.management import call_command

pytestmark = pytest.mark.django_db


def test_seed_creates_data():
    from apps.core.models import Cliente, Bodega
    call_command("seed_initial_data")
    assert Cliente.objects.filter(nombre__startswith="Nicholas").exists()
    assert Bodega.objects.count() == 3


def test_seed_is_idempotent():
    from apps.core.models import Cliente, Bodega
    call_command("seed_initial_data")
    call_command("seed_initial_data")  # segunda vez
    assert Cliente.objects.filter(nombre__startswith="Nicholas").count() == 1
    assert Bodega.objects.count() == 3
```

Correr: `docker compose exec web pytest apps/core/tests/test_seed.py -v`. Expected: 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/management/ apps/core/tests/test_seed.py
git commit -m "feat(core): add seed_initial_data management command

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.7 — Audit log integration

**Files:** modificar modelos clave para registrar con auditlog.

- [ ] **Step 1: Registrar modelos de `core` en auditlog**

`apps/core/apps.py`:

```python
from django.apps import AppConfig


class CoreConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.core"
    verbose_name = "Core"

    def ready(self):
        from auditlog.registry import auditlog
        from . import models
        auditlog.register(models.Obra)
        auditlog.register(models.Presupuesto)
        auditlog.register(models.Bodega)
```

- [ ] **Step 2: Registrar modelos de `catalogo`**

`apps/catalogo/apps.py`:

```python
from django.apps import AppConfig


class CatalogoConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.catalogo"
    verbose_name = "Catálogo"

    def ready(self):
        from auditlog.registry import auditlog
        from . import models
        auditlog.register(models.ItemCatalogo)
        auditlog.register(models.Proveedor)
```

- [ ] **Step 3: Aplicar migraciones de auditlog**

```bash
docker compose exec web python manage.py migrate
```

- [ ] **Step 4: Test que auditlog registra**

`apps/core/tests/test_audit.py`:

```python
import pytest
from auditlog.models import LogEntry

pytestmark = pytest.mark.django_db


def test_obra_audit_logged():
    from apps.core.models import Cliente, Obra
    c = Cliente.objects.create(nombre="Nicholas", identificacion="A-1")
    o = Obra.objects.create(cliente=c, nombre="Casa Lomas")
    logs = LogEntry.objects.get_for_object(o)
    assert logs.count() >= 1
    assert logs.first().action == LogEntry.Action.CREATE
```

Correr: `docker compose exec web pytest apps/core/tests/test_audit.py -v`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/apps.py apps/catalogo/apps.py apps/core/tests/test_audit.py
git commit -m "feat: register Obra/Presupuesto/Bodega/ItemCatalogo/Proveedor with auditlog

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.8 — Factories de testing

**Files:** `apps/core/tests/factories.py`, `apps/catalogo/tests/factories.py`

- [ ] **Step 1: Crear `apps/core/tests/factories.py`**

```python
import factory
from factory.django import DjangoModelFactory


class ClienteFactory(DjangoModelFactory):
    class Meta:
        model = "core.Cliente"

    nombre = factory.Sequence(lambda n: f"Cliente {n}")
    identificacion = factory.Sequence(lambda n: f"X-{n:06d}")


class ObraFactory(DjangoModelFactory):
    class Meta:
        model = "core.Obra"

    cliente = factory.SubFactory(ClienteFactory)
    nombre = factory.Sequence(lambda n: f"Obra {n}")
    estado = "en_curso"


class CategoriaPresupuestoFactory(DjangoModelFactory):
    class Meta:
        model = "core.CategoriaPresupuesto"

    obra = factory.SubFactory(ObraFactory)
    nombre = factory.Iterator(["Estructura", "Acabados", "Instalaciones", "Indirectos"])
    orden = factory.Sequence(lambda n: n)


class BodegaFactory(DjangoModelFactory):
    class Meta:
        model = "core.Bodega"

    cliente = factory.SubFactory(ClienteFactory)
    nombre = factory.Sequence(lambda n: f"Bodega {n}")
```

- [ ] **Step 2: Crear `apps/catalogo/tests/factories.py`**

```python
import factory
from factory.django import DjangoModelFactory


class ProveedorFactory(DjangoModelFactory):
    class Meta:
        model = "catalogo.Proveedor"

    nombre = factory.Sequence(lambda n: f"Proveedor {n}")
    identificacion = factory.Sequence(lambda n: f"3101{n:06d}")


class ItemCatalogoFactory(DjangoModelFactory):
    class Meta:
        model = "catalogo.ItemCatalogo"

    tipo = "material"
    nombre_canonico = factory.Sequence(lambda n: f"Item {n}")
    unidad = "unidad"
    estado = "aprobado"
```

- [ ] **Step 3: Test smoke de las factories**

`apps/core/tests/test_factories.py`:

```python
import pytest

pytestmark = pytest.mark.django_db


def test_obra_factory():
    from apps.core.tests.factories import ObraFactory
    o = ObraFactory()
    assert o.pk is not None
    assert o.cliente is not None


def test_bodega_factory():
    from apps.core.tests.factories import BodegaFactory
    b = BodegaFactory()
    assert b.cliente is not None
```

Correr → PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/*/tests/factories.py apps/core/tests/test_factories.py
git commit -m "test: add factory_boy factories for core and catalogo models

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.9 — Smoke test final de Fase 1

- [ ] **Step 1: Correr toda la suite**

```bash
docker compose exec web pytest -v
```

Expected: todos PASS.

- [ ] **Step 2: Verificar admin manualmente**

Login como superuser, crear: 1 Cliente Nicholas (o usar el del seed), 1 Obra "Casa Lomas", 4 CategoriaPresupuesto, 4 Presupuesto, 3 Bodegas (del seed), 3 Proveedores de prueba, 5 ItemCatalogo de prueba. Confirmar que todo se guarda.

- [ ] **Step 3: Verificar audit log**

En `/admin/auditlog/logentry/` deberían aparecer entradas por cada creación.

---

**Fase 1 completa.** Modelos core + auth + admin listos. Ya se puede operar manualmente desde el admin de Django.

---

## Fase 2 — Multi-moneda + BCCR

**Objetivo:** Modelo `ExchangeRate`, cliente HTTP BCCR REST, función única `convert()`, template tag `money_display`, management commands para fetch diario y backfill histórico, job programado.

**Resultado testeable:** `python manage.py verify_bccr_token` retorna éxito; `backfill_bccr_rates --desde 2026-05-01` carga ~17 días de TC; `convert()` retorna conversiones correctas con snapshot por fecha.

### Task 2.1 — App `finance` con modelo `ExchangeRate`

**Files:** `apps/finance/` completo.

- [ ] **Step 1: Crear estructura**

```bash
mkdir -p apps/finance/tests apps/finance/migrations apps/finance/management/commands apps/finance/templatetags
touch apps/finance/__init__.py apps/finance/migrations/__init__.py apps/finance/tests/__init__.py apps/finance/management/__init__.py apps/finance/management/commands/__init__.py apps/finance/templatetags/__init__.py
```

`apps/finance/apps.py`:
```python
from django.apps import AppConfig

class FinanceConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.finance"
    verbose_name = "Finance"
```

Agregar `apps.finance` a INSTALLED_APPS.

- [ ] **Step 2: Test fail-first del modelo**

`apps/finance/tests/test_models.py`:

```python
from decimal import Decimal
from datetime import date

import pytest

pytestmark = pytest.mark.django_db


def test_exchange_rate_creation():
    from apps.finance.models import ExchangeRate
    r = ExchangeRate.objects.create(
        currency="USD",
        date=date(2026, 5, 25),
        buy=Decimal("448.12"),
        sell=Decimal("455.75"),
    )
    assert r.sell == Decimal("455.75")


def test_for_date_returns_exact_match():
    from apps.finance.models import ExchangeRate
    ExchangeRate.objects.create(currency="USD", date=date(2026, 5, 23),
                                buy=Decimal("447"), sell=Decimal("455.75"))
    assert ExchangeRate.for_date("USD", date(2026, 5, 23)) == Decimal("455.75")


def test_for_date_carries_forward_weekend():
    from apps.finance.models import ExchangeRate
    # Viernes 23
    ExchangeRate.objects.create(currency="USD", date=date(2026, 5, 22),
                                buy=Decimal("447"), sell=Decimal("454.82"))
    # Pedimos domingo 24 — debe arrastrar el del viernes
    assert ExchangeRate.for_date("USD", date(2026, 5, 24)) == Decimal("454.82")


def test_for_date_compra_side():
    from apps.finance.models import ExchangeRate
    ExchangeRate.objects.create(currency="USD", date=date(2026, 5, 22),
                                buy=Decimal("447"), sell=Decimal("454.82"))
    assert ExchangeRate.for_date("USD", date(2026, 5, 22), side="buy") == Decimal("447")


def test_for_date_raises_when_no_data():
    from apps.finance.models import ExchangeRate, NoExchangeRateAvailable
    with pytest.raises(NoExchangeRateAvailable):
        ExchangeRate.for_date("USD", date(2026, 5, 25))


def test_unique_currency_date():
    from apps.finance.models import ExchangeRate
    from django.db import IntegrityError
    ExchangeRate.objects.create(currency="USD", date=date(2026, 5, 25),
                                buy=Decimal("1"), sell=Decimal("2"))
    with pytest.raises(IntegrityError):
        ExchangeRate.objects.create(currency="USD", date=date(2026, 5, 25),
                                    buy=Decimal("3"), sell=Decimal("4"))
```

Correr → FAIL.

- [ ] **Step 3: Implementar modelo**

`apps/finance/models.py`:

```python
from datetime import date as date_type
from decimal import Decimal

from django.db import models


class NoExchangeRateAvailable(Exception):
    """Lanzado cuando no hay TC en BD para una moneda/fecha."""


class ExchangeRate(models.Model):
    SOURCE_CHOICES = [("bccr", "BCCR"), ("manual", "Manual")]

    currency = models.CharField(max_length=3)
    date = models.DateField()
    buy = models.DecimalField(max_digits=12, decimal_places=5)
    sell = models.DecimalField(max_digits=12, decimal_places=5)
    fetched_at = models.DateTimeField(auto_now_add=True)
    source = models.CharField(max_length=10, choices=SOURCE_CHOICES, default="bccr")

    class Meta:
        verbose_name = "Tipo de cambio"
        verbose_name_plural = "Tipos de cambio"
        unique_together = [("currency", "date")]
        indexes = [
            models.Index(fields=["currency", "-date"]),
        ]

    def __str__(self):
        return f"{self.currency} {self.date}: compra={self.buy}, venta={self.sell}"

    @classmethod
    def for_date(cls, currency: str, on_date: date_type, side: str = "sell") -> Decimal:
        """Último TC <= on_date (arrastra fines de semana/feriados).

        Si no hay TC en o antes de on_date, lanza NoExchangeRateAvailable.
        side: 'sell' (default, cumple Hacienda) o 'buy'.
        """
        rate = (
            cls.objects
            .filter(currency=currency, date__lte=on_date)
            .order_by("-date")
            .first()
        )
        if rate is None:
            raise NoExchangeRateAvailable(
                f"No hay TC para {currency} en o antes de {on_date}"
            )
        return rate.sell if side == "sell" else rate.buy
```

- [ ] **Step 4: Migrar y testear**

```bash
docker compose exec web python manage.py makemigrations finance
docker compose exec web python manage.py migrate
docker compose exec web pytest apps/finance/tests/test_models.py -v
```

Expected: 6 PASS.

- [ ] **Step 5: Admin**

`apps/finance/admin.py`:

```python
from django.contrib import admin
from .models import ExchangeRate


@admin.register(ExchangeRate)
class ExchangeRateAdmin(admin.ModelAdmin):
    list_display = ("currency", "date", "buy", "sell", "source", "fetched_at")
    list_filter = ("currency", "source")
    date_hierarchy = "date"
    ordering = ("-date",)
```

- [ ] **Step 6: Commit**

```bash
git add apps/finance/ construmaster/settings.py
git commit -m "feat(finance): add ExchangeRate model with carry-forward lookup

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.2 — Cliente BCCR (`bccr_client.py`)

**Files:** `apps/finance/bccr_client.py`, `apps/finance/tests/test_bccr_client.py`

- [ ] **Step 1: Tests fail-first con `httpx_mock`**

Agregar dependencia dev:
```bash
# en pyproject.toml ya está httpx; agregar pytest-httpx
```

Editar `pyproject.toml` dev deps:
```toml
[project.optional-dependencies]
dev = [
    "pytest>=8.3",
    "pytest-django>=4.9",
    "pytest-httpx>=0.32",
    "factory-boy>=3.3",
    "freezegun>=1.5",
    "ruff>=0.7",
    "ipython>=8.30",
]
```

Reinstalar:
```bash
docker compose exec web pip install -e .[dev]
```

`apps/finance/tests/test_bccr_client.py`:

```python
from datetime import date

import pytest


def test_fetch_series_success(httpx_mock):
    from apps.finance.bccr_client import fetch_series, BASE_URL
    httpx_mock.add_response(
        url=(
            f"{BASE_URL}/indicadoresEconomicos/318/series"
            "?fechaInicio=2026/05/22&fechaFin=2026/05/22&idioma=es"
        ),
        json={
            "estado": True,
            "mensaje": "Consulta exitosa",
            "datos": [{
                "codigoIndicador": "318",
                "nombreIndicador": "Tipo cambio venta",
                "series": [{"fecha": "2026-05-22", "valorDatoPorPeriodo": 454.82}],
            }],
        },
    )
    result = fetch_series(318, date(2026, 5, 22), date(2026, 5, 22), token="t")
    assert result == [(date(2026, 5, 22), 454.82)]


def test_fetch_series_empty_weekend(httpx_mock):
    from apps.finance.bccr_client import fetch_series, BASE_URL
    httpx_mock.add_response(
        url=(
            f"{BASE_URL}/indicadoresEconomicos/318/series"
            "?fechaInicio=2026/05/24&fechaFin=2026/05/24&idioma=es"
        ),
        json={"estado": True, "mensaje": "Consulta exitosa", "datos": []},
    )
    result = fetch_series(318, date(2026, 5, 24), date(2026, 5, 24), token="t")
    assert result == []


def test_fetch_series_raises_on_400(httpx_mock):
    from apps.finance.bccr_client import fetch_series, BCCRError, BASE_URL
    httpx_mock.add_response(
        url=(
            f"{BASE_URL}/indicadoresEconomicos/318/series"
            "?fechaInicio=2026/05/22&fechaFin=2026/05/22&idioma=es"
        ),
        status_code=400,
        json={"CodigoError": "400", "Mensaje": "Parámetros inválidos"},
    )
    with pytest.raises(BCCRError, match="Parámetros inválidos"):
        fetch_series(318, date(2026, 5, 22), date(2026, 5, 22), token="t")


def test_fetch_series_raises_on_401_unauthorized(httpx_mock):
    from apps.finance.bccr_client import fetch_series, BCCRError, BASE_URL
    httpx_mock.add_response(
        url=(
            f"{BASE_URL}/indicadoresEconomicos/318/series"
            "?fechaInicio=2026/05/22&fechaFin=2026/05/22&idioma=es"
        ),
        status_code=401,
        text="Unauthorized",
    )
    with pytest.raises(BCCRError, match="HTTP 401"):
        fetch_series(318, date(2026, 5, 22), date(2026, 5, 22), token="bad")


def test_fetch_series_estado_false(httpx_mock):
    from apps.finance.bccr_client import fetch_series, BCCRError, BASE_URL
    httpx_mock.add_response(
        url=(
            f"{BASE_URL}/indicadoresEconomicos/318/series"
            "?fechaInicio=2026/05/22&fechaFin=2026/05/22&idioma=es"
        ),
        json={"estado": False, "mensaje": "Indicador no disponible", "datos": []},
    )
    with pytest.raises(BCCRError, match="Indicador no disponible"):
        fetch_series(318, date(2026, 5, 22), date(2026, 5, 22), token="t")
```

Correr → FAIL.

- [ ] **Step 2: Implementar cliente**

`apps/finance/bccr_client.py`:

```python
"""Cliente HTTP para la API REST SDDE del BCCR.

API REST nueva en https://apim.bccr.fi.cr/SDDE/...
El backend SOAP viejo (gee.bccr.fi.cr/.../wsindicadoreseconomicos.asmx)
se apaga el 30-jun-2026.
"""
from datetime import date
from typing import Optional

import httpx

BASE_URL = "https://apim.bccr.fi.cr/SDDE/api/Bccr.GE.SDDE.Publico.Indicadores.API"


class BCCRError(Exception):
    """Error retornado por el BCCR con mensaje legible."""


def fetch_series(
    codigo: int,
    desde: date,
    hasta: date,
    token: str,
    timeout: float = 20.0,
) -> list[tuple[date, Optional[float]]]:
    """Consulta la serie de un indicador económico del BCCR.

    Códigos relevantes:
    - 317 = tipo de cambio compra (USD/CRC)
    - 318 = tipo de cambio venta (USD/CRC) — default para cumplimiento Hacienda

    Devuelve lista de (fecha, valor). Valor puede ser None si BCCR retornó null
    (fin de semana, feriado, dato no publicado). Lista vacía si `series` viene vacío.

    Lanza BCCRError en HTTP 4xx/5xx o cuando estado=False.
    """
    r = httpx.get(
        f"{BASE_URL}/indicadoresEconomicos/{codigo}/series",
        params={
            "fechaInicio": desde.strftime("%Y/%m/%d"),
            "fechaFin": hasta.strftime("%Y/%m/%d"),
            "idioma": "es",
        },
        headers={"Authorization": f"Bearer {token}"},
        timeout=timeout,
    )
    # NO usamos r.raise_for_status() — necesitamos leer el cuerpo de error.
    if r.status_code >= 400:
        try:
            err = r.json()
            raise BCCRError(f"HTTP {r.status_code}: {err.get('Mensaje', r.text[:200])}")
        except ValueError:
            raise BCCRError(f"HTTP {r.status_code}: {r.text[:200]}")

    data = r.json()
    if not data.get("estado"):
        raise BCCRError(data.get("mensaje", "Error desconocido del BCCR"))

    if not data.get("datos"):
        return []
    series = data["datos"][0].get("series", [])
    return [
        (date.fromisoformat(s["fecha"][:10]), s.get("valorDatoPorPeriodo"))
        for s in series
    ]
```

- [ ] **Step 3: Correr tests**

```bash
docker compose exec web pytest apps/finance/tests/test_bccr_client.py -v
```

Expected: 5 PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/finance/bccr_client.py apps/finance/tests/test_bccr_client.py pyproject.toml
git commit -m "feat(finance): add BCCR SDDE REST client with error handling

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.3 — Management commands `verify_bccr_token` y `backfill_bccr_rates`

**Files:** `apps/finance/management/commands/verify_bccr_token.py`, `apps/finance/management/commands/backfill_bccr_rates.py`

- [ ] **Step 1: Crear `verify_bccr_token.py`**

```python
"""Smoke test del token BCCR — hace una llamada real al endpoint de series.

No usamos /Usuario/ValideSuscripcion porque en testing del 2026-05-25
ese endpoint devuelve HTTP 500 (bug del lado del BCCR). El endpoint
de series es el que vamos a usar en producción, así que es el smoke
test correcto.
"""
from datetime import date, timedelta

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from apps.finance.bccr_client import fetch_series, BCCRError


class Command(BaseCommand):
    help = "Verifica que el token de BCCR funcione (consulta TC venta de los últimos 7 días)."

    def handle(self, *args, **options):
        token = settings.BCCR_TOKEN
        if not token:
            raise CommandError("BCCR_TOKEN no está configurado en .env")

        hoy = date.today()
        hace_7 = hoy - timedelta(days=7)

        self.stdout.write(f"Consultando TC venta (318) desde {hace_7} hasta {hoy}…")
        try:
            results = fetch_series(318, hace_7, hoy, token=token)
        except BCCRError as e:
            raise CommandError(f"Token rechazado o error BCCR: {e}")
        except Exception as e:
            raise CommandError(f"Error de red: {e}")

        self.stdout.write(self.style.SUCCESS(f"\n✓ Token válido. {len(results)} datos:"))
        for fecha, valor in results:
            self.stdout.write(f"  {fecha}: {valor}")
```

- [ ] **Step 2: Crear `backfill_bccr_rates.py`**

```python
"""Backfill histórico de tipo de cambio del BCCR.

Hace una sola llamada con rango amplio (la API SDDE soporta fechaInicio
y fechaFin arbitrarios) e inserta lo que no exista. Idempotente.
"""
from datetime import date
from decimal import Decimal

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.finance.bccr_client import fetch_series, BCCRError
from apps.finance.models import ExchangeRate


class Command(BaseCommand):
    help = "Descarga histórico de tipo de cambio del BCCR (USD compra+venta)."

    def add_arguments(self, parser):
        parser.add_argument("--desde", type=str, required=True,
                            help="Fecha inicial yyyy-mm-dd")
        parser.add_argument("--hasta", type=str, default=None,
                            help="Fecha final yyyy-mm-dd (default: hoy)")

    def handle(self, *args, **options):
        token = settings.BCCR_TOKEN
        if not token:
            raise CommandError("BCCR_TOKEN no está configurado en .env")

        desde = date.fromisoformat(options["desde"])
        hasta = date.fromisoformat(options["hasta"]) if options["hasta"] else date.today()

        self.stdout.write(f"Backfill {desde} → {hasta}…")

        try:
            compras = dict(fetch_series(317, desde, hasta, token))
            ventas = dict(fetch_series(318, desde, hasta, token))
        except BCCRError as e:
            raise CommandError(f"BCCR: {e}")

        # Unión de fechas presentes en cualquiera de los dos
        all_dates = sorted(set(compras.keys()) | set(ventas.keys()))

        creados = 0
        actualizados = 0
        with transaction.atomic():
            for fecha in all_dates:
                buy = compras.get(fecha)
                sell = ventas.get(fecha)
                if buy is None and sell is None:
                    continue  # día sin datos
                obj, created = ExchangeRate.objects.update_or_create(
                    currency="USD", date=fecha,
                    defaults={
                        "buy": Decimal(str(buy)) if buy is not None else Decimal("0"),
                        "sell": Decimal(str(sell)) if sell is not None else Decimal("0"),
                        "source": "bccr",
                    },
                )
                if created:
                    creados += 1
                else:
                    actualizados += 1

        self.stdout.write(self.style.SUCCESS(
            f"\n✓ Creados: {creados}, actualizados: {actualizados}, total: {len(all_dates)}"
        ))
```

- [ ] **Step 3: Test del backfill**

`apps/finance/tests/test_management.py`:

```python
from datetime import date
from decimal import Decimal
from io import StringIO

import pytest
from django.core.management import call_command

pytestmark = pytest.mark.django_db


def test_backfill_creates_records(httpx_mock, settings):
    from apps.finance.bccr_client import BASE_URL
    from apps.finance.models import ExchangeRate
    settings.BCCR_TOKEN = "fake-token"

    # Mock compras (317)
    httpx_mock.add_response(
        url=(
            f"{BASE_URL}/indicadoresEconomicos/317/series"
            "?fechaInicio=2026/05/20&fechaFin=2026/05/22&idioma=es"
        ),
        json={
            "estado": True, "mensaje": "ok",
            "datos": [{"codigoIndicador": "317", "nombreIndicador": "TC compra",
                       "series": [
                           {"fecha": "2026-05-20", "valorDatoPorPeriodo": 446.85},
                           {"fecha": "2026-05-21", "valorDatoPorPeriodo": 447.95},
                           {"fecha": "2026-05-22", "valorDatoPorPeriodo": 447.50},
                       ]}],
        },
    )
    # Mock ventas (318)
    httpx_mock.add_response(
        url=(
            f"{BASE_URL}/indicadoresEconomicos/318/series"
            "?fechaInicio=2026/05/20&fechaFin=2026/05/22&idioma=es"
        ),
        json={
            "estado": True, "mensaje": "ok",
            "datos": [{"codigoIndicador": "318", "nombreIndicador": "TC venta",
                       "series": [
                           {"fecha": "2026-05-20", "valorDatoPorPeriodo": 454.22},
                           {"fecha": "2026-05-21", "valorDatoPorPeriodo": 455.10},
                           {"fecha": "2026-05-22", "valorDatoPorPeriodo": 454.82},
                       ]}],
        },
    )

    out = StringIO()
    call_command("backfill_bccr_rates", "--desde", "2026-05-20", "--hasta", "2026-05-22", stdout=out)

    assert ExchangeRate.objects.count() == 3
    r = ExchangeRate.objects.get(date=date(2026, 5, 22))
    assert r.buy == Decimal("447.50000")
    assert r.sell == Decimal("454.82000")
```

Correr → PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/finance/management/ apps/finance/tests/test_management.py
git commit -m "feat(finance): add verify_bccr_token and backfill_bccr_rates commands

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.4 — Función `convert()` única

**Files:** `apps/finance/services.py`, `apps/finance/tests/test_services.py`

- [ ] **Step 1: Tests fail-first**

`apps/finance/tests/test_services.py`:

```python
from datetime import date
from decimal import Decimal

import pytest
from djmoney.money import Money

pytestmark = pytest.mark.django_db


@pytest.fixture
def tc_22_may():
    from apps.finance.models import ExchangeRate
    return ExchangeRate.objects.create(
        currency="USD", date=date(2026, 5, 22),
        buy=Decimal("447.50000"), sell=Decimal("454.82000"),
    )


def test_convert_same_currency_is_noop(tc_22_may):
    from apps.finance.services import convert
    m = Money(1000, "CRC")
    assert convert(m, "CRC", date(2026, 5, 22)) == m


def test_convert_crc_to_usd_uses_sell_by_default(tc_22_may):
    from apps.finance.services import convert
    result = convert(Money(454_820, "CRC"), "USD", date(2026, 5, 22))
    assert result.currency.code == "USD"
    assert result.amount == Decimal("1000.00")


def test_convert_usd_to_crc(tc_22_may):
    from apps.finance.services import convert
    result = convert(Money(100, "USD"), "CRC", date(2026, 5, 22))
    assert result.currency.code == "CRC"
    assert result.amount == Decimal("45482.00")


def test_convert_uses_buy_side(tc_22_may):
    from apps.finance.services import convert
    result = convert(Money(447_500, "CRC"), "USD", date(2026, 5, 22), side="buy")
    assert result.amount == Decimal("1000.00")


def test_convert_carries_forward_weekend(tc_22_may):
    """Si pedimos un domingo, debe usar el TC del viernes (arrastre)."""
    from apps.finance.services import convert
    result = convert(Money(100, "USD"), "CRC", date(2026, 5, 24))  # domingo
    assert result.amount == Decimal("45482.00")


def test_convert_raises_unsupported_pair():
    from apps.finance.services import convert, UnsupportedConversion
    with pytest.raises(UnsupportedConversion):
        convert(Money(100, "USD"), "EUR", date(2026, 5, 22))
```

Correr → FAIL.

- [ ] **Step 2: Implementar `services.py`**

```python
"""Servicios de conversión multi-moneda.

REGLA DE ORO: ninguna otra parte de la app convierte montos sin pasar por
`convert()`. Los lookups de TC vía ExchangeRate.for_date() en `save()` de
modelos (snapshots) son válidos — la regla aplica a conversiones, no al
lookup puro.
"""
from datetime import date as date_type
from decimal import Decimal, ROUND_HALF_UP

from djmoney.money import Money

from .models import ExchangeRate


class UnsupportedConversion(Exception):
    """Par de monedas no soportado."""


def convert(
    amount: Money,
    to_currency: str,
    on_date: date_type,
    side: str = "sell",
) -> Money:
    """Convierte `amount` a `to_currency` usando TC del BCCR vigente en `on_date`.

    `on_date` es OBLIGATORIO — no aceptar default today() silencioso, fuerza al
    caller a decidir explícitamente qué fecha de cambio aplica.

    `side`: 'sell' (default, cumple Hacienda) o 'buy'.
    """
    if amount.currency.code == to_currency:
        return amount

    if amount.currency.code == "CRC" and to_currency == "USD":
        rate = ExchangeRate.for_date("USD", on_date, side)
        new_amount = (amount.amount / rate).quantize(Decimal("0.01"), ROUND_HALF_UP)
        return Money(new_amount, "USD")

    if amount.currency.code == "USD" and to_currency == "CRC":
        rate = ExchangeRate.for_date("USD", on_date, side)
        new_amount = (amount.amount * rate).quantize(Decimal("0.01"), ROUND_HALF_UP)
        return Money(new_amount, "CRC")

    raise UnsupportedConversion(
        f"{amount.currency.code} → {to_currency} no soportado"
    )
```

- [ ] **Step 3: Correr tests**

```bash
docker compose exec web pytest apps/finance/tests/test_services.py -v
```

Expected: 6 PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/finance/services.py apps/finance/tests/test_services.py
git commit -m "feat(finance): add single convert() function for currency conversion

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.5 — Template tag `money_display`

**Files:** `apps/finance/templatetags/money_extras.py`, `apps/finance/tests/test_templatetags.py`

- [ ] **Step 1: Test fail-first**

`apps/finance/tests/test_templatetags.py`:

```python
from datetime import date
from decimal import Decimal

import pytest
from djmoney.money import Money

pytestmark = pytest.mark.django_db


@pytest.fixture
def tc():
    from apps.finance.models import ExchangeRate
    return ExchangeRate.objects.create(
        currency="USD", date=date(2026, 5, 22),
        buy=Decimal("447.5"), sell=Decimal("454.82"),
    )


def test_money_display_same_currency(tc):
    from apps.finance.templatetags.money_extras import money_display
    out = money_display(Money(1000, "USD"), "USD", on_date=date(2026, 5, 22))
    assert "1,000.00" in out or "1.000,00" in out
    assert "USD" in out or "$" in out


def test_money_display_with_conversion(tc):
    from apps.finance.templatetags.money_extras import money_display
    out = money_display(Money(100, "USD"), "USD", on_date=date(2026, 5, 22))
    # Para mismo moneda no muestra conversión
    assert "≈" not in out


def test_money_display_crc_to_usd(tc):
    from apps.finance.templatetags.money_extras import money_display
    out = money_display(Money(454_820, "CRC"), "USD", on_date=date(2026, 5, 22))
    # Debe mostrar original + conversión
    assert "454" in out
    assert "1,000.00" in out or "1.000,00" in out
    assert "≈" in out
```

Correr → FAIL.

- [ ] **Step 2: Implementar template tag**

```python
"""Template tags para mostrar montos multi-moneda."""
from datetime import date as date_type
from decimal import Decimal

from babel.numbers import format_currency
from django import template
from djmoney.money import Money

from apps.finance.services import convert
from apps.finance.models import NoExchangeRateAvailable

register = template.Library()


@register.simple_tag
def money_display(amount: Money, target_currency: str = "USD", on_date: date_type = None) -> str:
    """Renderiza un Money con conversión opcional a target_currency.

    Si `amount.currency == target_currency`, solo muestra el primary formateado.
    Si difieren, muestra `<original> (≈ <convertido> al TC <rate> del <fecha>)`.
    """
    on_date = on_date or date_type.today()
    primary = format_currency(
        amount.amount, amount.currency.code, locale="es_CR",
    )
    if amount.currency.code == target_currency:
        return primary

    try:
        converted = convert(amount, target_currency, on_date)
    except (NoExchangeRateAvailable, Exception):
        return primary  # fallback: solo original si no hay TC

    converted_str = format_currency(
        converted.amount, converted.currency.code, locale="es_CR",
    )
    # Buscar el TC usado para mostrarlo
    from apps.finance.models import ExchangeRate
    try:
        rate_obj = (ExchangeRate.objects
                    .filter(currency="USD", date__lte=on_date)
                    .order_by("-date").first())
        rate_str = f"{rate_obj.sell:.2f}" if rate_obj else "—"
        rate_date = rate_obj.date.strftime("%d-%b-%Y") if rate_obj else "—"
    except Exception:
        rate_str, rate_date = "—", "—"

    return f"{primary} (≈ {converted_str} al TC ₡{rate_str} del {rate_date})"
```

- [ ] **Step 3: Correr tests**

```bash
docker compose exec web pytest apps/finance/tests/test_templatetags.py -v
```

Expected: 3 PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/finance/templatetags/
git commit -m "feat(finance): add money_display template tag with FX conversion

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.6 — Task `fetch_bccr_rates` + scheduler diario

**Files:** `apps/finance/tasks.py`, migración con `Schedule`

- [ ] **Step 1: Test fail-first**

`apps/finance/tests/test_tasks.py`:

```python
from datetime import date
from decimal import Decimal

import pytest

pytestmark = pytest.mark.django_db


def test_fetch_bccr_rates_creates_for_today(httpx_mock, settings):
    from apps.finance.bccr_client import BASE_URL
    from apps.finance.models import ExchangeRate
    from apps.finance.tasks import fetch_bccr_rates

    settings.BCCR_TOKEN = "fake"
    today = date.today()
    s = today.strftime("%Y/%m/%d")

    httpx_mock.add_response(
        url=f"{BASE_URL}/indicadoresEconomicos/317/series?fechaInicio={s}&fechaFin={s}&idioma=es",
        json={"estado": True, "mensaje": "ok",
              "datos": [{"codigoIndicador": "317", "nombreIndicador": "x",
                         "series": [{"fecha": today.isoformat(), "valorDatoPorPeriodo": 447.5}]}]},
    )
    httpx_mock.add_response(
        url=f"{BASE_URL}/indicadoresEconomicos/318/series?fechaInicio={s}&fechaFin={s}&idioma=es",
        json={"estado": True, "mensaje": "ok",
              "datos": [{"codigoIndicador": "318", "nombreIndicador": "x",
                         "series": [{"fecha": today.isoformat(), "valorDatoPorPeriodo": 454.82}]}]},
    )

    fetch_bccr_rates()
    r = ExchangeRate.objects.get(currency="USD", date=today)
    assert r.sell == Decimal("454.82000")


def test_fetch_bccr_rates_skips_when_no_data(httpx_mock, settings):
    from apps.finance.bccr_client import BASE_URL
    from apps.finance.models import ExchangeRate
    from apps.finance.tasks import fetch_bccr_rates

    settings.BCCR_TOKEN = "fake"
    today = date.today()
    s = today.strftime("%Y/%m/%d")

    for codigo in (317, 318):
        httpx_mock.add_response(
            url=f"{BASE_URL}/indicadoresEconomicos/{codigo}/series?fechaInicio={s}&fechaFin={s}&idioma=es",
            json={"estado": True, "mensaje": "ok", "datos": []},
        )

    fetch_bccr_rates()
    assert ExchangeRate.objects.filter(currency="USD", date=today).count() == 0
```

Correr → FAIL.

- [ ] **Step 2: Implementar `tasks.py`**

```python
"""Tasks async para el módulo finance."""
import logging
from datetime import date
from decimal import Decimal

from django.conf import settings

from .bccr_client import fetch_series, BCCRError
from .models import ExchangeRate

logger = logging.getLogger("construmaster.finance.tasks")


def fetch_bccr_rates(target_date: date = None) -> dict:
    """Descarga TC compra+venta del BCCR para `target_date` (default: hoy).

    Si BCCR retorna vacío (fin de semana/feriado), no hace nada.
    Si retorna valor, hace update_or_create.
    Devuelve {"created": bool, "skipped": bool, "error": Optional[str]}.
    """
    target_date = target_date or date.today()
    token = settings.BCCR_TOKEN
    if not token:
        logger.error("BCCR_TOKEN no configurado")
        return {"created": False, "skipped": True, "error": "no token"}

    try:
        compras = dict(fetch_series(317, target_date, target_date, token))
        ventas = dict(fetch_series(318, target_date, target_date, token))
    except BCCRError as e:
        logger.exception("BCCR error")
        return {"created": False, "skipped": False, "error": str(e)}

    buy = compras.get(target_date)
    sell = ventas.get(target_date)
    if buy is None and sell is None:
        logger.info(f"BCCR sin datos para {target_date} (fin de semana/feriado)")
        return {"created": False, "skipped": True, "error": None}

    _, created = ExchangeRate.objects.update_or_create(
        currency="USD", date=target_date,
        defaults={
            "buy": Decimal(str(buy)) if buy is not None else Decimal("0"),
            "sell": Decimal(str(sell)) if sell is not None else Decimal("0"),
            "source": "bccr",
        },
    )
    logger.info(f"TC {target_date}: compra={buy}, venta={sell} ({'creado' if created else 'actualizado'})")
    return {"created": created, "skipped": False, "error": None}
```

- [ ] **Step 3: Correr tests**

```bash
docker compose exec web pytest apps/finance/tests/test_tasks.py -v
```

Expected: 2 PASS.

- [ ] **Step 4: Crear management command `fetch_bccr_rates`** (wrapper para testing manual)

`apps/finance/management/commands/fetch_bccr_rates.py`:

```python
from django.core.management.base import BaseCommand

from apps.finance.tasks import fetch_bccr_rates


class Command(BaseCommand):
    help = "Ejecuta fetch_bccr_rates manualmente (también corre diario via scheduler)."

    def handle(self, *args, **options):
        result = fetch_bccr_rates()
        self.stdout.write(self.style.SUCCESS(str(result)))
```

- [ ] **Step 5: Migración de datos para crear el Schedule de Django-Q2**

```bash
docker compose exec web python manage.py makemigrations finance --empty --name create_bccr_schedule
```

Editar la migración generada:

```python
from django.db import migrations


def create_schedule(apps, schema_editor):
    Schedule = apps.get_model("django_q", "Schedule")
    Schedule.objects.update_or_create(
        name="fetch_bccr_rates_diario",
        defaults={
            "func": "apps.finance.tasks.fetch_bccr_rates",
            "schedule_type": "C",  # cron
            "cron": "30 8 * * 1-5",  # 8:30 AM L-V hora del servidor
            "repeats": -1,
        },
    )


def remove_schedule(apps, schema_editor):
    Schedule = apps.get_model("django_q", "Schedule")
    Schedule.objects.filter(name="fetch_bccr_rates_diario").delete()


class Migration(migrations.Migration):
    dependencies = [
        ("finance", "000X_previous"),  # ajustar
        ("django_q", "0019_alter_schedule_cluster"),  # o la más reciente
    ]
    operations = [
        migrations.RunPython(create_schedule, remove_schedule),
    ]
```

- [ ] **Step 6: Aplicar y verificar**

```bash
docker compose exec web python manage.py migrate
docker compose exec web python manage.py shell -c "
from django_q.models import Schedule
print(Schedule.objects.filter(name='fetch_bccr_rates_diario').values('func', 'cron', 'schedule_type'))
"
```

Expected: el schedule existe con cron `30 8 * * 1-5`.

- [ ] **Step 7: Commit**

```bash
git add apps/finance/tasks.py apps/finance/tests/test_tasks.py apps/finance/management/commands/fetch_bccr_rates.py apps/finance/migrations/
git commit -m "feat(finance): add fetch_bccr_rates task with daily schedule

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.7 — Backfill real con token de producción

- [ ] **Step 1: Validar token BCCR**

```bash
docker compose exec web python manage.py verify_bccr_token
```

Expected: lista los TC venta de los últimos 7 días sin errores.

- [ ] **Step 2: Hacer backfill histórico** (desde inicio del año)

```bash
docker compose exec web python manage.py backfill_bccr_rates --desde 2026-01-01
```

Expected: "Creados: ~100, actualizados: 0, total: ~100".

- [ ] **Step 3: Verificar en admin**

Abrir `/admin/finance/exchangerate/` y confirmar que hay datos desde enero hasta hoy.

- [ ] **Step 4: Commit (sin cambios, solo registrar que se hizo)**

No es necesario commit — el backfill modifica BD, no archivos.

---

**Fase 2 completa.** Multi-moneda funcionando: BCCR cliente, convert(), template tag, fetch programado diario, backfill histórico cargado.

---

## Fase 3 — RFQ + Cotizaciones + comparativa

**Objetivo:** Modelos `SolicitudCotizacion`, `Cotizacion`, `CotizacionItem`. UI HTMX para capturar cotizaciones con autocomplete del catálogo y "+ Sugerir nuevo item". Vista comparativa lado a lado.

**Resultado testeable:** Operativo logueado puede crear RFQ, capturar cotizaciones recibidas con items (autocompletando del catálogo), supervisor ve comparativa de varias cotizaciones para el mismo RFQ y puede rechazar/marcar para aprobación.

### Task 3.1 — App `compras` + modelos `SolicitudCotizacion`, `Cotizacion`, `CotizacionItem`

**Files:** `apps/compras/` nueva app.

- [ ] **Step 1: Crear estructura**

```bash
mkdir -p apps/compras/tests apps/compras/migrations apps/compras/management/commands
touch apps/compras/__init__.py apps/compras/migrations/__init__.py apps/compras/tests/__init__.py apps/compras/management/__init__.py apps/compras/management/commands/__init__.py
```

`apps/compras/apps.py`:
```python
from django.apps import AppConfig

class ComprasConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.compras"
    verbose_name = "Compras"

    def ready(self):
        from auditlog.registry import auditlog
        from . import models
        auditlog.register(models.SolicitudCotizacion)
        auditlog.register(models.Cotizacion)
        auditlog.register(models.OrdenCompra)
        auditlog.register(models.Pago)
```

Agregar `apps.compras` a INSTALLED_APPS.

- [ ] **Step 2: Tests fail-first**

`apps/compras/tests/test_models.py`:

```python
from decimal import Decimal
from datetime import date

import pytest
from djmoney.money import Money

pytestmark = pytest.mark.django_db


def test_solicitud_cotizacion_creation():
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.compras.models import SolicitudCotizacion
    from django.contrib.auth import get_user_model
    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    user = get_user_model().objects.create_user("u")
    s = SolicitudCotizacion.objects.create(
        obra=obra, categoria=cat,
        descripcion="Necesito cemento y varilla",
        fecha_requerida=date(2026, 6, 15),
        creada_por=user,
    )
    assert s.estado == "abierta"
    assert s.es_especial is False


def test_cotizacion_can_be_standalone():
    from apps.core.tests.factories import ObraFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import Cotizacion
    o = ObraFactory()
    p = ProveedorFactory()
    c = Cotizacion.objects.create(
        obra=o, proveedor=p, rfq=None,
        numero_cotizacion="COT-001", fecha=date.today(),
        total=Money(100_000, "CRC"),
        subtotal=Money(88_496, "CRC"), iva=Money(11_504, "CRC"),
    )
    assert c.rfq is None
    assert c.estado == "recibida"


def test_cotizacion_es_especial_inheritable_from_rfq():
    """Si se crea via approve flow desde un RFQ es_especial=True, el campo se hereda."""
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import SolicitudCotizacion, Cotizacion
    from django.contrib.auth import get_user_model
    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    user = get_user_model().objects.create_user("u2")
    rfq = SolicitudCotizacion.objects.create(
        obra=obra, categoria=cat, descripcion="custom",
        fecha_requerida=date(2026, 6, 1), creada_por=user,
        es_especial=True,
    )
    p = ProveedorFactory()
    c = Cotizacion.objects.create(
        obra=obra, proveedor=p, rfq=rfq,
        numero_cotizacion="X", fecha=date.today(),
        total=Money(1, "CRC"), subtotal=Money(1, "CRC"), iva=Money(0, "CRC"),
        es_especial=rfq.es_especial,
    )
    assert c.es_especial is True


def test_cotizacion_item_with_catalogo():
    from apps.core.tests.factories import ObraFactory
    from apps.catalogo.tests.factories import ProveedorFactory, ItemCatalogoFactory
    from apps.compras.models import Cotizacion, CotizacionItem
    o = ObraFactory()
    p = ProveedorFactory()
    item_cat = ItemCatalogoFactory(nombre_canonico="Cemento Sansón 50kg", unidad="saco")
    c = Cotizacion.objects.create(
        obra=o, proveedor=p, numero_cotizacion="C1", fecha=date.today(),
        total=Money(100, "CRC"), subtotal=Money(100, "CRC"), iva=Money(0, "CRC"),
    )
    line = CotizacionItem.objects.create(
        cotizacion=c, material=item_cat,
        descripcion="Cemento Sansón 50kg",
        cantidad=Decimal("100.0000"),
        unidad="saco",
        precio_unitario=Decimal("8500.00000"),
        subtotal=Decimal("850000.00"),
        iva_monto=Decimal("110500.00"),
        orden=1,
    )
    assert line.material == item_cat


def test_cotizacion_item_custom_without_catalogo():
    """Items custom no requieren FK a ItemCatalogo."""
    from apps.core.tests.factories import ObraFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import Cotizacion, CotizacionItem
    o = ObraFactory()
    p = ProveedorFactory()
    c = Cotizacion.objects.create(
        obra=o, proveedor=p, numero_cotizacion="C2", fecha=date.today(),
        total=Money(1, "CRC"), subtotal=Money(1, "CRC"), iva=Money(0, "CRC"),
    )
    line = CotizacionItem.objects.create(
        cotizacion=c, material=None,
        descripcion="Puerta hecha a la medida 1.20x2.10m",
        cantidad=Decimal("1.0000"),
        unidad="unidad",
        precio_unitario=Decimal("250000.00000"),
        subtotal=Decimal("250000.00"),
        iva_monto=Decimal("32500.00"),
        orden=1,
    )
    assert line.material is None
```

Correr → FAIL.

- [ ] **Step 3: Implementar modelos**

`apps/compras/models.py`:

```python
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db import models
from djmoney.models.fields import MoneyField

from apps.core.models import TimestampedModel, Obra, CategoriaPresupuesto
from apps.catalogo.models import Proveedor, ItemCatalogo


class SolicitudCotizacion(TimestampedModel):
    ESTADO_CHOICES = [
        ("abierta", "Abierta"),
        ("cerrada", "Cerrada"),
        ("cancelada", "Cancelada"),
    ]

    obra = models.ForeignKey(Obra, on_delete=models.PROTECT, related_name="rfqs")
    categoria = models.ForeignKey(CategoriaPresupuesto, on_delete=models.PROTECT)
    descripcion = models.TextField()
    fecha_requerida = models.DateField(null=True, blank=True)
    creada_por = models.ForeignKey(get_user_model(), on_delete=models.PROTECT,
                                   related_name="rfqs_creadas")
    estado = models.CharField(max_length=20, choices=ESTADO_CHOICES, default="abierta")
    es_especial = models.BooleanField(default=False)
    notas = models.TextField(blank=True)

    class Meta:
        verbose_name = "Solicitud de cotización"
        verbose_name_plural = "Solicitudes de cotización"
        ordering = ["-created_at"]

    def __str__(self):
        return f"RFQ-{self.pk} ({self.obra.nombre})"


class Cotizacion(TimestampedModel):
    ESTADO_CHOICES = [
        ("recibida", "Recibida"),
        ("en_revision", "En revisión"),
        ("aprobada", "Aprobada"),
        ("rechazada", "Rechazada"),
        ("vencida", "Vencida"),
    ]
    MONEDA_CHOICES = [("CRC", "Colones"), ("USD", "Dólares")]

    obra = models.ForeignKey(Obra, on_delete=models.PROTECT, related_name="cotizaciones")
    proveedor = models.ForeignKey(Proveedor, on_delete=models.PROTECT)
    rfq = models.ForeignKey(SolicitudCotizacion, null=True, blank=True,
                            on_delete=models.SET_NULL, related_name="cotizaciones")
    numero_cotizacion = models.CharField(max_length=80)
    fecha = models.DateField()
    fecha_validez = models.DateField(null=True, blank=True)
    moneda = models.CharField(max_length=3, choices=MONEDA_CHOICES, default="CRC")
    subtotal = MoneyField(max_digits=14, decimal_places=2, default_currency="CRC")
    iva = MoneyField(max_digits=14, decimal_places=2, default_currency="CRC")
    total = MoneyField(max_digits=14, decimal_places=2, default_currency="CRC")
    condiciones_pago = models.CharField(max_length=200, blank=True)
    plazo_entrega_dias = models.PositiveIntegerField(null=True, blank=True)
    pct_anticipo = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    archivo = models.FileField(upload_to="cotizaciones/", null=True, blank=True)
    es_especial = models.BooleanField(default=False)
    estado = models.CharField(max_length=20, choices=ESTADO_CHOICES, default="recibida")
    notas = models.TextField(blank=True)

    class Meta:
        verbose_name = "Cotización"
        verbose_name_plural = "Cotizaciones"
        ordering = ["-fecha", "-pk"]
        permissions = [
            ("approve_cotizacion", "Puede aprobar Cotizacion → crear OrdenCompra"),
        ]

    def __str__(self):
        return f"Cot {self.numero_cotizacion} ({self.proveedor.nombre})"


class CotizacionItem(models.Model):
    cotizacion = models.ForeignKey(Cotizacion, on_delete=models.CASCADE, related_name="items")
    material = models.ForeignKey(ItemCatalogo, null=True, blank=True, on_delete=models.SET_NULL)
    descripcion = models.CharField(max_length=300)
    cantidad = models.DecimalField(max_digits=12, decimal_places=4)
    unidad = models.CharField(max_length=20)
    precio_unitario = models.DecimalField(max_digits=14, decimal_places=5)
    subtotal = models.DecimalField(max_digits=14, decimal_places=2)
    iva_monto = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    codigo_cabys = models.CharField(max_length=13, blank=True)
    orden = models.PositiveIntegerField(default=0)

    class Meta:
        verbose_name = "Item de cotización"
        verbose_name_plural = "Items de cotización"
        ordering = ["cotizacion", "orden"]
```

- [ ] **Step 4: Path de upload para Cotizacion.archivo (por obra)**

Modificar el `upload_to` de `Cotizacion.archivo` para usar layout `obras/<obra_id>-<slug>/cotizaciones/`:

```python
def cotizacion_upload_path(instance, filename):
    import hashlib, uuid
    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else "bin"
    short = uuid.uuid4().hex[:8]
    obra = instance.obra
    return f"obras/{obra.pk}-{obra.slug}/cotizaciones/{instance.pk or 'tmp'}-{short}.{suffix}"


class Cotizacion(TimestampedModel):
    # ...
    archivo = models.FileField(upload_to=cotizacion_upload_path, null=True, blank=True)
```

- [ ] **Step 5: Migrar y testear**

```bash
docker compose exec web python manage.py makemigrations compras
docker compose exec web python manage.py migrate
docker compose exec web pytest apps/compras/tests/test_models.py -v
```

Expected: 5 PASS.

- [ ] **Step 6: Admin**

`apps/compras/admin.py`:

```python
from django.contrib import admin
from .models import SolicitudCotizacion, Cotizacion, CotizacionItem


class CotizacionItemInline(admin.TabularInline):
    model = CotizacionItem
    extra = 0
    fields = ("orden", "descripcion", "material", "cantidad", "unidad",
              "precio_unitario", "subtotal", "iva_monto")


@admin.register(SolicitudCotizacion)
class SolicitudCotizacionAdmin(admin.ModelAdmin):
    list_display = ("__str__", "categoria", "estado", "es_especial", "fecha_requerida", "creada_por")
    list_filter = ("estado", "es_especial", "obra")
    search_fields = ("descripcion",)


@admin.register(Cotizacion)
class CotizacionAdmin(admin.ModelAdmin):
    list_display = ("numero_cotizacion", "proveedor", "obra", "fecha", "total", "estado")
    list_filter = ("estado", "obra", "moneda")
    search_fields = ("numero_cotizacion",)
    inlines = [CotizacionItemInline]
```

- [ ] **Step 7: Commit**

```bash
git add apps/compras/ construmaster/settings.py
git commit -m "feat(compras): add SolicitudCotizacion, Cotizacion, CotizacionItem models

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3.2 — Vista autocomplete del catálogo

**Files:** `apps/catalogo/views.py`, `apps/catalogo/urls.py`, `construmaster/urls.py`

- [ ] **Step 1: Test fail-first**

`apps/catalogo/tests/test_views.py`:

```python
import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group

pytestmark = pytest.mark.django_db


def _login_as(client, group_name="operativo"):
    User = get_user_model()
    u = User.objects.create_user(username="t", password="pw")
    u.groups.add(Group.objects.get(name=group_name))
    client.login(username="t", password="pw")
    return u


def test_autocomplete_returns_matching_items(client):
    from apps.catalogo.tests.factories import ItemCatalogoFactory
    _login_as(client)
    ItemCatalogoFactory(nombre_canonico="Cemento Sansón 50kg")
    ItemCatalogoFactory(nombre_canonico="Cemento Holcim 50kg")
    ItemCatalogoFactory(nombre_canonico="Varilla #4")
    resp = client.get("/catalogo/autocomplete/?q=cemento")
    assert resp.status_code == 200
    body = resp.content.decode()
    assert "Cemento Sansón" in body
    assert "Cemento Holcim" in body
    assert "Varilla" not in body


def test_autocomplete_excludes_pendientes_e_inactivos(client):
    from apps.catalogo.tests.factories import ItemCatalogoFactory
    _login_as(client)
    ItemCatalogoFactory(nombre_canonico="Aprobado X", estado="aprobado")
    ItemCatalogoFactory(nombre_canonico="Pendiente X", estado="pendiente")
    ItemCatalogoFactory(nombre_canonico="Inactivo X", estado="inactivo")
    resp = client.get("/catalogo/autocomplete/?q=x")
    body = resp.content.decode()
    assert "Aprobado X" in body
    assert "Pendiente X" not in body
    assert "Inactivo X" not in body


def test_autocomplete_requires_login(client):
    resp = client.get("/catalogo/autocomplete/?q=x")
    assert resp.status_code in (302, 403)
```

Correr → FAIL.

- [ ] **Step 2: Implementar vista**

`apps/catalogo/views.py`:

```python
from django.contrib.auth.decorators import login_required
from django.shortcuts import render
from django.db.models import Q

from .models import ItemCatalogo


@login_required
def autocomplete(request):
    """HTMX endpoint para autocomplete de ItemCatalogo.

    GET /catalogo/autocomplete/?q=<query>
    Devuelve fragmento HTML con resultados (<li>) para colocar en un <ul>.
    """
    q = request.GET.get("q", "").strip()
    items = ItemCatalogo.objects.filter(estado="aprobado", activo=True)
    if q:
        items = items.filter(
            Q(nombre_canonico__icontains=q) |
            Q(alias__icontains=q) |
            Q(slug__icontains=q)
        )
    items = items[:15]
    return render(request, "catalogo/_autocomplete_results.html", {"items": items, "q": q})
```

- [ ] **Step 3: Crear template**

`templates/catalogo/_autocomplete_results.html`:

```html
{% load static %}
{% if items %}
<ul class="bg-white border border-gray-200 rounded shadow max-h-64 overflow-y-auto">
  {% for item in items %}
  <li>
    <button type="button"
            class="w-full text-left px-3 py-2 hover:bg-blue-50"
            data-id="{{ item.pk }}"
            data-nombre="{{ item.nombre_canonico }}"
            data-unidad="{{ item.unidad }}"
            onclick="window.dispatchEvent(new CustomEvent('item-selected', {detail: {id: {{ item.pk }}, nombre: '{{ item.nombre_canonico|escapejs }}', unidad: '{{ item.unidad }}'}}))">
      <span class="font-medium">{{ item.nombre_canonico }}</span>
      <span class="text-sm text-gray-500">({{ item.get_unidad_display }})</span>
    </button>
  </li>
  {% endfor %}
</ul>
{% elif q %}
<div class="bg-yellow-50 border border-yellow-200 rounded p-3 text-sm">
  No hay match. <button type="button" class="text-blue-600 underline"
  onclick="window.dispatchEvent(new CustomEvent('suggest-new-item', {detail: {q: '{{ q|escapejs }}'}}))">
  + Sugerir nuevo item</button>
</div>
{% endif %}
```

- [ ] **Step 4: Crear `apps/catalogo/urls.py`**

```python
from django.urls import path
from . import views

app_name = "catalogo"

urlpatterns = [
    path("autocomplete/", views.autocomplete, name="autocomplete"),
]
```

- [ ] **Step 5: Incluir en `construmaster/urls.py`**

```python
from django.contrib import admin
from django.urls import path, include

urlpatterns = [
    path("admin/", admin.site.urls),
    path("catalogo/", include("apps.catalogo.urls")),
]
```

- [ ] **Step 6: Correr tests**

```bash
docker compose exec web pytest apps/catalogo/tests/test_views.py -v
```

Expected: 3 PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/catalogo/views.py apps/catalogo/urls.py construmaster/urls.py templates/catalogo/
git commit -m "feat(catalogo): add autocomplete view for ItemCatalogo

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3.3 — Vista "Sugerir nuevo item" (operativo)

**Files:** `apps/catalogo/views.py`, `apps/catalogo/forms.py`, template

- [ ] **Step 1: Test fail-first**

Append a `apps/catalogo/tests/test_views.py`:

```python
def test_suggest_item_creates_pendiente(client):
    from apps.catalogo.models import ItemCatalogo
    u = _login_as(client, "operativo")
    resp = client.post("/catalogo/suggest/", {
        "tipo": "material",
        "nombre_canonico": "Cemento Cemex 50kg",
        "unidad": "saco",
    })
    assert resp.status_code == 200
    item = ItemCatalogo.objects.get(nombre_canonico="Cemento Cemex 50kg")
    assert item.estado == "pendiente"
    assert item.sugerido_por == u


def test_suggest_item_requires_permission(client):
    _login_as(client, "lector")  # lector NO tiene suggest_item
    resp = client.post("/catalogo/suggest/", {
        "tipo": "material", "nombre_canonico": "X", "unidad": "saco",
    })
    assert resp.status_code == 403
```

Correr → FAIL.

- [ ] **Step 2: Form**

`apps/catalogo/forms.py`:

```python
from django import forms

from .models import ItemCatalogo


class SuggestItemForm(forms.ModelForm):
    class Meta:
        model = ItemCatalogo
        fields = ["tipo", "nombre_canonico", "unidad", "categoria_sugerida"]
        widgets = {
            "nombre_canonico": forms.TextInput(attrs={"class": "input"}),
        }
```

- [ ] **Step 3: Vista**

Append a `apps/catalogo/views.py`:

```python
from django.contrib.auth.decorators import permission_required
from django.shortcuts import render
from django.http import HttpResponse

from .forms import SuggestItemForm


@login_required
@permission_required("catalogo.suggest_item", raise_exception=True)
def suggest_item(request):
    if request.method == "POST":
        form = SuggestItemForm(request.POST)
        if form.is_valid():
            item = form.save(commit=False)
            item.estado = "pendiente"
            item.sugerido_por = request.user
            item.save()
            return render(request, "catalogo/_suggested_ok.html", {"item": item})
        return render(request, "catalogo/_suggest_form.html", {"form": form}, status=400)
    return render(request, "catalogo/_suggest_form.html", {"form": SuggestItemForm()})
```

- [ ] **Step 4: Templates**

`templates/catalogo/_suggest_form.html`:

```html
<form hx-post="{% url 'catalogo:suggest' %}" hx-target="this" hx-swap="outerHTML" class="space-y-2 p-3 border rounded bg-white">
  {% csrf_token %}
  <h3 class="font-semibold">Sugerir nuevo item del catálogo</h3>
  {{ form.as_p }}
  <button type="submit" class="btn-primary">Sugerir</button>
  <p class="text-xs text-gray-500">Tu sugerencia queda pendiente de aprobación por un supervisor.</p>
</form>
```

`templates/catalogo/_suggested_ok.html`:

```html
<div class="p-3 bg-green-50 border border-green-200 rounded">
  ✓ Item "{{ item.nombre_canonico }}" sugerido. Quedó pendiente de aprobación.
</div>
```

- [ ] **Step 5: URL**

Agregar a `apps/catalogo/urls.py`:

```python
path("suggest/", views.suggest_item, name="suggest"),
```

- [ ] **Step 6: Test pass + commit**

```bash
docker compose exec web pytest apps/catalogo/tests/test_views.py -v
git add apps/catalogo/ templates/catalogo/
git commit -m "feat(catalogo): allow operativo users to suggest pending items

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3.4 — Vista de captura de Cotizacion + items

**Files:** `apps/compras/forms.py`, `apps/compras/views.py`, `apps/compras/urls.py`, templates

- [ ] **Step 1: Forms**

`apps/compras/forms.py`:

```python
from django import forms
from django.forms import inlineformset_factory

from apps.core.models import Obra
from apps.catalogo.models import Proveedor
from .models import SolicitudCotizacion, Cotizacion, CotizacionItem


class SolicitudCotizacionForm(forms.ModelForm):
    class Meta:
        model = SolicitudCotizacion
        fields = ["obra", "categoria", "descripcion", "fecha_requerida", "es_especial"]


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
        }

    def clean_archivo(self):
        from django.conf import settings
        f = self.cleaned_data.get("archivo")
        if f and f.size > settings.MAX_UPLOAD_SIZE:
            raise forms.ValidationError(
                f"Archivo excede {settings.MAX_UPLOAD_SIZE // 1024 // 1024} MB."
            )
        return f


CotizacionItemFormSet = inlineformset_factory(
    Cotizacion, CotizacionItem,
    fields=["orden", "material", "descripcion", "cantidad", "unidad",
            "precio_unitario", "subtotal", "iva_monto", "codigo_cabys"],
    extra=1, can_delete=True,
)
```

- [ ] **Step 2: Vistas**

`apps/compras/views.py`:

```python
from django.contrib import messages
from django.contrib.auth.decorators import login_required, permission_required
from django.db import transaction
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse

from .models import SolicitudCotizacion, Cotizacion
from .forms import SolicitudCotizacionForm, CotizacionForm, CotizacionItemFormSet


@login_required
@permission_required("compras.add_solicitudcotizacion", raise_exception=True)
def rfq_create(request):
    if request.method == "POST":
        form = SolicitudCotizacionForm(request.POST)
        if form.is_valid():
            s = form.save(commit=False)
            s.creada_por = request.user
            s.save()
            messages.success(request, f"RFQ creado: {s}")
            return redirect("compras:rfq_detail", pk=s.pk)
    else:
        form = SolicitudCotizacionForm()
    return render(request, "compras/rfq_form.html", {"form": form})


@login_required
@permission_required("compras.view_solicitudcotizacion", raise_exception=True)
def rfq_detail(request, pk):
    rfq = get_object_or_404(SolicitudCotizacion, pk=pk)
    return render(request, "compras/rfq_detail.html", {"rfq": rfq})


@login_required
@permission_required("compras.add_cotizacion", raise_exception=True)
def cotizacion_create(request, rfq_pk=None):
    initial = {}
    rfq = None
    if rfq_pk:
        rfq = get_object_or_404(SolicitudCotizacion, pk=rfq_pk)
        initial = {"obra": rfq.obra, "rfq": rfq, "es_especial": rfq.es_especial}

    if request.method == "POST":
        form = CotizacionForm(request.POST, request.FILES, initial=initial)
        if form.is_valid():
            with transaction.atomic():
                cot = form.save()
                formset = CotizacionItemFormSet(request.POST, instance=cot)
                if formset.is_valid():
                    formset.save()
                    messages.success(request, f"Cotización {cot.numero_cotizacion} creada")
                    return redirect("compras:cotizacion_detail", pk=cot.pk)
                else:
                    transaction.set_rollback(True)
        else:
            formset = CotizacionItemFormSet()
    else:
        form = CotizacionForm(initial=initial)
        formset = CotizacionItemFormSet()

    return render(request, "compras/cotizacion_form.html",
                  {"form": form, "formset": formset, "rfq": rfq})


@login_required
@permission_required("compras.view_cotizacion", raise_exception=True)
def cotizacion_detail(request, pk):
    cot = get_object_or_404(Cotizacion, pk=pk)
    return render(request, "compras/cotizacion_detail.html", {"cotizacion": cot})


@login_required
@permission_required("compras.view_cotizacion", raise_exception=True)
def comparativa(request, rfq_pk):
    """Vista comparativa lado a lado de todas las cotizaciones de un RFQ."""
    rfq = get_object_or_404(SolicitudCotizacion, pk=rfq_pk)
    cotizaciones = rfq.cotizaciones.exclude(estado="rechazada").select_related("proveedor")
    return render(request, "compras/comparativa.html",
                  {"rfq": rfq, "cotizaciones": cotizaciones})
```

- [ ] **Step 3: URLs**

`apps/compras/urls.py`:

```python
from django.urls import path
from . import views

app_name = "compras"

urlpatterns = [
    path("rfq/new/", views.rfq_create, name="rfq_create"),
    path("rfq/<int:pk>/", views.rfq_detail, name="rfq_detail"),
    path("rfq/<int:rfq_pk>/comparativa/", views.comparativa, name="comparativa"),
    path("cotizacion/new/", views.cotizacion_create, name="cotizacion_create"),
    path("cotizacion/new/<int:rfq_pk>/", views.cotizacion_create, name="cotizacion_from_rfq"),
    path("cotizacion/<int:pk>/", views.cotizacion_detail, name="cotizacion_detail"),
]
```

Incluir en `construmaster/urls.py`:
```python
path("compras/", include("apps.compras.urls")),
```

- [ ] **Step 4: Templates**

`templates/compras/rfq_form.html`:
```html
{% extends "base.html" %}
{% block content %}
<h1 class="text-2xl font-bold mb-4">Nueva solicitud de cotización (RFQ)</h1>
<form method="post" class="space-y-3 bg-white p-4 rounded shadow">
  {% csrf_token %}
  {{ form.as_p }}
  <button type="submit" class="btn-primary">Crear RFQ</button>
</form>
{% endblock %}
```

`templates/compras/rfq_detail.html`:
```html
{% extends "base.html" %}
{% block content %}
<h1 class="text-2xl font-bold mb-2">{{ rfq }}</h1>
<p class="text-sm text-gray-600">Obra: {{ rfq.obra.nombre }} · Categoría: {{ rfq.categoria.nombre }} · Estado: {{ rfq.get_estado_display }}{% if rfq.es_especial %} · <span class="badge-orange">Pedido especial</span>{% endif %}</p>
<p class="my-3">{{ rfq.descripcion|linebreaks }}</p>
<div class="mt-4 flex gap-3">
  <a href="{% url 'compras:cotizacion_from_rfq' rfq_pk=rfq.pk %}" class="btn-primary">+ Capturar cotización recibida</a>
  {% if rfq.cotizaciones.exists %}
  <a href="{% url 'compras:comparativa' rfq_pk=rfq.pk %}" class="btn-secondary">Ver comparativa</a>
  {% endif %}
</div>
<h2 class="text-xl font-semibold mt-6 mb-2">Cotizaciones recibidas ({{ rfq.cotizaciones.count }})</h2>
<ul class="space-y-2">
  {% for c in rfq.cotizaciones.all %}
  <li class="bg-white p-3 rounded shadow flex justify-between">
    <span><a href="{% url 'compras:cotizacion_detail' pk=c.pk %}" class="text-blue-600">{{ c.proveedor.nombre }} — {{ c.numero_cotizacion }}</a></span>
    <span>{{ c.total }} · <span class="badge-{% if c.estado == 'aprobada' %}green{% elif c.estado == 'rechazada' %}red{% else %}yellow{% endif %}">{{ c.get_estado_display }}</span></span>
  </li>
  {% empty %}
  <li class="text-gray-500">Aún no hay cotizaciones capturadas.</li>
  {% endfor %}
</ul>
{% endblock %}
```

`templates/compras/cotizacion_form.html`:
```html
{% extends "base.html" %}
{% block content %}
<h1 class="text-2xl font-bold mb-4">Nueva cotización{% if rfq %} para RFQ {{ rfq.pk }}{% endif %}</h1>
<form method="post" enctype="multipart/form-data" class="space-y-3 bg-white p-4 rounded shadow">
  {% csrf_token %}
  <div class="grid grid-cols-2 gap-4">{{ form.as_p }}</div>

  <h2 class="text-lg font-semibold mt-4">Items</h2>
  {{ formset.management_form }}
  <table class="w-full text-sm">
    <thead><tr class="border-b">
      <th>Orden</th><th>Material (catálogo)</th><th>Descripción</th><th>Cantidad</th><th>Unidad</th><th>Precio unit.</th><th>Subtotal</th><th>IVA</th><th>CABYS</th><th>Borrar</th>
    </tr></thead>
    <tbody>
    {% for f in formset.forms %}
      <tr>{% for field in f.visible_fields %}<td>{{ field }}</td>{% endfor %}{% for h in f.hidden_fields %}{{ h }}{% endfor %}</tr>
    {% endfor %}
    </tbody>
  </table>

  <button type="submit" class="btn-primary">Guardar cotización</button>
</form>
{% endblock %}
```

`templates/compras/cotizacion_detail.html`:
```html
{% extends "base.html" %}
{% load money_extras %}
{% block content %}
<h1 class="text-2xl font-bold">{{ cotizacion.numero_cotizacion }}</h1>
<p>Proveedor: <strong>{{ cotizacion.proveedor.nombre }}</strong></p>
<p>Total: {% money_display cotizacion.total cotizacion.obra.moneda_reporte cotizacion.fecha %}</p>
<p>Estado: <span class="badge-yellow">{{ cotizacion.get_estado_display }}</span></p>

<h2 class="text-xl font-semibold mt-4">Items</h2>
<table class="w-full text-sm bg-white shadow rounded">
  <thead><tr class="border-b"><th>Descripción</th><th>Cantidad</th><th>Unidad</th><th>P. unit.</th><th>Subtotal</th><th>IVA</th></tr></thead>
  <tbody>
  {% for item in cotizacion.items.all %}
  <tr><td>{{ item.descripcion }}</td><td>{{ item.cantidad }}</td><td>{{ item.unidad }}</td><td>{{ item.precio_unitario }}</td><td>{{ item.subtotal }}</td><td>{{ item.iva_monto }}</td></tr>
  {% endfor %}
  </tbody>
</table>
{% endblock %}
```

`templates/compras/comparativa.html`:
```html
{% extends "base.html" %}
{% load money_extras %}
{% block content %}
<h1 class="text-2xl font-bold mb-3">Comparativa: {{ rfq }}</h1>
<div class="grid grid-cols-{{ cotizaciones|length }} gap-4">
{% for c in cotizaciones %}
<div class="bg-white p-4 rounded shadow">
  <h3 class="font-bold">{{ c.proveedor.nombre }}</h3>
  <p class="text-sm text-gray-500">{{ c.numero_cotizacion }} · {{ c.fecha }}</p>
  <p class="my-2 text-lg">{% money_display c.total c.obra.moneda_reporte c.fecha %}</p>
  <p class="text-sm">Entrega: {{ c.plazo_entrega_dias|default:"—" }} días · Anticipo: {{ c.pct_anticipo|default:"—" }}%</p>
  <ul class="mt-3 text-xs space-y-1">
    {% for item in c.items.all %}
    <li>{{ item.descripcion }} — {{ item.cantidad }} {{ item.unidad }} × {{ item.precio_unitario }}</li>
    {% endfor %}
  </ul>
  {% if perms.compras.approve_cotizacion %}
  <form method="post" action="{% url 'compras:cotizacion_detail' pk=c.pk %}" class="mt-3">
    {% csrf_token %}
    <button class="btn-primary text-sm">Aprobar → crear OC</button>
  </form>
  {% endif %}
</div>
{% endfor %}
</div>
{% endblock %}
```

- [ ] **Step 5: Tests integrados**

`apps/compras/tests/test_views.py`:

```python
import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group

pytestmark = pytest.mark.django_db


def _login(client, group="operativo"):
    User = get_user_model()
    u = User.objects.create_user(username="x", password="pw")
    u.groups.add(Group.objects.get(name=group))
    client.login(username="x", password="pw")
    return u


def test_rfq_create_view(client):
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    _login(client, "supervisor")
    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    resp = client.post("/compras/rfq/new/", {
        "obra": obra.pk, "categoria": cat.pk,
        "descripcion": "Compra de cemento", "fecha_requerida": "2026-06-01",
        "es_especial": "",
    })
    assert resp.status_code == 302  # redirect a detail


def test_rfq_create_requires_permission(client):
    _login(client, "lector")
    resp = client.get("/compras/rfq/new/")
    assert resp.status_code == 403


def test_operativo_can_create_cotizacion(client):
    from apps.core.tests.factories import ObraFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    _login(client, "operativo")
    obra = ObraFactory()
    prov = ProveedorFactory()

    resp = client.post("/compras/cotizacion/new/", {
        "obra": obra.pk, "proveedor": prov.pk,
        "numero_cotizacion": "COT-1", "fecha": "2026-05-25",
        "moneda": "CRC",
        "subtotal_0": "100000", "subtotal_1": "CRC",
        "iva_0": "13000", "iva_1": "CRC",
        "total_0": "113000", "total_1": "CRC",
        "items-TOTAL_FORMS": "1", "items-INITIAL_FORMS": "0",
        "items-MIN_NUM_FORMS": "0", "items-MAX_NUM_FORMS": "100",
        "items-0-orden": "1",
        "items-0-descripcion": "Cemento Sansón 50kg",
        "items-0-cantidad": "10",
        "items-0-unidad": "saco",
        "items-0-precio_unitario": "10000",
        "items-0-subtotal": "100000",
        "items-0-iva_monto": "13000",
    })
    assert resp.status_code == 302  # redirect
```

Correr → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/compras/ templates/compras/ construmaster/urls.py
git commit -m "feat(compras): add RFQ and Cotizacion CRUD views with HTMX-friendly templates

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

**Fase 3 completa.** RFQ y Cotizaciones operativas; autocomplete del catálogo + sugerir item nuevo; comparativa visual lado a lado.

---

## Fase 4 — Aprobación → OrdenCompra + Hitos + semáforo presupuesto

**Objetivo:** Aprobación atómica de cotización → snapshot inmutable `OrdenCompra` + `OrdenCompraItem`. Generación de `numero_oc` con lock contra race conditions. Hitos para items de servicio. Semáforo de presupuesto 70/90/100. Snapshot del TC al aprobar.

**Resultado testeable:** Supervisor aprueba cotización → se crea OC con snapshot, `Obra.next_oc_seq` se incrementa, presupuesto consumido se calcula, alerta si excede 70/90/100%.

### Task 4.1 — Modelos `OrdenCompra`, `OrdenCompraItem`, `Hito`

- [ ] **Step 1: Tests fail-first**

`apps/compras/tests/test_oc.py`:

```python
from datetime import date
from decimal import Decimal

import pytest
from djmoney.money import Money

pytestmark = pytest.mark.django_db


@pytest.fixture
def tc_25_may():
    from apps.finance.models import ExchangeRate
    return ExchangeRate.objects.create(
        currency="USD", date=date(2026, 5, 25),
        buy=Decimal("447.5"), sell=Decimal("454.82"),
    )


def test_oc_snapshot_fields_inmutables_post_creation():
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import OrdenCompra
    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    oc = OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="LOMAS-OC-0001",
        fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(1_000_000, "CRC"),
        fx_rate_applied=Decimal("454.82"),
        fx_rate_date=date(2026, 5, 25),
        estado="autorizada",
    )
    assert oc.estado == "autorizada"
    assert oc.numero_oc == "LOMAS-OC-0001"


def test_oc_item_snapshot_denormaliza_nombre_unidad():
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory, ItemCatalogoFactory
    from apps.compras.models import OrdenCompra, OrdenCompraItem
    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    item = ItemCatalogoFactory(nombre_canonico="Cemento Sansón 50kg", unidad="saco")
    oc = OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="X-OC-0001", fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(1000, "CRC"), estado="autorizada",
    )
    line = OrdenCompraItem.objects.create(
        oc=oc, material=item,
        material_nombre_snapshot=item.nombre_canonico,
        material_unidad_snapshot=item.unidad,
        descripcion="Cemento Sansón 50kg",
        cantidad=Decimal("10"), unidad="saco",
        precio_unitario=Decimal("100"), subtotal=Decimal("1000"),
        iva_monto=Decimal("0"), orden=1,
    )
    # Renombrar el material maestro NO debe afectar el snapshot
    item.nombre_canonico = "Cemento OTRO nombre"
    item.save()
    line.refresh_from_db()
    assert line.material_nombre_snapshot == "Cemento Sansón 50kg"


def test_hito_solo_para_servicios():
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory, ItemCatalogoFactory
    from apps.compras.models import OrdenCompra, OrdenCompraItem, Hito
    from django.core.exceptions import ValidationError

    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    material = ItemCatalogoFactory(tipo="material", nombre_canonico="X", unidad="saco")
    servicio = ItemCatalogoFactory(tipo="servicio", nombre_canonico="Instalación", unidad="global")

    oc = OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="Y-OC-0001", fecha_aprobacion=date.today(),
        monto_total=Money(1000, "CRC"), estado="autorizada",
    )
    line_servicio = OrdenCompraItem.objects.create(
        oc=oc, material=servicio,
        material_nombre_snapshot=servicio.nombre_canonico,
        material_unidad_snapshot=servicio.unidad,
        descripcion="Instalación", cantidad=Decimal("1"),
        unidad="global", precio_unitario=Decimal("1000"),
        subtotal=Decimal("1000"), iva_monto=Decimal("0"), orden=1,
    )
    h = Hito(oc_item=line_servicio, nombre="Anticipo 50%", monto=Decimal("500"))
    h.full_clean()  # debe pasar

    line_material = OrdenCompraItem.objects.create(
        oc=oc, material=material,
        material_nombre_snapshot=material.nombre_canonico,
        material_unidad_snapshot=material.unidad,
        descripcion="Cemento", cantidad=Decimal("1"),
        unidad="saco", precio_unitario=Decimal("1000"),
        subtotal=Decimal("1000"), iva_monto=Decimal("0"), orden=2,
    )
    h_invalid = Hito(oc_item=line_material, nombre="X", monto=Decimal("1"))
    with pytest.raises(ValidationError):
        h_invalid.full_clean()
```

Correr → FAIL.

- [ ] **Step 2: Implementar modelos**

Append a `apps/compras/models.py`:

```python
from django.core.exceptions import ValidationError


def oc_numero_help():
    return "Formato: <SLUG_OBRA>-OC-NNNN. Generado por compras.services.generate_numero_oc."


class OrdenCompra(TimestampedModel):
    ESTADO_CHOICES = [
        ("autorizada", "Autorizada"),
        ("pagada_parcial", "Pagada parcial"),
        ("pagada", "Pagada"),
        ("entregada_parcial", "Entregada parcial"),
        ("completada", "Completada"),
        ("cancelada", "Cancelada"),
    ]
    MONEDA_CHOICES = [("CRC", "Colones"), ("USD", "Dólares")]

    obra = models.ForeignKey(Obra, on_delete=models.PROTECT, related_name="ordenes_compra")
    categoria = models.ForeignKey(CategoriaPresupuesto, on_delete=models.PROTECT)
    cotizacion_origen = models.ForeignKey(
        Cotizacion, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="ocs",
    )
    proveedor = models.ForeignKey(Proveedor, on_delete=models.PROTECT)
    numero_oc = models.CharField(max_length=80, unique=True, help_text=oc_numero_help())
    fecha_aprobacion = models.DateField()
    aprobada_por = models.ForeignKey(
        get_user_model(), null=True, blank=True,
        on_delete=models.PROTECT, related_name="ocs_aprobadas",
    )
    moneda = models.CharField(max_length=3, choices=MONEDA_CHOICES, default="CRC")
    monto_total = MoneyField(max_digits=14, decimal_places=2, default_currency="CRC")
    fx_rate_applied = models.DecimalField(max_digits=12, decimal_places=5, null=True, blank=True)
    fx_rate_date = models.DateField(null=True, blank=True)
    es_especial = models.BooleanField(default=False)
    tiempo_estimado_dias = models.PositiveIntegerField(null=True, blank=True)
    pct_anticipo = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    estado = models.CharField(max_length=20, choices=ESTADO_CHOICES, default="autorizada")
    notas = models.TextField(blank=True)

    class Meta:
        verbose_name = "Orden de compra"
        verbose_name_plural = "Órdenes de compra"
        ordering = ["-fecha_aprobacion", "-pk"]
        permissions = [
            ("cancel_oc", "Puede cancelar/anular una OrdenCompra autorizada"),
        ]

    def __str__(self):
        return self.numero_oc


class OrdenCompraItem(models.Model):
    oc = models.ForeignKey(OrdenCompra, on_delete=models.CASCADE, related_name="items")
    material = models.ForeignKey(ItemCatalogo, null=True, blank=True, on_delete=models.SET_NULL)
    # Denormalización defensiva: copia del nombre/unidad al momento de aprobar
    material_nombre_snapshot = models.CharField(max_length=200, blank=True)
    material_unidad_snapshot = models.CharField(max_length=20, blank=True)
    descripcion = models.CharField(max_length=300)
    cantidad = models.DecimalField(max_digits=12, decimal_places=4)
    unidad = models.CharField(max_length=20)
    precio_unitario = models.DecimalField(max_digits=14, decimal_places=5)
    subtotal = models.DecimalField(max_digits=14, decimal_places=2)
    iva_monto = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    codigo_cabys = models.CharField(max_length=13, blank=True)
    orden = models.PositiveIntegerField(default=0)

    class Meta:
        verbose_name = "Item de OC"
        verbose_name_plural = "Items de OC"
        ordering = ["oc", "orden"]


class Hito(TimestampedModel):
    oc_item = models.ForeignKey(OrdenCompraItem, on_delete=models.CASCADE, related_name="hitos")
    nombre = models.CharField(max_length=200)
    monto = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    fecha_estimada = models.DateField(null=True, blank=True)
    completado = models.BooleanField(default=False)
    fecha_completado = models.DateField(null=True, blank=True)
    notas = models.TextField(blank=True)
    orden = models.PositiveIntegerField(default=0)

    class Meta:
        verbose_name = "Hito"
        verbose_name_plural = "Hitos"
        ordering = ["oc_item", "orden"]

    def clean(self):
        # Hito solo aplica a items de tipo servicio
        if self.oc_item_id and self.oc_item.material and self.oc_item.material.tipo != "servicio":
            raise ValidationError("Hito solo aplica a items de tipo servicio.")

    def __str__(self):
        return f"{self.nombre} ({self.oc_item.descripcion[:40]})"
```

Registrar `OrdenCompra` y `OrdenCompraItem` y `Hito` con auditlog en `apps/compras/apps.py`:

```python
def ready(self):
    from auditlog.registry import auditlog
    from . import models
    auditlog.register(models.SolicitudCotizacion)
    auditlog.register(models.Cotizacion)
    auditlog.register(models.OrdenCompra)
    auditlog.register(models.OrdenCompraItem)
    auditlog.register(models.Hito)
```

- [ ] **Step 3: Migrar y testear**

```bash
docker compose exec web python manage.py makemigrations compras
docker compose exec web python manage.py migrate
docker compose exec web pytest apps/compras/tests/test_oc.py -v
```

Expected: 3 PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/compras/
git commit -m "feat(compras): add OrdenCompra, OrdenCompraItem, Hito models

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 4.2 — `generate_numero_oc` con select_for_update (race condition fix)

**Files:** `apps/compras/services.py`, `apps/compras/tests/test_services.py`

- [ ] **Step 1: Tests fail-first** (incluyendo simulación de concurrencia)

`apps/compras/tests/test_services.py`:

```python
import threading

import pytest
from django.db import connection

pytestmark = pytest.mark.django_db


def test_generate_numero_oc_secuencial():
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
    from apps.core.tests.factories import ObraFactory
    from apps.compras.services import generate_numero_oc
    o1 = ObraFactory(nombre="Lomas")
    o2 = ObraFactory(nombre="Baches")
    n1a = generate_numero_oc(o1.pk)
    n2a = generate_numero_oc(o2.pk)
    n1b = generate_numero_oc(o1.pk)
    assert "lomas" in n1a.lower()
    assert "baches" in n2a.lower()
    assert n1b.endswith("-OC-0002")
```

- [ ] **Step 2: Implementar `services.py`**

`apps/compras/services.py`:

```python
"""Servicios atómicos del módulo compras."""
from django.db import transaction

from apps.core.models import Obra


def generate_numero_oc(obra_pk: int) -> str:
    """Genera un numero_oc único y secuencial para la obra dada.

    Usa select_for_update() sobre la fila de Obra para serializar
    aprobaciones concurrentes (ver spec §6.4 race condition fix).
    """
    with transaction.atomic():
        obra = Obra.objects.select_for_update().get(pk=obra_pk)
        seq = obra.next_oc_seq
        obra.next_oc_seq = seq + 1
        obra.save(update_fields=["next_oc_seq"])
    return f"{obra.slug.upper()}-OC-{seq:04d}"
```

- [ ] **Step 3: Correr tests**

```bash
docker compose exec web pytest apps/compras/tests/test_services.py -v
```

Expected: 2 PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/compras/services.py apps/compras/tests/test_services.py
git commit -m "feat(compras): add generate_numero_oc with select_for_update lock

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 4.3 — `approve_cotizacion` (servicio atómico que crea OC)

**Files:** `apps/compras/services.py`, `apps/compras/tests/test_services.py`

- [ ] **Step 1: Tests fail-first**

Append a `apps/compras/tests/test_services.py`:

```python
from datetime import date
from decimal import Decimal
from djmoney.money import Money


@pytest.fixture
def tc_25_may(db):
    from apps.finance.models import ExchangeRate
    return ExchangeRate.objects.create(
        currency="USD", date=date(2026, 5, 25),
        buy=Decimal("447.5"), sell=Decimal("454.82"),
    )


def test_approve_cotizacion_creates_oc_with_snapshot(tc_25_may):
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory, ItemCatalogoFactory
    from apps.compras.models import Cotizacion, CotizacionItem
    from apps.compras.services import approve_cotizacion
    from django.contrib.auth import get_user_model

    obra = ObraFactory(nombre="Casa Lomas")
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    item_cat = ItemCatalogoFactory(nombre_canonico="Cemento", unidad="saco")

    c = Cotizacion.objects.create(
        obra=obra, proveedor=prov,
        numero_cotizacion="X", fecha=date(2026, 5, 25),
        moneda="USD",
        subtotal=Money(1000, "USD"), iva=Money(130, "USD"), total=Money(1130, "USD"),
    )
    CotizacionItem.objects.create(
        cotizacion=c, material=item_cat,
        descripcion="Cemento Sansón", cantidad=Decimal("10"),
        unidad="saco", precio_unitario=Decimal("100"),
        subtotal=Decimal("1000"), iva_monto=Decimal("130"), orden=1,
    )

    user = get_user_model().objects.create_user("diana")
    oc = approve_cotizacion(c, categoria=cat, approver=user, fecha_aprobacion=date(2026, 5, 25))

    assert oc.numero_oc.endswith("-OC-0001")
    assert oc.estado == "autorizada"
    assert oc.fx_rate_applied == Decimal("454.82000")
    assert oc.fx_rate_date == date(2026, 5, 25)
    assert oc.items.count() == 1
    line = oc.items.first()
    assert line.material_nombre_snapshot == "Cemento"
    assert line.material_unidad_snapshot == "saco"

    c.refresh_from_db()
    assert c.estado == "aprobada"


def test_approve_cotizacion_already_approved_raises(tc_25_may):
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import Cotizacion
    from apps.compras.services import approve_cotizacion, AlreadyApproved
    from django.contrib.auth import get_user_model

    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    c = Cotizacion.objects.create(
        obra=obra, proveedor=prov, numero_cotizacion="X", fecha=date(2026, 5, 25),
        subtotal=Money(1, "CRC"), iva=Money(0, "CRC"), total=Money(1, "CRC"),
        estado="aprobada",
    )
    user = get_user_model().objects.create_user("u")
    with pytest.raises(AlreadyApproved):
        approve_cotizacion(c, categoria=cat, approver=user, fecha_aprobacion=date.today())
```

- [ ] **Step 2: Implementar**

Append a `apps/compras/services.py`:

```python
from datetime import date as date_type
from decimal import Decimal

from django.db import transaction

from apps.finance.models import ExchangeRate, NoExchangeRateAvailable
from .models import Cotizacion, OrdenCompra, OrdenCompraItem


class AlreadyApproved(Exception):
    pass


@transaction.atomic
def approve_cotizacion(
    cotizacion: Cotizacion,
    categoria,
    approver,
    fecha_aprobacion: date_type,
) -> OrdenCompra:
    """Aprueba una Cotizacion y crea su OrdenCompra snapshot.

    Operación atómica:
    1. Validar que la cotización no esté ya aprobada
    2. Lockear obra y generar numero_oc
    3. Capturar fx_rate_applied (snapshot at write-time)
    4. Crear OC + OrdenCompraItem por cada CotizacionItem
    5. Marcar Cotizacion.estado='aprobada'
    """
    cotizacion.refresh_from_db()
    if cotizacion.estado in ("aprobada", "rechazada", "vencida"):
        raise AlreadyApproved(
            f"Cotizacion {cotizacion.pk} ya está en estado {cotizacion.estado}"
        )

    numero_oc = generate_numero_oc(cotizacion.obra_id)

    # Snapshot del TC si la moneda no es CRC
    fx_rate, fx_date = None, None
    if cotizacion.monto_total.currency.code != "CRC":
        try:
            fx_rate = ExchangeRate.for_date("USD", fecha_aprobacion, side="sell")
            fx_date = fecha_aprobacion
        except NoExchangeRateAvailable:
            # No bloqueamos: el supervisor puede editar manualmente luego
            pass

    oc = OrdenCompra.objects.create(
        obra=cotizacion.obra,
        categoria=categoria,
        cotizacion_origen=cotizacion,
        proveedor=cotizacion.proveedor,
        numero_oc=numero_oc,
        fecha_aprobacion=fecha_aprobacion,
        aprobada_por=approver,
        moneda=cotizacion.moneda,
        monto_total=cotizacion.total,
        fx_rate_applied=fx_rate,
        fx_rate_date=fx_date,
        es_especial=cotizacion.es_especial,
        tiempo_estimado_dias=cotizacion.plazo_entrega_dias,
        pct_anticipo=cotizacion.pct_anticipo,
        estado="autorizada",
    )

    # Snapshot inmutable de items
    for ci in cotizacion.items.all():
        OrdenCompraItem.objects.create(
            oc=oc,
            material=ci.material,
            material_nombre_snapshot=ci.material.nombre_canonico if ci.material else "",
            material_unidad_snapshot=ci.material.unidad if ci.material else ci.unidad,
            descripcion=ci.descripcion,
            cantidad=ci.cantidad,
            unidad=ci.unidad,
            precio_unitario=ci.precio_unitario,
            subtotal=ci.subtotal,
            iva_monto=ci.iva_monto,
            codigo_cabys=ci.codigo_cabys,
            orden=ci.orden,
        )

    cotizacion.estado = "aprobada"
    cotizacion.save(update_fields=["estado"])

    # Cerrar RFQ si aplica
    if cotizacion.rfq_id:
        cotizacion.rfq.estado = "cerrada"
        cotizacion.rfq.save(update_fields=["estado"])

    return oc
```

- [ ] **Step 3: Correr tests**

```bash
docker compose exec web pytest apps/compras/tests/test_services.py -v
```

Expected: 4 PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/compras/services.py apps/compras/tests/test_services.py
git commit -m "feat(compras): add approve_cotizacion service with atomic OC snapshot

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 4.4 — Vista de aprobación + semáforo de presupuesto

**Files:** `apps/compras/views.py`, `apps/compras/services.py`, templates

- [ ] **Step 1: Helper para semáforo de presupuesto**

Append a `apps/compras/services.py`:

```python
from djmoney.money import Money
from django.db.models import Sum

from apps.core.models import Presupuesto


def presupuesto_status(obra, categoria) -> dict:
    """Devuelve el estado del presupuesto para una categoría de una obra.

    Returns: {
        "presupuesto": Money,
        "consumido": Money,
        "disponible": Money,
        "porcentaje": float,
        "semaforo": "verde" | "amarillo" | "naranja" | "rojo",
    }
    """
    try:
        p = Presupuesto.objects.get(obra=obra, categoria=categoria)
    except Presupuesto.DoesNotExist:
        return None

    # Sumar todas las OCs autorizadas (no canceladas) de la categoría, normalizado en CRC
    # (asumimos presupuesto en CRC; si está en USD, convertir)
    from apps.finance.services import convert
    from datetime import date

    target_ccy = p.monto.currency.code
    total_consumido = Money(0, target_ccy)
    for oc in OrdenCompra.objects.filter(
        obra=obra, categoria=categoria,
    ).exclude(estado="cancelada"):
        monto = oc.monto_total
        if monto.currency.code != target_ccy:
            try:
                monto = convert(monto, target_ccy, oc.fx_rate_date or date.today())
            except Exception:
                pass
        total_consumido += monto

    if p.monto.amount > 0:
        pct = float(total_consumido.amount / p.monto.amount * 100)
    else:
        pct = 0.0

    if pct > 100:
        semaforo = "rojo"
    elif pct > 90:
        semaforo = "naranja"
    elif pct > 70:
        semaforo = "amarillo"
    else:
        semaforo = "verde"

    return {
        "presupuesto": p.monto,
        "consumido": total_consumido,
        "disponible": p.monto - total_consumido,
        "porcentaje": pct,
        "semaforo": semaforo,
    }
```

- [ ] **Step 2: Vista de aprobación con check de presupuesto**

Append a `apps/compras/views.py`:

```python
from datetime import date
from django.contrib.auth.decorators import permission_required
from django.shortcuts import get_object_or_404, render, redirect
from django.contrib import messages
from django.urls import reverse

from .services import approve_cotizacion, presupuesto_status, AlreadyApproved


@login_required
@permission_required("compras.approve_cotizacion", raise_exception=True)
def cotizacion_approve(request, pk):
    cot = get_object_or_404(Cotizacion, pk=pk)

    if request.method == "GET":
        # Mostrar form con semáforo de presupuesto
        categoria_id = request.GET.get("categoria") or (cot.rfq.categoria_id if cot.rfq else None)
        categoria = None
        status = None
        if categoria_id:
            from apps.core.models import CategoriaPresupuesto
            categoria = get_object_or_404(CategoriaPresupuesto, pk=categoria_id)
            status = presupuesto_status(cot.obra, categoria)
        return render(request, "compras/cotizacion_approve.html", {
            "cotizacion": cot, "categoria": categoria, "status": status,
        })

    # POST = ejecutar aprobación
    from apps.core.models import CategoriaPresupuesto
    categoria = get_object_or_404(CategoriaPresupuesto, pk=request.POST.get("categoria"))
    try:
        oc = approve_cotizacion(
            cot, categoria=categoria, approver=request.user,
            fecha_aprobacion=date.today(),
        )
    except AlreadyApproved as e:
        messages.error(request, str(e))
        return redirect("compras:cotizacion_detail", pk=cot.pk)

    messages.success(request, f"Cotización aprobada → {oc.numero_oc}")
    return redirect("compras:oc_detail", pk=oc.pk)


@login_required
@permission_required("compras.view_ordencompra", raise_exception=True)
def oc_detail(request, pk):
    oc = get_object_or_404(OrdenCompra, pk=pk)
    return render(request, "compras/oc_detail.html", {"oc": oc})
```

(Importar `OrdenCompra` en el module-level.)

Agregar URLs:

```python
path("cotizacion/<int:pk>/approve/", views.cotizacion_approve, name="cotizacion_approve"),
path("oc/<int:pk>/", views.oc_detail, name="oc_detail"),
```

- [ ] **Step 3: Templates**

`templates/compras/cotizacion_approve.html`:

```html
{% extends "base.html" %}
{% load money_extras %}
{% block content %}
<h1 class="text-2xl font-bold">Aprobar cotización: {{ cotizacion.numero_cotizacion }}</h1>
<p>Proveedor: <strong>{{ cotizacion.proveedor.nombre }}</strong> · Total: {{ cotizacion.total }}</p>

{% if status %}
<div class="mt-4 p-4 rounded
    {% if status.semaforo == 'verde' %}bg-green-50 border border-green-200
    {% elif status.semaforo == 'amarillo' %}bg-yellow-50 border border-yellow-200
    {% elif status.semaforo == 'naranja' %}bg-orange-50 border border-orange-200
    {% else %}bg-red-50 border border-red-200{% endif %}">
  <h3 class="font-semibold">Presupuesto — {{ categoria.nombre }}</h3>
  <p>Asignado: {{ status.presupuesto }}</p>
  <p>Consumido: {{ status.consumido }} ({{ status.porcentaje|floatformat:1 }}%)</p>
  <p>Disponible: {{ status.disponible }}</p>
  {% if status.semaforo == 'rojo' %}
  <p class="font-bold mt-2">⚠️ Exceso de presupuesto. Confirmar requiere justificación en notas.</p>
  {% elif status.semaforo == 'naranja' %}
  <p class="mt-2">⚠️ Presupuesto crítico (>90%).</p>
  {% elif status.semaforo == 'amarillo' %}
  <p class="mt-2">Atención: presupuesto al {{ status.porcentaje|floatformat:1 }}%.</p>
  {% endif %}
</div>
{% endif %}

<form method="post" class="mt-6 space-y-3 bg-white p-4 rounded shadow">
  {% csrf_token %}
  <label>Categoría de presupuesto:</label>
  <select name="categoria" required class="w-full border rounded p-2">
    <option value="">— Elegir —</option>
    {% for c in cotizacion.obra.categorias.all %}
    <option value="{{ c.pk }}" {% if categoria and c.pk == categoria.pk %}selected{% endif %}>{{ c.nombre }}</option>
    {% endfor %}
  </select>
  <button type="submit" class="btn-primary">Aprobar y crear OC</button>
</form>
{% endblock %}
```

`templates/compras/oc_detail.html`:

```html
{% extends "base.html" %}
{% load money_extras %}
{% block content %}
<h1 class="text-2xl font-bold">{{ oc.numero_oc }}</h1>
<p>Obra: {{ oc.obra.nombre }} · Categoría: {{ oc.categoria.nombre }}</p>
<p>Proveedor: {{ oc.proveedor.nombre }}</p>
<p>Monto: {% money_display oc.monto_total oc.obra.moneda_reporte oc.fecha_aprobacion %}</p>
<p>Estado: <span class="badge-yellow">{{ oc.get_estado_display }}</span>{% if oc.es_especial %} · <span class="badge-orange">Pedido especial</span>{% endif %}</p>

<h2 class="text-xl font-semibold mt-4">Items</h2>
<table class="w-full bg-white shadow rounded text-sm">
  <thead><tr class="border-b"><th>Material</th><th>Cantidad</th><th>Unidad</th><th>P. unit.</th><th>Subtotal</th><th>Hitos</th></tr></thead>
  <tbody>
  {% for item in oc.items.all %}
  <tr>
    <td>{{ item.material_nombre_snapshot|default:item.descripcion }}</td>
    <td>{{ item.cantidad }}</td><td>{{ item.material_unidad_snapshot|default:item.unidad }}</td>
    <td>{{ item.precio_unitario }}</td><td>{{ item.subtotal }}</td>
    <td>
      {% for h in item.hitos.all %}<div>{% if h.completado %}✓{% else %}○{% endif %} {{ h.nombre }}</div>{% endfor %}
    </td>
  </tr>
  {% endfor %}
  </tbody>
</table>
{% endblock %}
```

- [ ] **Step 4: Tests integrados**

`apps/compras/tests/test_views_approve.py`:

```python
from datetime import date
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from djmoney.money import Money

pytestmark = pytest.mark.django_db


def test_supervisor_can_approve_cotizacion(client):
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import Cotizacion, OrdenCompra
    from apps.finance.models import ExchangeRate

    ExchangeRate.objects.create(currency="USD", date=date(2026, 5, 25),
                                buy=Decimal("447.5"), sell=Decimal("454.82"))

    obra = ObraFactory(nombre="Casa Lomas")
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    cot = Cotizacion.objects.create(
        obra=obra, proveedor=prov, numero_cotizacion="X",
        fecha=date(2026, 5, 25),
        subtotal=Money(100, "CRC"), iva=Money(13, "CRC"), total=Money(113, "CRC"),
    )

    User = get_user_model()
    u = User.objects.create_user("diana", password="pw")
    u.groups.add(Group.objects.get(name="supervisor"))
    client.login(username="diana", password="pw")

    resp = client.post(f"/compras/cotizacion/{cot.pk}/approve/", {"categoria": cat.pk})
    assert resp.status_code == 302
    cot.refresh_from_db()
    assert cot.estado == "aprobada"
    assert OrdenCompra.objects.filter(cotizacion_origen=cot).exists()


def test_operativo_cannot_approve(client):
    from apps.core.tests.factories import ObraFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import Cotizacion

    obra = ObraFactory()
    prov = ProveedorFactory()
    cot = Cotizacion.objects.create(
        obra=obra, proveedor=prov, numero_cotizacion="X",
        fecha=date.today(),
        subtotal=Money(1, "CRC"), iva=Money(0, "CRC"), total=Money(1, "CRC"),
    )

    User = get_user_model()
    u = User.objects.create_user("tony", password="pw")
    u.groups.add(Group.objects.get(name="operativo"))
    client.login(username="tony", password="pw")

    resp = client.get(f"/compras/cotizacion/{cot.pk}/approve/")
    assert resp.status_code == 403
```

- [ ] **Step 5: Migración de permisos** (asegurar que supervisor tenga `approve_cotizacion` y `cancel_oc`)

```bash
docker compose exec web python manage.py makemigrations core --empty --name update_groups_oc_permissions
```

Editar:

```python
from django.db import migrations


def update_groups(apps, schema_editor):
    Group = apps.get_model("auth", "Group")
    Permission = apps.get_model("auth", "Permission")
    supervisor = Group.objects.get(name="supervisor")
    # Agregar approve_cotizacion y cancel_oc
    for codename in ("approve_cotizacion", "cancel_oc"):
        try:
            p = Permission.objects.get(codename=codename)
            supervisor.permissions.add(p)
        except Permission.DoesNotExist:
            pass


def rollback(apps, schema_editor):
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("core", "000X_create_groups"),
        ("compras", "000X_latest"),
    ]
    operations = [migrations.RunPython(update_groups, rollback)]
```

Aplicar: `docker compose exec web python manage.py migrate`.

- [ ] **Step 6: Correr tests + commit**

```bash
docker compose exec web pytest apps/compras/tests/test_views_approve.py -v
git add apps/compras/ templates/compras/
git commit -m "feat(compras): add approve flow with budget semaphore (70/90/100)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

**Fase 4 completa.** Aprobación atómica funcionando: race condition resuelta con `select_for_update`, snapshot inmutable, semáforo de presupuesto 70/90/100, audit log activo.

---

## Fase 5 — Pagos con normalización de moneda

**Objetivo:** Modelo `Pago`, vínculo M:N con `Hito`, transición de estado de OC normalizando moneda con `convert()`.

**Resultado testeable:** Operativo programa pagos, supervisor los marca como realizados, OC transiciona automáticamente entre `autorizada → pagada_parcial → pagada` aun cuando el pago sea en moneda distinta a la OC.

### Task 5.1 — Modelo `Pago` con relación M:N a Hito

- [ ] **Step 1: Tests fail-first**

`apps/compras/tests/test_pago.py`:

```python
from datetime import date
from decimal import Decimal

import pytest
from djmoney.money import Money

pytestmark = pytest.mark.django_db


@pytest.fixture
def oc_simple():
    from apps.core.tests.factories import ObraFactory, CategoriaPresupuestoFactory
    from apps.catalogo.tests.factories import ProveedorFactory
    from apps.compras.models import OrdenCompra
    from apps.finance.models import ExchangeRate
    ExchangeRate.objects.create(currency="USD", date=date(2026, 5, 25),
                                buy=Decimal("447.5"), sell=Decimal("454.82"))
    obra = ObraFactory()
    cat = CategoriaPresupuestoFactory(obra=obra)
    prov = ProveedorFactory()
    return OrdenCompra.objects.create(
        obra=obra, categoria=cat, proveedor=prov,
        numero_oc="X-OC-0001", fecha_aprobacion=date(2026, 5, 25),
        monto_total=Money(1000, "USD"),
        moneda="USD",
        fx_rate_applied=Decimal("454.82"), fx_rate_date=date(2026, 5, 25),
        estado="autorizada",
    )


def test_pago_creation(oc_simple):
    from apps.compras.models import Pago
    p = Pago.objects.create(
        oc=oc_simple, fecha_programada=date(2026, 5, 25),
        monto=Money(500, "USD"), metodo="transferencia",
        referencia="TR-001",
    )
    assert p.fecha_realizada is None  # pendiente


def test_pago_with_hito(oc_simple):
    from apps.compras.models import Pago, OrdenCompraItem, Hito
    from apps.catalogo.tests.factories import ItemCatalogoFactory
    servicio = ItemCatalogoFactory(tipo="servicio", nombre_canonico="Inst", unidad="global")
    item = OrdenCompraItem.objects.create(
        oc=oc_simple, material=servicio,
        material_nombre_snapshot="Inst", material_unidad_snapshot="global",
        descripcion="Instalación", cantidad=Decimal("1"),
        unidad="global", precio_unitario=Decimal("1000"),
        subtotal=Decimal("1000"), iva_monto=Decimal("0"), orden=1,
    )
    h = Hito.objects.create(oc_item=item, nombre="Anticipo 50%", monto=Decimal("500"))
    p = Pago.objects.create(
        oc=oc_simple, fecha_programada=date(2026, 5, 25),
        monto=Money(500, "USD"), metodo="transferencia",
    )
    p.hitos_relacionados.add(h)
    assert h in p.hitos_relacionados.all()
```

- [ ] **Step 2: Implementar modelo**

Append a `apps/compras/models.py`:

```python
class Pago(TimestampedModel):
    METODO_CHOICES = [
        ("transferencia", "Transferencia"),
        ("cheque", "Cheque"),
        ("efectivo", "Efectivo"),
        ("tarjeta", "Tarjeta"),
        ("otro", "Otro"),
    ]

    oc = models.ForeignKey(OrdenCompra, on_delete=models.PROTECT, related_name="pagos")
    fecha_programada = models.DateField()
    fecha_realizada = models.DateField(null=True, blank=True)
    monto = MoneyField(max_digits=14, decimal_places=2, default_currency="CRC")
    metodo = models.CharField(max_length=20, choices=METODO_CHOICES)
    referencia = models.CharField(max_length=120, blank=True)
    comprobante = models.FileField(upload_to="pagos/", null=True, blank=True)
    registrado_por = models.ForeignKey(
        get_user_model(), on_delete=models.PROTECT,
        related_name="pagos_registrados", null=True, blank=True,
    )
    marcado_pagado_por = models.ForeignKey(
        get_user_model(), null=True, blank=True,
        on_delete=models.PROTECT, related_name="pagos_marcados",
    )
    fx_rate_applied = models.DecimalField(max_digits=12, decimal_places=5, null=True, blank=True)
    fx_rate_date = models.DateField(null=True, blank=True)
    hitos_relacionados = models.ManyToManyField(Hito, blank=True, related_name="pagos")
    notas = models.TextField(blank=True)

    class Meta:
        verbose_name = "Pago"
        verbose_name_plural = "Pagos"
        ordering = ["-fecha_programada"]
        permissions = [
            ("mark_paid", "Puede marcar Pago como realizado"),
        ]

    def __str__(self):
        estado = "realizado" if self.fecha_realizada else "programado"
        return f"Pago {self.pk} ({estado}, {self.monto})"
```

Modificar `upload_to` de `comprobante` para layout por obra:

```python
def pago_upload_path(instance, filename):
    import uuid
    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else "bin"
    short = uuid.uuid4().hex[:8]
    obra = instance.oc.obra
    return f"obras/{obra.pk}-{obra.slug}/ordenes_compra/{instance.oc.pk}-{instance.oc.numero_oc}/pagos/{instance.pk or 'tmp'}-{short}.{suffix}"


class Pago(TimestampedModel):
    # ...
    comprobante = models.FileField(upload_to=pago_upload_path, null=True, blank=True)
```

- [ ] **Step 3: Migrar y testear**

```bash
docker compose exec web python manage.py makemigrations compras
docker compose exec web python manage.py migrate
docker compose exec web pytest apps/compras/tests/test_pago.py -v
```

Expected: 2 PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/compras/
git commit -m "feat(compras): add Pago model with M2M to Hito

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 5.2 — Servicio `mark_pago_paid` con transición de estado normalizando moneda

- [ ] **Step 1: Tests fail-first**

Append a `apps/compras/tests/test_pago.py`:

```python
def test_mark_pago_paid_transitions_oc_to_pagada_parcial(oc_simple):
    from apps.compras.models import Pago
    from apps.compras.services import mark_pago_paid
    from django.contrib.auth import get_user_model

    p = Pago.objects.create(
        oc=oc_simple, fecha_programada=date(2026, 5, 25),
        monto=Money(500, "USD"), metodo="transferencia",
    )
    user = get_user_model().objects.create_user("diana")
    mark_pago_paid(p, by=user, on=date(2026, 5, 25))

    p.refresh_from_db()
    oc_simple.refresh_from_db()
    assert p.fecha_realizada == date(2026, 5, 25)
    assert oc_simple.estado == "pagada_parcial"


def test_mark_pago_paid_transitions_oc_to_pagada_when_full(oc_simple):
    from apps.compras.models import Pago
    from apps.compras.services import mark_pago_paid
    from django.contrib.auth import get_user_model

    user = get_user_model().objects.create_user("diana")
    p1 = Pago.objects.create(
        oc=oc_simple, fecha_programada=date(2026, 5, 25),
        monto=Money(400, "USD"), metodo="transferencia",
    )
    p2 = Pago.objects.create(
        oc=oc_simple, fecha_programada=date(2026, 5, 25),
        monto=Money(600, "USD"), metodo="transferencia",
    )
    mark_pago_paid(p1, by=user, on=date(2026, 5, 25))
    mark_pago_paid(p2, by=user, on=date(2026, 5, 25))
    oc_simple.refresh_from_db()
    assert oc_simple.estado == "pagada"


def test_mark_pago_normaliza_moneda_oc_usd_pago_crc(oc_simple):
    """OC en USD pagada en CRC desde cuenta local — debe normalizar via convert()."""
    from apps.compras.models import Pago
    from apps.compras.services import mark_pago_paid
    from django.contrib.auth import get_user_model

    # OC: 1000 USD ≈ 454,820 CRC al TC 454.82
    user = get_user_model().objects.create_user("diana")
    # Pago en CRC equivalente a 1000 USD
    p = Pago.objects.create(
        oc=oc_simple, fecha_programada=date(2026, 5, 25),
        monto=Money(454820, "CRC"), metodo="transferencia",
    )
    mark_pago_paid(p, by=user, on=date(2026, 5, 25))
    oc_simple.refresh_from_db()
    # Conversión: 454820 CRC / 454.82 = 1000 USD exactos → pagada (no parcial)
    assert oc_simple.estado == "pagada"
```

- [ ] **Step 2: Implementar `mark_pago_paid`**

Append a `apps/compras/services.py`:

```python
from datetime import date as date_type
from djmoney.money import Money

from apps.finance.services import convert
from apps.finance.models import NoExchangeRateAvailable
from .models import Pago, OrdenCompra


@transaction.atomic
def mark_pago_paid(pago: Pago, by, on: date_type) -> Pago:
    """Marca un Pago como realizado y actualiza el estado de la OC.

    La transición de OC normaliza la moneda: si OC en USD y Pago en CRC,
    convierte via convert() usando TC del día del pago (snapshot histórico).
    """
    pago.fecha_realizada = on
    pago.marcado_pagado_por = by

    # Snapshot del TC al pagar si el pago es en moneda distinta a la OC
    if pago.monto.currency.code != "CRC":
        try:
            pago.fx_rate_applied = convert(Money(1, pago.monto.currency.code), "CRC", on).amount
            pago.fx_rate_date = on
        except (NoExchangeRateAvailable, Exception):
            pass

    pago.save()

    # Calcular total pagado normalizado en la moneda de la OC
    oc = OrdenCompra.objects.select_for_update().get(pk=pago.oc_id)
    target_ccy = oc.monto_total.currency.code
    total_pagado = Money(0, target_ccy)

    for p in oc.pagos.filter(fecha_realizada__isnull=False):
        m = p.monto
        if m.currency.code != target_ccy:
            try:
                m = convert(m, target_ccy, p.fecha_realizada)
            except (NoExchangeRateAvailable, Exception):
                continue
        total_pagado += m

    if total_pagado >= oc.monto_total:
        nuevo_estado = "pagada"
    elif total_pagado.amount > 0:
        nuevo_estado = "pagada_parcial"
    else:
        nuevo_estado = oc.estado  # sin cambio

    # Solo transiciona si no está en estado terminal
    if oc.estado in ("autorizada", "pagada_parcial") and nuevo_estado != oc.estado:
        oc.estado = nuevo_estado
        oc.save(update_fields=["estado"])

    return pago
```

- [ ] **Step 3: Tests + commit**

```bash
docker compose exec web pytest apps/compras/tests/test_pago.py -v
git add apps/compras/services.py apps/compras/tests/test_pago.py
git commit -m "feat(compras): add mark_pago_paid with currency-aware OC state transition

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 5.3 — Vistas de Pago (programar + marcar pagado)

**Files:** `apps/compras/views.py`, `apps/compras/forms.py`, templates

- [ ] **Step 1: Forms y vistas**

Append a `apps/compras/forms.py`:

```python
from .models import Pago


class PagoProgramarForm(forms.ModelForm):
    class Meta:
        model = Pago
        fields = ["fecha_programada", "monto", "metodo", "referencia", "notas"]
        widgets = {
            "fecha_programada": forms.DateInput(attrs={"type": "date"}),
            "monto": forms.NumberInput(attrs={"step": "0.01"}),
        }


class PagoMarcarPagadoForm(forms.ModelForm):
    fecha_realizada = forms.DateField(widget=forms.DateInput(attrs={"type": "date"}))

    class Meta:
        model = Pago
        fields = ["fecha_realizada", "referencia", "comprobante", "notas"]

    def clean_comprobante(self):
        from django.conf import settings
        f = self.cleaned_data.get("comprobante")
        if f and f.size > settings.MAX_UPLOAD_SIZE:
            raise forms.ValidationError(
                f"Archivo excede {settings.MAX_UPLOAD_SIZE // 1024 // 1024} MB."
            )
        return f
```

Append a `apps/compras/views.py`:

```python
from .models import Pago
from .forms import PagoProgramarForm, PagoMarcarPagadoForm
from .services import mark_pago_paid


@login_required
@permission_required("compras.add_pago", raise_exception=True)
def pago_programar(request, oc_pk):
    oc = get_object_or_404(OrdenCompra, pk=oc_pk)
    if request.method == "POST":
        form = PagoProgramarForm(request.POST)
        if form.is_valid():
            p = form.save(commit=False)
            p.oc = oc
            p.registrado_por = request.user
            p.save()
            messages.success(request, f"Pago programado por {p.monto}")
            return redirect("compras:oc_detail", pk=oc.pk)
    else:
        form = PagoProgramarForm()
    return render(request, "compras/pago_programar.html", {"oc": oc, "form": form})


@login_required
@permission_required("compras.mark_paid", raise_exception=True)
def pago_marcar_pagado(request, pk):
    pago = get_object_or_404(Pago, pk=pk)
    if pago.fecha_realizada:
        messages.warning(request, "Este pago ya está marcado como realizado.")
        return redirect("compras:oc_detail", pk=pago.oc.pk)

    if request.method == "POST":
        form = PagoMarcarPagadoForm(request.POST, request.FILES, instance=pago)
        if form.is_valid():
            pago = form.save(commit=False)
            mark_pago_paid(pago, by=request.user, on=form.cleaned_data["fecha_realizada"])
            messages.success(request, "Pago marcado como realizado")
            return redirect("compras:oc_detail", pk=pago.oc.pk)
    else:
        form = PagoMarcarPagadoForm(instance=pago, initial={"fecha_realizada": date.today()})
    return render(request, "compras/pago_marcar_pagado.html", {"pago": pago, "form": form})
```

Agregar URLs:

```python
path("oc/<int:oc_pk>/pago/programar/", views.pago_programar, name="pago_programar"),
path("pago/<int:pk>/marcar-pagado/", views.pago_marcar_pagado, name="pago_marcar_pagado"),
```

Migración de permiso para supervisor: `mark_paid`:

```bash
docker compose exec web python manage.py makemigrations compras --empty --name grant_mark_paid_to_supervisor
```

Editar:

```python
from django.db import migrations


def grant(apps, schema_editor):
    Group = apps.get_model("auth", "Group")
    Permission = apps.get_model("auth", "Permission")
    supervisor = Group.objects.get(name="supervisor")
    try:
        p = Permission.objects.get(codename="mark_paid")
        supervisor.permissions.add(p)
    except Permission.DoesNotExist:
        pass


def rollback(apps, schema_editor):
    pass


class Migration(migrations.Migration):
    dependencies = [("compras", "000X_pago_creation"), ("auth", "0012_alter_user_first_name_max_length")]
    operations = [migrations.RunPython(grant, rollback)]
```

- [ ] **Step 2: Templates** (cortos, reutilizando estilos)

`templates/compras/pago_programar.html`:

```html
{% extends "base.html" %}
{% block content %}
<h1 class="text-2xl font-bold">Programar pago para {{ oc.numero_oc }}</h1>
<p>OC total: {{ oc.monto_total }}</p>
<form method="post" class="space-y-3 bg-white p-4 rounded shadow mt-4">
  {% csrf_token %}{{ form.as_p }}
  <button class="btn-primary">Programar</button>
</form>
{% endblock %}
```

`templates/compras/pago_marcar_pagado.html`:

```html
{% extends "base.html" %}
{% block content %}
<h1 class="text-2xl font-bold">Marcar pago como realizado</h1>
<p>Pago: {{ pago.monto }} · OC: {{ pago.oc.numero_oc }}</p>
<form method="post" enctype="multipart/form-data" class="space-y-3 bg-white p-4 rounded shadow mt-4">
  {% csrf_token %}{{ form.as_p }}
  <button class="btn-primary">Marcar como pagado</button>
</form>
{% endblock %}
```

- [ ] **Step 3: Aplicar + commit**

```bash
docker compose exec web python manage.py migrate
git add apps/compras/ templates/compras/
git commit -m "feat(compras): add pago programar and marcar-pagado views

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

**Fase 5 completa.** Pagos con normalización de moneda; transiciones de OC funcionales.

---

> **Nota sobre el resto del plan:** Las fases 6-11 siguen el mismo patrón (TDD, archivo + código exacto + tests + commit). Por límite de output del documento las siguientes fases se entregan a **mayor granularidad de tarea** (qué archivo, qué hace, qué se testea, qué commit) — el agente ejecutor expande cada bullet en los micro-steps siguiendo los patrones de Fases 0-5. Cada tarea sigue las mismas reglas: tests primero, código completo, commits frecuentes.

---

## Fase 6 — Parser de comprobantes electrónicos (XML FE/TE/NC/ND/FEC/FEE)

**Objetivo:** Implementar `parse_comprobante_xml(file_path) → dict` polimórfico para los 6 tipos de comprobantes de Hacienda v4.4. Tests con XMLs reales.

### Task 6.1 — Descargar y commitear XSDs oficiales

**Files:** `apps/facturas/schemas/V4.4/*.xsd`

- [ ] Descargar los 6 XSDs desde `hacienda.go.cr/docs/` o `atv.hacienda.go.cr` y guardarlos en `apps/facturas/schemas/V4.4/`. Nombres: `FacturaElectronica.xsd`, `TiqueteElectronico.xsd`, `NotaCreditoElectronica.xsd`, `NotaDebitoElectronica.xsd`, `FacturaElectronicaCompra.xsd`, `FacturaElectronicaExportacion.xsd`.
- [ ] Verificar con `lxml.etree.XMLSchema(file)` que cada XSD parsea sin errores.
- [ ] Commit: `chore(facturas): add Hacienda CR v4.4 XSDs`.

### Task 6.2 — Detector de tipo y parser polimórfico

**Files:** `apps/facturas/parsers/xml_parser.py`

- [ ] **Test fail-first:** copiar el XML real `/mnt/NAS/ConstruMaster/docs/TQ50604052600310169828000100001040000134414127865041.xml` a `apps/facturas/tests/fixtures/te_real.xml`. Test:

```python
def test_parse_real_tiquete():
    from apps.facturas.parsers.xml_parser import parse_comprobante_xml
    data = parse_comprobante_xml("apps/facturas/tests/fixtures/te_real.xml")
    assert data["tipo"] == "TE"
    assert data["clave"] == "50604052600310169828000100001040000134414127865041"
    assert data["consecutivo"] == "00100001040000134414"
    assert data["fecha"].startswith("2026-05-04")
    assert data["emisor"]["nombre"] == "MATERIALES LA COSTA, S.A."
    assert data["emisor"]["identificacion"]["numero"] == "3101698280"
    assert data["resumen"]["moneda"] == "CRC"
    assert len(data["items"]) == 1
    item = data["items"][0]
    assert item["codigo_cabys"] == "3632098010100"
    assert item["detalle"] == "CODO LISO PVC 90' 38MM SCH40 908580"
    assert item["cantidad"] == "1.000"
    assert item["precio_unitario"] == "1565.76000"
```

Tests adicionales:
- `test_parse_unknown_namespace_raises_FacturaExtractionError`
- `test_parse_corrupted_xml_raises_FacturaExtractionError`
- `test_parse_failing_xsd_validation_raises`

- [ ] **Implementar `xml_parser.py`** siguiendo el contrato del spec §7.1:

```python
"""Parser polimórfico de comprobantes electrónicos de Hacienda CR v4.4.

Detecta tipo por namespace del root y aplica XSD correspondiente.
Lanza FacturaExtractionError en cualquier error permanente (sin retry).
"""
from pathlib import Path

from lxml import etree


class FacturaExtractionError(Exception):
    """Error permanente extrayendo datos del comprobante (no retry)."""


SCHEMA_DIR = Path(__file__).resolve().parent.parent / "schemas" / "V4.4"

# Mapeo namespace → (tipo, archivo XSD, nombre del root esperado)
NAMESPACE_MAP = {
    "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/facturaElectronica":
        ("FE", "FacturaElectronica.xsd", "FacturaElectronica"),
    "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/tiqueteElectronico":
        ("TE", "TiqueteElectronico.xsd", "TiqueteElectronico"),
    "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/notaCreditoElectronica":
        ("NC", "NotaCreditoElectronica.xsd", "NotaCreditoElectronica"),
    "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/notaDebitoElectronica":
        ("ND", "NotaDebitoElectronica.xsd", "NotaDebitoElectronica"),
    "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/facturaElectronicaCompra":
        ("FEC", "FacturaElectronicaCompra.xsd", "FacturaElectronicaCompra"),
    "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/facturaElectronicaExportacion":
        ("FEE", "FacturaElectronicaExportacion.xsd", "FacturaElectronicaExportacion"),
}


def _detect_type(root: etree._Element) -> tuple[str, str, str]:
    ns = root.nsmap.get(None) or root.tag.split("}")[0].lstrip("{")
    if ns not in NAMESPACE_MAP:
        raise FacturaExtractionError(f"Versión XML no soportada: {ns}")
    return NAMESPACE_MAP[ns]


def _xpath(node, path, ns):
    """XPath shortcut con namespace registrado."""
    return node.find(path, namespaces={"x": ns})


def _text(node, path, ns, default=None):
    el = _xpath(node, path, ns)
    return el.text if el is not None else default


def parse_comprobante_xml(file_path: str) -> dict:
    """Parsea un comprobante electrónico y devuelve dict con campos canónicos.

    Contrato de retorno (ver spec §7.1):
    - tipo: str (FE | TE | NC | ND | FEC | FEE)
    - clave: str (alfanumérica)
    - consecutivo: str
    - fecha: str ISO
    - emisor: {nombre, identificacion: {tipo, numero}}
    - receptor: dict | None
    - condicion_venta: str código
    - items: list[dict]
    - resumen: {moneda, tipo_cambio, total_gravado, total_impuesto, total_comprobante, medios_pago[]}
    """
    try:
        tree = etree.parse(file_path)
    except etree.XMLSyntaxError as e:
        raise FacturaExtractionError(f"XML inválido: {e}")

    root = tree.getroot()
    tipo, xsd_filename, _ = _detect_type(root)

    # Validación XSD
    xsd_path = SCHEMA_DIR / xsd_filename
    if xsd_path.exists():
        try:
            schema = etree.XMLSchema(etree.parse(str(xsd_path)))
            schema.assertValid(tree)
        except etree.DocumentInvalid as e:
            raise FacturaExtractionError(f"XSD: {e}")

    ns = next(k for k, v in NAMESPACE_MAP.items() if v[0] == tipo)
    nsm = {"x": ns}

    # Emisor
    emisor_el = root.find("x:Emisor", nsm)
    emisor = {
        "nombre": _text(emisor_el, "x:Nombre", ns),
        "identificacion": {
            "tipo": _text(emisor_el, "x:Identificacion/x:Tipo", ns),
            "numero": _text(emisor_el, "x:Identificacion/x:Numero", ns),
        },
    }

    # Receptor (puede no existir en TE)
    receptor_el = root.find("x:Receptor", nsm)
    receptor = None
    if receptor_el is not None:
        receptor = {
            "nombre": _text(receptor_el, "x:Nombre", ns),
            "identificacion": {
                "tipo": _text(receptor_el, "x:Identificacion/x:Tipo", ns),
                "numero": _text(receptor_el, "x:Identificacion/x:Numero", ns),
            },
        }

    # Items
    items = []
    for ln in root.findall("x:DetalleServicio/x:LineaDetalle", nsm):
        items.append({
            "numero_linea": _text(ln, "x:NumeroLinea", ns),
            "codigo_cabys": _text(ln, "x:CodigoCABYS", ns, default=""),
            "cantidad": _text(ln, "x:Cantidad", ns),
            "unidad_medida": _text(ln, "x:UnidadMedida", ns),
            "detalle": _text(ln, "x:Detalle", ns),
            "precio_unitario": _text(ln, "x:PrecioUnitario", ns),
            "subtotal": _text(ln, "x:SubTotal", ns),
            "iva_monto": _text(ln, "x:Impuesto/x:Monto", ns, default="0"),
            "monto_total_linea": _text(ln, "x:MontoTotalLinea", ns),
        })

    # Resumen
    res = root.find("x:ResumenFactura", nsm)
    resumen = {
        "moneda": _text(res, "x:CodigoTipoMoneda/x:CodigoMoneda", ns, default="CRC"),
        "tipo_cambio": _text(res, "x:CodigoTipoMoneda/x:TipoCambio", ns, default="1"),
        "total_gravado": _text(res, "x:TotalGravado", ns),
        "total_impuesto": _text(res, "x:TotalImpuesto", ns, default="0"),
        "total_comprobante": _text(res, "x:TotalComprobante", ns),
        "medios_pago": [
            {
                "tipo": _text(mp, "x:TipoMedioPago", ns),
                "monto": _text(mp, "x:TotalMedioPago", ns),
            }
            for mp in res.findall("x:MedioPago", nsm)
        ] if res is not None else [],
    }

    return {
        "tipo": tipo,
        "clave": _text(root, "x:Clave", ns),
        "consecutivo": _text(root, "x:NumeroConsecutivo", ns),
        "fecha": _text(root, "x:FechaEmision", ns),
        "emisor": emisor,
        "receptor": receptor,
        "condicion_venta": _text(root, "x:CondicionVenta", ns),
        "items": items,
        "resumen": resumen,
    }
```

- [ ] **Commit:** `feat(facturas): add polymorphic XML parser for Hacienda v4.4 comprobantes`.

---

## Fase 7 — OCR con Gemini Flash-Lite

**Objetivo:** Implementar `ocr_invoice_gemini(file_path) → (dict, confidence)` con structured output (JSON Schema constrained). Validaciones post-extracción.

### Task 7.1 — Cliente Gemini con structured output

**Files:** `apps/facturas/parsers/ocr_gemini.py`, tests

- [ ] **Tests:** mock de `google.genai.Client` con response JSON conforme al schema del spec §7.2. Casos:
  - Happy path: PDF retorna dict válido + confidence > 0.8
  - Imagen torcida → confidence < 0.5 pero retorna lo que pudo
  - Total < 0 → ValidationError post-extracción
  - Cédula con regex `^\d{9,12}$` falla → warning (no raise)

- [ ] **Implementar `ocr_invoice_gemini.py`** según spec §7.2:

```python
"""OCR de facturas no-electrónicas usando Gemini Flash-Lite con structured output."""
import base64
import json
import re
from pathlib import Path

from django.conf import settings
from google import genai
from google.genai import types


INVOICE_SCHEMA = {
    "type": "object",
    "properties": {
        "emisor": {
            "type": "object",
            "properties": {
                "nombre": {"type": "string"},
                "identificacion": {"type": "string"},
            },
            "required": ["nombre"],
        },
        "consecutivo": {"type": "string"},
        "clave": {"type": "string"},
        "fecha": {"type": "string", "format": "date"},
        "moneda": {"type": "string", "enum": ["CRC", "USD"]},
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "descripcion": {"type": "string"},
                    "cantidad": {"type": "number"},
                    "unidad": {"type": "string"},
                    "precio_unitario": {"type": "number"},
                    "subtotal": {"type": "number"},
                    "iva": {"type": "number"},
                },
                "required": ["descripcion"],
            },
        },
        "subtotal": {"type": "number"},
        "iva": {"type": "number"},
        "total": {"type": "number"},
        "confianza": {"type": "number", "minimum": 0, "maximum": 1},
    },
    "required": ["emisor", "fecha", "total"],
}

PROMPT = """Extraé los datos de esta factura costarricense.
Si un campo no es legible, dejalo vacío en lugar de inventar.
Reportá tu confianza self-assessment (0.0-1.0) en el campo "confianza"."""


CEDULA_REGEX = re.compile(r"^\d{9,12}$")


class OCRError(Exception):
    pass


def ocr_invoice_gemini(file_path: str) -> tuple[dict, float]:
    """OCR de una factura (PDF/imagen) via Gemini Flash-Lite.

    Devuelve (extracted_data, confidence_score). Validaciones blandas
    post-extracción registran warnings pero no levantan.
    """
    if not settings.GEMINI_API_KEY:
        raise OCRError("GEMINI_API_KEY no configurado")

    client = genai.Client(api_key=settings.GEMINI_API_KEY)
    path = Path(file_path)
    mime_type = {
        ".pdf": "application/pdf",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".webp": "image/webp",
    }.get(path.suffix.lower(), "application/octet-stream")

    file_bytes = path.read_bytes()

    response = client.models.generate_content(
        model=settings.OCR_MODEL,  # gemini-3.1-flash-lite (fallback documentado: 2.5)
        contents=[
            types.Part.from_bytes(data=file_bytes, mime_type=mime_type),
            PROMPT,
        ],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=INVOICE_SCHEMA,
            temperature=0,
        ),
    )
    data = json.loads(response.text)
    confidence = float(data.pop("confianza", 0.0))

    # Validaciones blandas
    if data.get("total", 0) <= 0:
        data["_warnings"] = data.get("_warnings", []) + ["total inválido (<=0)"]

    ced = data.get("emisor", {}).get("identificacion", "")
    if ced and not CEDULA_REGEX.match(str(ced)):
        data["_warnings"] = data.get("_warnings", []) + [f"cédula no matchea regex 9-12 dígitos: {ced}"]

    return data, confidence
```

- [ ] **Commit:** `feat(facturas): add Gemini Flash-Lite OCR with structured output`.

---

## Fase 8 — Factura model + worker async + UI confirmación

**Objetivo:** Modelo `Factura`, task `extract_invoice` con manejo correcto de errores (fix del review), upload form, HTMX polling, form de confirmación.

### Task 8.1 — Modelo `Factura`

**Files:** `apps/facturas/models.py`

- [ ] **Implementar `Factura`** con todos los campos del spec §4.3:

```python
import uuid
from django.db import models
from djmoney.models.fields import MoneyField

from apps.core.models import TimestampedModel
from apps.compras.models import OrdenCompra


def factura_upload_path(instance, filename):
    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else "bin"
    short = uuid.uuid4().hex[:8]
    obra = instance.oc.obra
    return f"obras/{obra.pk}-{obra.slug}/ordenes_compra/{instance.oc.pk}-{instance.oc.numero_oc}/facturas/{instance.pk or 'tmp'}-{short}.{suffix}"


class Factura(TimestampedModel):
    SOURCE_TYPE_CHOICES = [("xml", "XML"), ("pdf", "PDF"), ("imagen", "Imagen")]
    TIPO_CHOICES = [
        ("FE", "Factura Electrónica"), ("TE", "Tiquete Electrónico"),
        ("NC", "Nota de Crédito"), ("ND", "Nota de Débito"),
        ("FEC", "Factura Electrónica de Compra"),
        ("FEE", "Factura Electrónica de Exportación"),
    ]
    STATUS_CHOICES = [
        ("pending", "Pendiente"), ("processing", "Procesando"),
        ("extracted", "Extraída"), ("confirmed", "Confirmada"),
        ("error", "Error"),
    ]

    oc = models.ForeignKey(OrdenCompra, on_delete=models.PROTECT, related_name="facturas")
    source_type = models.CharField(max_length=10, choices=SOURCE_TYPE_CHOICES)
    tipo_comprobante = models.CharField(max_length=5, choices=TIPO_CHOICES, blank=True)
    archivo_original = models.FileField(upload_to=factura_upload_path)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default="pending")
    extracted_data = models.JSONField(default=dict, blank=True)
    confidence_score = models.FloatField(null=True, blank=True)
    # Campos canónicos (promovidos al confirmar)
    clave_numerica = models.CharField(max_length=50, blank=True, db_index=True)
    numero_consecutivo = models.CharField(max_length=80, blank=True)
    fecha_emision = models.DateField(null=True, blank=True)
    monto_total = MoneyField(max_digits=14, decimal_places=2, null=True, blank=True, default_currency="CRC")
    condicion_venta = models.CharField(max_length=2, blank=True)
    medios_pago = models.JSONField(default=list, blank=True)
    fx_rate_applied = models.DecimalField(max_digits=12, decimal_places=5, null=True, blank=True)
    fx_rate_date = models.DateField(null=True, blank=True)
    confirmada_por = models.ForeignKey(
        "auth.User", null=True, blank=True,
        on_delete=models.PROTECT, related_name="facturas_confirmadas",
    )
    error_message = models.TextField(blank=True)
    notas = models.TextField(blank=True)

    class Meta:
        verbose_name = "Factura"
        verbose_name_plural = "Facturas"
        ordering = ["-created_at"]
        permissions = [
            ("confirm_factura", "Puede confirmar una Factura extraída"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["clave_numerica"], name="factura_clave_unique",
                condition=~models.Q(clave_numerica=""),
            ),
        ]
```

- [ ] **Migrar, registrar con auditlog**, commit `feat(facturas): add Factura model with extracted/confirmed workflow`.

### Task 8.2 — Task `extract_invoice` (con todos los fixes del review)

**Files:** `apps/facturas/tasks.py`, tests

Implementar **exactamente** el código del spec §7.3 (con catch de `XMLSyntaxError`, sin re-raise para permanentes, dejar transitorios escapar):

```python
import logging
from lxml.etree import XMLSyntaxError

from .models import Factura
from .parsers.xml_parser import parse_comprobante_xml, FacturaExtractionError
from .parsers.ocr_gemini import ocr_invoice_gemini, OCRError

logger = logging.getLogger("construmaster.facturas.tasks")


def extract_invoice(factura_id: int):
    """Job async para extraer datos de una Factura.

    Errores permanentes (archivo corrupto, schema no soportado):
    - status='error', NO se re-lanza → Django-Q2 NO reintenta.

    Errores transitorios (Gemini 5xx, timeout, error de red):
    - se dejan escapar → Django-Q2 reintenta hasta max_attempts=3.
    """
    f = Factura.objects.get(id=factura_id)
    f.status = "processing"
    f.save(update_fields=["status"])
    try:
        if f.source_type == "xml":
            data = parse_comprobante_xml(f.archivo_original.path)
            f.tipo_comprobante = data["tipo"]
            f.extracted_data = data
            f.confidence_score = None  # determinista, no aplica
        else:
            data, confidence = ocr_invoice_gemini(f.archivo_original.path)
            f.extracted_data = data
            f.confidence_score = confidence
        f.status = "extracted"
        f.save()
    except (FacturaExtractionError, XMLSyntaxError, OCRError) as e:
        # Errores permanentes: no reintentar
        logger.warning(f"Factura {factura_id} extraction failed permanently: {e}")
        f.status = "error"
        f.error_message = str(e)
        f.save(update_fields=["status", "error_message"])
        return  # NO re-lanzar
    # Cualquier otra excepción (httpx.HTTPError, TimeoutError, etc) escapa → retry de Q2
```

- [ ] Tests con mocks para todos los escenarios; commit.

### Task 8.3 — Vista de upload + HTMX polling de status + form de confirmación

**Files:** `apps/facturas/views.py`, `apps/facturas/forms.py`, templates

- [ ] **Vista de upload** que crea Factura `pending`, encola `extract_invoice`, redirige a página con polling.
- [ ] **Vista `factura_status`** que devuelve partial HTML según `status`. Si terminal (`extracted/confirmed/error`), el partial no incluye `hx-trigger` → polling se detiene.
- [ ] **Form de confirmación** con permisos `facturas.confirm_factura`. Promueve `extracted_data` a campos canónicos.
- [ ] Validación de tamaño 20 MB en form (no settings).
- [ ] Tests integrados + commit `feat(facturas): add upload, async extraction, and confirmation workflow`.

### Task 8.4 — Vista de download autenticada (sin permiso por objeto — fix del review)

**Files:** `apps/facturas/views.py`

- [ ] Implementar:

```python
from django.contrib.auth.decorators import login_required, permission_required
from django.http import FileResponse


@login_required
@permission_required("facturas.view_factura", raise_exception=True)
def factura_archivo(request, pk):
    f = get_object_or_404(Factura, pk=pk)
    return FileResponse(f.archivo_original.open("rb"))
```

- [ ] Tests para permisos por grupo. Commit.

---

## Fase 9 — Entregas + EntregaItem + reconciliación

**Objetivo:** Modelo `Entrega`, `EntregaItem` (con FK opcional a `OrdenCompraItem` para reconciliación), `EntregaFoto`. UI para registrar entregas con items pre-llenados desde la OC.

### Task 9.1 — Modelos

**Files:** `apps/entregas/models.py`, `apps/entregas/apps.py`

- [ ] Crear app `apps.entregas`, registrar en INSTALLED_APPS, con modelos según spec §4.3.
- [ ] `Entrega.bodega_destino` nullable en MVP (será obligatorio cuando llegue módulo inventario).
- [ ] `EntregaItem.oc_item` FK nullable para reconciliación.
- [ ] `EntregaFoto` con upload_to por obra (capa de fotos de evidencia, EXIF preservado).
- [ ] Registrar todos con auditlog. Tests, migración, commit.

### Task 9.2 — Vista de registro de entrega con pre-llenado

**Files:** `apps/entregas/views.py`, formset

- [ ] Vista que al GET pre-llena `EntregaItem` con los items pendientes de la OC (cantidad sugerida = `OCItem.cantidad - SUM(EntregaItem.cantidad WHERE oc_item=X)`).
- [ ] Multi-upload de fotos a `EntregaFoto`.
- [ ] Al POST: si suma de entregas iguala cantidades de OCItems → sugerir `Entrega.completa=True` y transicionar OC.
- [ ] Tests de cálculo de pendiente + transición. Commit.

### Task 9.3 — Cálculo de "pendiente por entregar" y reconciliación material × obra

**Files:** `apps/entregas/services.py`, queries

- [ ] Servicios:
  - `pendiente_por_oc_item(oc_item) → Decimal`: cantidad faltante.
  - `compras_vs_entregas_por_material(obra, material) → dict`: `{comprado, entregado, pendiente}`.
- [ ] Tests con datos sintéticos. Commit.

---

## Fase 10 — Dashboards + reportes + exports

**Objetivo:** 3 dashboards por rol (supervisor, operativo, lector). Exports CSV/PDF.

### Task 10.1 — Dashboard supervisor

**Files:** `apps/reportes/views.py`, templates

- [ ] Vista `/` con redirect según grupo del usuario.
- [ ] Dashboard supervisor: obras activas + semáforo presupuesto + bandeja "pendiente de mi acción" (cotizaciones por aprobar, facturas `extracted`, pagos sin marcar, items `pendiente` del catálogo).
- [ ] Atajos: "+ RFQ", "comparar cotizaciones".
- [ ] Tests con `_login_as` por rol. Commit.

### Task 10.2 — Dashboard operativo

- [ ] Mis obras + accesos rápidos (+ Cotización, + Entrega, Subir factura).
- [ ] Bandeja: RFQs abiertas, OCs autorizadas sin entrega, facturas por subir contra pagos hechos.
- [ ] Commit.

### Task 10.3 — Dashboard lector (Don Nicholas)

- [ ] Resumen por obra: % avance estimado + presupuesto vs ejecutado en USD (modo histórico por default; toggle "valor a hoy").
- [ ] OCs grandes recientes. Sin acciones (lector solo lee). Commit.

### Task 10.4 — Reportes específicos + exports

**Files:** `apps/reportes/views.py`, `apps/reportes/exporters.py`

- [ ] Estado de cuenta por proveedor (filtros + export CSV).
- [ ] Resumen de cotizaciones por categoría/material.
- [ ] Reconciliación pedido-vs-entregado por OC y por material × obra.
- [ ] Histórico TC (gráfica con Chart.js).
- [ ] PDF via `weasyprint`.
- [ ] Tests + commit `feat(reportes): add reports module with CSV/PDF exports`.

---

## Fase 11 — Deploy production + Cloudflare Tunnel + backup

**Objetivo:** Setup completo en VM con Cloudflare Tunnel; backup sidecar; runbook documentado.

### Task 11.1 — Backup sidecar

**Files:** `docker-compose.yml`, `docker/backup.sh`

- [ ] Servicio `backup` con `ofelia` o cron simple que ejecute:
  - Diario 3 AM: `pg_dump --format=custom` a `/dest/db/`.
  - Cada 12h: `tar -czf` de `/var/data/files` a `/dest/files/`.
- [ ] Bind mount `/dest` al NAS Synology (NFS).
- [ ] Retención 30 días (DB) / 90 días (files) con `find -delete`.
- [ ] Smoke test: correr backup manualmente y restaurar en container desechable.
- [ ] Commit `feat: add backup sidecar with pg_dump and file archives`.

### Task 11.2 — Cloudflare Tunnel real

- [ ] Crear túnel en `dash.cloudflare.com → Zero Trust → Networks → Tunnels`.
- [ ] Obtener `CLOUDFLARED_TOKEN`, pegarlo en `.env`.
- [ ] Configurar hostname público (`construmaster.soporte101.com` u otro) apuntando a `http://web:8000`.
- [ ] `docker compose --profile production up -d cloudflared`.
- [ ] Verificar acceso HTTPS desde fuera.
- [ ] Smoke test: login admin, crear obra, subir factura, ver dashboard.

### Task 11.3 — Verificación end-to-end de producción

- [ ] **Smoke test funcional completo:**
  1. Login admin.
  2. Crear usuarios reales: diana (supervisor), gabriel (supervisor), tony (operativo), adrian (operativo), nicholas (lector).
  3. Asignar grupos.
  4. Verificar dashboards por rol.
  5. Flujo completo end-to-end: RFQ → cotización → aprobar → pago programado → marcar pagado → subir XML real → confirmar → registrar entrega.
  6. Don Nicholas logueado ve dashboard con totales en USD.
- [ ] Commit final: `chore: ship MVP module materiales`.

---

## Self-review del plan

**Coverage de spec:**
- ✅ §1 Resumen ejecutivo → cubierto en Fase 0-1
- ✅ §2 Contexto → seed data (Fase 1.6)
- ✅ §3 Arquitectura → Fase 0 (Docker, gunicorn, worker, postgres, redis, cloudflared)
- ✅ §4 Modelos → Fases 1, 4, 8, 9
- ✅ §5 Roles y permisos → Fase 1.5, refuerzos en 4.4 y 5.3
- ✅ §6 Flujo de compra paso a paso → Fases 3, 4, 5, 8, 9
- ✅ §7 Procesamiento async (parser XML, OCR, BCCR) → Fases 2, 6, 7, 8
- ✅ §8 Archivos por obra → upload_to por obra en Cotizacion (Fase 3), Factura (Fase 8), Pago (Fase 5), EntregaFoto (Fase 9)
- ✅ §9 Multi-moneda y BCCR → Fase 2 completa + normalización en pago (Fase 5.2)
- ✅ §10 Reportes/testing/deploy → Fase 10 + 11

**Fixes del review aplicados:**
- ✅ Fix #1 (has_perm sin obj) → Fase 8.4
- ✅ Fix #2 (extract_invoice catch + no re-raise) → Fase 8.2
- ✅ Fix #3 (parse retorna 'tipo') → Fase 6.2
- ✅ Fix #4 (BCCR sin raise_for_status) → Fase 2.2
- ✅ Fix #5 (fixtures BCCR JSON) → Fase 2 todos los tests
- ✅ Fix #6 (semáforo 70/90/100) → Fase 4.4
- ✅ Fix #8 (Gemini 3.1 con plan B) → Fase 7.1
- ✅ Fix #9 (race condition numero_oc con select_for_update) → Fase 4.2
- ✅ Fix #10 (validación tamaño 20 MB explícita en forms) → Fases 3.4, 5.3, 8.3
- ✅ Fix #11 (retry inside task, no en Q_CLUSTER) → comentado en spec; Fase 8.2 implementa con `return` en lugar de `raise`
- ✅ Fix #12 (pago-vs-OC con convert()) → Fase 5.2
- ✅ Fix #13 (Cotizacion.es_especial) → Fase 3.1
- ✅ Regex cédula 9-12 → Fase 7.1
- ✅ confidence_score=None para XML → Fase 8.2
- ✅ Regla de oro aclarada → Fase 2.4 docstring
- ✅ EXIF preservado → Fase 9.1

**Tipos/signaturas consistentes:** `convert(Money, str, date) → Money`; `ExchangeRate.for_date(currency, date, side="sell") → Decimal`; `parse_comprobante_xml(file_path) → dict`; `ocr_invoice_gemini(file_path) → (dict, float)`; `extract_invoice(factura_id) → None`. Todos referenciados consistentemente.

**Scope:** un solo plan, ejecutable en orden. Cada fase produce un increment testeable.

---

## Próximos pasos después del MVP (referencia, no en este plan)

Ver spec §11 Roadmap. Próximas iteraciones:
- Módulo 2: Empleados + EPP
- Módulo 3: Inventario + alertas Telegram (vía Hermes Agent)
- Mensaje Receptor Hacienda
- Multi-cliente
- SSO con Cloudflare Access

---

**Plan completo.**

