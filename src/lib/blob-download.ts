/**
 * Helpers para abrir/descargar archivos que requieren auth via Authorization
 * header (no podemos usar `<a download>` ni `window.open` directo porque el
 * navegador no envía el Bearer token).
 *
 * Patrón: fetch → blob → URL.createObjectURL → window.open (preview inline) o
 * <a download> sintético (forzar descarga).
 */

interface AuthOptions {
  /** Token JWT. Si no se pasa, lo lee de localStorage('token'). */
  token?: string | null;
}

interface OpenOptions extends AuthOptions {
  /** Endpoint relativo a `/api`. Ej: `/cotizaciones/123/archivo`. */
  path: string;
  /** Nombre de archivo sugerido para el caso de descarga forzada (opcional). */
  filename?: string;
}

function authHeader(token?: string | null): HeadersInit | undefined {
  const t = token ?? localStorage.getItem('token');
  return t ? { Authorization: `Bearer ${t}` } : undefined;
}

async function fetchBlob({ path, token }: OpenOptions): Promise<Blob> {
  const res = await fetch(`/api${path}`, { headers: authHeader(token) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

/**
 * Abre un endpoint autenticado en una pestaña nueva como preview inline (PDF
 * o imagen). El navegador decide si renderiza inline o fuerza descarga según
 * Content-Type y Content-Disposition.
 *
 * El blob URL queda vivo 60s para permitir que la pestaña termine de cargar y
 * luego se revoca para liberar memoria.
 */
export async function openAuthenticatedBlob(opts: OpenOptions): Promise<void> {
  const blob = await fetchBlob(opts);
  const url = URL.createObjectURL(blob);
  const w = window.open(url, '_blank', 'noopener,noreferrer');
  // Si el navegador bloquea el popup, caemos a un <a> sintético como fallback.
  if (!w) {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  // Revocamos después de 60s — la pestaña ya cargó.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Descarga forzada (Save As) — usa <a download> sintético sobre un blob URL.
 * Útil cuando explícitamente queremos guardar (vs ver) el archivo.
 */
export async function downloadAuthenticatedBlob(opts: OpenOptions): Promise<void> {
  const blob = await fetchBlob(opts);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  if (opts.filename) a.download = opts.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
