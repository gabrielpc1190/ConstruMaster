# ConstruMaster — Módulo de Materiales (MVP)

**Spec de diseño**
**Fecha:** 2026-05-25
**Estado:** Aprobado por el usuario tras brainstorming
**Siguiente paso:** plan de implementación (skill `writing-plans`)

---

## 1. Resumen ejecutivo

**ConstruMaster** es una webapp interna para que **Gabriel y Diana** supervisen las obras de construcción que **ADITA (Tony y Adrián Vargas)** ejecuta para el cliente **Don Nicholas Charles Rowley**.

Este spec cubre el **MVP del módulo de Materiales**: control de cotizaciones, órdenes de compra, pagos, facturas (con parseo automático de XML de Hacienda y OCR de PDFs/fotos), entregas con reconciliación pedido-vs-entregado, presupuestos por categoría y reportes multi-moneda CRC/USD.

Módulos futuros documentados en la Sección 11 (Empleados, EPP, Inventario con alertas Telegram, Mensaje Receptor a Hacienda).

### Audiencia y roles

| Rol | Quién | Acciones |
|---|---|---|
| **Supervisor** | Gabriel, Diana | Captura todo, aprueba cotizaciones, marca pagos hechos, confirma facturas, edita presupuestos y catálogo. |
| **Operativo** | Tony, Adrián (ADITA) | Captura cotizaciones, registra entregas/facturas, programa pagos, sugiere items al catálogo. |
| **Lector** | Don Nicholas | Solo lectura: dashboards y reportes. |

### Stack final

- **Backend:** Python 3.13, Django 5.2 LTS, Django-Q2 1.10 (worker con Redis broker).
- **Frontend:** HTMX 2.0.9 + `django-htmx` 1.27 + Tailwind v4 (via `django-tailwind-cli`).
- **Datos:** Postgres 16, `django-money` 3.6, `django-auditlog`.
- **Procesamiento:** `lxml` (parser FE/TE XML), `httpx` (cliente BCCR + Gemini), Gemini Flash-Lite (OCR).
- **Auth:** Django nativo + Groups (sin allauth, sin Cloudflare Access en MVP).
- **Servidor:** `gunicorn` 23 + `whitenoise` (sin Caddy/nginx).
- **Infra:** Docker Compose, Cloudflare Tunnel para acceso externo. VM Linux local → futuro VPS.

---

## 2. Contexto del negocio

**Quién hace qué hoy (sin la app):**
- ADITA recibe cotizaciones de proveedores por email/WhatsApp. Las guarda en carpetas, hojas de cálculo o memoria.
- ADITA negocia con proveedores. Cuando Diana/Gabriel aprueban verbalmente, paga el anticipo desde la cuenta del cliente.
- Material llega a la obra (parcial o total). ADITA recibe.
- Factura electrónica (XML) o física llega después. Se guarda en correo o impresa.
- Diana/Gabriel mensualmente intentan reconciliar gastos, pagos, entregas — proceso manual con errores.

**Lo que ConstruMaster cambia:**
- Cotizaciones, OCs, pagos, facturas y entregas son un solo registro consistente.
- Diana/Gabriel ven en tiempo real qué se aprobó, qué se pagó, qué llegó, qué falta.
- Don Nicholas tiene acceso de lectura sin depender de reportes manuales.
- Reportes auditables por obra, categoría, proveedor, material, moneda.

**Decisiones explícitas del usuario que moldean el diseño:**
- **Múltiples obras simultáneas** (todas de Nicholas hoy; estructura preparada para multi-cliente).
- **Multi-moneda CRC + USD** con tipo de cambio del BCCR (cumple Hacienda).
- **OCR de facturas no-electrónicas** con Gemini Flash-Lite (datos viajan a Google).
- **FE Hacienda v4.4** soportada via parser determinista.
- **Catálogo cross-obra** de materiales y servicios (lazy, requiere disciplina via autocomplete).
- **Items modelados como tabla** (no JSONField) para reconciliación pedido-vs-entregado.
- **Hitos para servicios** desde el MVP.
- **Bodegas cross-obra del cliente** (Cuarto Eléctrico GADI, Cuarto 4 del Bache, Bodega Baches).
- **Audit log** con `django-auditlog` en modelos críticos.

---

## 3. Arquitectura

```
                    Cloudflare Edge (TLS, WAF, rate limit)
                                  │
                                  │ tunnel (outbound only)
                                  ▼
              ┌───────────────────────────────────┐
              │  VM Linux (luego VPS) — Docker    │
              │                                   │
              │  cloudflared                      │
              │       │                           │
              │       ▼ (HTTP plano, red interna) │
              │  gunicorn (Django + django-htmx + │
              │            whitenoise)            │
              │       │                           │
              │  django-q2 qcluster (worker)      │
              │       │                           │
              │  postgres 16  redis 7  /var/data  │
              │       │                           │
              │  backup-sidecar (pg_dump diario)  │
              └───────────────────────────────────┘
```

**Justificación de cada pieza:**
- **cloudflared → gunicorn directo** sin reverse proxy adicional. Cloudflare Tunnel actúa como buffer HTTP (mitiga slow-client attacks), maneja TLS y rate limiting. Whitenoise sirve estáticos.
- **Django-Q2** sobre Celery: menos infra, integrado con Django, suficiente para volumen actual (~10-30 jobs/día de OCR).
- **Redis** con dos databases lógicas: `db=0` para Django-Q2 broker, `db=1` para cache de Django.
- **Volumen Docker nombrado** `media_files` montado en `/var/data/files`. Storage abstraído con `STORAGES` setting → switch a S3-compatible (R2/MinIO) cambia solo env vars.
- **Backup sidecar** corre `pg_dump --format=custom` diario + `tar zst` de `/var/data/files` cada 12h, destino en NAS Synology via bind mount NFS.
- **Sin Caddy/nginx** en MVP. Si en el futuro hay múltiples servicios, se agrega.
- **Sin Kubernetes**, sin microservicios — un solo `docker-compose.yml`.

**Configuración Django crítica detrás de Cloudflare Tunnel:**

```python
# settings.py
ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS")
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS")  # con scheme https://
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
USE_X_FORWARDED_HOST = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_SSL_REDIRECT = False  # Cloudflare ya redirige; evitar loop
```

`SECURE_PROXY_SSL_HEADER` solo es seguro porque gunicorn **no expone `ports:`** al host — toda red interna en compose. Documentar esto: nunca hacer `ports: 8000:8000` ni siquiera "para debug".

---

## 4. Modelos de datos

### 4.1 Núcleo organizacional

**`Cliente`** — Don Nicholas hoy; estructura lista para multi-cliente futuro.
- `nombre`, `identificacion` (cédula), `notas`.

**`Obra`** — contenedor principal. Cada compra, factura, empleado vive dentro de una obra.
- `cliente` (FK Cliente)
- `nombre`, `slug` (auto, único)
- `direccion`, `fecha_inicio`, `fecha_fin_estimada`
- `moneda_reporte` (CRC | USD) — para dashboards y reportes
- `estado` (planificada | en_curso | pausada | finalizada)

**`CategoriaPresupuesto`** — catálogo por obra (preset editable: estructura, acabados, instalaciones, mano de obra, indirectos).
- `obra` (FK), `nombre`, `orden`.

**`Presupuesto`** — monto presupuestado por categoría dentro de una obra.
- `obra` (FK), `categoria` (FK), `monto` (MoneyField), `notas`.

### 4.2 Catálogos cross-obra

**`Proveedor`**
- `nombre`, `identificacion` (cédula jurídica/física), `email_facturacion`, `telefono`, `notas`, `activo`.

**`ItemCatalogo`** — materiales **y servicios**, lazy (se crea on-the-fly).
- `tipo` (material | servicio)
- `nombre_canonico` (ej: "Cemento Sansón Tipo I 50kg", "Instalación eléctrica (hora)")
- `unidad` (saco | kg | m³ | m² | m | unidad | varilla | galón | hora | día | visita | global | mes | …)
- `categoria_sugerida` (FK CategoriaPresupuesto, nullable — solo sugerencia)
- `slug` (autogenerado), `alias` (TextField — strings alternativos para autocomplete)
- `estado` (pendiente | aprobado | inactivo)
- `sugerido_por` (FK User, nullable — para los pendientes)
- `activo` (bool)

**`Bodega`** — cross-obra, **pertenecen al cliente** (Nicholas).
- `cliente` (FK Cliente)
- `nombre` (seed: "Cuarto Eléctrico GADI", "Cuarto 4 del Bache", "Bodega Baches")
- `direccion` (opcional), `responsable` (FK User nullable), `activo`, `notas`.

### 4.3 Flujo de compra

**`SolicitudCotizacion` (RFQ)** — opcional. Pedido inicial de cotización.
- `obra` (FK), `categoria` (FK), `descripcion` (texto libre)
- `fecha_requerida`, `creada_por` (FK User)
- `estado` (abierta | cerrada | cancelada)
- `es_especial` (bool — pedidos custom / hechos a la medida)

**`Cotizacion`** — respuesta de un proveedor (puede asociarse a RFQ o ser standalone).
- `obra` (FK), `proveedor` (FK), `rfq` (FK SolicitudCotizacion, nullable)
- `numero_cotizacion` (string libre), `fecha`, `fecha_validez`
- `moneda`, `subtotal` (MoneyField), `iva` (MoneyField), `total` (MoneyField)
- `condiciones_pago`, `plazo_entrega_dias`, `pct_anticipo` (nullable)
- `archivo` (FileField — PDF/foto)
- `es_especial` (bool, default False) — heredado del RFQ si existe; capturado en el form si la cotización es standalone
- `estado` (recibida | en_revision | aprobada | rechazada | vencida)
- `notas`

**Nota sobre totales de Cotizacion:** los campos `subtotal`/`iva`/`total` no se derivan automáticamente de `SUM(CotizacionItem)`. La app los pre-llena en vivo al capturar items, pero el usuario puede sobrescribirlos para cuadrar con el PDF del proveedor (descuentos, redondeos, ajustes manuales). Discrepancia entre suma de items y total declarado → warning amarillo, no error.

**`CotizacionItem`** — items en tabla (no JSONField).
- `cotizacion` (FK), `material` (FK ItemCatalogo, nullable — para items custom)
- `descripcion` (texto libre, siempre presente)
- `cantidad` (Decimal 12,4), `unidad` (string, denormalizado o libre)
- `precio_unitario` (Decimal 14,5), `subtotal` (Decimal 14,2)
- `iva_monto` (Decimal 14,2)
- `codigo_cabys` (CharField 13, nullable — catálogo nacional de bienes/servicios)
- `orden` (int)

**`OrdenCompra` (OC)** — snapshot de Cotizacion aprobada. Sus **items, montos y `fx_rate_applied` son inmutables** después de creada (el `estado` sí transiciona por su máquina de estados; el resto del registro no cambia).
- `obra` (FK), `categoria` (FK CategoriaPresupuesto)
- `cotizacion_origen` (FK Cotizacion), `proveedor` (FK)
- `numero_oc` (autogenerado, formato `<SLUG_OBRA>-OC-NNNN` con secuencia **por obra**; ej: `LOMAS-OC-0001`, `LOMAS-OC-0002`, `BACHE-OC-0001`)
- `fecha_aprobacion`, `aprobada_por` (FK User)
- `moneda`, `monto_total` (MoneyField)
- `fx_rate_applied` (Decimal 12,5, nullable), `fx_rate_date` (Date, nullable)
- `es_especial` (bool), `tiempo_estimado_dias` (nullable), `pct_anticipo` (nullable)
- `estado` (autorizada | pagada_parcial | pagada | entregada_parcial | completada | cancelada)
- `notas`

**`OrdenCompraItem`** — snapshot inmutable de CotizacionItem al aprobar.
- `oc` (FK), `material` (FK ItemCatalogo, nullable)
- `material_nombre_snapshot`, `material_unidad_snapshot` (denormalización defensiva)
- `descripcion`, `cantidad`, `unidad`, `precio_unitario` (Decimal 14,5), `subtotal`, `iva_monto`
- `codigo_cabys` (nullable)
- `orden`

**`Hito`** — para items de tipo servicio en una OC.
- `oc_item` (FK OrdenCompraItem)
- `nombre` (ej: "Anticipo 50%", "Entrega de planos", "Instalación final")
- `monto` (Decimal nullable), `fecha_estimada` (Date nullable)
- `completado` (bool default False), `fecha_completado` (Date nullable)
- `notas`, `orden`

**`Pago`**
- `oc` (FK)
- `fecha_programada`, `fecha_realizada` (nullable)
- `monto` (MoneyField), `metodo` (transferencia | cheque | efectivo | tarjeta | otro)
- `referencia` (n° transferencia/cheque), `comprobante` (FileField nullable)
- `registrado_por` (FK User), `marcado_pagado_por` (FK User nullable)
- `fx_rate_applied` (Decimal nullable), `fx_rate_date` (Date nullable)
- `hitos_relacionados` (M:N Hito, opcional)
- `notas`

**`Factura`** — XML FE/TE o PDF/foto + OCR. Diseño unificado.
- `oc` (FK)
- `source_type` (xml | pdf | imagen)
- `tipo_comprobante` (FE | TE | NC | ND | FEC | FEE) — null hasta parsear
- `archivo_original` (FileField — byte-a-byte, no reformatear si es XML firmado)
- `status` (pending | processing | extracted | confirmed | error)
- `extracted_data` (JSONField — datos parseados/OCR crudos)
- `confidence_score` (float, nullable — solo OCR)
- **Campos canónicos** (promovidos al confirmar):
  - `clave_numerica` (CharField 50, alfanumérica)
  - `numero_consecutivo`, `fecha_emision`, `monto_total` (MoneyField, nullable)
  - `condicion_venta` (01 contado | 02 crédito 30d | …)
  - `medios_pago` (JSONField — lista de `{tipo, monto}`)
- `fx_rate_applied`, `fx_rate_date` (snapshot)
- `confirmada_por` (FK User nullable), `error_message`, `notas`

**`Entrega`** — registro físico (material entregado o servicio cumplido).
- `oc` (FK), `bodega_destino` (FK Bodega, nullable en MVP — obligatorio cuando llegue módulo inventario)
- `fecha`, `recibido_por` (texto libre)
- `registrada_por` (FK User)
- `completa` (bool — true si esta entrega cierra la OC)
- `notas`

**`EntregaItem`** — items recibidos en esta entrega.
- `entrega` (FK), `oc_item` (FK OrdenCompraItem, nullable — vínculo de reconciliación)
- `material` (FK ItemCatalogo, nullable)
- `descripcion`, `cantidad` (Decimal 12,4), `unidad`
- `notas` (texto libre)

**`EntregaFoto`** — fotos de evidencia (N por entrega).
- `entrega` (FK), `archivo` (ImageField), `subida_por` (FK User), `fecha`.

### 4.4 Finanzas

**`ExchangeRate`** — snapshot diario del BCCR.
- `currency` (CharField 3 — "USD" en MVP)
- `date` (Date — fecha de vigencia)
- `buy` (Decimal 12,5 — cód 317), `sell` (Decimal 12,5 — cód 318)
- `fetched_at` (DateTime auto)
- `source` (CharField — 'bccr' | 'manual')
- Unique `(currency, date)`. Index sobre `(currency, -date)`.

### 4.5 Decisiones de diseño explícitas

1. **Items como tabla, no JSONField.** Permite agregaciones SQL para reconciliación cuánto-se-compró-vs-cuánto-llegó por material × obra.
2. **Catálogo cross-obra y lazy.** Permite histórico de precios entre obras. Disciplina via autocomplete agresivo + admin de fusión de duplicados.
3. **`OrdenCompra` y `OrdenCompraItem` son snapshots inmutables.** Si la cotización original cambia o se vence, la OC no se mueve. Idem para `fx_rate_applied`.
4. **Categoría de presupuesto a nivel de OC**, no de línea. Una OC = una categoría. Compras mixtas se hacen en dos OCs.
5. **Reconciliación pedido-vs-entregado es semi-automática.** `EntregaItem.oc_item` se pre-llena al registrar entrega; usuario solo ajusta cantidades.
6. **`Factura.extracted_data` JSONField permite parseo flexible.** Mismo modelo para XML y OCR. Datos canónicos se promueven al confirmar.
7. **Bodegas pertenecen al cliente.** Estructura prepara para multi-cliente sin migración.
8. **Snapshot at write-time del `fx_rate_applied`** garantiza reportes históricos consistentes y cumple NIIF 2027.

---

## 5. Roles y permisos

Tres Django Groups: `supervisor`, `operativo`, `lector`. Acceso a todas las obras (sin segregación por-obra en MVP).

### Matriz de permisos

| Acción | Supervisor | Operativo | Lector |
|---|:-:|:-:|:-:|
| CRUD `Cliente`, `Obra`, `CategoriaPresupuesto` | ✅ | ❌ | 👁️ |
| CRUD `Proveedor` | ✅ | ✅ | 👁️ |
| CRUD `ItemCatalogo` aprobado | ✅ | ❌ | 👁️ |
| Sugerir `ItemCatalogo` (estado pendiente) | ✅ | ✅ | ❌ |
| Aprobar / fusionar / desactivar items del catálogo | ✅ | ❌ | ❌ |
| CRUD `Bodega` | ✅ | ❌ | 👁️ |
| CRUD `Presupuesto` | ✅ | ❌ | 👁️ |
| Crear `SolicitudCotizacion` | ✅ | ✅ | 👁️ |
| Crear/editar `Cotizacion` + items | ✅ | ✅ | 👁️ |
| **Aprobar Cotización → OrdenCompra** | ✅ | ❌ | ❌ |
| Cancelar OC autorizada | ✅ | ❌ | ❌ |
| Registrar `Pago` programado | ✅ | ✅ | 👁️ |
| **Marcar Pago como realizado** | ✅ | ❌ | ❌ |
| Subir XML/PDF/foto → crea `Factura` | ✅ | ✅ | 👁️ |
| **Confirmar Factura tras extracción** | ✅ | ❌ | ❌ |
| Registrar `Entrega` + items + fotos | ✅ | ✅ | 👁️ |
| Marcar entrega como "OC completada" | ✅ | ✅ | ❌ |
| Crear/editar `Hito` | ✅ | ❌ | 👁️ |
| Marcar `Hito` como completado | ✅ | ✅ | ❌ |
| Ver dashboards y reportes | ✅ | ✅ | ✅ |
| Acceder al admin de Django | ✅ | ❌ | ❌ |
| CRUD usuarios | ✅ | ❌ | ❌ |

### Permisos custom (Django Permissions)

- `cotizaciones.approve_cotizacion`
- `pagos.mark_paid`
- `facturas.confirm_factura`
- `catalogo.suggest_item` (operativo + supervisor)
- `catalogo.approve_item` (supervisor)
- `obras.cancel_oc`

### Autenticación

- **Solo Django auth nativo** en MVP. Sin allauth, sin Cloudflare Access, sin OAuth, sin 2FA.
- Sesiones por cookie con `SESSION_COOKIE_SECURE=True`, `CSRF_COOKIE_SECURE=True`.
- **Password reset:** manual via admin de Django (sin SMTP en MVP). Cuando se agregue SMTP, habilitar flow nativo.

### Audit trail

- **`django-auditlog`** registrando automáticamente cambios en: `OrdenCompra`, `Pago`, `Factura`, `Presupuesto`, `ItemCatalogo`.
- Visible desde admin de Django.

---

## 6. Flujo de compra paso a paso

```
SolicitudCotizacion          Cotizacion            OrdenCompra          Factura            Entrega
   (RFQ)                                          (snapshot)
abierta ──┐               recibida           autorizada          pending           N/A
          │1:N          en_revision     pagada_parcial        processing
          │             aprobada/         pagada             extracted
          ▼             rechazada        entregada_parcial  confirmed
       cerrada/         vencida          completada/        error
       cancelada                         cancelada
```

### 6.1 Paso 1 — RFQ (opcional)

Supervisor u operativo crea `SolicitudCotizacion(obra, categoria, descripcion, fecha_requerida, es_especial)`. Estado inicial: `abierta`.

### 6.2 Paso 2 — Captura de cotizaciones recibidas

Operativo (o supervisor) captura cada cotización recibida de un proveedor:
1. Crear `Cotizacion(obra, proveedor, rfq?, ...)`.
2. Captura items uno por uno con autocomplete contra `ItemCatalogo` (filtra por `estado='aprobado'`).
3. Si el item no existe → "+ Sugerir nuevo item" → crea `ItemCatalogo(estado='pendiente', sugerido_por=user)`.
4. App calcula totales en vivo; usuario puede sobrescribir para cuadrar con el PDF del proveedor.
5. Discrepancia entre suma de items y total declarado → warning amarillo, no error.

Estado: `recibida`.

### 6.3 Paso 3 — Comparación y revisión

Supervisor entra a la vista comparativa por RFQ (o agrupando por obra+categoría sin RFQ). Tabla con cotizaciones lado a lado: proveedor, total (moneda original + convertido a moneda de reporte), plazo entrega, % anticipo, condiciones. Items que coinciden por `ItemCatalogo` aparecen en la misma fila (precios lado a lado).

Acciones del supervisor:
- Aprobar cotización X → siguiente paso.
- Rechazar cotización (con motivo opcional).
- Pedir más cotizaciones (mantener RFQ abierto).

### 6.4 Paso 4 — Aprobación → creación de OC

Transacción atómica:
1. Validar `cotizaciones.approve_cotizacion`.
2. **Lockear la fila de `Obra`** con `Obra.objects.select_for_update().get(pk=...)` antes de generar `numero_oc`. Esto serializa aprobaciones concurrentes de la misma obra y previene secuencias duplicadas (ver "Generación de `numero_oc`" abajo).
3. Crear `OrdenCompra` snapshot con `fx_rate_applied = ExchangeRate.for_date('USD', today, 'sell')`.
4. Snapshot todos los `CotizacionItem` → `OrdenCompraItem` con denormalización defensiva.
5. **Validación de presupuesto** (consistente con el semáforo del dashboard, §10.1): suma de OCs autorizadas por categoría vs presupuesto.
   - `> 70%` → semáforo amarillo (warning informativo).
   - `> 90%` → semáforo naranja (warning fuerte).
   - `> 100%` → semáforo rojo (warning crítico), **no bloquea** — supervisor confirma con justificación en notas.
6. Si hay items de servicio: supervisor puede crear `Hito`s ahora o después.
7. `Cotizacion.estado = 'aprobada'`; cerrar RFQ si aplicable.
8. Audit log: "Diana aprobó cotización X → OC LOMAS-OC-0042".

Estado OC: `autorizada`.

**Generación de `numero_oc`:** formato `<SLUG_OBRA>-OC-NNNN` con secuencia por obra.

Para evitar race condition con dos aprobaciones concurrentes leyendo el mismo `MAX(numero)+1` bajo aislamiento READ COMMITTED de Postgres, hay dos opciones (escoger en implementación):

- **Opción A (recomendada): contador en la fila de `Obra`.** Agregar campo `Obra.next_oc_seq` (int default 1). Dentro de la transacción atómica del paso 2, lockear con `select_for_update()`, leer `next_oc_seq`, asignar a la nueva OC y hacer `obra.next_oc_seq += 1; obra.save()`. Postgres serializa las transacciones que tocan esa fila.
- **Opción B: secuencia dedicada por obra en Postgres** (`CREATE SEQUENCE ...`) llamada con `nextval()`. Más performante en alta concurrencia pero más fricción operativa (migration por cada obra nueva). Para 3-5 usuarios la opción A sobra.

### 6.5 Paso 5 — Pago

1. Operativo registra `Pago(oc, fecha_programada, monto, metodo, referencia)`. Sin `fecha_realizada` aún.
2. Supervisor ejecuta el pago en su banco, sube comprobante, marca `fecha_realizada = today` (permiso `pagos.mark_paid`).
3. Si la OC tiene hitos: supervisor puede vincular el pago a uno o más Hitos (M:N).
4. Estado OC se actualiza automáticamente. **La comparación debe normalizar moneda** porque una OC en USD se puede pagar parcialmente en CRC (común: girar desde cuenta bancaria local). Algoritmo:
   ```python
   total_pagado = Money(0, oc.monto_total.currency.code)
   for p in oc.pagos.filter(fecha_realizada__isnull=False):
       total_pagado += convert(p.monto, oc.monto_total.currency.code, p.fecha_realizada, side='sell')
   if total_pagado >= oc.monto_total:
       oc.estado = 'pagada'
   elif total_pagado > Money(0, oc.monto_total.currency.code):
       oc.estado = 'pagada_parcial'
   ```
   La normalización pasa por la función única `convert()` con el TC del día del pago (no del día actual), preservando la consistencia histórica.

### 6.6 Paso 6 — Llegada de factura (async)

Operativo sube archivo (XML/PDF/foto) y selecciona OC. Crea `Factura(status='pending')`. Encola `extract_invoice(factura.id)` (Django-Q2). HTMX polling cada 2s muestra status.

Worker procesa según `source_type`:
- `xml` → parser determinista con `lxml` + XSD v4.4 (Sección 7.1)
- `pdf | imagen` → Gemini Flash-Lite con structured output (Sección 7.2)

Resultado: `extracted_data` JSON, `confidence_score` (solo OCR), `status='extracted'`.

### 6.7 Paso 7 — Confirmación de factura

Cuando `status='extracted'`, supervisor abre form pre-llenado con archivo original al lado:
1. Revisa y corrige campos: emisor, fecha, número consecutivo, clave numérica, monto, items.
2. Si los items matchean OCItem, vincula manualmente (opcional).
3. Submit → `status='confirmed'`, datos promovidos a columnas canónicas (`clave_numerica`, `numero_consecutivo`, `fecha_emision`, `monto_total`, `condicion_venta`, `medios_pago`).

Validación blanda: si `factura.monto_total != oc.monto_total` → warning (puede haber descuentos, IVA distinto).

### 6.8 Paso 8 — Entrega (parcial o total)

1. Operativo crea `Entrega(oc, fecha, bodega_destino, recibido_por, notas)`.
2. App pre-llena `EntregaItem` con items pendientes de la OC (cantidad sugerida = lo que falta).
3. Operativo ajusta cantidades reales, sube fotos.
4. Si suma de entregas iguala cantidad de cada OCItem → app sugiere `Entrega.completa=True` y `OrdenCompra.estado='completada'`.

**Para servicios con hitos:** marca `Hito.completado=True, fecha_completado=today` en vez (o además) de items físicos.

### 6.9 Paso 9 — Cierre

Estados terminales:
- `completada` — happy path.
- `cancelada` — supervisor canceló (motivo en notas). Pagos hechos quedan registrados; OC no consume presupuesto hacia adelante.

---

## 7. Procesamiento async

### 7.1 Parser de comprobantes electrónicos (`parse_comprobante_xml`)

**Función pura:** `parse_comprobante_xml(file_path) -> dict`. Determinista, sin red.

**Tipos soportados** (detectados por namespace del root):

| Tipo | Root | Namespace suffix |
|---|---|---|
| FE | `FacturaElectronica` | `facturaElectronica` |
| TE | `TiqueteElectronico` | `tiqueteElectronico` |
| NC | `NotaCreditoElectronica` | `notaCreditoElectronica` |
| ND | `NotaDebitoElectronica` | `notaDebitoElectronica` |
| FEC | `FacturaElectronicaCompra` | `facturaElectronicaCompra` |
| FEE | `FacturaElectronicaExportacion` | `facturaElectronicaExportacion` |

**Algoritmo:**
1. Leer XML; detectar tipo por namespace del root.
2. Cargar XSD correspondiente desde `apps/facturas/schemas/V4.4/<tipo>.xsd`.
3. Validar con `lxml.etree.XMLSchema.assertValid` antes de extraer (lanzar `FacturaExtractionError` si falla).
4. Extraer con XPath con namespace registrado.

**Contrato de retorno (`dict` con keys exactas):**
- `tipo` (str, uno de `FE | TE | NC | ND | FEC | FEE`) — detectado en paso 1
- `clave` (str, alfanumérica) — `<Clave>`
- `consecutivo` (str) — `<NumeroConsecutivo>`
- `fecha` (str ISO) — `<FechaEmision>`
- `emisor` (dict) — `<Emisor>` con `{nombre, identificacion: {tipo, numero}}`
- `receptor` (dict | None) — `<Receptor>` (puede faltar en TE)
- `condicion_venta` (str código, ej `"01"`) — `<CondicionVenta>`
- `items` (list[dict]) — cada `<LineaDetalle>` con `{numero_linea, codigo_cabys, cantidad, unidad_medida, detalle, precio_unitario, subtotal, iva_monto, monto_total_linea}`
- `resumen` (dict) — `<ResumenFactura>` con `{moneda, tipo_cambio, total_gravado, total_impuesto, total_comprobante, medios_pago: [{tipo, monto}]}`

5. Conservar XML original byte-a-byte (no reformatear) — preserva firma XAdES.

**Errores (todos como `FacturaExtractionError`, sin retry):**
- `XMLSyntaxError` (lxml) → el parser lo atrapa y lo re-lanza como `FacturaExtractionError("XML inválido: <detalle>")`.
- Namespace desconocido → `FacturaExtractionError("Versión XML no soportada: <ns>")`.
- Falla de validación XSD → `FacturaExtractionError("XSD: <detalle>")`.

`confidence_score` para XML queda `None` (no aplica self-assessment a un parser determinista).

### 7.2 OCR con Gemini Flash-Lite (`ocr_invoice_gemini`)

**Función:** `ocr_invoice_gemini(file_path) -> (dict, float)`.

- Modelo: **`gemini-3.1-flash-lite`** (versión `3.1-flash-lite-05-2026` al 2026-05-25). **Nota importante:** este modelo no está marcado explícitamente como "Stable" en el metadata de Google (a diferencia de `gemini-2.5-flash-lite`, descrito como "Stable version... released in July of 2025"). Google podría cambiarlo o discontinuarlo con poco aviso. **Plan de contingencia:** si aparecen fallos sistémicos (rate limits, breaking changes, deprecación), cambiar la constante `OCR_MODEL` en settings a `gemini-2.5-flash-lite` (estable, ~mismo costo y calidad). No usar el alias `gemini-flash-lite-latest` — apunta al experimental, con rate limits más estrictos.
- Subida: vía Files API para archivos > 5 MB, inline base64 para chicos.
- **Structured output** con `response_schema` (JSON Schema constrained):
  ```python
  schema = {
      "type": "object",
      "properties": {
          "emisor": {"type": "object", "properties": {
              "nombre": {"type": "string"},
              "identificacion": {"type": "string"},  # cédula jurídica/física
          }},
          "consecutivo": {"type": "string"},
          "clave": {"type": "string"},
          "fecha": {"type": "string", "format": "date"},
          "moneda": {"type": "string", "enum": ["CRC", "USD"]},
          "items": {"type": "array", "items": {"type": "object", "properties": {
              "descripcion": {"type": "string"},
              "cantidad": {"type": "number"},
              "unidad": {"type": "string"},
              "precio_unitario": {"type": "number"},
              "subtotal": {"type": "number"},  # pre-IVA
              "iva": {"type": "number"},
          }}},
          "subtotal": {"type": "number"},
          "iva": {"type": "number"},
          "total": {"type": "number"},
          "confianza": {"type": "number", "minimum": 0, "maximum": 1},
      },
      "required": ["emisor", "fecha", "total"],
  }
  ```
- Prompt: "Extraé los datos de esta factura costarricense. Si un campo no es legible, dejalo vacío en lugar de inventar. Reportá tu confianza self-assessment al final."
- Costo esperado: ~$0.30/mes para 900 facturas. Datos viajan a Google.
- **Privacidad:** API key en `.env`, nunca en código ni en spec. Nunca enviar XMLs ya parseados a Gemini (innecesario).

**Validaciones post-extracción:**
- Cédula jurídica/física/DIMEX: regex `^\d{9,12}$` (9=física CR, 10=jurídica CR, 11-12=DIMEX para residentes extranjeros). Si no matchea, warning.
- Total > 0.
- Fecha plausible (no antes de 2020, no después de hoy + 7 días).

### 7.3 Job `extract_invoice(factura_id)`

```python
from lxml.etree import XMLSyntaxError

def extract_invoice(factura_id):
    f = Factura.objects.get(id=factura_id)
    f.status = 'processing'
    f.save(update_fields=['status'])
    try:
        if f.source_type == 'xml':
            data = parse_comprobante_xml(f.archivo_original.path)
            f.tipo_comprobante = data['tipo']
            f.extracted_data = data
            f.confidence_score = None          # determinista, no aplica
        else:  # pdf | imagen
            data, confidence = ocr_invoice_gemini(f.archivo_original.path)
            f.extracted_data = data
            f.confidence_score = confidence
        f.status = 'extracted'
        f.save()
    except (FacturaExtractionError, XMLSyntaxError) as e:
        # Errores permanentes del archivo: no reintentar.
        # NO re-lanzamos: Django-Q2 reintenta cualquier excepción que escape de la task.
        f.status = 'error'
        f.error_message = str(e)
        f.save()
        return
    # Errores transitorios (httpx.HTTPError, TimeoutError, etc) NO se atrapan acá:
    # se dejan escapar para que Django-Q2 reintente según `max_attempts`.
```

**Retry policy — implementada dentro de la task, no en `Q_CLUSTER`:**
- **Errores permanentes** (archivo corrupto, schema no soportado, XML inválido): `status='error'`, sin retry.
- **Errores transitorios** (Gemini 5xx, timeout, error de red, 429): se dejan escapar; Django-Q2 los reintenta hasta `max_attempts: 3`.
- **Backoff por `Retry-After` y rate limits 429:** se implementa en `ocr_invoice_gemini` (no en `extract_invoice`) leyendo el header de la respuesta. Si Gemini pide >120s de espera, se aborta y se deja a Django-Q2 reintentar después.
- **`time.sleep()` dentro de la task** está limitado por `timeout: 180`. Backoffs largos (> 60s) **no se hacen con sleep**; se aborta y se reencola.

**Configuración Django-Q2:**
```python
Q_CLUSTER = {
    'name': 'construmaster',
    'workers': 2,
    'recycle': 500,
    'timeout': 180,        # 3 min máx por task
    'retry': 240,
    'max_attempts': 3,
    'queue_limit': 50,
    'bulk': 10,
    'redis': {'host': 'redis', 'port': 6379, 'db': 0},
}
```

### 7.4 Job `fetch_bccr_rates()` (cron diario)

- **Cron:** lunes-viernes 8:30 AM hora CR (UTC-6).
- **Cliente:** `httpx` propio (~30 LOC) contra la **API REST SDDE** del BCCR:
  - Base: `https://apim.bccr.fi.cr/SDDE/api/Bccr.GE.SDDE.Publico.Indicadores.API`
  - Endpoint principal: `GET /indicadoresEconomicos/{codigo}/series?fechaInicio={inicio}&fechaFin={fin}&idioma=es`
  - Fechas en formato `yyyy/mm/dd` (URL-encoded: `2026%2F05%2F25`).
- **Códigos:** 317 (compra), 318 (venta). Default para conversiones = **venta** (cumple Hacienda).
- **Auth:** header `Authorization: Bearer <BCCR_TOKEN>` (env var). Token se obtiene desde https://sdd.bccr.fi.cr/ → Mi perfil → Generar token.
- **Validación inicial del token:** management command `python manage.py verify_bccr_token` que hace una llamada al endpoint real de series (`GET /indicadoresEconomicos/318/series` para el día de hoy) y reporta éxito si HTTP 200. **No usar `POST /Usuario/ValideSuscripcion`** — en testing del 2026-05-25 ese endpoint devolvía HTTP 500 (parece bug del lado del BCCR). El endpoint de series es el que vamos a usar en producción de todas formas, así que es el smoke test correcto.
- **Response JSON:**
  ```json
  {
    "estado": true,
    "mensaje": "Consulta exitosa",
    "datos": [{
      "codigoIndicador": "318",
      "nombreIndicador": "Tipo cambio venta",
      "series": [{"fecha": "2026-05-25", "valorDatoPorPeriodo": 508.50}]
    }]
  }
  ```
- **Si `series` vacío o `valorDatoPorPeriodo: null`** (fin de semana / feriado): no hacer nada, retornar.
- **Si valor:** `ExchangeRate.objects.update_or_create(currency='USD', date=fecha, defaults={'buy': X, 'sell': Y})`.
- **Retry:** si falla (401 token rechazado, 5xx, timeout), cada 30 min hasta las 18:00. Después: log CRITICAL.
- **Manejo de errores:** 400/500 devuelven `{"CodigoError": "400", "Mensaje": "..."}` — lanzar `BCCRError(mensaje)`.

**Backfill inicial:** management command `python manage.py backfill_bccr_rates --desde 2020-01-01`. Una sola llamada al BCCR con rango completo (la API soporta `fechaInicio`/`fechaFin` arbitrarios), idempotente.

**Snippet del cliente:**
```python
# apps/finance/bccr_client.py
import httpx
from datetime import date

BASE_URL = "https://apim.bccr.fi.cr/SDDE/api/Bccr.GE.SDDE.Publico.Indicadores.API"

class BCCRError(Exception):
    """Error retornado por el BCCR con mensaje legible."""

def fetch_series(codigo: int, desde: date, hasta: date, token: str) -> list[tuple[date, float | None]]:
    r = httpx.get(
        f"{BASE_URL}/indicadoresEconomicos/{codigo}/series",
        params={
            "fechaInicio": desde.strftime("%Y/%m/%d"),
            "fechaFin": hasta.strftime("%Y/%m/%d"),
            "idioma": "es",
        },
        headers={"Authorization": f"Bearer {token}"},
        timeout=20,
    )
    # NO usar r.raise_for_status() — necesitamos leer el cuerpo de error del BCCR
    # antes de levantar excepción.
    if r.status_code >= 400:
        try:
            err = r.json()  # {"CodigoError": "400", "Mensaje": "..."}
            raise BCCRError(f"HTTP {r.status_code}: {err.get('Mensaje', r.text[:200])}")
        except ValueError:  # cuerpo no era JSON (p.ej. página 411 en HTML)
            raise BCCRError(f"HTTP {r.status_code}: {r.text[:200]}")
    data = r.json()
    if not data.get("estado"):
        raise BCCRError(data.get("mensaje", "error desconocido"))
    series = data["datos"][0]["series"] if data["datos"] else []
    return [(date.fromisoformat(s["fecha"][:10]), s.get("valorDatoPorPeriodo")) for s in series]
```

### 7.5 Notificación al frontend (HTMX polling)

Patrón estándar Django + HTMX cada 2s, sin websockets ni SSE.

```html
<div id="factura-status"
     hx-get="{% url 'facturas:status' factura.id %}"
     hx-trigger="every 2s"
     hx-swap="outerHTML">
  {% include 'facturas/_status_partial.html' %}
</div>
```

Cuando `status ∈ {extracted, confirmed, error}` el partial devuelto ya no tiene `hx-trigger` → polling se detiene automáticamente.

Si `status == 'processing'` por más de 5 min → botón "Reintentar manualmente".

---

## 8. Archivos y storage

### 8.1 Layout por obra

```
/var/data/files/
├── obras/
│   └── <obra_id>-<obra_slug>/
│       ├── cotizaciones/<cotizacion_id>-<sha256[:8]>.<ext>
│       ├── ordenes_compra/
│       │   └── <oc_id>-<oc_numero>/
│       │       ├── facturas/<factura_id>-<sha256[:8]>.<ext>
│       │       ├── pagos/<pago_id>-<sha256[:8]>.<ext>
│       │       └── entregas/<entrega_id>/<foto_id>-<sha256[:8]>.<ext>
│       └── otros/
└── tmp/<upload_session_uuid>/...
```

- Hash sha256 corto en filename → defense-in-depth contra enumeración.
- Particionado por obra → backup/archive selectivo trivial.
- Rename de obra no mueve archivos (slug histórico en path es OK porque acceso es por URL, no path).

### 8.2 Storage backend

```python
STORAGES = {
    "default": {
        "BACKEND": "django.core.files.storage.FileSystemStorage",
        "OPTIONS": {"location": "/var/data/files", "base_url": "/media/"},
    },
    "staticfiles": {
        "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage",
    },
}
```

Switch a S3-compatible (R2/MinIO) cambia solo env vars (`S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`) y el `BACKEND` a `storages.backends.s3.S3Storage`. Cero cambio en modelos.

### 8.3 Acceso a archivos

URLs `/media/...` directas **no se exponen**. Cada download pasa por vista Django con `@login_required` + verificación de permisos a nivel de modelo (sin `obj`, porque el `ModelBackend` nativo no soporta permisos por objeto — eso requiere `django-guardian`, fuera del MVP por §11.5):

```python
@login_required
def factura_archivo(request, pk):
    f = get_object_or_404(Factura, pk=pk)
    if not request.user.has_perm('facturas.view_factura'):
        raise PermissionDenied
    return FileResponse(f.archivo_original.open('rb'), ...)
```

En MVP todos los `operativo` y `lector` ven todas las obras (decisión documentada en §5). El permiso a nivel de modelo es suficiente. Cuando agreguemos segregación por-obra (roadmap §11.5), agregamos `django-guardian` y el chequeo se vuelve `has_perm('facturas.view_factura', f.oc.obra)`.

### 8.4 Subida

- **Tamaño máximo: 20 MB.** Validación explícita en el form/vista:
  ```python
  MAX_UPLOAD_SIZE = 20 * 1024 * 1024  # 20 MB

  def clean_archivo(self):
      f = self.cleaned_data['archivo']
      if f and f.size > MAX_UPLOAD_SIZE:
          raise ValidationError(f"Archivo excede 20 MB ({f.size / 1024 / 1024:.1f} MB).")
      return f
  ```
  Aclaración: el setting `FILE_UPLOAD_MAX_MEMORY_SIZE` **no es un tope**, solo decide cuándo se pasa a archivo temporal en disco. El límite real se valida explícitamente en el form. `DATA_UPLOAD_MAX_MEMORY_SIZE` tampoco aplica (excluye campos de archivo).
- **Whitelist de mimetypes:** `application/xml`, `application/pdf`, `image/jpeg`, `image/png`, `image/heic`, `image/webp`.
- **Renombrado al guardar** (sha256 + ext normalizada). Nunca confiar en filename del cliente.
- **HEIC (iPhone) → JPEG** con `pyheif` + Pillow.
- **EXIF preservado** en fotos de entrega (la geolocalización es **evidencia útil** de que el material llegó a la obra; borrarla quita valor probatorio). Si en el futuro se abre a usuarios externos o aparece concern de privacidad, se puede agregar stripping opcional por categoría de foto. En MVP los uploaders son ADITA (identificados, contractualmente vinculados).

### 8.5 Backups

- **Postgres:** `pg_dump --format=custom` diario via container sidecar, retención 30 días.
- **Archivos:** `tar zst` incremental cada 12h al NAS Synology via NFS bind mount, retención 90 días.
- **Volúmenes nombrados** en Docker Compose (no bind mounts con paths absolutos del host) → migración a VPS sin fricción.
- **Pruebas de restore:** mensual, en container desechable, validar `count(*)` de tablas críticas.

### 8.6 Sin antimalware en MVP

Decisión consciente: 3-5 usuarios internos identificados; archivos no se ejecutan ni se sirven como HTML/JS. Riesgo aceptable. Anotar para revisión si se abre a más usuarios.

---

## 9. Multi-moneda y BCCR

### 9.1 Principios

- **Cada monto** (Cotización, OC, Pago, Factura, Presupuesto) tiene moneda original (CRC | USD).
- **Snapshot at write-time:** al crear/aprobar, guardar `fx_rate_applied` y `fx_rate_date`. Inmutable después.
- **Conversión at read-time** para reportes via función única.
- **Tipo de cambio venta (cód 318)** del BCCR es el default (cumple Hacienda).
- **Override manual** del TC permitido para supervisor (caso: contrato pactado con TC distinto).

### 9.2 Modelo `ExchangeRate` (descrito en Sección 4.4)

Lookup con arrastre:
```python
@classmethod
def for_date(cls, currency: str, on_date: date, side: str = 'sell') -> Decimal:
    rate = cls.objects.filter(currency=currency, date__lte=on_date).order_by('-date').first()
    if not rate:
        raise NoExchangeRateAvailable(f"No hay TC para {currency} en o antes de {on_date}")
    return rate.sell if side == 'sell' else rate.buy
```

### 9.3 Función única de conversión

```python
def convert(amount: Money, to_currency: str, on_date: date, side: str = 'sell') -> Money:
    """Convierte amount a to_currency. on_date es OBLIGATORIO (no default today() silencioso)."""
    if amount.currency.code == to_currency:
        return amount
    if amount.currency.code == 'CRC' and to_currency == 'USD':
        return Money(amount.amount / ExchangeRate.for_date('USD', on_date, side), 'USD')
    if amount.currency.code == 'USD' and to_currency == 'CRC':
        return Money(amount.amount * ExchangeRate.for_date('USD', on_date, side), 'CRC')
    raise UnsupportedConversion
```

**Regla de oro:** ninguna otra parte de la app **convierte montos** sin pasar por `convert()`. (Hacer `ExchangeRate.for_date()` directo para capturar el snapshot en `save()` de modelos — como en §9.4 — es válido, esa función es lookup puro; lo prohibido es construir conversiones ad-hoc como `monto / rate` dispersas por el código.)

### 9.4 Snapshot en modelos monetarios

`OrdenCompra.save()`, `Cotizacion.save()`, `Pago.save()`, `Factura.save()` capturan `fx_rate_applied` la primera vez (`if not self.pk`). Si el supervisor edita la fecha del documento después, re-disparar snapshot y registrar en audit log.

### 9.5 Reportes

- **Modo "histórico"** (default): cada línea usa su `fx_rate_applied` snapshot. Suma exacta de lo que costó en su momento.
- **Modo "valor a hoy"** (toggle UI): revaluar al TC actual. Útil para ver exposición FX.

Badge explícito en UI: "Valor histórico" o "Valor a hoy".

### 9.6 Agregaciones SQL (gotcha)

`MoneyField` guarda `amount` y `amount_currency` como columnas separadas.

**Patrón correcto:**
```python
qs.values('amount_currency').annotate(total=Sum('amount'))
```

**Patrón prohibido:** `qs.aggregate(total=Sum('amount'))` mezclando monedas.

### 9.7 Display (template tag)

`{{ amount|money_display:"USD" }}` → `$1,234.00 USD (≈ ₡628,000 CRC al TC ₡508.50 del 15-mar-2026)`. Implementación con `babel` y locale `es_CR`.

Settings:
```python
LANGUAGE_CODE = 'es-cr'
TIME_ZONE = 'America/Costa_Rica'
USE_TZ = True
USE_THOUSAND_SEPARATOR = True
DECIMAL_SEPARATOR = ','
THOUSAND_SEPARATOR = '.'
```

### 9.8 Decimales

- **Totales** (subtotal, IVA, total, monto OC, monto pago): `MoneyField(max_digits=14, decimal_places=2)`.
- **Precio unitario**: `DecimalField(max_digits=14, decimal_places=5)` (XML de Hacienda usa 5 decimales).
- **Cantidad** (items, entregas): `DecimalField(max_digits=12, decimal_places=4)`.
- **Tipo de cambio** (fx_rate_applied, ExchangeRate.buy/sell): `DecimalField(max_digits=12, decimal_places=5)`.
- Multiplicación `cantidad × precio_unitario` → `quantize(Decimal("0.01"), ROUND_HALF_UP)` antes de asignar a `subtotal`.
- Conversiones de moneda: `quantize(Decimal("0.01"), ROUND_HALF_UP)` antes de retornar desde `convert()`.

---

## 10. Reportes, dashboards, testing y deploy

### 10.1 Dashboards (3 vistas según rol)

**Supervisor — "/"**
- Obras activas con % presupuesto consumido (semáforo verde/amarillo/rojo a 70%/90%/100%).
- "Pendiente de mi acción": cotizaciones esperando aprobación, facturas `extracted` esperando confirmación, pagos programados sin marcar realizados, items del catálogo sugeridos pendientes.
- Gasto del mes en CRC + USD.
- Próximos hitos y pagos por vencer.

**Operativo — "/"**
- Mis obras activas con accesos rápidos: "+ Cotización", "+ Entrega", "Subir factura".
- "Pendiente de mi acción": RFQs abiertas, OCs autorizadas sin entrega, facturas que faltan por subir.

**Lector — "/"**
- Resumen por obra: % avance estimado, presupuesto vs ejecutado en USD (modo histórico default), gasto por categoría, hitos próximos.
- OCs grandes recientes.

### 10.2 Reportes específicos (exportables CSV/PDF)

- **Estado de cuenta por proveedor:** OCs, pagos hechos, pendientes, facturas asociadas.
- **Resumen de cotizaciones:** comparativo por categoría/material, qué proveedores ganan, precio promedio histórico.
- **Reconciliación pedido vs entregado:** por OC, qué items faltan; por material × obra, "compraron N, llegaron M, faltan K".
- **Histórico de tipo de cambio:** gráfica simple (Chart.js).
- **Auditoría:** vista del `django-auditlog`.

Export: `weasyprint` para PDF, `python-csv` para CSV. Sin reportes por email programados en MVP.

### 10.3 Testing

**Stack:** `pytest` + `pytest-django` + `factory_boy` + `freezegun`. Cobertura objetivo: ~70% líneas, **100% de servicios financieros** (`convert()`, snapshots, sumas multi-moneda).

**Capas:**
1. **Modelos y validaciones** (unit): snapshots fx_rate, cálculo de subtotales, permisos custom, state machines.
2. **Parser comprobantes** (unit con XMLs reales): fixtures de FE, TE, NC, ND en `apps/facturas/tests/fixtures/`. Asserts sobre el XML de Materiales La Costa.
3. **OCR mock** (unit): mock de Gemini API.
4. **Cliente BCCR mock** (unit): respuesta JSON exitosa con `estado: true`, respuesta de error con `{CodigoError, Mensaje}` (HTTP 400/500), token rechazado (HTTP 401), `series` vacío para fin de semana, `valorDatoPorPeriodo: null`.
5. **Flujo end-to-end** (integration con BD): crear obra → RFQ → cotización → aprobar → pago → factura → confirmar → entrega → OC completada. Verificar permisos por rol.
6. **Workers Django-Q2** (integration).
7. **Views/HTMX** (integration con Django test client).

**No se testea:** UI visual, performance, Gemini real (mocks en CI; smoke test manual al desplegar).

### 10.4 Deploy

**Repositorio:** `git@github.com:gabrielpc1190/construmaster.git`. Push directo a `main` (convención del usuario para repos personales).

**`docker-compose.yml` (resumen):**
```yaml
services:
  web:           # gunicorn + Django; sin ports: expuestos
  worker:        # qcluster, mismo image que web
  postgres:      # postgres:16.4 pinned, volume pgdata, healthcheck pg_isready
  redis:         # redis:7-alpine, maxmemory-policy allkeys-lru
  cloudflared:   # cloudflare/cloudflared:latest, token de env
  backup:        # sidecar con ofelia + pg_dump + tar zst
```

**Variables de entorno** (en `.env`, ver `.env.example`):
- `DJANGO_SECRET_KEY`, `DJANGO_DEBUG`, `DJANGO_ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`
- `DATABASE_URL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
- `REDIS_URL`, `CACHE_URL`
- `CLOUDFLARED_TOKEN`
- `BCCR_EMAIL`, `BCCR_TOKEN`
- `GEMINI_API_KEY`
- Email vars (opcional, futuro)

**Setup inicial (runbook):**
```bash
git clone git@github.com:gabrielpc1190/construmaster.git
cd construmaster
cp .env.example .env  # llenar
docker compose up -d
docker compose exec web python manage.py migrate
docker compose exec web python manage.py createsuperuser
docker compose exec web python manage.py seed_initial_data
docker compose exec web python manage.py backfill_bccr_rates --desde 2020-01-01
```

**Actualizaciones:**
```bash
git pull
docker compose build web worker
docker compose exec web python manage.py migrate
docker compose restart web worker
```

**CI/CD (GitHub Actions, simple):**
- `lint`: `ruff check`, `ruff format --check`.
- `test`: `pytest` con Postgres + Redis services.
- **Sin auto-deploy en MVP.** Actualización manual via `git pull` + `docker compose build`.

**Observabilidad mínima:**
- Logs a stdout (Docker logs).
- `django-q` admin para estado de tasks.
- Postgres slow query log (>1s).
- Sin Prometheus/Grafana en MVP.

**Backup verification:** mensual, restaurar último `pg_dump` en container desechable, validar conteos.

---

## 11. Roadmap (fuera del MVP)

Documentado para no perder ideas. Sin compromiso de timing.

### 11.1 Módulo 2 — Empleados

- Horas trabajadas (parte diario por obra), días libres, ausencias justificadas/injustificadas.
- Pagos a empleados (planilla quincenal/mensual).
- **EPP (equipo de protección personal):** registro de entrega de guantes, lentes, cascos a empleados; flujo "entregar nuevo contra recibir viejo"; alertas de EPP vencido.

### 11.2 Módulo 3 — Inventario

- Stock por `Bodega × ItemCatalogo`.
- Movimientos: entradas (entregas), salidas (consumos en obra), traslados entre bodegas, ajustes (mermas, robos).
- Cantidad mínima configurable por material × bodega.
- **Alerta Telegram** vía Hermes Agent cuando stock < mínimo.
- UI para registrar consumos diarios en obra.
- Cuando llegue: `Entrega.bodega_destino` se vuelve obligatorio.

### 11.3 Mensaje Receptor a Hacienda

Aceptación/rechazo de FE en 8 días hábiles del mes siguiente (obligación legal). Requiere certificado digital de persona jurídica de ADITA + firma XAdES. Fuera del MVP por complejidad regulatoria.

### 11.4 Multi-cliente

Estructura ya preparada (`Bodega` y `Obra` tienen FK a `Cliente`). Solo requiere UI para gestión de clientes y permisos por-cliente.

### 11.5 Mejoras menores

- Catálogo de materiales con foto y especificación técnica.
- Reportes programados por email/Telegram.
- SMTP outbound para password reset nativo de Django.
- Permisos por-obra (`django-guardian`) — hoy todos los operativos ven todas las obras.
- Auto-deploy via webhook GitHub Actions.
- Cloudflare Access como capa de SSO opcional encima de Django auth.
- `django-simple-history` para versiones completas de modelos críticos.
- Métricas con Prometheus + Grafana si crece el volumen.

---

## 12. Glosario

- **ADITA** — Empresa constructora dirigida por Tony y Adrián Vargas. Ejecuta obras para Nicholas.
- **BCCR** — Banco Central de Costa Rica. Publica tipo de cambio diario.
- **CABYS** — Catálogo de Bienes y Servicios (Hacienda CR). Código de 13 dígitos por producto.
- **FE / TE / NC / ND** — Factura / Tiquete / Nota de Crédito / Nota de Débito Electrónica (Hacienda CR).
- **GADI** — Una de las bodegas del cliente (Cuarto Eléctrico GADI).
- **Hito** — Etapa de cumplimiento de un servicio (anticipo, fabricación, instalación, etc).
- **OC** — Orden de Compra. Cotización aprobada que se ejecuta.
- **RFQ** — Solicitud de Cotización (Request for Quotation).
- **XAdES** — XML Advanced Electronic Signatures (ETSI). Estándar de firma de los XMLs de Hacienda.
