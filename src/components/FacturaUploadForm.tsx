import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UploadCloud, FileText, X } from 'lucide-react';
import { api, type ApiError } from '../services/api';
import { useList } from '../hooks/useApi';
import { useToast } from '../context/ToastContext';
import { Button } from './ui/Button';
import { Select, Field } from './ui/Input';
import { formatMoney, type Money } from '../lib/format';
import { cn } from '../lib/cn';

interface ProveedorMini { id: number; nombre: string }
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

interface DuplicateError {
  error: string;
  existingFacturaId: number;
}

// OCs en estados aptos para recibir facturas.
const OC_ESTADOS_VALIDOS = ['autorizada', 'pagada_parcial', 'pagada', 'entregada_parcial'];

interface Props {
  /** Pre-selecciona una OC (usado desde FacturaDetail "Subir de nuevo"). */
  initialOcId?: number;
  onUploaded?: (factura: FacturaCreated) => void;
  onCancel?: () => void;
}

export function FacturaUploadForm({ initialOcId, onUploaded, onCancel }: Props) {
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
    // Filtro defensivo en cliente por si el backend ignora el filtro.
    return list.filter((o) => OC_ESTADOS_VALIDOS.includes(o.estado));
  }, [ocsQuery.data]);

  useEffect(() => {
    if (initialOcId) setOcId(initialOcId);
  }, [initialOcId]);

  const uploadMutation = useMutation<FacturaCreated, ApiError, { ocId: number; file: File }>({
    mutationFn: ({ ocId: id, file: f }) => {
      const fd = new FormData();
      fd.append('archivo', f);
      return api.upload<FacturaCreated>(`/facturas/upload/${id}`, fd);
    },
  });

  const isValidXml = (f: File) => {
    const nameOk = f.name.toLowerCase().endsWith('.xml');
    const typeOk = !f.type || f.type === 'text/xml' || f.type === 'application/xml';
    return nameOk && typeOk;
  };

  const handleFile = (f: File | null) => {
    if (!f) {
      setFile(null);
      return;
    }
    if (!isValidXml(f)) {
      setErrors((e) => ({ ...e, file: 'El archivo debe ser un XML (.xml).' }));
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
    if (!file) next.file = 'Adjuntá el XML de la factura.';
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
            const msg = factura.errorMessage || 'XML inválido';
            showToast(`Factura cargada con error: ${msg}`, 'error');
            onUploaded?.(factura);
            // Aun así abrimos el detail para que se vea el error.
            navigate(`/facturas/${factura.id}`);
            return;
          }
          showToast('Factura extraída. Pendiente de confirmación.', 'success');
          onUploaded?.(factura);
          navigate(`/facturas/${factura.id}`);
        },
        onError: (err) => {
          if (err.status === 409) {
            const dup = err.payload as DuplicateError | undefined;
            const existingId = dup?.existingFacturaId;
            if (existingId) {
              showToast('Factura ya existe — abriendo la existente.', 'error');
              navigate(`/facturas/${existingId}`);
              return;
            }
            showToast('Factura ya existe.', 'error');
            return;
          }
          showToast(err.message || 'Error subiendo factura', 'error');
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
      <Field
        label="Orden de compra"
        required
        error={errors.ocId}
        hint={ocsQuery.isLoading ? 'Cargando OCs…' : `${ocs.length} OC(s) disponibles para facturación.`}
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

      <Field label="Archivo XML" required error={errors.file} hint="Solo se aceptan XMLs de Hacienda CR (.xml).">
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
            accept=".xml,text/xml,application/xml"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <div className="flex items-center gap-3 text-slate-700">
              <FileText className="w-8 h-8 text-emerald-600" />
              <div className="text-left">
                <p className="text-sm font-medium text-slate-900">{file.name}</p>
                <p className="text-xs text-slate-500">{(file.size / 1024).toFixed(1)} KB</p>
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
                Arrastrá el XML acá o <span className="text-indigo-600 font-medium">hacé click para elegirlo</span>
              </p>
              <p className="text-xs text-slate-400">Tamaño máximo recomendado: 2 MB</p>
            </>
          )}
        </div>
      </Field>

      <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel} disabled={uploadMutation.isPending}>
            Cancelar
          </Button>
        )}
        <Button type="submit" disabled={uploadMutation.isPending}>
          {uploadMutation.isPending ? 'Subiendo…' : 'Subir factura'}
        </Button>
      </div>
    </form>
  );
}
