# CLAUDE.md — ConstruMaster

Landing page de Claude Code cuando trabaja en `/mnt/NAS/ConstruMaster/`. Mantener corto — el detalle vive en `docs/superpowers/specs/`, `docs/superpowers/plans/` y `docs/HANDOFF.md`.

> **Si recién entrás a esta sesión: leé primero [`docs/HANDOFF.md`](docs/HANDOFF.md).** Tiene el estado actualizado, los blockers conocidos, y el prompt sugerido para retomar.

---

## 1. Identidad

- **Webapp Django interna** para supervisión externa de obras de construcción.
- **Diana y Gabriel** supervisan a **ADITA (Tony y Adrián Vargas)** que ejecuta obras para el cliente **Don Nicholas Charles Rowley**.
- **Estado al 2026-05-25:** spec aprobado, plan aprobado (50 tareas / 12 fases), implementación arrancando. Cero código Python escrito aún.
- **Modo de ejecución:** Subagent-Driven Development (`superpowers:subagent-driven-development`) — un subagente fresco por tarea + spec review + code-quality review + commit.
- Repo personal (futuro `git@github.com:gabrielpc1190/construmaster.git`). Branch principal: `main`. Push directo, sin PRs.

## 2. Reglas inviolables

- **TDD estricto.** Tests primero (ver fallar), implementar mínimo (ver pasar), refactor si aplica, commit. Cada tarea termina con commit.
- **Idioma:** código + identifiers + commits + logs en **inglés**. Docstrings (cuando aclaren negocio) + templates UI + docs + commits-comments en **español**.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`, `refactor:`) + línea final `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **GitHub:** SSH only. Nunca HTTPS.
- **Secretos:** todo lo sensible va en `.env` (gitignored, `chmod 600`). `.env.example` con placeholders se commitea. **Nunca pegar API keys ni tokens en código, spec, plan, ni en mensajes a usuarios.**
- **Multi-moneda:** **nadie convierte montos** sin pasar por `apps.finance.services.convert()`. Lookup directo de `ExchangeRate` para snapshots en `save()` SÍ está permitido — la regla aplica a conversiones, no a lookups.
- **`fx_rate_applied` y `fx_rate_date`** se snapshot al crear/aprobar (write-time). Si supervisor edita `fecha` después, re-disparar snapshot. **Inmutables** una vez la entidad está en estado terminal (OC autorizada, Factura confirmada).
- **Permisos en MVP:** **a nivel de modelo** (Django Groups + `has_perm('app.codename')` sin obj). `django-guardian` queda para Fase futura. Por ahora todos los `operativo` ven todas las obras.
- **Items modelados como tabla** (`CotizacionItem`, `OrdenCompraItem`, `EntregaItem`). NO `JSONField`. Reconciliación material × obra requiere identidad relacional.
- **Catálogo `ItemCatalogo` cross-obra, lazy.** No se prellena. Sólo se aprueba por supervisor. Operativos sugieren (estado `pendiente`).
- **Comparación pago-vs-OC normaliza moneda** con `convert()` (OC en USD puede pagarse en CRC).
- **`numero_oc` se genera con `select_for_update()`** sobre `Obra.next_oc_seq`. Sin esto = race conditions.
- **`extract_invoice` no re-lanza para errores permanentes** (XML corrupto, schema desconocido) — `return` directo → Django-Q2 no reintenta. Errores transitorios (Gemini 5xx, timeout) sí escapan para que Q2 reintente.
- **Validación de tamaño 20 MB explícita en forms** (`if f.size > settings.MAX_UPLOAD_SIZE`). `FILE_UPLOAD_MAX_MEMORY_SIZE` NO es tope; es umbral memoria/disco.

## 3. Stack final

- **Backend:** Python 3.13, Django 5.2 LTS, Django-Q2 1.10 (worker async).
- **Frontend:** HTMX 2.0.9 + `django-htmx` 1.27 + Tailwind v4 (vía `django-tailwind-cli`).
- **Datos:** Postgres 16, `django-money` 3.6, `django-auditlog`.
- **Procesamiento:** `lxml` (parser FE Hacienda v4.4), `httpx` (cliente BCCR + Gemini), `google-genai` (OCR Gemini Flash-Lite).
- **Servidor:** `gunicorn` 23 + `whitenoise`. **Sin Caddy/nginx** — `cloudflared` → `gunicorn` directo.
- **Infra:** Docker Compose, Cloudflare Tunnel. VM Linux local → futuro VPS.
- **Tests:** `pytest` + `pytest-django` + `pytest-httpx` + `factory_boy` + `freezegun`.

**Descartados (no agregar):** Celery (overkill), allauth (sin social/2FA en MVP), django-guardian (no per-objeto), Caddy/nginx (cloudflared suficiente).

## 4. Mapa del repo (futuro, conforme se construye)

| Carpeta | Qué tiene / tendrá |
|---|---|
| `apps/core/` | Modelos `Cliente`, `Obra`, `CategoriaPresupuesto`, `Presupuesto`, `Bodega` + grupos auth + seed (Fase 1) |
| `apps/catalogo/` | `Proveedor`, `ItemCatalogo` cross-obra lazy + autocomplete views (Fase 1+3) |
| `apps/finance/` | `ExchangeRate`, cliente BCCR REST, `convert()`, template tag `money_display`, jobs cron (Fase 2) |
| `apps/compras/` | `SolicitudCotizacion`, `Cotizacion`, `OrdenCompra`, `OrdenCompraItem`, `Hito`, `Pago` + flow aprobación atómica (Fases 3-5) |
| `apps/facturas/` | `Factura` + parser polimórfico XML v4.4 + OCR Gemini + task async `extract_invoice` + XSDs en `schemas/V4.4/` (Fases 6-8) |
| `apps/entregas/` | `Entrega`, `EntregaItem`, `EntregaFoto` + reconciliación pedido-vs-entregado (Fase 9) |
| `apps/reportes/` | Dashboards por rol + exports CSV/PDF (Fase 10) |
| `construmaster/` | Django project (settings, urls, wsgi, asgi) |
| `docker/` | Entrypoints `web.entrypoint.sh`, `worker.entrypoint.sh`, `backup.sh` |
| `templates/` | Base + parciales HTMX |
| `static/css/` | `input.css` para Tailwind v4 (compilado a `tailwind.css`) |
| `docs/` | Esta documentación |
| `Dockerfile`, `docker-compose.yml`, `pyproject.toml`, `manage.py` | Raíz |

## 5. Documentos clave

| Doc | Para qué |
|---|---|
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | **Leer al retomar.** Estado actual + cómo retomar + blockers + prompt sugerido |
| [`docs/superpowers/specs/2026-05-25-construmaster-modulo-materiales-design.md`](docs/superpowers/specs/2026-05-25-construmaster-modulo-materiales-design.md) | Spec completo (12 secciones + roadmap). Fuente de verdad del diseño |
| [`docs/superpowers/plans/2026-05-25-construmaster-modulo-materiales.md`](docs/superpowers/plans/2026-05-25-construmaster-modulo-materiales.md) | Plan de ejecución TDD (50 tareas en 12 fases) |
| [`docs/superpowers/specs/Analisis-Spec-20260525-1545.md`](docs/superpowers/specs/Analisis-Spec-20260525-1545.md) | Review externo del spec con 13 hallazgos. Todos aplicados al spec |
| [`docs/Estándar para la Comunicación con el Sistema de Divulgación de Datos Económicos (SDDE).pdf`](docs/Estándar%20para%20la%20Comunicación%20con%20el%20Sistema%20de%20Divulgación%20de%20Datos%20Económicos%20(SDDE).pdf) | API REST oficial del BCCR |
| [`docs/TQ50604052600310169828000100001040000134414127865041.xml`](docs/TQ50604052600310169828000100001040000134414127865041.xml) | Tiquete Electrónico real (Materiales La Costa) — fixture para tests del parser |

## 6. Comandos comunes

```bash
# Levantar todo
docker compose up -d

# Logs en vivo
docker compose logs -f web
docker compose logs -f worker

# Migrar
docker compose exec web python manage.py migrate

# Tests (toda la suite o por path)
docker compose exec web pytest
docker compose exec web pytest apps/finance/tests/ -v

# Crear superuser
docker compose exec web python manage.py createsuperuser

# Validar tokens
docker compose exec web python manage.py verify_bccr_token

# Backfill BCCR histórico
docker compose exec web python manage.py backfill_bccr_rates --desde 2026-01-01

# Seed data inicial (Cliente Nicholas + 3 bodegas)
docker compose exec web python manage.py seed_initial_data

# Production con Cloudflare Tunnel
docker compose --profile production up -d
```

## 7. Recursos externos críticos

- **BCCR SDDE API:** `https://apim.bccr.fi.cr/SDDE/api/Bccr.GE.SDDE.Publico.Indicadores.API/...`. Auth `Authorization: Bearer <token>`. Códigos relevantes: **317** (TC compra) y **318** (TC venta). Default para conversiones = **venta** (cumple Hacienda). Smoke test: `GET /indicadoresEconomicos/318/series?fechaInicio=...&fechaFin=...&idioma=es`. Ver memoria `reference_bccr_api`.
- **Gemini API:** `gemini-3.1-flash-lite` (preview con fallback documentado a `gemini-2.5-flash-lite` stable). `OCR_MODEL` en settings, cambiable sin migración.
- **FE Hacienda v4.4:** 6 tipos de comprobantes (FE / TE / NC / ND / FEC / FEE), cada uno con XSD propio en `apps/facturas/schemas/V4.4/`. Detección por namespace del root. Ver memoria `reference_fe_hacienda_cr`.

## 8. Gotchas a no olvidar

1. **`docker compose` v2** instalado en `/usr/local/lib/docker/cli-plugins/docker-compose` (download manual; el repo de Debian 12 no trae `docker-compose-plugin`). Sin esto los comandos `docker compose ...` no funcionan.
2. **Mi usuario `gabriel` debe estar en el grupo `docker`** (`sudo usermod -aG docker gabriel` + reiniciar sesión). Sin esto todo Docker requiere `sudo`.
3. **NFS para volúmenes Docker:** el proyecto vive en `/mnt/NAS/` que es Synology NFSv4.1. **Usar volúmenes nombrados** (`pgdata`, `mediadata`, etc), NO bind mounts a paths del NAS. Si aparecen problemas de locks/ownership con Postgres, mover el volumen a `/var/lib/docker/volumes/` local y rsync solo los archivos finales al NAS.
4. **Backups separados del volumen:** `pg_dump --format=custom` diario a `/mnt/NAS/backups/construmaster/` vía sidecar. Si el volumen Postgres se corrompe, el dump te salva.
5. **Múltiples comprobantes electrónicos:** no es solo FE. Hay TE (tiquetes, sin cédula del receptor), NC (notas crédito), ND (notas débito), FEC, FEE. Parser polimórfico detecta por namespace.
6. **`ValideSuscripcion` del BCCR devuelve HTTP 500** — bug del lado del BCCR. Usar `GET /indicadoresEconomicos/318/series` con rango de 7 días como smoke test del token.
7. **`MontoTotalLinea` del XML de Hacienda INCLUYE IVA.** `SubTotal` es pre-IVA. Al modelar `CotizacionItem.subtotal` usar el pre-IVA y guardar el IVA separado.
8. **Clave numérica del comprobante es alfanumérica** en v4.4 (antes era integer). `CharField(max_length=50)`, NO `IntegerField`.
9. **Precio unitario con 5 decimales** en el XML (`Decimal(max_digits=14, decimal_places=5)`). Cantidad 4 decimales. Totales 2 decimales. Multiplicación se redondea con `quantize(Decimal("0.01"), ROUND_HALF_UP)`.
10. **EXIF preservado** en fotos de entrega (la geolocalización es evidencia útil de que el material llegó a la obra). NO usar EXIF stripping por default.
11. **`gemini-3.1-flash-lite` no dice "Stable"** en su metadata de Google (a diferencia de 2.5). Decisión consciente del usuario: aceptamos el riesgo de preview con plan de contingencia documentado.
12. **`pyheif` requiere `libheif-dev`** en el sistema. Está en el Dockerfile pero si se desarrolla fuera de Docker, instalar manualmente.

## 9. Convenciones del usuario (del CLAUDE.md raíz del NAS)

- **Autonomía:** cambios pequeños sin pedir; plan/spec antes de refactors multi-archivo, archivos nuevos importantes, o cambios de infra/producción.
- **Software nuevo:** evaluación de riesgos antes de instalar herramientas con permisos amplios.
- **Memorias en `/home/gabriel/.claude/projects/-home-gabriel/memory/`** se cargan auto en cualquier sesión bajo `/mnt/NAS/`. Las claves para este proyecto: `project_construmaster.md` (índice), `reference_bccr_api.md`, `reference_fe_hacienda_cr.md`.
