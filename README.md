# ConstruMaster v2

Webapp interna para supervisar las obras de construcción que ADITA (Tony + Adrián Vargas) ejecuta en Costa Rica para el cliente Nicholas Charles Rowley. Gabriel y Diana son los supervisores; Don Nicholas tiene acceso de solo lectura.

Cubre el ciclo completo de compras: obras y presupuestos, catálogo de materiales/servicios, proveedores, cotizaciones (manuales o vía **OCR Gemini** sobre PDF/foto del proveedor), órdenes de compra con numeración por obra, pagos e hitos, entregas con fotos, facturas electrónicas Hacienda CR (XML v4.4) y tipo de cambio diario del BCCR.

> Para contexto técnico profundo (decisiones de diseño, deuda, modelos, workflow operativo, endpoints), ver [`CLAUDE.md`](CLAUDE.md).

## Stack

React 19 + Vite + TypeScript + Tailwind v4 / Node 22 + Express 5 + Prisma 6 / Postgres 16 / `@google/genai` (Gemini Flash-Lite) / `node-cron` (BCCR).

## Setup local

### Requisitos

- Node 22+
- Docker + Docker Compose (para Postgres)
- `openssl` (para generar secrets)

### Pasos

```bash
# 1. Variables de entorno
cp .env.example .env
# Editá .env y completá:
#   JWT_SECRET                  → openssl rand -hex 64
#   DATABASE_URL                → password = el de docker-compose.yml
#   ADMIN_BOOTSTRAP_PASSWORD    → openssl rand -base64 24 (opcional)
#   BCCR_TOKEN                  → opcional; si falta, el cron BCCR no arranca
#   GEMINI_API_KEY              → opcional; sin él el OCR de cotizaciones devuelve 422

# 2. Dependencias
npm install

# 3. Postgres
docker compose up -d postgres

# 4. Migrar schema + sembrar datos iniciales
npx prisma migrate dev
node prisma/seed.js     # Imprime las passwords de los 5 users una sola vez — guardalas

# 5. Levantar dev server (Express :3001 + Vite :8000)
./manage.sh start
```

Abrí `http://localhost:8000` y logueate con el username que prefieras del seed (`gabriel`, `diana`, `tony`, `adrian`, `nicholas`) usando la password que imprimió `prisma/seed.js`. Si perdiste la del admin:

```bash
./manage.sh reset-admin <nueva-password>
```

## `manage.sh`

| Comando | Descripción |
|---|---|
| `./manage.sh start` | Levanta Postgres (si no está) + Express + Vite en background. Logs → `dev.log`. |
| `./manage.sh stop` | Mata procesos en `:8000` y `:3001`. |
| `./manage.sh restart` | `stop` + `start`. |
| `./manage.sh status` | Estado de backend, frontend y container Postgres. |
| `./manage.sh logs` | `tail -f dev.log`. |
| `./manage.sh reset-admin <pwd>` | Upsert del user `admin` con la password dada. |

## Layout

```
ConstruMaster/
├── docker-compose.yml      # Solo Postgres
├── manage.sh
├── prisma/                 # schema.prisma (22 modelos), migrations/, seed.js
├── server/
│   ├── index.js            # App Express + arranque cron BCCR
│   ├── cron/               # bccr-daily.js (+ tests)
│   ├── middleware/         # auth (JWT), errorHandler
│   ├── lib/                # permissions, slug, uploads (XML + fotos + cotizaciones), audit (+ tests)
│   ├── services/           # oc-flow, xml-parser, bccr, exchange-rates, gemini-ocr,
│   │                       # gemini-cotizacion-ocr, pago-flow, entrega-flow, finance (+ tests)
│   ├── controllers/        # 13 controllers
│   └── routes/             # 14 routers (+ __tests__/)
├── src/
│   ├── App.tsx             # 18 rutas
│   ├── context/            # AuthContext, ThemeContext, ToastContext
│   ├── components/         # Layout, PrivateRoute, FacturaUploadForm,
│   │                       # CotizacionArchivoUpload, CotizacionOcrModal,
│   │                       # ItemCatalogoAutocomplete, oc/{Pagos,Hitos,Entregas}Section, ui/*
│   ├── pages/              # Login, Dashboard, Obras, ObraDetail, Bodegas, Proveedores,
│   │                       # Catalogo, Cotizaciones (list/form/detail), OCs, OcDetail,
│   │                       # Facturas, FacturaDetail, Pagos, Entregas, EntregaDetail,
│   │                       # TipoDeCambio, Usuarios
│   ├── hooks/              # useApi
│   ├── services/           # api.ts (fetch wrapper)
│   └── lib/                # cn, queryClient, format, badges, blob-download
├── uploads/                # facturas/, entregas/, cotizaciones/ — todos gitignored
├── package.json
└── vite.config.ts          # Proxy /api → :3001, dev en :8000
```

## Deploy a producción

El build de producción empaqueta el frontend estático dentro del mismo proceso Express: **una sola imagen, un solo puerto (`3001` interno → `127.0.0.1:8000` en el host)**. Cloudflare Tunnel apunta a `localhost:8000` igual que en dev, así que no hay que tocar la config del tunnel al cambiar entre stacks.

Stack en prod:

- `Dockerfile` multi-stage (`node:22-alpine`, `dumb-init`, runtime sin devDeps).
- `docker-compose.prod.yml` — services `postgres` (volumen separado `construmaster_v2_pgdata_prod`) + `app` (volumen `construmaster_v2_uploads`).
- App corre como user `node` (no root).

### Pasos

1. **Variables de entorno** — completar `.env`:

   ```bash
   cp .env.example .env
   # Llenar al menos:
   #   POSTGRES_PASSWORD           → openssl rand -hex 32
   #   DATABASE_URL                → usar el mismo password (host=localhost para dev; el container override apunta a host=postgres)
   #   JWT_SECRET                  → openssl rand -hex 64
   #   ALLOWED_ORIGINS             → https://construmaster.inventitec.com
   #   ADMIN_BOOTSTRAP_PASSWORD    → opcional (solo se usa en el seed)
   #   BCCR_TOKEN / GEMINI_API_KEY → según lo que se quiera habilitar
   ```

2. **Build de la imagen** (~2-3 min la primera vez, después tira de cache):

   ```bash
   ./manage.sh build-prod
   ```

3. **Levantar el stack**:

   ```bash
   ./manage.sh up-prod
   ```

4. **Primera vez** — aplicar migraciones y sembrar datos iniciales (idempotente):

   ```bash
   ./manage.sh migrate-prod
   docker compose -f docker-compose.prod.yml exec app node prisma/seed.js
   ```

   `migrate-prod` usa `prisma migrate deploy` (no `migrate dev`, que es interactivo y no aplica en containers). Para generar migraciones nuevas seguí usando `npx prisma migrate dev` en local contra el postgres de dev, commiteá la carpeta y volvé a correr `migrate-prod`.

5. **Verificar arranque**:

   ```bash
   ./manage.sh logs-prod
   # Esperar: "[server] listening on http://localhost:3001"
   curl -sf http://127.0.0.1:8000/api/health   # {"ok":true}
   ```

6. **Cloudflare Tunnel** ya en el host debe apuntar a `http://localhost:8000`. No corre dentro del compose para no duplicar config con otros servicios del NAS.

### Operación

| Comando | Descripción |
|---|---|
| `./manage.sh build-prod` | Build / rebuild de la imagen. |
| `./manage.sh up-prod` | Up detached. |
| `./manage.sh down-prod` | Stop. Volúmenes (`pgdata_prod`, `uploads`) persisten. |
| `./manage.sh logs-prod` | `logs -f --tail=200 app`. |
| `./manage.sh migrate-prod` | `prisma migrate deploy` dentro del container. |

> **Importante**: NO corras `up-prod` mientras el dev server esté arriba — ambos pelean por `127.0.0.1:8000`. Hacé `./manage.sh stop` primero.

## Tests

**Backend** (node:test nativo, sin frameworks externos):

```bash
# Suite completa
node --test server/**/__tests__/*.test.js

# Subsets
node --test server/routes/__tests__/*.test.js
node --test server/services/__tests__/*.test.js
```

Al 2026-05-28: **241/243** pasan (2 fallos conocidos en filtros de list de `entregas` y `facturas`). Cobertura: `oc-flow` (numeración + snapshots + FX), `xml-parser` (6 tipos de comprobante Hacienda CR), `bccr` + cron diario, `exchange-rates`, `gemini-ocr` (facturas) y `gemini-cotizacion-ocr` (cotizaciones), `pago-flow`, `entrega-flow`, `audit` helpers, `uploads` paths, y los 12 routers REST.

**Frontend**: sin runner configurado. Verificación manual en `http://localhost:8000` hasta agregar Vitest + RTL.

## Licencia

Privado — todos los derechos reservados. Uso interno Gabriel / ADITA / Inventitec.
