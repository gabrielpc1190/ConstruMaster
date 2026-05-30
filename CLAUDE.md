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
- **Backend**: Node 22 + Express 5 + Prisma 6 + JWT + bcryptjs + multer + helmet + cors + express-rate-limit + node-cron.
- **DB**: Postgres 16 (container `construmaster_v2_postgres`, volumen `construmaster_v2_pgdata`, puerto 5432).
- **Integraciones externas**: `fast-xml-parser` (facturas Hacienda CR v4.4), `@google/genai` (Gemini Flash-Lite OCR para facturas no-electrónicas y para cotizaciones), BCCR REST (tipo de cambio diario).
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
│   ├── index.js               # App Express + monkey-patch BigInt.toJSON + arranque cron BCCR
│   ├── db.js
│   ├── cron/                  # bccr-daily.js (+ tests)
│   ├── middleware/            # auth.js (JWT), errorHandler.js
│   ├── lib/                   # permissions.js, slug.js, uploads.js (3 multers), audit.js (+ tests)
│   ├── services/              # oc-flow, xml-parser, bccr, exchange-rates, gemini-ocr (facturas),
│   │                          # gemini-cotizacion-ocr, pago-flow, entrega-flow, finance (+ tests)
│   ├── controllers/           # 13 controllers (auth, obras, bodegas, clientes, users, proveedores,
│   │                          # items-catalogo, cotizaciones, cotizaciones-ocr, ocs, pagos,
│   │                          # entregas, exchange-rates, audit-log, facturas)
│   ├── routes/                # 14 routers + __tests__/ (node --test)
│   └── schemas/               # (vacío; placeholder para zod schemas)
├── src/
│   ├── App.tsx                # BrowserRouter + providers — 18 rutas activas
│   ├── main.tsx, index.css
│   ├── context/               # AuthContext, ThemeContext, ToastContext
│   ├── components/            # Layout, PrivateRoute, FacturaUploadForm,
│   │                          # CotizacionArchivoUpload, CotizacionOcrModal,
│   │                          # ItemCatalogoAutocomplete, oc/{Pagos,Hitos,Entregas}Section, ui/*
│   ├── pages/                 # Login, Dashboard, Obras, ObraDetail, Bodegas, Proveedores,
│   │                          # Catalogo, Cotizaciones, CotizacionForm, CotizacionDetail,
│   │                          # OCs, OcDetail, Facturas, FacturaDetail, Pagos, Entregas,
│   │                          # EntregaDetail, TipoDeCambio, Usuarios
│   ├── hooks/                 # useApi
│   ├── services/              # api.ts (fetch wrapper)
│   ├── lib/                   # cn, queryClient, format, badges, blob-download
│   └── types/                 # compras.ts
└── uploads/
    ├── facturas/<año>/<mes>/<ocId>/        # XMLs Hacienda
    ├── entregas/<año>/<mes>/<entregaId>/   # Fotos (jpeg/png/heif/webp)
    └── cotizaciones/<año>/<mes>/<cotId>/   # PDF/imagen de evidencia
```

## Workflow del usuario (operativo diario)

1. **Operativo** (Tony/Adrián) crea una **Cotización** dentro de una obra. Hay dos caminos:
   - **Manual**: elige proveedor + items (catálogo o ad-hoc) y digita precios.
   - **OCR**: sube el PDF/foto del presupuesto del proveedor; Gemini extrae el JSON estructurado (proveedor, items, totales, condiciones), matchea proveedor por cédula/nombre y cada item contra `ItemCatalogo`, y pre-llena el form. Estado inicial: `recibida`.
2. Opcionalmente se adjunta el PDF/foto como **archivo de evidencia** (separado del OCR — el archivo OCR vive solo en `/tmp/` durante la extracción).
3. **Supervisor** (Diana/Gabriel) revisa la cotización y la **aprueba** o **rechaza**.
4. Al aprobar → `oc-flow.approveCotizacion` crea una **OrdenCompra** con `numeroOc = ${SLUG_OBRA}-OC-NNNN` (correlativo por obra), snapshot de items y de TC si la moneda es USD.
5. Los **Pagos** se programan contra la OC y, opcionalmente, vinculan **Hitos** (entregables intermedios). Marcado de pagado/desmarcado vía `pago-flow`.
6. **Entregas** se registran cuando llega material a una bodega, con fotos como evidencia legal (bytes raw, sin recompresión, preservando EXIF). Reconciliación pedido-vs-entregado en `entrega-flow`.
7. **Facturas XML** Hacienda CR v4.4 (FE/TE/NC/ND/FEC/FEE) se suben a una OC, se parsean inline y quedan en estado `extracted`; el supervisor las **confirma** o **anula**.

## Roles

| Rol | Quién | Permisos |
|---|---|---|
| `admin` | gabriel | Todo + DELETE de obras/categorías/bodegas + gestión de Usuarios + lectura de AuditLog. |
| `supervisor` | diana | Aprueba cotizaciones, crea/edita OCs, confirma facturas, marca pagos. Lee todo. |
| `operativo` | tony, adrian | Crea cotizaciones (manual u OCR), items, proveedores; sube facturas; registra entregas. |
| `lector` | nicholas | Read-only. |

Helpers en `server/lib/permissions.js`: `WRITE_ROLES = [admin, supervisor]`, `CATALOG_WRITE = [admin, supervisor, operativo]`, `ALL_AUTH_ROLES`.

## Comandos comunes

| Comando | Qué hace |
|---|---|
| `./manage.sh start` | Levanta Postgres (si no está) + `npm run dev` (Express + Vite). |
| `./manage.sh stop` / `restart` / `status` | Operativos sobre el dev server. |
| `./manage.sh logs` | `tail -f dev.log`. |
| `./manage.sh reset-admin <pwd>` | Upsert del user `admin` con la password dada. |
| `node prisma/seed.js` | Re-siembra users + cliente + bodegas + materiales (idempotente; passwords sólo se imprimen al crear). |
| `npx prisma migrate dev --name <X>` | Nueva migración. |
| `npx prisma studio` | GUI a la DB. |
| `node --test server/**/__tests__/*.test.js` | Corre toda la suite backend (~243 tests al 2026-05-28). |
| `node --test server/routes/__tests__/*.test.js` | Solo tests de routes REST. |
| `node --test server/services/__tests__/*.test.js` | Solo tests de services (oc-flow, xml-parser, OCRs, etc.). |

## Reglas / convenciones

- **Idioma**: UI/docs/comentarios en español. Código/identifiers/commits en inglés.
- **Money**: dos columnas `xxxAmount Decimal(15,2)` + `xxxCurrency` (enum `Currency: CRC|USD`). API recibe/devuelve `{amount: "12345.67", currency: "CRC"}`.
- **IDs**: `BigInt` en Prisma (= `bigserial`). `server/index.js` monkey-patchea `BigInt.prototype.toJSON` para serializar como `Number` (válido para ids < 2^53).
- **Numeración OC**: `${SLUG_OBRA.toUpperCase()}-OC-NNNN`, contador `obra.next_oc_seq`. Generación dentro de transacción con `pg_advisory_xact_lock(obraId)` para serializar solo writes de esa obra.
- **Snapshots OC**: `OrdenCompraItem` guarda `materialNombreSnapshot` + `materialUnidadSnapshot` del catálogo al momento de la aprobación. Si el `ItemCatalogo` se renombra después, la OC histórica preserva el nombre original.
- **FX snapshot**: al aprobar OC con `moneda != CRC`, se busca el último `ExchangeRate` `currency='USD'` con `date <= fechaAprobacion` y se guarda `sell` en `fxRateApplied` + esa fecha en `fxRateDate`. Inmutable post-autorización.
- **Facturas XML**: `claveNumerica` con UNIQUE INDEX parcial (`WHERE clave_numerica IS NOT NULL`) en Postgres — ver migration `20260528053219_factura_clave_unique_partial`.
- **Auth**: JWT en header `Authorization: Bearer <token>`, login rate-limited a 8/min (skip successful).
- **Tipo de cambio**: upsert por `(date, currency, source)`. El cron BCCR NO pisa rows con `source='manual'` — el operador siempre gana sobre el feed automático.

## API endpoints (resumen)

Todos requieren `Authorization: Bearer <jwt>` salvo `/auth/login`. Routers montados en `server/index.js`.

| Método | Path | Roles |
|---|---|---|
| `POST` | `/api/auth/login` | público (rate-limited 8/min) |
| `GET` · `POST` | `/api/auth/me` · `/api/auth/logout` | auth |
| `GET\|POST\|PUT\|DELETE` | `/api/obras[/:id]` · `/categorias` · `/presupuestos` | read=auth, write=WRITE_ROLES, delete=admin |
| `GET\|POST\|PUT\|DELETE` | `/api/bodegas[/:id]` | write=WRITE_ROLES, delete=admin (soft) |
| `GET\|POST\|PUT` | `/api/clientes[/:id]` | read=auth, write=WRITE_ROLES |
| `GET\|POST\|PUT` · `/:id/reset-password` · `/:id/deactivate` | `/api/users[/:id]` | read=auth, write/admin actions=admin |
| `GET\|POST\|PUT\|DELETE` | `/api/proveedores[/:id]` | POST=CATALOG_WRITE, PUT=WRITE_ROLES, DELETE=admin |
| `GET\|POST\|PUT\|DELETE` · `GET /autocomplete?q=` · `POST /:id/aprobar` | `/api/items-catalogo[/:id]` | POST=CATALOG_WRITE (operativo crea como `pendiente`); aprobar=WRITE_ROLES |
| `GET\|POST\|PUT /api/cotizaciones[/:id]` · `POST /:id/aprobar` · `POST /:id/rechazar` | auth (CR/UP), aprobar/rechazar=WRITE_ROLES |
| `POST /api/cotizaciones/parse-document` (multipart `archivo`, PDF/imagen) | CATALOG_WRITE — OCR Gemini, devuelve JSON + matches |
| `POST\|GET\|DELETE /api/cotizaciones/:id/archivo` (evidencia PDF/imagen) | POST/GET=CATALOG_WRITE, DELETE=WRITE_ROLES |
| `GET\|PUT /api/ocs[/:id]` · `POST /:id/cancelar` | auth (controllers chequean rol) |
| `POST /api/ocs/:ocId/pagos` · `GET\|PUT\|DELETE /api/pagos[/:id]` · `POST /:id/marcar-pagado` · `POST /:id/desmarcar` | auth + controllers (write=WRITE_ROLES) |
| `GET /api/ocs/:ocId/hitos` · `POST /api/ocs/:ocId/items/:itemId/hitos` · `PUT /api/ocs/hitos/:hitoId` · `POST /api/ocs/hitos/:hitoId/completar` | auth + controllers |
| `POST /api/ocs/:ocId/entregas` · `GET /api/ocs/:ocId/pendientes` | POST=CATALOG_WRITE, GET=ALL_AUTH_ROLES |
| `GET /api/entregas[/:id]` · `POST /:id/fotos` (multer `fotos[]` hasta 10) · `GET /:id/fotos/:fotoId/archivo` · `PUT /:id` · `DELETE /:id` | read=ALL_AUTH_ROLES, fotos=CATALOG_WRITE, PUT=WRITE_ROLES, DELETE=admin |
| `GET /api/exchange-rates` · `/latest` · `POST /backfill` · `/fetch-today` · `POST /` (manual) · `DELETE /:id` | read=auth, write=WRITE_ROLES, delete=admin |
| `GET /api/facturas[/:id]` · `GET /:id/archivo` | ALL_AUTH_ROLES |
| `POST /api/facturas/upload/:ocId` (multipart `archivo` XML) | CATALOG_WRITE |
| `POST /api/facturas/:id/confirmar` · `POST /:id/anular` | WRITE_ROLES |
| `GET /api/audit-log` | admin only |

## OCR y archivos adjuntos

Tres pipelines de upload distintos (todos vía `multer`, helpers en `server/lib/uploads.js`):

- **Facturas XML** (`xmlUpload`, field `archivo`, 20 MiB, mime XML / extensión `.xml`). Layout: `uploads/facturas/<año>/<mes>/<ocId>/<uuid>-<sanitized>`. Parsing inline con `fast-xml-parser` (`xml-parser.js`).
- **Cotizaciones — archivo de evidencia** (`cotizacionArchivoUpload`, field `archivo`, 20 MiB, mime PDF/JPEG/PNG/HEIC/HEIF/WEBP). Layout: `uploads/cotizaciones/<año>/<mes>/<cotId>/<uuid>-<sanitized>`. Bytes raw, sin recompresión (evidencia del precio ofrecido). Endpoints POST/GET/DELETE.
- **Entregas — fotos** (`fotoUpload`, field `fotos[]`, hasta 10 archivos, 10 MiB c/u, mime JPEG/PNG/HEIF/WEBP). Layout: `uploads/entregas/<año>/<mes>/<entregaId>/<uuid>-<sanitized>`. Bytes raw para preservar EXIF (evidencia legal).

**OCR Gemini** (dos sabores). Modelo en uso: **`gemini-3.5-flash`** (set vía `OCR_MODEL` en `.env`, 2026-05-29). Override por env. Default hardcoded en código si falta env: `gemini-3.1-flash-lite`. Requiere `GEMINI_API_KEY`. Ver `.env.example` para alternativas (`gemini-flash-lite-latest`, `gemini-2.5-flash-lite`).

- **Facturas no-electrónicas** (`server/services/gemini-ocr.js`): servicio listo + testeado, endpoint no expuesto aún en UI.
- **Cotizaciones** (`server/services/gemini-cotizacion-ocr.js` + `controllers/cotizaciones-ocr.controller.js`): endpoint `POST /api/cotizaciones/parse-document` activo. Multer guarda en `/tmp/` (20 MiB, PDF/imagen), llama Gemini con `responseSchema` constrained, devuelve `{data, model, warnings, matches}` donde `matches.proveedorId` y `matches.items[*].materialId` salen de un enrichment que busca match único en `Proveedor` (por cédula primero, luego nombre `contains` case-insensitive) y en `ItemCatalogo` (por `nombreCanonico` o `alias`). El tmp file se borra siempre. Validaciones blandas devuelven `warnings[]` (cédula fuera de regex 9-12 dígitos, total <=0, items sin precio, etc.) — no levantan, la UI decide.

Costo aproximado: ~milésimas de dólar por documento OCR (~$0.30/mes en los volúmenes esperados).

## Background jobs

- **`server/cron/bccr-daily.js`** — arrancado desde `server/index.js` al `listen`. Schedule `'30 9 * * 1-5'` en TZ `America/Costa_Rica` (lun-vie 9:30 hora CR; el BCCR publica el TC vigente cerca de las 9 AM). Si `BCCR_TOKEN` no está seteado, el cron NO se registra (warning, no error). Cada tick va en try/catch; tras 5 fallas consecutivas el log escala de `warn` a `error` pero sigue intentando. Política de upsert: NO pisa rows con `source='manual'` (`exchange-rates` service controla esto).

## Decisiones de diseño que NO se ven en el código

- **Por qué dejamos Django (v1)**: MVP de 51 commits / 231 tests, pero la UX híbrida webapp + Django-admin no convenció a Gabriel. v2 rehace UI 100% React. Lógica de dominio (parsing XML, snapshots, numeración OC) se portó a Node manteniendo semántica.
- **Por qué Prisma (no Drizzle ni TypeORM)**: el proyecto de referencia Propiedades360 usa Prisma; queremos máxima reutilización de patrones/scripts y el equipo (Gabriel + Claude) ya tiene fluidez con `prisma migrate`.
- **Por qué Postgres (no SQLite)**: necesitamos `pg_advisory_xact_lock` para serializar numeración OC, índices parciales (UNIQUE WHERE NOT NULL en `claveNumerica`) y `Decimal(15,2)` confiable. SQLite no calza.
- **Por qué advisory lock (no `SERIALIZABLE`)**: el lock escopeado por `obraId` permite aprobaciones concurrentes en obras distintas sin retries. `SERIALIZABLE` global aborta transacciones bajo contención y obliga lógica de retry.
- **Por qué fast-xml-parser (no libxmljs2)**: zero-dep nativo, sin compilar bindings. Sacrifica validación XSD (anotado como TODO; aceptable mientras el volumen sea bajo).
- **Por qué inline parsing de facturas (no worker)**: volumen esperado bajo (decenas/mes). Se puede migrar a BullMQ + Redis cuando duela.
- **Por qué audit service-layer (no middleware HTTP)**: interceptar `res.json()` para sacar el `recordId` es frágil en Express 5; el diff before/after vive naturalmente en el controller que ya hace `findUnique` previo al `update`. Ver header de `server/lib/audit.js`.

## Deuda técnica conocida

- **rfqId prefill desde RfqDetail al CotizacionForm**: las dos páginas existen pero el form no consume todavía el `state.rfqId` que le pasamos desde "+ Cargar cotización de proveedor". El operativo digita el SC# manualmente.
- **Worker async opcional**: BullMQ + ioredis instalados, queue en `server/queues/factura-queue.js`, processor compartido en `server/services/factura-processor.js`. Default **sync** (REDIS_URL vacío). Para activar async: setear `REDIS_URL` en `.env` + arrancar `./manage.sh worker` (dev) o el service `worker` de `docker-compose.prod.yml`.
- **Validación XSD opt-in**: `XSD_VALIDATE=true` en `.env` activa validación con `xmllint-wasm` + los 6 XSDs de Hacienda v4.4 commiteados en `server/schemas/V4.4/`. Default off.
- **UI BullMQ / dead-letter alerts**: sin `@bull-board`, sin alertas en fallos repetidos. Jobs fallidos quedan 7 días en Redis.
- **Frontend polling de facturas async**: cuando el upload responde 202 (queue activa), el cliente no hace poll todavía — el usuario tiene que refrescar manualmente.
- **Frontend tests**: sin runner configurado (verificación manual). Falta Vitest + RTL.
- **CI/CD**: build de producción funciona local pero no hay pipeline automatizado.
- **Observabilidad**: sin Prometheus/healthcheck externo en prod.

## Modelos Prisma (22)

Auth: `User`. Core: `Cliente`, `Obra`, `CategoriaPresupuesto`, `Presupuesto`, `Bodega`. Catálogo: `Proveedor`, `ItemCatalogo`. Finanzas: `ExchangeRate`. Compras: `SolicitudCotizacion`, `Cotizacion`, `CotizacionItem`, `OrdenCompra`, `OrdenCompraItem`, `Hito`, `Pago`, `PagoHito`. Facturas: `Factura`. Entregas: `Entrega`, `EntregaItem`, `EntregaFoto`. Auditoría: `AuditLog`.

Enums clave: `Role`, `Currency`, `ObraEstado`, `ItemTipo`, `ItemEstado`, `ItemUnidad`, `RfqEstado`, `CotizacionEstado`, `OcEstado`, `PagoMetodo`, `FacturaSourceType`, `FacturaTipo`, `FacturaStatus`, `AuditAction`, `ExchangeRateSource`.

## Cómo retomar después de cerrar Claude

1. `docker ps | grep construmaster_v2_postgres` — verificá que esté corriendo.
2. Si no: `cd /mnt/NAS/ConstruMaster && docker compose up -d postgres`.
3. `./manage.sh start` para arrancar Express + Vite (puerto 8000/3001).
4. Login en `https://construmaster.inventitec.com` (o `http://localhost:8000`) como `gabriel`. Si olvidaste la password: `./manage.sh reset-admin <new-pw>`.
5. Para ver el estado del trabajo: `git log --oneline -30` y `./manage.sh logs`.
6. Antes de tocar dominio (cotizaciones / OCs / facturas) leé los headers de `server/services/oc-flow.js`, `server/services/xml-parser.js` y `server/services/gemini-cotizacion-ocr.js` — explican las decisiones críticas.
