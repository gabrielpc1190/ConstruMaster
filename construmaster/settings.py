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
    "django_tailwind_cli",
    "django_htmx",
    "django_q",
    "djmoney",
    "auditlog",
    # Local apps
    "apps.core",
    "apps.catalogo",
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
OCR_MODEL = env("OCR_MODEL", default="gemini-3.1-flash-lite")  # override via env; fallback stable: gemini-2.5-flash-lite
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

# Tailwind CSS v4 (vía django-tailwind-cli)
# SRC_CSS es relativo a BASE_DIR; ponerlo fuera de static/ para que whitenoise no lo procese
# NOTA: El binario standalone de Tailwind v4 requiere AVX2 (Bun-based). Esta VM QEMU no tiene
# AVX2, así que usamos TAILWIND_CLI_USE_SYSTEM_BINARY=True con @tailwindcss/cli npm instalado
# en la imagen Docker. Funcionalmente idéntico; el CLI npm es Node.js puro sin requisito de AVX.
TAILWIND_CLI_VERSION = "4.3.0"
TAILWIND_CLI_SRC_CSS = "src/css/input.css"
TAILWIND_CLI_DIST_CSS = "css/tailwind.css"
TAILWIND_CLI_USE_SYSTEM_BINARY = True
TAILWIND_CLI_SYSTEM_BINARY_NAME = "tailwindcss"
