# ConstruMaster v2 — CLAUDE.md

Webapp interna para supervisión de obras de construcción. v2 es un rewrite full-stack JS arrancado el 2026-05-27 sobre el stack de [Propiedades360](../Propiedades360/), reemplazando al MVP Django archivado en [`../ConstruMaster-django-old/`](../ConstruMaster-django-old/) (NO TOCAR).

## Negocio (no olvidar)

- **Cliente** (único en MVP): Nicholas Charles Rowley.
- **Ejecutor** (a quien controlamos): ADITA — Tony Vargas + Adrián Vargas.
- **Supervisores**: Gabriel (admin) + Diana (supervisor).
- **Lector**: Don Nicholas.
- **Bodegas iniciales** (cross-obra, sembradas): `Cuarto Eléctrico GADI`, `Cuarto 4 del Bache`, `Bodega Baches`.

## Stack

- **Frontend**: React 19 + Vite 7 + TypeScript 5.9 + Tailwind v4 + react-router-dom v7 + @tanstack/react-query v5 + lucide-react + zod.
- **Backend**: Node 22 + Express 5 + Prisma 6 + JWT + bcryptjs + multer + helmet + cors + express-rate-limit.
- **DB**: Postgres 16 (container `construmaster_v2_postgres`, volumen `construmaster_v2_pgdata`, puerto 5432).
- **Otros**: `fast-xml-parser` (parsing facturas Hacienda CR v4.4), `@google/genai` (Gemini OCR, sin UI todavía).
- **Dev**: Vite en `:8000`, Express en `:3001`, Vite proxy `/api` → `3001`.
- **Producción**: Cloudflare Tunnel → `construmaster.inventitec.com` → `localhost:8000` (Vite preview / dev — no hay build de prod aún).

## Estructura

```
ConstruMaster/
├── docker-compose.yml         # Solo Postgres
├── manage.sh                  # start/stop/restart/status/logs/reset-admin
├── prisma/
│   ├── schema.prisma          # 22 modelos, money = (amount Decimal + currency enum)
│   ├── seed.js                # Users + cliente Nicholas + bodegas + materiales semilla
│   └── migrations/            # init_v2 + factura_clave_unique_partial
├── server/
│   ├── index.js               # App Express + monkey-patch BigInt.toJSON
│   ├── db.js
│   ├── middleware/            # auth.js (JWT), errorHandler.js
│   ├── lib/                   # permissions.js, slug.js, uploads.js (multer)
│   ├── services/              # oc-flow.js, xml-parser.js, bccr.js, gemini-ocr.js (+ tests)
│   ├── controllers/           # 8 controllers (auth, obras, bodegas, proveedores, items-catalogo, cotizaciones, ocs, facturas)
│   ├── routes/                # 8 routers + __tests__/ (node --test)
│   └── schemas/               # (vacío; placeholder para zod schemas)
├── src/
│   ├── App.tsx                # BrowserRouter + providers
│   ├── main.tsx, index.css
│   ├── context/               # AuthContext, ThemeContext, ToastContext
│   ├── components/            # Layout, PrivateRoute, FacturaUploadForm, ItemCatalogoAutocomplete, ui/*
│   ├── pages/                 # Login, Dashboard, Obras, ObraDetail, Cotizaciones
│   ├── hooks/                 # useApi
│   ├── services/              # api.ts (fetch wrapper)
│   ├── lib/                   # cn, queryClient, format, badges
│   └── types/                 # compras.ts
└── uploads/facturas/          # XMLs subidos (gitignored)
```

## Workflow del usuario (operativo diario)

1. **Operativo** (Tony/Adrián) crea **Cotización** dentro de una obra, con items (material/servicio del catálogo o ad-hoc) y proveedor. Estado inicial: `recibida`.
2. **Supervisor** (Diana/Gabriel) revisa la cotización y la **aprueba** o **rechaza**.
3. Al aprobar → `oc-flow.approveCotizacion` crea una **OrdenCompra** con `numeroOc = ${SLUG_OBRA}-OC-NNNN` (correlativo por obra), snapshot de items y de TC si la moneda es USD.
4. Los **Pagos** se programan contra la OC y, opcionalmente, vinculan **Hitos** (entregables intermedios).
5. **Entregas** se registran cuando llega material a una bodega (modelo listo, UI pendiente).
6. **Facturas XML** Hacienda CR v4.4 (FE/TE/NC/ND/FEC/FEE) se suben a una OC, se parsean inline y quedan en estado `extracted`; el supervisor las **confirma** o **anula**.

## Roles

| Rol | Quién | Permisos |
|---|---|---|
| `admin` | gabriel | Todo + DELETE de obras/categorías/bodegas. |
| `supervisor` | diana | Aprueba cotizaciones, crea/edita OCs, confirma facturas. Lee todo. |
| `operativo` | tony, adrian | Crea cotizaciones, items, proveedores; sube facturas; registra entregas. |
| `lector` | nicholas | Read-only. |

Helpers en `server/lib/permissions.js`: `WRITE_ROLES = [admin, supervisor]`, `CATALOG_WRITE = [admin, supervisor, operativo]`, `ALL_AUTH_ROLES`.

## Comandos comunes

| Comando | Qué hace |
|---|---|
| `./manage.sh start` | Levanta Postgres (si no está) + `npm run dev` (Express + Vite). |
| `./manage.sh stop` / `restart` / `status` / `logs` | Operativos sobre el dev server. |
| `./manage.sh reset-admin <pwd>` | Upsert del user `admin` con la password dada. |
| `node prisma/seed.js` | Re-siembra users + cliente + bodegas + materiales (idempotente; passwords sólo se imprimen al crear). |
| `npx prisma migrate dev --name <X>` | Nueva migración. |
| `npx prisma studio` | GUI a la DB. |
| `node --test server/services/__tests__/*.js server/routes/__tests__/*.js` | Tests backend (node:test nativo). |

## Reglas / convenciones

- **Idioma**: UI/docs/comentarios en español. Código/identifiers/commits en inglés.
- **Money**: dos columnas `xxxAmount Decimal(15,2)` + `xxxCurrency` (enum `Currency: CRC|USD`). API recibe/devuelve `{amount: "12345.67", currency: "CRC"}`.
- **IDs**: `BigInt` en Prisma (= `bigserial`). `server/index.js` monkey-patchea `BigInt.prototype.toJSON` para serializar como `Number` (válido para ids < 2^53).
- **Numeración OC**: `${SLUG_OBRA.toUpperCase()}-OC-NNNN`, contador `obra.next_oc_seq`. Generación dentro de transacción con `pg_advisory_xact_lock(obraId)` para serializar solo writes de esa obra.
- **Snapshots OC**: `OrdenCompraItem` guarda `materialNombreSnapshot` + `materialUnidadSnapshot` del catálogo al momento de la aprobación. Si el `ItemCatalogo` se renombra después, la OC histórica preserva el nombre original.
- **FX snapshot**: al aprobar OC con `moneda != CRC`, se busca el último `ExchangeRate` `currency='USD'` con `date <= fechaAprobacion` y se guarda `sell` en `fxRateApplied` + esa fecha en `fxRateDate`. Inmutable post-autorización.
- **Facturas XML**: `claveNumerica` con UNIQUE INDEX parcial (`WHERE clave_numerica IS NOT NULL`) en Postgres — ver migration `20260528053219_factura_clave_unique_partial`.
- **Auth**: JWT en header `Authorization: Bearer <token>`, login rate-limited a 8/min (skip successful).

## API endpoints (resumen)

Todos requieren `Authorization: Bearer <jwt>` salvo `/auth/login`.

| Método | Path | Roles |
|---|---|---|
| `POST` | `/api/auth/login` | público (rate-limited 8/min) |
| `GET` | `/api/auth/me` | auth |
| `POST` | `/api/auth/logout` | auth |
| `GET\|POST\|PUT\|DELETE` | `/api/obras[/:id]` | read=auth, write=WRITE_ROLES, delete=admin |
| `GET\|POST` | `/api/obras/:id/categorias` · `PUT\|DELETE /api/obras/categorias/:catId` | write=WRITE_ROLES, delete=admin |
| `GET\|POST` | `/api/obras/:id/presupuestos` · `PUT\|DELETE /api/obras/presupuestos/:pId` | WRITE_ROLES |
| `GET\|POST\|PUT\|DELETE` | `/api/bodegas[/:id]` | write=WRITE_ROLES, delete=admin (soft) |
| `GET\|POST\|PUT\|DELETE` | `/api/proveedores[/:id]` | POST=CATALOG_WRITE, PUT=WRITE_ROLES, DELETE=admin |
| `GET\|POST\|PUT\|DELETE` | `/api/items-catalogo[/:id]` · `GET /autocomplete?q=` · `POST /:id/aprobar` | POST=CATALOG_WRITE (operativo crea como `pendiente`); aprobar=WRITE_ROLES |
| `GET\|POST\|PUT /api/cotizaciones[/:id]` · `POST /:id/aprobar` · `POST /:id/rechazar` | auth (CR/UP), aprobar/rechazar=WRITE_ROLES (via controller) |
| `GET\|PUT /api/ocs[/:id]` · `POST /:id/cancelar` | auth (controllers chequean rol) |
| `GET /api/facturas[/:id]` · `GET /:id/archivo` | ALL_AUTH_ROLES |
| `POST /api/facturas/upload/:ocId` (multipart `archivo`) | CATALOG_WRITE |
| `POST /api/facturas/:id/confirmar` · `POST /:id/anular` | WRITE_ROLES |

## Decisiones de diseño que NO se ven en el código

- **Por qué dejamos Django (v1)**: MVP de 51 commits / 231 tests, pero la UX híbrida webapp + Django-admin no convenció a Gabriel. v2 rehace UI 100% React. Lógica de dominio (parsing XML, snapshots, numeración OC) se portó a Node manteniendo semántica.
- **Por qué Prisma (no Drizzle ni TypeORM)**: el proyecto de referencia Propiedades360 usa Prisma; queremos máxima reutilización de patrones/scripts y el equipo (Gabriel + Claude) ya tiene fluidez con `prisma migrate`.
- **Por qué Postgres (no SQLite)**: necesitamos `pg_advisory_xact_lock` para serializar numeración OC, índices parciales (UNIQUE WHERE NOT NULL en `claveNumerica`) y `Decimal(15,2)` confiable. SQLite no calza.
- **Por qué advisory lock (no `SERIALIZABLE`)**: el lock escopeado por `obraId` permite aprobaciones concurrentes en obras distintas sin retries. `SERIALIZABLE` global aborta transacciones bajo contención y obliga lógica de retry.
- **Por qué fast-xml-parser (no libxmljs2)**: zero-dep nativo, sin compilar bindings. Sacrifica validación XSD (anotado como TODO; aceptable mientras el volumen sea bajo).
- **Por qué inline parsing de facturas (no worker)**: volumen esperado bajo (decenas/mes). Se puede migrar a BullMQ + Redis cuando duela.

## Deuda técnica conocida (Fase 2+)

- `/api/clientes` no existe — el UI usa `clienteId=1` hardcoded (cliente Nicholas).
- `/api/users` no existe — selector de "responsable" en Bodega no tiene fuente.
- `AuditLog` modelo existe pero ningún controller lo escribe (falta middleware).
- Sin worker async — facturas se procesan inline en el request HTTP.
- Sin validación XSD del XML (limitación de `fast-xml-parser`).
- Sin reportes ni dashboards reales (placeholder en `Dashboard.tsx`).
- Entregas + reconciliación pedido-vs-entregado: modelo Prisma listo, falta UI + API.
- Pagos + Hitos: modelo listo, falta UI + API.
- OCR Gemini para facturas no-electrónicas: `server/services/gemini-ocr.js` implementado + testeado, sin endpoint UI.
- BCCR scheduler: `server/services/bccr.js` cliente + tests, sin cron job que poblé `ExchangeRate`.
- Build de producción: solo dev server. Falta multi-stage Dockerfile + serve estático con Express o nginx.
- `App.tsx` solo registra rutas para `/login` y `/` (Dashboard). Las páginas Obras/Cotizaciones/ObraDetail existen pero no están ruteadas todavía.

## Modelos Prisma (22)

Auth: `User`. Core: `Cliente`, `Obra`, `CategoriaPresupuesto`, `Presupuesto`, `Bodega`. Catálogo: `Proveedor`, `ItemCatalogo`. Finanzas: `ExchangeRate`. Compras: `SolicitudCotizacion`, `Cotizacion`, `CotizacionItem`, `OrdenCompra`, `OrdenCompraItem`, `Hito`, `Pago`, `PagoHito`. Facturas: `Factura`. Entregas: `Entrega`, `EntregaItem`, `EntregaFoto`. Auditoría: `AuditLog`.

Enums clave: `Role`, `Currency`, `ObraEstado`, `ItemTipo`, `ItemEstado`, `ItemUnidad`, `RfqEstado`, `CotizacionEstado`, `OcEstado`, `PagoMetodo`, `FacturaSourceType`, `FacturaTipo`, `FacturaStatus`, `AuditAction`, `ExchangeRateSource`.

## Cómo retomar después de cerrar Claude

1. `docker ps | grep construmaster_v2_postgres` — verificá que esté corriendo.
2. Si no: `cd /mnt/NAS/ConstruMaster && docker compose up -d postgres`.
3. `./manage.sh start` para arrancar Express + Vite (puerto 8000/3001).
4. Login en `https://construmaster.inventitec.com` (o `http://localhost:8000`) como `gabriel`. Si olvidaste la password: `./manage.sh reset-admin <new-pw>`.
5. Para ver el estado del trabajo: `git log --oneline -30` (cuando se conecte al remoto; hoy no es repo git aún) o `./manage.sh logs`.
6. Antes de tocar dominio (cotizaciones / OCs / facturas) leé los headers de `server/services/oc-flow.js` y `server/services/xml-parser.js` — explican las decisiones críticas.
