/**
 * Helpers de presentación: dinero y fechas en formato es-CR.
 */

export interface Money {
  amount: string | number;
  currency: 'CRC' | 'USD' | string;
}

const SYMBOLS: Record<string, string> = {
  CRC: '₡', // ₡
  USD: '$',
};

/**
 * Format a Money object like { amount: "12345.67", currency: "CRC" }
 * → "₡12,345.67". Tolerates null/undefined returning '—'.
 */
export function formatMoney(value?: Money | null): string {
  if (value == null || value.amount === undefined || value.amount === null) return '—';
  const num = typeof value.amount === 'string' ? Number(value.amount) : value.amount;
  if (!Number.isFinite(num)) return '—';
  const symbol = SYMBOLS[value.currency] ?? `${value.currency} `;
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
  return `${symbol}${formatted}`;
}

/**
 * ISO string → "DD/MM/YYYY" en locale es-CR. Devuelve '—' para vacíos.
 */
export function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('es-CR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d);
}

/**
 * ISO → "DD/MM/YYYY HH:mm" en locale es-CR. Devuelve '—' para vacíos.
 */
export function formatDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('es-CR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/**
 * ISO → "YYYY-MM-DD" para inputs type=date.
 */
export function toDateInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
