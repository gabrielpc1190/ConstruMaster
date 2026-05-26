# ConstruMaster — Handoff entre sesiones

**Última actualización:** 2026-05-25 (sesión 1, antes del primer subagente)
**Modo de trabajo:** Subagent-Driven Development (skill `superpowers:subagent-driven-development`)

---

## Cómo retomar después de cerrar Claude Code

### 1. Acción previa (solo si todavía no la hiciste)

```bash
sudo usermod -aG docker gabriel
```

Después cerrar Claude Code completamente y abrir uno nuevo en `/mnt/NAS/`.

### 2. Verificación rápida al iniciar la nueva sesión

```bash
docker ps                    # debe funcionar SIN sudo
docker compose version       # debe mostrar v2.x
groups | grep docker         # debe contener "docker"
```

Si las tres pasan, el setup quedó OK y se puede proceder.

### 3. Prompt sugerido para retomar

> Estamos trabajando en ConstruMaster. Lee `/mnt/NAS/ConstruMaster/docs/HANDOFF.md`, verificá que docker funciona sin sudo, y retomá ejecución del plan en Subagent-Driven Development desde la Task **0.1**. Sin pausar entre tareas; sólo parar en blockers reales o tareas completas.

---

## Estado del proyecto

### Documentos clave

| Documento | Path | Estado |
|---|---|---|
| Spec de diseño | [`docs/superpowers/specs/2026-05-25-construmaster-modulo-materiales-design.md`](superpowers/specs/2026-05-25-construmaster-modulo-materiales-design.md) | Aprobado, 14 fixes del review externo aplicados |
| Plan de implementación | [`docs/superpowers/plans/2026-05-25-construmaster-modulo-materiales.md`](superpowers/plans/2026-05-25-construmaster-modulo-materiales.md) | Completo, 50 tareas en 12 fases |
| Análisis externo del spec | [`docs/superpowers/specs/Analisis-Spec-20260525-1545.md`](superpowers/specs/Analisis-Spec-20260525-1545.md) | Aplicado |
| Estándar BCCR | [`docs/Estándar para la Comunicación con el Sistema de Divulgación de Datos Económicos (SDDE).pdf`](Estándar%20para%20la%20Comunicación%20con%20el%20Sistema%20de%20Divulgación%20de%20Datos%20Económicos%20(SDDE).pdf) | Referencia oficial BCCR |
| XML real de prueba | [`docs/TQ50604052600310169828000100001040000134414127865041.xml`](TQ50604052600310169828000100001040000134414127865041.xml) | Tiquete Electrónico de Materiales La Costa |
| `.env` (secretos) | [`/mnt/NAS/ConstruMaster/.env`](/mnt/NAS/ConstruMaster/.env) | `chmod 600`, gitignored, con `GEMINI_API_KEY` y `BCCR_TOKEN` validados |

### Memorias de Claude relevantes

Índice en `/home/gabriel/.claude/projects/-home-gabriel/memory/MEMORY.md`. Las más útiles para este proyecto:

- `reference_bccr_api.md` — endpoint REST nuevo, smoke test, gotchas
- `reference_fe_hacienda_cr.md` — schema v4.4, 6 tipos de comprobantes, no hay librería Python
- `feedback_documentation_language.md`, `feedback_autonomy_level.md`, `feedback_git_convention.md` — preferencias del usuario

### Validaciones realizadas

- ✅ Token Gemini: 50 modelos disponibles. Modelo elegido: `gemini-3.1-flash-lite` (preview pero usable; plan B documentado: `gemini-2.5-flash-lite` stable).
- ✅ Token BCCR: HTTP 200 contra endpoint de series; TC venta 2026-05-23 = ₡455.75 confirmado.
- ⚠️ `POST /Usuario/ValideSuscripcion` del BCCR devuelve HTTP 500 (parece bug del BCCR). Smoke test usa el endpoint de series real.

---

## Plan de ejecución

**50 tareas en 12 fases.** Cada fase produce un increment testeable. Subagent-Driven Development: subagente fresco por tarea + dos reviews (spec compliance, code quality) + commit.

| Fase | Tareas | Producto |
|---|---|---|
| 0 — Bootstrap | 6 | Docker, Django esqueleto, login admin funcional |
| 1 — Core models | 9 | Cliente/Obra/Categoría/Presupuesto/Bodega/Proveedor/ItemCatalogo + grupos + audit + seed |
| 2 — Multi-moneda + BCCR | 7 | ExchangeRate + cliente httpx + `convert()` + template tag + jobs |
| 3 — RFQ + Cotizaciones | 4 | Modelos + UI HTMX + autocomplete + comparativa |
| 4 — OC + Hitos + semáforo | 4 | OrdenCompra atómica con race-fix + presupuesto 70/90/100 |
| 5 — Pagos | 3 | Pago + normalización de moneda con `convert()` |
| 6 — Parser comprobantes | 2 | XSDs commiteados + parser polimórfico 6 tipos |
| 7 — OCR Gemini | 1 | `ocr_invoice_gemini` con structured output |
| 8 — Facturas + async | 4 | Modelo Factura + worker + HTMX polling + confirmación |
| 9 — Entregas | 3 | Entrega + reconciliación pedido-vs-entregado |
| 10 — Dashboards + reportes | 4 | 3 dashboards por rol + exports CSV/PDF |
| 11 — Deploy production | 3 | Backup sidecar + Cloudflare Tunnel + smoke E2E |

**Estado actual:** Task 0.1 lista para arrancar. Ningún código escrito todavía.

---

## Decisiones clave (no olvidar)

### Stack final

Python 3.13, Django 5.2 LTS, Django-Q2 1.10, django-htmx 1.27, django-money 3.6, django-auditlog, HTMX 2.0.9, Tailwind v4 (django-tailwind-cli), gunicorn 23, whitenoise, lxml, httpx, google-genai, Postgres 16, Redis 7, Docker Compose, Cloudflare Tunnel.

**Sin:** Caddy/nginx (cloudflared → gunicorn directo), Celery, allauth, django-guardian.

### Reglas de implementación

- **TDD estricto** — tests primero, fallar, implementar, pasar, commit.
- **Idioma:** código/identifiers/commits en inglés. Docstrings y templates en español.
- **Commits:** Conventional Commits + `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. Push directo a `main` para repos personales.
- **Storage abstracción:** `STORAGES` setting → switch a S3 con env vars, sin tocar modelos.
- **Layout archivos por obra:** `/var/data/files/obras/<id>-<slug>/(cotizaciones|ordenes_compra/<oc_id>/(facturas|pagos|entregas))/...`.

### Decisiones del review externo aplicadas (14 fixes)

Documentadas en spec con explicación inline. Los más críticos para ejecución:

1. `has_perm` SIN obj (django-guardian no está en MVP) — Fase 8.4.
2. `extract_invoice` atrapa `XMLSyntaxError`, NO re-lanza para permanentes → así Django-Q2 no reintenta — Fase 8.2.
3. `parse_comprobante_xml` retorna dict con key `'tipo'` (entre otros) — Fase 6.2.
4. Cliente BCCR sin `raise_for_status()` (necesitamos leer cuerpo de error) — Fase 2.2.
5. Fixtures BCCR son **JSON**, no XML — Fase 2.
6. Semáforo presupuesto unificado: **70/90/100** (verde/amarillo/naranja/rojo) — Fase 4.4.
7. Race condition `numero_oc`: `select_for_update()` sobre Obra + campo `next_oc_seq` — Fase 4.2.
8. Validación tamaño 20 MB **explícita** en forms (no settings) — Fases 3.4, 5.3, 8.3.
9. Retry/backoff DENTRO de tasks (no en `Q_CLUSTER`); errores permanentes con `return`, transitorios con `raise` — Fase 8.2.
10. Comparación pago-vs-OC normaliza moneda con `convert()` — Fase 5.2.
11. `Cotizacion.es_especial` agregado al modelo — Fase 3.1.
12. Regex cédula `^\d{9,12}$` (cubre DIMEX) — Fase 7.1.
13. `confidence_score=None` para XML (no 1.0) — Fase 8.2.
14. Regla de oro: prohibido **convertir** sin `convert()`; lookup directo de `ExchangeRate` para snapshots SÍ está permitido — Fase 2.4.

### Contexto del negocio (no olvidar)

- **Cliente:** Don Nicholas Charles Rowley (único cliente del MVP).
- **Ejecutor (a quien controlamos):** ADITA, dirigida por Tony y Adrián Vargas.
- **Supervisores (los usuarios principales):** Gabriel y Diana.
- **Lector:** Don Nicholas.
- **Bodegas iniciales** (cross-obra, propiedad del cliente): Cuarto Eléctrico GADI, Cuarto 4 del Bache, Bodega Baches.

---

## Blockers / cosas a saber

1. **`docker compose v5.1.4`** instalado en `/usr/local/lib/docker/cli-plugins/docker-compose` (download manual). El número `v5.1.4` parece raro — verificar `docker compose version` post-reinicio para confirmar que es la v2 de verdad. Si es v1, downgradear.

2. **Repo `/mnt/NAS/ConstruMaster/` no es git todavía.** Task 0.1 ejecuta `git init`. Aún no hay remote en GitHub — se crea cuando se haga el primer push (probablemente al final de Fase 0 o más tarde según preferencia).

3. **`gemini-3.1-flash-lite` es preview, no GA.** El usuario aceptó usarlo con fallback a `gemini-2.5-flash-lite` si aparecen fallos. Decisión registrada en spec §7.2.

4. **`ValideSuscripcion` del BCCR devuelve 500** — usar `GET /indicadoresEconomicos/318/series` con rango `[today-7d, today]` como smoke test alternativo. Documentado en plan Task 2.3.

5. **NAS en NFS:** el proyecto vive en `/mnt/NAS/ConstruMaster/` que es Synology vía NFSv4.1. Docker volumes nombrados (no bind mounts) funcionan OK. Si aparecen problemas de file locks o ownership con Postgres, considerar mover a `/var/lib/docker/volumes/` y migrar sólo los archivos finales al NAS.

---

## Convenciones del usuario (recordatorio)

- **Idioma de docs/CLAUDE.md/memorias:** español.
- **Idioma de código/commits/logs/identifiers:** inglés.
- **Git:** Conventional Commits + push directo a main para repos personales.
- **GitHub:** SSH only (`git@github.com:gabrielpc1190/...`), nunca HTTPS.
- **Autonomía:** adelante con cambios pequeños; plan/spec antes de refactors multi-archivo o cambios de infra.
- **Software nuevo:** análisis de riesgos antes de instalar herramientas con permisos amplios.
