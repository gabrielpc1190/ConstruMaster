import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { UploadCloud, FileText, X, Loader2 } from 'lucide-react';
import { api, type ApiError } from '../services/api';
import { useToast } from '../context/ToastContext';
import { Button } from './ui/Button';
import { Drawer } from './ui/Drawer';
import { cn } from '../lib/cn';

/**
 * Modal/drawer drag-drop para subir un PDF o imagen de cotización a
 * `/api/cotizaciones/parse-document`. Cuando responde con `data` + `matches`,
 * invoca `onParsed(payload)` para que el padre navegue al form de creación
 * con el prefill.
 *
 * Patrón inspirado en `FacturaUploadForm.tsx` (sin copiar código): los XMLs
 * de factura se suben directo a una OC, acá el PDF se procesa, se descarta
 * el archivo, y el form recibe el JSON estructurado.
 */

const ACCEPT_MIMES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
];

const ACCEPT_EXTS = ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp'];

const MAX_SIZE = 20 * 1024 * 1024; // 20 MiB

export interface ParsedCotizacion {
  data: {
    proveedor?: { nombre?: string; identificacion?: string; telefono?: string; email?: string };
    numeroCotizacion?: string;
    fecha?: string;
    fechaValidez?: string;
    moneda?: 'CRC' | 'USD';
    condicionesPago?: string;
    plazoEntregaDias?: number;
    pctAnticipo?: number;
    items?: Array<{
      descripcion?: string;
      cantidad?: number;
      unidad?: string;
      precioUnitario?: number;
      subtotal?: number;
      ivaMonto?: number;
    }>;
    subtotal?: number;
    iva?: number;
    total?: number;
    notas?: string;
  };
  model?: string;
  warnings?: string[];
  matches?: {
    proveedorId?: number | null;
    proveedorNombre?: string | null;
    items?: Array<{
      descripcion?: string;
      cantidad?: number;
      unidad?: string;
      precioUnitario?: number;
      subtotal?: number;
      ivaMonto?: number;
      materialId?: number | null;
      materialNombre?: string | null;
    }>;
  };
}

interface Props {
  open: boolean;
  onClose: () => void;
  onParsed: (parsed: ParsedCotizacion) => void;
}

function isValidFile(f: File): { ok: boolean; reason?: string } {
  if (f.size > MAX_SIZE) return { ok: false, reason: 'Archivo > 20 MB.' };
  const lower = f.name.toLowerCase();
  const extOk = ACCEPT_EXTS.some((e) => lower.endsWith(e));
  const mimeOk = !f.type || ACCEPT_MIMES.includes(f.type);
  if (!extOk && !mimeOk) return { ok: false, reason: 'Formato no soportado (PDF/JPG/PNG/HEIC/HEIF/WebP).' };
  return { ok: true };
}

export function CotizacionOcrModal({ open, onClose, onParsed }: Props) {
  const { showToast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const parseMutation = useMutation<ParsedCotizacion, ApiError, File>({
    mutationFn: (f) => {
      const fd = new FormData();
      fd.append('archivo', f);
      return api.upload<ParsedCotizacion>('/cotizaciones/parse-document', fd);
    },
  });

  const handleFile = (f: File | null) => {
    if (!f) {
      setFile(null);
      setFileError(null);
      return;
    }
    const v = isValidFile(f);
    if (!v.ok) {
      setFileError(v.reason ?? 'Archivo inválido.');
      setFile(null);
      return;
    }
    setFileError(null);
    setFile(f);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };

  const submit = () => {
    if (!file) {
      setFileError('Adjuntá un PDF o imagen.');
      return;
    }
    parseMutation.mutate(file, {
      onSuccess: (parsed) => {
        const w = parsed.warnings ?? [];
        if (w.length > 0) {
          showToast(`OCR ok con ${w.length} advertencia(s) — revisá los datos`, 'info');
        } else {
          showToast('OCR completado — revisá los datos antes de guardar', 'success');
        }
        onParsed(parsed);
        // Reset state al cerrar.
        setFile(null);
        if (inputRef.current) inputRef.current.value = '';
      },
      onError: (err) => {
        const msg = (err.payload as { detail?: string })?.detail || err.message || 'Error procesando documento';
        showToast(`OCR falló: ${msg}`, 'error');
      },
    });
  };

  const close = () => {
    if (parseMutation.isPending) return; // no cerrar mientras procesa
    setFile(null);
    setFileError(null);
    parseMutation.reset();
    onClose();
  };

  const pending = parseMutation.isPending;

  return (
    <Drawer
      open={open}
      onClose={close}
      title="Importar cotización desde PDF/foto"
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={close} disabled={pending}>
            Cancelar
          </Button>
          <Button type="button" onClick={submit} disabled={pending || !file}>
            {pending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Procesando…
              </>
            ) : (
              'Procesar con OCR'
            )}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          Subí el PDF o foto de la cotización del proveedor. El sistema extrae los datos con OCR
          (Gemini) y pre-llena el formulario para que revisés/edités antes de guardar.
        </p>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => !pending && inputRef.current?.click()}
          className={cn(
            'relative flex flex-col items-center justify-center gap-2 px-6 py-10 rounded-lg border-2 border-dashed transition-colors',
            pending && 'cursor-not-allowed opacity-60',
            !pending && 'cursor-pointer',
            dragOver
              ? 'border-indigo-500 bg-indigo-50'
              : file
              ? 'border-emerald-400 bg-emerald-50/40'
              : 'border-slate-300 hover:border-slate-400 bg-slate-50/40',
          )}
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT_EXTS.join(',')}
            className="hidden"
            disabled={pending}
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <div className="flex items-center gap-3 text-slate-700">
              <FileText className="w-8 h-8 text-emerald-600" />
              <div className="text-left">
                <p className="text-sm font-medium text-slate-900">{file.name}</p>
                <p className="text-xs text-slate-500">{(file.size / 1024).toFixed(1)} KB</p>
              </div>
              {!pending && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleFile(null);
                  }}
                  className="ml-2 text-slate-400 hover:text-slate-700"
                  aria-label="Quitar archivo"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          ) : (
            <>
              <UploadCloud className="w-10 h-10 text-slate-400" />
              <p className="text-sm text-slate-600">
                Arrastrá el archivo o{' '}
                <span className="text-indigo-600 font-medium">hacé click para elegirlo</span>
              </p>
              <p className="text-xs text-slate-400">
                PDF, JPG, PNG, HEIC, WebP — máx 20 MB
              </p>
            </>
          )}
        </div>

        {fileError && <p className="text-xs text-red-600">{fileError}</p>}

        {pending && (
          <div className="flex items-center gap-2 text-sm text-slate-600 bg-indigo-50 px-3 py-2 rounded">
            <Loader2 className="w-4 h-4 animate-spin text-indigo-600" />
            Procesando con Gemini OCR. Puede tomar 10-30 segundos.
          </div>
        )}
      </div>
    </Drawer>
  );
}
