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
