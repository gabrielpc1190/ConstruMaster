/**
 * Componente reutilizable de upload de archivo de evidencia para cotizaciones.
 *
 * Estados visuales:
 *  - `cotizacionId == null` (modo create del form): muestra el panel pero
 *    deshabilitado, con un hint explicativo.
 *  - `cotizacionId != null` && `currentPath == null`: dropzone "Arrastrá un
 *    PDF o foto aquí" + botón "Seleccionar archivo".
 *  - `cotizacionId != null` && `currentPath != null`: card con icono + nombre
 *    + acciones "Ver" / "Reemplazar" / "Eliminar".
 *
 * El upload se hace a `POST /api/cotizaciones/:id/archivo` con field `archivo`.
 * Para "Ver" usamos blob URL autenticado (no `<a download>`) porque el
 * endpoint requiere `Authorization: Bearer <token>`.
 */
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { UploadCloud, FileText, FileImage, Trash2, ExternalLink, RefreshCw } from 'lucide-react';
import { api, type ApiError } from '../services/api';
import { useToast } from '../context/ToastContext';
import { Button } from './ui/Button';
import { cn } from '../lib/cn';
import { openAuthenticatedBlob } from '../lib/blob-download';

const ACCEPTED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
]);
const ACCEPTED_EXT_RE = /\.(pdf|jpg|jpeg|png|heic|heif|webp)$/i;
const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20 MiB
const ACCEPT_ATTR = '.pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,application/pdf,image/jpeg,image/png,image/heic,image/heif,image/webp';

interface UploadResponse {
  ok: boolean;
  archivoPath: string;
  sizeMb?: number | null;
}

interface Props {
  /** Id de la cotización. Si es null, el panel se muestra deshabilitado (modo create). */
  cotizacionId: number | null;
  /** Path actual del archivo (relativo a `uploads/`). null = no hay archivo aún. */
  currentPath: string | null;
  /** Si el usuario tiene permisos para borrar (admin/supervisor). */
  canDelete?: boolean;
  /** Si el usuario tiene permisos para escribir (admin/supervisor/operativo). */
  canWrite?: boolean;
  /** Callback tras un upload o delete exitoso. */
  onChange?: (newPath: string | null) => void;
  /** Forzar disabled (ej. cotización aprobada). */
  disabled?: boolean;
}

function isImagePath(path: string): boolean {
  return /\.(jpg|jpeg|png|heic|heif|webp)$/i.test(path);
}

function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path);
}

/** Extrae el nombre "humano" del archivo (sin el prefijo UUID del backend). */
function displayName(path: string): string {
  const base = path.split('/').pop() || path;
  return base.replace(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i,
    '',
  );
}

function isAcceptedFile(f: File): boolean {
  if (ACCEPTED_MIME.has(f.type)) return true;
  return ACCEPTED_EXT_RE.test(f.name);
}

export function CotizacionArchivoUpload({
  cotizacionId,
  currentPath,
  canDelete = false,
  canWrite = true,
  onChange,
  disabled = false,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { showToast } = useToast();
  const qc = useQueryClient();
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);

  const isLockedNew = cotizacionId == null;

  async function handleFile(file: File | null) {
    if (!file) return;
    if (!cotizacionId) {
      showToast('Guardá la cotización primero', 'info');
      return;
    }
    if (!isAcceptedFile(file)) {
      showToast('Tipo de archivo no permitido (PDF / JPG / PNG / HEIC / WEBP)', 'error');
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      showToast(`Archivo demasiado grande (máx 20 MB; este pesa ${(file.size / 1024 / 1024).toFixed(1)} MB)`, 'error');
      return;
    }

    const fd = new FormData();
    fd.append('archivo', file);

    setBusy(true);
    try {
      const resp = await api.upload<UploadResponse>(
        `/cotizaciones/${cotizacionId}/archivo`,
        fd,
      );
      showToast('Archivo adjuntado', 'success');
      qc.invalidateQueries({ queryKey: ['cotizaciones'] });
      qc.invalidateQueries({ queryKey: ['cotizaciones', cotizacionId] });
      onChange?.(resp.archivoPath);
    } catch (err) {
      const e = err as ApiError;
      showToast(e.message || 'Error subiendo el archivo', 'error');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function handleView() {
    if (!cotizacionId) return;
    try {
      await openAuthenticatedBlob({ path: `/cotizaciones/${cotizacionId}/archivo` });
    } catch (err) {
      showToast(`No se pudo abrir el archivo: ${(err as Error).message}`, 'error');
    }
  }

  async function handleDelete() {
    if (!cotizacionId) return;
    if (!confirm('¿Eliminar el archivo de evidencia? Esta acción no se puede deshacer.')) return;
    setBusy(true);
    try {
      await api.delete(`/cotizaciones/${cotizacionId}/archivo`);
      showToast('Archivo eliminado', 'success');
      qc.invalidateQueries({ queryKey: ['cotizaciones'] });
      qc.invalidateQueries({ queryKey: ['cotizaciones', cotizacionId] });
      onChange?.(null);
    } catch (err) {
      const e = err as ApiError;
      showToast(e.message || 'Error eliminando el archivo', 'error');
    } finally {
      setBusy(false);
    }
  }

  function openPicker() {
    if (disabled || busy || isLockedNew || !canWrite) return;
    inputRef.current?.click();
  }

  // === Render ===

  // Estado 1: pre-create (no hay id todavía)
  if (isLockedNew) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-8 rounded-lg border-2 border-dashed border-slate-200 bg-slate-50/60 text-center">
        <UploadCloud className="w-8 h-8 text-slate-300" />
        <p className="text-sm font-medium text-slate-500">Archivo de evidencia</p>
        <p className="text-xs text-slate-400 max-w-xs">
          Guardá la cotización primero para poder adjuntar el PDF / foto de la cotización del proveedor.
        </p>
      </div>
    );
  }

  // Estado 2: ya hay un archivo cargado
  if (currentPath) {
    const name = displayName(currentPath);
    const Icon = isImagePath(currentPath) ? FileImage : FileText;
    return (
      <div className="flex flex-wrap items-center gap-3 p-4 rounded-lg bg-white ring-1 ring-slate-200">
        <Icon className="w-8 h-8 text-indigo-500 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-900 truncate" title={name}>{name}</p>
          <p className="text-xs text-slate-500">
            {isPdfPath(currentPath) ? 'Documento PDF' : isImagePath(currentPath) ? 'Imagen' : 'Archivo'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button type="button" variant="secondary" size="sm" onClick={handleView} disabled={busy}>
            <ExternalLink className="w-4 h-4" /> Ver
          </Button>
          {canWrite && !disabled && (
            <Button type="button" variant="secondary" size="sm" onClick={openPicker} disabled={busy}>
              <RefreshCw className="w-4 h-4" /> {busy ? 'Subiendo…' : 'Reemplazar'}
            </Button>
          )}
          {canDelete && !disabled && (
            <Button type="button" variant="danger" size="sm" onClick={handleDelete} disabled={busy}>
              <Trash2 className="w-4 h-4" /> Eliminar
            </Button>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTR}
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
        />
      </div>
    );
  }

  // Estado 3: cotización existe pero sin archivo → dropzone
  const writable = canWrite && !disabled && !busy;
  return (
    <div
      onDragOver={(e) => {
        if (!writable) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!writable) return;
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) handleFile(f);
      }}
      onClick={openPicker}
      className={cn(
        'relative flex flex-col items-center justify-center gap-2 px-6 py-8 rounded-lg border-2 border-dashed transition-colors text-center',
        writable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
        dragOver
          ? 'border-indigo-500 bg-indigo-50'
          : 'border-slate-300 hover:border-slate-400 bg-slate-50/40',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
      />
      <UploadCloud className={cn('w-10 h-10', dragOver ? 'text-indigo-500' : 'text-slate-400')} />
      <p className="text-sm text-slate-600">
        Arrastrá un PDF o foto acá o{' '}
        <span className="text-indigo-600 font-medium">hacé click para elegirlo</span>
      </p>
      <p className="text-xs text-slate-400">
        Formatos: PDF, JPG, PNG, HEIC, WEBP · Máx 20 MB
      </p>
      {busy && <p className="text-xs text-indigo-600 font-medium">Subiendo…</p>}
      {!writable && !busy && (
        <p className="text-xs text-slate-500">
          {canWrite ? 'Edición deshabilitada' : 'No tenés permisos para adjuntar archivos.'}
        </p>
      )}
    </div>
  );
}
