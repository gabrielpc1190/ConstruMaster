# ConstruMaster v2

Webapp interna para supervisar las obras de construcción que ADITA (Tony + Adrián Vargas) ejecuta en Costa Rica para el cliente Nicholas Charles Rowley. Gabriel y Diana son los supervisores; Don Nicholas tiene acceso de solo lectura. La app cubre obras y presupuestos, catálogo de materiales/servicios, proveedores, cotizaciones, órdenes de compra con numeración por obra, pagos, entregas y facturas electrónicas de Hacienda CR (XML v4.4).

> Para contexto técnico profundo (decisiones de diseño, deuda, modelos, workflow operativo), ver [`CLAUDE.md`](CLAUDE.md).

## Stack

React 19 + Vite + TypeScript + Tailwind v4 / Node 22 + Express 5 + Prisma 6 / Postgres 16.

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
#   BCCR_TOKEN / GEMINI_API_KEY → opcionales por ahora

# 2. Dependencias
npm install

# 3. Postgres
docker compose up -d postgres

# 4. Migrar schema + sembrar datos iniciales
npx prisma migrate dev
node prisma/seed.js     # Imprime las contraseñas de los 5 users una sola vez — guardalas

# 5. Levantar dev server (Express :3001 + Vite :8000)
./manage.sh start
```

Abrí `http://localhost:8000` y logueate con `gabriel` (o cualquier user del seed). Si perdiste la password de admin:

```bash
./manage.sh reset-admin <nueva-password>
```

## `manage.sh`

| Comando | Descripción |
|---|---|
| `./manage.sh start` | Levanta Postgres (si no está) + Express + Vite en background. Logs → `dev.log`. |
| `./manage.sh stop` | Mata procesos en `:8000` y `:3001`. |
| `./manage.sh restart` | `stop` + `start`. |
| `./manage.sh status` | Muestra estado de backend, frontend y container Postgres. |
| `./manage.sh logs` | `tail -f dev.log`. |
| `./manage.sh reset-admin <pwd>` | Upsert del user `admin` con la password dada. |

## Layout

```
ConstruMaster/
├── docker-compose.yml   # Solo Postgres
├── manage.sh
├── prisma/              # schema.prisma, migrations/, seed.js
├── server/              # Express: middleware, lib, services, controllers, routes
├── src/                 # React: context, components, pages, hooks, lib, services, types
├── uploads/             # facturas/ XMLs (gitignored)
├── package.json
└── vite.config.ts       # Proxy /api → :3001, dev en :8000
```

## Tests

**Backend** (node:test nativo, sin frameworks externos):

```bash
node --test server/services/__tests__/*.js server/routes/__tests__/*.js
```

Cobertura actual: `oc-flow` (numeración OC, snapshots, FX), `xml-parser` (6 tipos de comprobante Hacienda CR), `bccr`, `gemini-ocr`, y los 7 routers REST.

**Frontend**: sin runner configurado todavía. Verificación manual en `http://localhost:8000` hasta agregar Vitest + RTL.

## Licencia

Privado — todos los derechos reservados. Uso interno Gabriel / ADITA / Inventitec.
