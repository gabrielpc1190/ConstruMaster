/**
 * Mapeo único de estados (cotizaciones, OCs) a {label, tone} para Badge.
 * Centralizado para evitar duplicar la lógica en cada listing/detail.
 */

export type BadgeTone = 'slate' | 'indigo' | 'emerald' | 'amber' | 'orange' | 'red' | 'blue';

export type CotizacionEstado = 'recibida' | 'en_revision' | 'aprobada' | 'rechazada' | 'vencida';
export type OcEstado =
  | 'autorizada'
  | 'pagada_parcial'
  | 'pagada'
  | 'entregada_parcial'
  | 'completada'
  | 'cancelada';

interface BadgeMeta {
  label: string;
  tone: BadgeTone;
}

export const COTIZACION_ESTADO_META: Record<CotizacionEstado, BadgeMeta> = {
  recibida: { label: 'Recibida', tone: 'slate' },
  en_revision: { label: 'En revisión', tone: 'blue' },
  aprobada: { label: 'Aprobada', tone: 'emerald' },
  rechazada: { label: 'Rechazada', tone: 'red' },
  vencida: { label: 'Vencida', tone: 'orange' },
};

export const OC_ESTADO_META: Record<OcEstado, BadgeMeta> = {
  autorizada: { label: 'Autorizada', tone: 'blue' },
  pagada_parcial: { label: 'Pagada parcial', tone: 'amber' },
  pagada: { label: 'Pagada', tone: 'emerald' },
  entregada_parcial: { label: 'Entrega parcial', tone: 'amber' },
  completada: { label: 'Completada', tone: 'emerald' },
  cancelada: { label: 'Cancelada', tone: 'red' },
};

export function cotizacionMeta(estado: string): BadgeMeta {
  return COTIZACION_ESTADO_META[estado as CotizacionEstado] ?? { label: estado, tone: 'slate' };
}

export function ocMeta(estado: string): BadgeMeta {
  return OC_ESTADO_META[estado as OcEstado] ?? { label: estado, tone: 'slate' };
}
