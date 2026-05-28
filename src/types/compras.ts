/**
 * Tipos compartidos entre páginas de Cotizaciones y Órdenes de Compra.
 * Reflejan los contratos del backend (no incluyen TODOS los campos del schema,
 * solo lo que la UI consume).
 */
import type { Money } from '../lib/format';
import type { CotizacionEstado, OcEstado } from '../lib/badges';

export type Moneda = 'CRC' | 'USD';

export interface ObraLite {
  id: number;
  nombre: string;
  slug?: string;
  monedaReporte?: Moneda;
}

export interface ProveedorLite {
  id: number;
  nombre: string;
  cedulaJuridica?: string | null;
}

export interface CategoriaLite {
  id: number;
  nombre: string;
}

export interface CotizacionItem {
  id?: number;
  materialId?: number | null;
  descripcion: string;
  cantidad: number | string;
  unidad: string;
  precioUnitario: number | string;
  subtotal: number | string;
  ivaPct?: number | string | null;
  ivaMonto?: number | string | null;
  codigoCabys?: string | null;
  orden?: number;
}

export interface Cotizacion {
  id: number;
  obraId: number;
  obra?: ObraLite;
  proveedorId: number;
  proveedor?: ProveedorLite;
  rfqId?: number | null;
  numeroCotizacion: string;
  fecha: string;
  fechaValidez?: string | null;
  moneda: Moneda;
  subtotal: Money;
  iva: Money;
  total: Money;
  condicionesPago?: string | null;
  plazoEntregaDias?: number | null;
  pctAnticipo?: number | string | null;
  esEspecial?: boolean;
  archivoPath?: string | null;
  estado: CotizacionEstado;
  notas?: string | null;
  items?: CotizacionItem[];
  ocId?: number | null;
  oc?: { id: number; numeroOc: string } | null;
  createdAt: string;
}

export interface OcItem {
  id: number;
  materialId?: number | null;
  descripcion: string;
  cantidad: number | string;
  unidad: string;
  precioUnitario: number | string;
  subtotal: number | string;
  ivaPct?: number | string | null;
  ivaMonto?: number | string | null;
  orden?: number;
}

export interface Oc {
  id: number;
  obraId: number;
  obra?: ObraLite;
  proveedorId: number;
  proveedor?: ProveedorLite;
  cotizacionId?: number | null;
  categoriaId?: number | null;
  categoria?: CategoriaLite | null;
  numeroOc: string;
  fechaAprobacion: string;
  moneda: Moneda;
  montoTotal: Money;
  fxRateApplied?: number | string | null;
  fxRateDate?: string | null;
  estado: OcEstado;
  notas?: string | null;
  pctAnticipo?: number | string | null;
  tiempoEstimadoDias?: number | null;
  items?: OcItem[];
  pagos?: unknown[];
  entregas?: unknown[];
  facturas?: unknown[];
  _count?: { items?: number; pagos?: number; entregas?: number; facturas?: number };
}
