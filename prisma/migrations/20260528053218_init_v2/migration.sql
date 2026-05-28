-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'supervisor', 'operativo', 'lector');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('CRC', 'USD');

-- CreateEnum
CREATE TYPE "ObraEstado" AS ENUM ('planificada', 'en_curso', 'pausada', 'finalizada');

-- CreateEnum
CREATE TYPE "ItemTipo" AS ENUM ('material', 'servicio');

-- CreateEnum
CREATE TYPE "ItemEstado" AS ENUM ('pendiente', 'aprobado', 'inactivo');

-- CreateEnum
CREATE TYPE "ItemUnidad" AS ENUM ('saco', 'kg', 'm3', 'm2', 'm', 'unidad', 'varilla', 'galon', 'litro', 'hora', 'dia', 'visita', 'global', 'mes');

-- CreateEnum
CREATE TYPE "ExchangeRateSource" AS ENUM ('bccr', 'manual');

-- CreateEnum
CREATE TYPE "RfqEstado" AS ENUM ('abierta', 'cerrada', 'cancelada');

-- CreateEnum
CREATE TYPE "CotizacionEstado" AS ENUM ('recibida', 'en_revision', 'aprobada', 'rechazada', 'vencida');

-- CreateEnum
CREATE TYPE "OcEstado" AS ENUM ('autorizada', 'pagada_parcial', 'pagada', 'entregada_parcial', 'completada', 'cancelada');

-- CreateEnum
CREATE TYPE "PagoMetodo" AS ENUM ('transferencia', 'cheque', 'efectivo', 'tarjeta', 'otro');

-- CreateEnum
CREATE TYPE "FacturaSourceType" AS ENUM ('xml', 'pdf', 'imagen');

-- CreateEnum
CREATE TYPE "FacturaTipo" AS ENUM ('FE', 'TE', 'NC', 'ND', 'FEC', 'FEE');

-- CreateEnum
CREATE TYPE "FacturaStatus" AS ENUM ('pending', 'processing', 'extracted', 'confirmed', 'error');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('create', 'update', 'delete');

-- CreateTable
CREATE TABLE "users" (
    "id" BIGSERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT,
    "email" TEXT,
    "role" "Role" NOT NULL DEFAULT 'operativo',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clientes" (
    "id" BIGSERIAL NOT NULL,
    "nombre" VARCHAR(200) NOT NULL,
    "identificacion" VARCHAR(50),
    "notas" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "clientes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "obras" (
    "id" BIGSERIAL NOT NULL,
    "cliente_id" BIGINT NOT NULL,
    "nombre" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "direccion" TEXT,
    "fecha_inicio" DATE,
    "fecha_fin_estimada" DATE,
    "moneda_reporte" "Currency" NOT NULL DEFAULT 'USD',
    "estado" "ObraEstado" NOT NULL DEFAULT 'planificada',
    "next_oc_seq" INTEGER NOT NULL DEFAULT 1,
    "notas" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "obras_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categorias_presupuesto" (
    "id" BIGSERIAL NOT NULL,
    "obra_id" BIGINT NOT NULL,
    "nombre" VARCHAR(100) NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "categorias_presupuesto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "presupuestos" (
    "id" BIGSERIAL NOT NULL,
    "obra_id" BIGINT NOT NULL,
    "categoria_id" BIGINT NOT NULL,
    "monto_amount" DECIMAL(15,2) NOT NULL,
    "monto_currency" "Currency" NOT NULL DEFAULT 'CRC',
    "notas" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "presupuestos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bodegas" (
    "id" BIGSERIAL NOT NULL,
    "cliente_id" BIGINT NOT NULL,
    "nombre" VARCHAR(120) NOT NULL,
    "direccion" TEXT,
    "responsable_id" BIGINT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "notas" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "bodegas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proveedores" (
    "id" BIGSERIAL NOT NULL,
    "nombre" VARCHAR(200) NOT NULL,
    "identificacion" VARCHAR(20),
    "email_facturacion" VARCHAR(254),
    "telefono" VARCHAR(30),
    "notas" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "proveedores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items_catalogo" (
    "id" BIGSERIAL NOT NULL,
    "tipo" "ItemTipo" NOT NULL,
    "nombre_canonico" VARCHAR(200) NOT NULL,
    "unidad" "ItemUnidad" NOT NULL,
    "categoria_sugerida_id" BIGINT,
    "slug" VARCHAR(220) NOT NULL,
    "alias" TEXT,
    "estado" "ItemEstado" NOT NULL DEFAULT 'aprobado',
    "sugerido_por_id" BIGINT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "items_catalogo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" BIGSERIAL NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "date" DATE NOT NULL,
    "buy" DECIMAL(12,5) NOT NULL,
    "sell" DECIMAL(12,5) NOT NULL,
    "fetched_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "ExchangeRateSource" NOT NULL DEFAULT 'bccr',

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "solicitudes_cotizacion" (
    "id" BIGSERIAL NOT NULL,
    "obra_id" BIGINT NOT NULL,
    "categoria_id" BIGINT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "fecha_requerida" DATE,
    "creada_por_id" BIGINT NOT NULL,
    "estado" "RfqEstado" NOT NULL DEFAULT 'abierta',
    "es_especial" BOOLEAN NOT NULL DEFAULT false,
    "notas" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "solicitudes_cotizacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cotizaciones" (
    "id" BIGSERIAL NOT NULL,
    "obra_id" BIGINT NOT NULL,
    "proveedor_id" BIGINT NOT NULL,
    "rfq_id" BIGINT,
    "numero_cotizacion" VARCHAR(80) NOT NULL,
    "fecha" DATE NOT NULL,
    "fecha_validez" DATE,
    "moneda" "Currency" NOT NULL DEFAULT 'CRC',
    "subtotal_amount" DECIMAL(15,2) NOT NULL,
    "subtotal_currency" "Currency" NOT NULL DEFAULT 'CRC',
    "iva_amount" DECIMAL(15,2) NOT NULL,
    "iva_currency" "Currency" NOT NULL DEFAULT 'CRC',
    "total_amount" DECIMAL(15,2) NOT NULL,
    "total_currency" "Currency" NOT NULL DEFAULT 'CRC',
    "condiciones_pago" VARCHAR(200),
    "plazo_entrega_dias" INTEGER,
    "pct_anticipo" DECIMAL(5,2),
    "archivo_path" TEXT,
    "es_especial" BOOLEAN NOT NULL DEFAULT false,
    "estado" "CotizacionEstado" NOT NULL DEFAULT 'recibida',
    "notas" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "cotizaciones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cotizacion_items" (
    "id" BIGSERIAL NOT NULL,
    "cotizacion_id" BIGINT NOT NULL,
    "material_id" BIGINT,
    "descripcion" VARCHAR(300) NOT NULL,
    "cantidad" DECIMAL(12,4) NOT NULL,
    "unidad" VARCHAR(20) NOT NULL,
    "precio_unitario" DECIMAL(14,5) NOT NULL,
    "subtotal" DECIMAL(15,2) NOT NULL,
    "iva_monto" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "codigo_cabys" VARCHAR(13),
    "orden" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "cotizacion_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ordenes_compra" (
    "id" BIGSERIAL NOT NULL,
    "obra_id" BIGINT NOT NULL,
    "categoria_id" BIGINT NOT NULL,
    "cotizacion_origen_id" BIGINT,
    "proveedor_id" BIGINT NOT NULL,
    "numero_oc" VARCHAR(80) NOT NULL,
    "fecha_aprobacion" DATE NOT NULL,
    "aprobada_por_id" BIGINT,
    "moneda" "Currency" NOT NULL DEFAULT 'CRC',
    "monto_total_amount" DECIMAL(15,2) NOT NULL,
    "monto_total_currency" "Currency" NOT NULL DEFAULT 'CRC',
    "fx_rate_applied" DECIMAL(12,5),
    "fx_rate_date" DATE,
    "es_especial" BOOLEAN NOT NULL DEFAULT false,
    "tiempo_estimado_dias" INTEGER,
    "pct_anticipo" DECIMAL(5,2),
    "estado" "OcEstado" NOT NULL DEFAULT 'autorizada',
    "notas" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ordenes_compra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orden_compra_items" (
    "id" BIGSERIAL NOT NULL,
    "oc_id" BIGINT NOT NULL,
    "material_id" BIGINT,
    "material_nombre_snapshot" VARCHAR(200),
    "material_unidad_snapshot" VARCHAR(20),
    "descripcion" VARCHAR(300) NOT NULL,
    "cantidad" DECIMAL(12,4) NOT NULL,
    "unidad" VARCHAR(20) NOT NULL,
    "precio_unitario" DECIMAL(14,5) NOT NULL,
    "subtotal" DECIMAL(15,2) NOT NULL,
    "iva_monto" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "codigo_cabys" VARCHAR(13),
    "orden" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "orden_compra_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hitos" (
    "id" BIGSERIAL NOT NULL,
    "oc_item_id" BIGINT NOT NULL,
    "nombre" VARCHAR(200) NOT NULL,
    "monto" DECIMAL(15,2),
    "fecha_estimada" DATE,
    "completado" BOOLEAN NOT NULL DEFAULT false,
    "fecha_completado" DATE,
    "notas" TEXT,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "hitos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pagos" (
    "id" BIGSERIAL NOT NULL,
    "oc_id" BIGINT NOT NULL,
    "fecha_programada" DATE NOT NULL,
    "fecha_realizada" DATE,
    "monto_amount" DECIMAL(15,2) NOT NULL,
    "monto_currency" "Currency" NOT NULL DEFAULT 'CRC',
    "metodo" "PagoMetodo" NOT NULL,
    "referencia" VARCHAR(120),
    "comprobante_path" TEXT,
    "registrado_por_id" BIGINT,
    "marcado_pagado_por_id" BIGINT,
    "fx_rate_applied" DECIMAL(12,5),
    "fx_rate_date" DATE,
    "notas" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "pagos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pago_hitos" (
    "pago_id" BIGINT NOT NULL,
    "hito_id" BIGINT NOT NULL,

    CONSTRAINT "pago_hitos_pkey" PRIMARY KEY ("pago_id","hito_id")
);

-- CreateTable
CREATE TABLE "facturas" (
    "id" BIGSERIAL NOT NULL,
    "oc_id" BIGINT NOT NULL,
    "source_type" "FacturaSourceType" NOT NULL,
    "tipo_comprobante" "FacturaTipo",
    "archivo_original_path" TEXT NOT NULL,
    "status" "FacturaStatus" NOT NULL DEFAULT 'pending',
    "extracted_data" JSONB NOT NULL DEFAULT '{}',
    "confidence_score" DOUBLE PRECISION,
    "clave_numerica" VARCHAR(50),
    "numero_consecutivo" VARCHAR(80),
    "fecha_emision" DATE,
    "monto_total_amount" DECIMAL(15,2),
    "monto_total_currency" "Currency",
    "condicion_venta" VARCHAR(2),
    "medios_pago" JSONB NOT NULL DEFAULT '[]',
    "fx_rate_applied" DECIMAL(12,5),
    "fx_rate_date" DATE,
    "confirmada_por_id" BIGINT,
    "error_message" TEXT,
    "notas" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "facturas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entregas" (
    "id" BIGSERIAL NOT NULL,
    "oc_id" BIGINT NOT NULL,
    "bodega_destino_id" BIGINT,
    "fecha" DATE NOT NULL,
    "recibido_por" VARCHAR(120) NOT NULL,
    "registrada_por_id" BIGINT NOT NULL,
    "completa" BOOLEAN NOT NULL DEFAULT false,
    "notas" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "entregas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entrega_items" (
    "id" BIGSERIAL NOT NULL,
    "entrega_id" BIGINT NOT NULL,
    "oc_item_id" BIGINT,
    "material_id" BIGINT,
    "descripcion" VARCHAR(300) NOT NULL,
    "cantidad" DECIMAL(12,4) NOT NULL,
    "unidad" VARCHAR(20) NOT NULL,
    "notas" TEXT,

    CONSTRAINT "entrega_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entrega_fotos" (
    "id" BIGSERIAL NOT NULL,
    "entrega_id" BIGINT NOT NULL,
    "archivo_path" TEXT NOT NULL,
    "subida_por_id" BIGINT NOT NULL,
    "fecha" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entrega_fotos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "model_name" VARCHAR(80) NOT NULL,
    "record_id" VARCHAR(40) NOT NULL,
    "action" "AuditAction" NOT NULL,
    "changes" JSONB NOT NULL DEFAULT '{}',
    "user_id" BIGINT,
    "ip_address" VARCHAR(45),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "clientes_nombre_idx" ON "clientes"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "obras_slug_key" ON "obras"("slug");

-- CreateIndex
CREATE INDEX "obras_cliente_id_idx" ON "obras"("cliente_id");

-- CreateIndex
CREATE INDEX "obras_estado_idx" ON "obras"("estado");

-- CreateIndex
CREATE INDEX "categorias_presupuesto_obra_id_orden_idx" ON "categorias_presupuesto"("obra_id", "orden");

-- CreateIndex
CREATE UNIQUE INDEX "categorias_presupuesto_obra_id_nombre_key" ON "categorias_presupuesto"("obra_id", "nombre");

-- CreateIndex
CREATE UNIQUE INDEX "presupuestos_obra_id_categoria_id_key" ON "presupuestos"("obra_id", "categoria_id");

-- CreateIndex
CREATE INDEX "bodegas_cliente_id_idx" ON "bodegas"("cliente_id");

-- CreateIndex
CREATE UNIQUE INDEX "bodegas_cliente_id_nombre_key" ON "bodegas"("cliente_id", "nombre");

-- CreateIndex
CREATE INDEX "proveedores_nombre_idx" ON "proveedores"("nombre");

-- CreateIndex
CREATE INDEX "items_catalogo_estado_idx" ON "items_catalogo"("estado");

-- CreateIndex
CREATE INDEX "items_catalogo_tipo_idx" ON "items_catalogo"("tipo");

-- CreateIndex
CREATE INDEX "items_catalogo_slug_idx" ON "items_catalogo"("slug");

-- CreateIndex
CREATE INDEX "items_catalogo_nombre_canonico_idx" ON "items_catalogo"("nombre_canonico");

-- CreateIndex
CREATE INDEX "exchange_rates_currency_date_idx" ON "exchange_rates"("currency", "date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_currency_date_key" ON "exchange_rates"("currency", "date");

-- CreateIndex
CREATE INDEX "solicitudes_cotizacion_obra_id_estado_idx" ON "solicitudes_cotizacion"("obra_id", "estado");

-- CreateIndex
CREATE INDEX "cotizaciones_obra_id_estado_idx" ON "cotizaciones"("obra_id", "estado");

-- CreateIndex
CREATE INDEX "cotizaciones_proveedor_id_idx" ON "cotizaciones"("proveedor_id");

-- CreateIndex
CREATE INDEX "cotizaciones_fecha_idx" ON "cotizaciones"("fecha" DESC);

-- CreateIndex
CREATE INDEX "cotizacion_items_cotizacion_id_orden_idx" ON "cotizacion_items"("cotizacion_id", "orden");

-- CreateIndex
CREATE INDEX "cotizacion_items_material_id_idx" ON "cotizacion_items"("material_id");

-- CreateIndex
CREATE UNIQUE INDEX "ordenes_compra_numero_oc_key" ON "ordenes_compra"("numero_oc");

-- CreateIndex
CREATE INDEX "ordenes_compra_obra_id_estado_idx" ON "ordenes_compra"("obra_id", "estado");

-- CreateIndex
CREATE INDEX "ordenes_compra_proveedor_id_idx" ON "ordenes_compra"("proveedor_id");

-- CreateIndex
CREATE INDEX "ordenes_compra_fecha_aprobacion_idx" ON "ordenes_compra"("fecha_aprobacion" DESC);

-- CreateIndex
CREATE INDEX "orden_compra_items_oc_id_orden_idx" ON "orden_compra_items"("oc_id", "orden");

-- CreateIndex
CREATE INDEX "orden_compra_items_material_id_idx" ON "orden_compra_items"("material_id");

-- CreateIndex
CREATE INDEX "hitos_oc_item_id_orden_idx" ON "hitos"("oc_item_id", "orden");

-- CreateIndex
CREATE INDEX "pagos_oc_id_idx" ON "pagos"("oc_id");

-- CreateIndex
CREATE INDEX "pagos_fecha_programada_idx" ON "pagos"("fecha_programada" DESC);

-- CreateIndex
CREATE INDEX "facturas_oc_id_idx" ON "facturas"("oc_id");

-- CreateIndex
CREATE INDEX "facturas_status_idx" ON "facturas"("status");

-- CreateIndex
CREATE INDEX "facturas_clave_numerica_idx" ON "facturas"("clave_numerica");

-- CreateIndex
CREATE INDEX "entregas_oc_id_fecha_idx" ON "entregas"("oc_id", "fecha" DESC);

-- CreateIndex
CREATE INDEX "entrega_items_entrega_id_idx" ON "entrega_items"("entrega_id");

-- CreateIndex
CREATE INDEX "entrega_items_oc_item_id_idx" ON "entrega_items"("oc_item_id");

-- CreateIndex
CREATE INDEX "entrega_fotos_entrega_id_fecha_idx" ON "entrega_fotos"("entrega_id", "fecha" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_model_name_record_id_idx" ON "audit_logs"("model_name", "record_id");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at" DESC);

-- AddForeignKey
ALTER TABLE "obras" ADD CONSTRAINT "obras_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "clientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categorias_presupuesto" ADD CONSTRAINT "categorias_presupuesto_obra_id_fkey" FOREIGN KEY ("obra_id") REFERENCES "obras"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "presupuestos" ADD CONSTRAINT "presupuestos_obra_id_fkey" FOREIGN KEY ("obra_id") REFERENCES "obras"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "presupuestos" ADD CONSTRAINT "presupuestos_categoria_id_fkey" FOREIGN KEY ("categoria_id") REFERENCES "categorias_presupuesto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bodegas" ADD CONSTRAINT "bodegas_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "clientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bodegas" ADD CONSTRAINT "bodegas_responsable_id_fkey" FOREIGN KEY ("responsable_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items_catalogo" ADD CONSTRAINT "items_catalogo_categoria_sugerida_id_fkey" FOREIGN KEY ("categoria_sugerida_id") REFERENCES "categorias_presupuesto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items_catalogo" ADD CONSTRAINT "items_catalogo_sugerido_por_id_fkey" FOREIGN KEY ("sugerido_por_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitudes_cotizacion" ADD CONSTRAINT "solicitudes_cotizacion_obra_id_fkey" FOREIGN KEY ("obra_id") REFERENCES "obras"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitudes_cotizacion" ADD CONSTRAINT "solicitudes_cotizacion_categoria_id_fkey" FOREIGN KEY ("categoria_id") REFERENCES "categorias_presupuesto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitudes_cotizacion" ADD CONSTRAINT "solicitudes_cotizacion_creada_por_id_fkey" FOREIGN KEY ("creada_por_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cotizaciones" ADD CONSTRAINT "cotizaciones_obra_id_fkey" FOREIGN KEY ("obra_id") REFERENCES "obras"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cotizaciones" ADD CONSTRAINT "cotizaciones_proveedor_id_fkey" FOREIGN KEY ("proveedor_id") REFERENCES "proveedores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cotizaciones" ADD CONSTRAINT "cotizaciones_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "solicitudes_cotizacion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cotizacion_items" ADD CONSTRAINT "cotizacion_items_cotizacion_id_fkey" FOREIGN KEY ("cotizacion_id") REFERENCES "cotizaciones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cotizacion_items" ADD CONSTRAINT "cotizacion_items_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "items_catalogo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ordenes_compra" ADD CONSTRAINT "ordenes_compra_obra_id_fkey" FOREIGN KEY ("obra_id") REFERENCES "obras"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ordenes_compra" ADD CONSTRAINT "ordenes_compra_categoria_id_fkey" FOREIGN KEY ("categoria_id") REFERENCES "categorias_presupuesto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ordenes_compra" ADD CONSTRAINT "ordenes_compra_cotizacion_origen_id_fkey" FOREIGN KEY ("cotizacion_origen_id") REFERENCES "cotizaciones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ordenes_compra" ADD CONSTRAINT "ordenes_compra_proveedor_id_fkey" FOREIGN KEY ("proveedor_id") REFERENCES "proveedores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ordenes_compra" ADD CONSTRAINT "ordenes_compra_aprobada_por_id_fkey" FOREIGN KEY ("aprobada_por_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orden_compra_items" ADD CONSTRAINT "orden_compra_items_oc_id_fkey" FOREIGN KEY ("oc_id") REFERENCES "ordenes_compra"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orden_compra_items" ADD CONSTRAINT "orden_compra_items_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "items_catalogo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hitos" ADD CONSTRAINT "hitos_oc_item_id_fkey" FOREIGN KEY ("oc_item_id") REFERENCES "orden_compra_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos" ADD CONSTRAINT "pagos_oc_id_fkey" FOREIGN KEY ("oc_id") REFERENCES "ordenes_compra"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos" ADD CONSTRAINT "pagos_registrado_por_id_fkey" FOREIGN KEY ("registrado_por_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos" ADD CONSTRAINT "pagos_marcado_pagado_por_id_fkey" FOREIGN KEY ("marcado_pagado_por_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pago_hitos" ADD CONSTRAINT "pago_hitos_pago_id_fkey" FOREIGN KEY ("pago_id") REFERENCES "pagos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pago_hitos" ADD CONSTRAINT "pago_hitos_hito_id_fkey" FOREIGN KEY ("hito_id") REFERENCES "hitos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facturas" ADD CONSTRAINT "facturas_oc_id_fkey" FOREIGN KEY ("oc_id") REFERENCES "ordenes_compra"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facturas" ADD CONSTRAINT "facturas_confirmada_por_id_fkey" FOREIGN KEY ("confirmada_por_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entregas" ADD CONSTRAINT "entregas_oc_id_fkey" FOREIGN KEY ("oc_id") REFERENCES "ordenes_compra"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entregas" ADD CONSTRAINT "entregas_bodega_destino_id_fkey" FOREIGN KEY ("bodega_destino_id") REFERENCES "bodegas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entregas" ADD CONSTRAINT "entregas_registrada_por_id_fkey" FOREIGN KEY ("registrada_por_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entrega_items" ADD CONSTRAINT "entrega_items_entrega_id_fkey" FOREIGN KEY ("entrega_id") REFERENCES "entregas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entrega_items" ADD CONSTRAINT "entrega_items_oc_item_id_fkey" FOREIGN KEY ("oc_item_id") REFERENCES "orden_compra_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entrega_items" ADD CONSTRAINT "entrega_items_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "items_catalogo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entrega_fotos" ADD CONSTRAINT "entrega_fotos_entrega_id_fkey" FOREIGN KEY ("entrega_id") REFERENCES "entregas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entrega_fotos" ADD CONSTRAINT "entrega_fotos_subida_por_id_fkey" FOREIGN KEY ("subida_por_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
