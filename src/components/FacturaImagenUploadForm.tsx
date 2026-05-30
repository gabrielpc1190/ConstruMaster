/**
 * Upload de FACTURAS NO-ELECTRÓNICAS (PDF/imagen) que pasan por OCR Gemini.
 *
 * Mismo patrón que `FacturaUploadForm.tsx` (Select de OC + drag-drop + submit)
 * pero acepta PDF/JPG/PNG/HEIC/HEIF/WEBP en lugar de XML, postea a
 * `POST /api/facturas/upload-imagen/:ocId` y avisa al supervisor que el
 * resultado depende del OCR — los datos pendientes de confirmar tardan hasta
 * 30s y conviene revisarlos antes de marcar la factura como válida.
 *
 * Comparado con el flujo XML:
 *  - El upload puede demorar ~10-30s porque Gemini analiza inline (sin worker).
 *  - El `status` final puede ser `extracted` o `error` (si el OCR falla).
 *  - El listado de OCs facturables es el mismo (`OC_ESTADOS_VALIDOS`).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UploadCloud, FileText, X, Sparkles } from 'lucide-react';
import { api, type ApiError } from '../services/api';
import { useList } from '../hooks/useApi';
import { useToast } from '../context/ToastContext';
import { Button } from './ui/Button';
import { Select, Field } from './ui/Input';
import { formatMoney, type Money } from '../lib/format';
import { cn } from '../lib/cn';

interface ProveedorMini {
  id: number;
  nombre: string;
}
interface OcMini {
  id: number;
  numeroOc: string;
  proveedor: ProveedorMini;
  estado: string;
  montoTotal?: Money | null;
}

interface FacturaCreated {
  id: number;
  status: 'pending' | 'processing' | 'extracted' | 'confirmed' | 'error';
  errorMessage?: string | null;
}

// OCs en estados aptos para recibir facturas (mismo set que el flujo XML).
const OC_ESTADOS_VALIDOS = [
  'autorizada',
  'pagada_parcial',
  'pagada',
  'entregada_parcial',
];

const ACCEPTED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
]);
const ACCEPTED_EXT_RE = /\.(pdf|jpg|jpeg|png|heic|heif|webp)$/i;
const ACCEPT_ATTR =
  '.pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,application/pdf,image/jpeg,image/png,image/heic,image/heif,image/webp';
const MAX_SIZE_BYTES = 20 * 1024 * 1024;

interface Props {
  /** Pre-selecciona una OC (ej. desde FacturaDetail "Subir de nuevo"). */
  initialOcId?: number;
  onUploaded?: (factura: FacturaCreated) => void;
  onCancel?: () => void;
}

function isAcceptedFile(f: File): boolean {
  if (ACCEPTED_MIME.has(f.type)) return true;
  return ACCEPTED_EXT_RE.test(f.name);
}

export function FacturaImagenUploadForm({
  initialOcId,
  onUploaded,
  onCancel,
}: Props) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  const [ocId, setOcId] = useState<number | ''>(initialOcId ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [errors, setErrors] = useState<{ ocId?: string; file?: string }>({});

  const ocsQuery = useList<OcMini>(
    ['ocs', { facturables: true }],
    `/ocs?estado=${OC_ESTADOS_VALIDOS.join(',')}`,
  );

  const ocs = useMemo(() => {
    const list = ocsQuery.data ?? [];
    return list.filter((o) => OC_ESTADOS_VALIDOS.includes(o.estado));
  }, [ocsQuery.data]);

  useEffect(() => {
    if (initialOcId) setOcId(initialOcId);
  }, [initialOcId]);

  const uploadMutation = useMutation<
    FacturaCreated,
    ApiError,
    { ocId: number; file: File }
  >({
    mutationFn: ({ ocId: id, file: f }) => {
      const fd = new FormData();
      fd.append('archivo', f);
      return api.upload<FacturaCreated>(`/facturas/upload-imagen/${id}`, fd);
    },
  });

  const handleFile = (f: File | null) => {
    if (!f) {
      setFile(null);
      return;
    }
    if (!isAcceptedFile(f)) {
      setErrors((e) => ({
        ...e,
        file: 'Tipo no permitido. Subí PDF, JPG, PNG, HEIC o WEBP.',
      }));
      setFile(null);
      return;
    }
    if (f.size > MAX_SIZE_BYTES) {
      setErrors((e) => ({
        ...e,
        file: `Archivo demasiado grande (máx 20 MB; este pesa ${(f.size / 1024 / 1024).toFixed(1)} MB).`,
      }));
      setFile(null);
      return;
    }
    setErrors((e) => ({ ...e, file: undefined }));
    setFile(f);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const next: typeof errors = {};
    if (!ocId) next.ocId = 'Seleccioná la OC asociada.';
    if (!file) next.file = 'Adjuntá el archivo (PDF o foto).';
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    uploadMutation.mutate(
      { ocId: ocId as number, file: file as File },
      {
        onSuccess: (factura) => {
          qc.invalidateQueries({ queryKey: ['facturas'] });
          if (factura.status === 'error') {
            const msg = factura.errorMessage || 'No se pudo extraer la factura';
            showToast(`OCR falló: ${msg}`, 'error');
            onUploaded?.(factura);
            navigate(`/facturas/${factura.id}`);
            return;
          }
          showToast('Factura extraída. Revisá los datos antes de confirmar.', 'success');
          onUploaded?.(factura);
          navigate(`/facturas/${factura.id}`);
        },
        onError: (err) => {
          showToast(err.message || 'Error subiendo la factura escaneada', 'error');
        },
      },
    );
  };

  const clearFile = () => {
    setFile(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="flex items-start gap-3 rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-900">
        <Sparkles className="w-5 h-5 text-indigo-600 mt-0.5 shrink-0" />
        <p>
          Esta opción usa OCR Gemini para extraer los datos. El resultado queda
          pendiente de confirmar y tarda hasta <strong>30 segundos</strong>.
          Ideal para facturas que NO te enviaron en XML.
        </p>
      </div>

      <Field
        label="Orden de compra"
        required
        error={errors.ocId}
        hint={
          ocsQuery.isLoading
            ? 'Cargando OCs…'
            : `${ocs.length} OC(s) disponibles para facturación.`
        }
      >
        <Select
          value={ocId === '' ? '' : String(ocId)}
          onChange={(e) => {
            const v = e.target.value;
            setOcId(v === '' ? '' : Number(v));
            setErrors((er) => ({ ...er, ocId: undefined }));
          }}
          disabled={ocsQuery.isLoading || !!initialOcId}
        >
          <option value="">— Seleccionar OC —</option>
          {ocs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.numeroOc} — {o.proveedor?.nombre ?? 'Sin proveedor'}
              {o.montoTotal ? ` — ${formatMoney(o.montoTotal)}` : ''}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Factura escaneada (PDF / foto)"
        required
        error={errors.file}
        hint="Formatos: PDF, JPG, PNG, HEIC, WEBP · Máx 20 MB."
      >
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={cn(
            'relative flex flex-col items-center justify-center gap-2 px-6 py-10 rounded-lg border-2 border-dashed cursor-pointer transition-colors',
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
            accept={ACCEPT_ATTR}
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <div className="flex items-center gap-3 text-slate-700">
              <FileText className="w-8 h-8 text-emerald-600" />
              <div className="text-left">
                <p className="text-sm font-medium text-slate-900">{file.name}</p>
                <p className="text-xs text-slate-500">
                  {(file.size / 1024).toFixed(1)} KB
                </p>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  clearFile();
                }}
                className="ml-2 text-slate-400 hover:text-slate-700"
                aria-label="Quitar archivo"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <>
              <UploadCloud className="w-10 h-10 text-slate-400" />
              <p className="text-sm text-slate-600">
                Arrastrá el archivo acá o{' '}
                <span className="text-indigo-600 font-medium">
                  hacé click para elegirlo
                </span>
              </p>
              <p className="text-xs text-slate-400">
                PDF / foto del proveedor
              </p>
            </>
          )}
        </div>
      </Field>

      <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
        {onCancel && (
          <Button
            type="button"
            variant="secondary"
            onClick={onCancel}
            disabled={uploadMutation.isPending}
          >
            Cancelar
          </Button>
        )}
        <Button type="submit" disabled={uploadMutation.isPending}>
          {uploadMutation.isPending ? 'Procesando OCR…' : 'Subir y extraer'}
        </Button>
      </div>
    </form>
  );
}
