import { useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Download,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ExternalLink,
  RefreshCw,
} from 'lucide-react';
import { useItem } from '../hooks/useApi';
import { api, type ApiError } from '../services/api';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { Button } from '../components/ui/Button';
import { Textarea, Field } from '../components/ui/Input';
import { Badge } from '../components/ui/Badge';
import { Drawer } from '../components/ui/Drawer';
import { Table } from '../components/ui/Table';
import { formatMoney, formatDate, formatDateTime, type Money } from '../lib/format';
import {
  FACTURA_STATUS_LABELS,
  FACTURA_STATUS_TONES,
  FACTURA_TIPO_LABELS,
} from './Facturas';

type FacturaStatus = 'pending' | 'processing' | 'extracted' | 'confirmed' | 'error';
type FacturaTipo = 'FE' | 'TE' | 'NC' | 'ND' | 'FEC' | 'FEE';

interface ProveedorMini { id: number; nombre: string }
interface OcMini {
  id: number;
  numeroOc: string;
  proveedor: ProveedorMini;
  montoTotal?: Money | null;
}
interface UserMini { id: number; username: string; fullName?: string | null }

interface ExtractedParty {
  nombre?: string;
  identificacion?: string;
  tipoIdentificacion?: string;
  email?: string;
  telefono?: string;
}

interface ExtractedItem {
  codigoCabys?: string;
  descripcion?: string;
  cantidad?: number | string;
  unidadMedida?: string;
  precioUnitario?: number | string;
  subtotal?: number | string;
  ivaMonto?: number | string;
}

interface ExtractedTotals {
  subtotal?: number | string;
  iva?: number | string;
  total?: number | string;
}

interface ExtractedData {
  emisor?: ExtractedParty;
  receptor?: ExtractedParty;
  items?: ExtractedItem[];
  totales?: ExtractedTotals;
  [k: string]: unknown;
}

interface Factura {
  id: number;
  ocId: number;
  oc: OcMini;
  sourceType: 'xml' | 'pdf' | 'imagen';
  tipoComprobante: FacturaTipo;
  archivoOriginalPath?: string | null;
  status: FacturaStatus;
  extractedData?: ExtractedData | null;
  confidenceScore?: number | null;
  claveNumerica?: string | null;
  numeroConsecutivo?: string | null;
  fechaEmision?: string | null;
  montoTotal?: Money | null;
  condicionVenta?: string | null;
  mediosPago?: string[] | string | null;
  fxRateApplied?: string | number | null;
  fxRateDate?: string | null;
  confirmadaPor?: UserMini | null;
  confirmadaAt?: string | null;
  errorMessage?: string | null;
  notas?: string | null;
  createdAt: string;
  updatedAt?: string;
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="bg-white rounded-lg ring-1 ring-slate-200">
      <header className="px-5 h-11 flex items-center justify-between border-b border-slate-100">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {action}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs uppercase tracking-wide text-slate-500 font-medium">{label}</dt>
      <dd className="text-sm text-slate-900 break-words">{children ?? '—'}</dd>
    </div>
  );
}

function asNumber(v: number | string | undefined | null): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

function nMoney(amount: number | string | undefined | null, currency: string): Money | null {
  const n = asNumber(amount);
  if (n === null) return null;
  return { amount: n, currency: currency as Money['currency'] };
}

export default function FacturaDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { user, token } = useAuth();
  const qc = useQueryClient();

  const facturaId = Number(id);
  const { data: factura, isLoading, error } = useItem<Factura>(
    ['facturas', facturaId],
    `/facturas/${facturaId}`,
    Number.isFinite(facturaId),
  );

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [anularOpen, setAnularOpen] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [reuploadOpen, setReuploadOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const canActuar = user?.role === 'admin'; // tipo solo trae admin|user — supervisor mapearía al backend.

  const confirmMutation = useMutation<Factura, ApiError, void>({
    mutationFn: () => api.post<Factura>(`/facturas/${facturaId}/confirmar`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facturas'] });
      qc.invalidateQueries({ queryKey: ['facturas', facturaId] });
      showToast('Factura confirmada', 'success');
      setConfirmOpen(false);
    },
    onError: (err) => showToast(err.message || 'Error al confirmar', 'error'),
  });

  const anularMutation = useMutation<Factura, ApiError, { motivo?: string }>({
    mutationFn: (body) => api.post<Factura>(`/facturas/${facturaId}/anular`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['facturas'] });
      qc.invalidateQueries({ queryKey: ['facturas', facturaId] });
      showToast('Factura anulada', 'success');
      setAnularOpen(false);
      setMotivo('');
    },
    onError: (err) => showToast(err.message || 'Error al anular', 'error'),
  });

  // Descarga autenticada: fetch con Authorization → blob → click sintético en <a download>.
  const handleDownload = async () => {
    if (!factura) return;
    setDownloading(true);
    try {
      const res = await fetch(`/api/facturas/${factura.id}/archivo`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const fname =
        factura.archivoOriginalPath?.split('/').pop() ??
        `factura-${factura.numeroConsecutivo ?? factura.id}.xml`;
      a.href = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (e) {
      showToast(`No se pudo descargar el archivo: ${(e as Error).message}`, 'error');
    } finally {
      setDownloading(false);
    }
  };

  const mediosPagoText = useMemo(() => {
    if (!factura?.mediosPago) return null;
    return Array.isArray(factura.mediosPago) ? factura.mediosPago.join(', ') : factura.mediosPago;
  }, [factura]);

  if (isLoading) {
    return <div className="p-6 text-sm text-slate-500">Cargando factura…</div>;
  }
  if (error || !factura) {
    return (
      <div className="p-6">
        <Button variant="secondary" onClick={() => navigate('/facturas')}>
          <ArrowLeft className="w-4 h-4" /> Volver
        </Button>
        <p className="mt-4 text-sm text-red-600">Factura no encontrada o sin acceso.</p>
      </div>
    );
  }

  const monedaCurrency = factura.montoTotal?.currency ?? 'CRC';
  const items = factura.extractedData?.items ?? [];
  const totals = factura.extractedData?.totales ?? {};
  const emisor = factura.extractedData?.emisor;
  const receptor = factura.extractedData?.receptor;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <button
          onClick={() => navigate('/facturas')}
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800 mb-2"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Facturas
        </button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Badge tone="indigo" className="text-sm px-3 py-1 font-mono">
              {factura.tipoComprobante}
            </Badge>
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-slate-900 truncate">
                {factura.numeroConsecutivo ?? `Factura #${factura.id}`}
              </h1>
              <p className="text-xs text-slate-500">
                {FACTURA_TIPO_LABELS[factura.tipoComprobante]} ·{' '}
                <Badge tone={FACTURA_STATUS_TONES[factura.status]}>
                  {FACTURA_STATUS_LABELS[factura.status]}
                </Badge>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="secondary" onClick={handleDownload} disabled={downloading}>
              <Download className="w-4 h-4" /> {downloading ? 'Descargando…' : 'Descargar comprobante'}
            </Button>

            {factura.status === 'extracted' && canActuar && (
              <>
                <Button variant="danger" onClick={() => setAnularOpen(true)}>
                  <XCircle className="w-4 h-4" /> Anular
                </Button>
                <Button onClick={() => setConfirmOpen(true)} className="bg-emerald-600 hover:bg-emerald-700">
                  <CheckCircle2 className="w-4 h-4" /> Confirmar factura
                </Button>
              </>
            )}

            {factura.status === 'error' && (
              <Button variant="primary" onClick={() => setReuploadOpen(true)}>
                <RefreshCw className="w-4 h-4" /> Subir de nuevo
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Banner extracted */}
      {factura.status === 'extracted' && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-amber-900">
              Esta factura fue extraída automáticamente. Revisá los datos y confirmala.
            </p>
            {factura.confidenceScore != null && (
              <p className="text-xs text-amber-800 mt-0.5">
                Score de confianza: {(Number(factura.confidenceScore) * 100).toFixed(0)}%
              </p>
            )}
          </div>
          {canActuar && (
            <Button onClick={() => setConfirmOpen(true)} className="bg-emerald-600 hover:bg-emerald-700" size="sm">
              <CheckCircle2 className="w-4 h-4" /> Confirmar
            </Button>
          )}
        </div>
      )}

      {/* Banner confirmed */}
      {factura.status === 'confirmed' && factura.confirmadaPor && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
          <p className="text-sm text-emerald-900">
            Confirmada por <strong>{factura.confirmadaPor.fullName ?? factura.confirmadaPor.username}</strong>
            {factura.confirmadaAt && <> · {formatDateTime(factura.confirmadaAt)}</>}
          </p>
        </div>
      )}

      {/* Banner error */}
      {factura.status === 'error' && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 flex items-start gap-3">
          <XCircle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-red-900">La factura no pudo procesarse correctamente.</p>
            {factura.errorMessage && (
              <p className="text-xs text-red-800 mt-1 font-mono break-all">{factura.errorMessage}</p>
            )}
          </div>
        </div>
      )}

      {/* Información general */}
      <Section title="Información general">
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
          <Row label="Tipo de comprobante">
            <span className="font-mono mr-1">{factura.tipoComprobante}</span> ·{' '}
            <span className="text-slate-600">{FACTURA_TIPO_LABELS[factura.tipoComprobante]}</span>
          </Row>
          <Row label="Consecutivo">
            <span className="font-mono">{factura.numeroConsecutivo ?? '—'}</span>
          </Row>
          <Row label="Clave numérica">
            <span className="font-mono text-xs break-all">{factura.claveNumerica ?? '—'}</span>
          </Row>
          <Row label="Fecha emisión">{formatDate(factura.fechaEmision)}</Row>
          <Row label="Condición de venta">{factura.condicionVenta ?? '—'}</Row>
          <Row label="Medios de pago">{mediosPagoText ?? '—'}</Row>
          {factura.fxRateApplied != null && (
            <Row label="Tipo de cambio aplicado">
              {factura.fxRateApplied} {factura.fxRateDate && <span className="text-xs text-slate-500">({formatDate(factura.fxRateDate)})</span>}
            </Row>
          )}
          <Row label="Origen">
            <Badge tone="slate">{factura.sourceType.toUpperCase()}</Badge>
          </Row>
        </dl>
      </Section>

      {/* Emisor */}
      {emisor && (
        <Section title="Emisor">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
            <Row label="Nombre">{emisor.nombre ?? '—'}</Row>
            <Row label="Identificación">
              <span className="font-mono">{emisor.identificacion ?? '—'}</span>
            </Row>
            <Row label="Tipo de identificación">{emisor.tipoIdentificacion ?? '—'}</Row>
            {emisor.email && <Row label="Email">{emisor.email}</Row>}
            {emisor.telefono && <Row label="Teléfono">{emisor.telefono}</Row>}
          </dl>
        </Section>
      )}

      {/* Receptor */}
      {receptor && (
        <Section title="Receptor">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
            <Row label="Nombre">{receptor.nombre ?? '—'}</Row>
            <Row label="Identificación">
              <span className="font-mono">{receptor.identificacion ?? '—'}</span>
            </Row>
            <Row label="Tipo de identificación">{receptor.tipoIdentificacion ?? '—'}</Row>
            {receptor.email && <Row label="Email">{receptor.email}</Row>}
            {receptor.telefono && <Row label="Teléfono">{receptor.telefono}</Row>}
          </dl>
        </Section>
      )}

      {/* Items */}
      <Section title={`Items (${items.length})`}>
        <Table<ExtractedItem & { __idx: number }>
          rows={items.map((it, idx) => ({ ...it, __idx: idx }))}
          rowKey={(r) => r.__idx}
          empty={<span>El comprobante no incluye líneas o no fueron extraídas.</span>}
          columns={[
            {
              key: 'cabys',
              header: 'CABYS',
              cell: (i) => <span className="font-mono text-xs">{i.codigoCabys ?? '—'}</span>,
            },
            { key: 'desc', header: 'Descripción', cell: (i) => i.descripcion ?? '—' },
            {
              key: 'cant',
              header: 'Cant.',
              align: 'right',
              cell: (i) => <span className="font-mono">{asNumber(i.cantidad) ?? '—'}</span>,
            },
            { key: 'unidad', header: 'Unidad', cell: (i) => i.unidadMedida ?? '—' },
            {
              key: 'precio',
              header: 'P. unit.',
              align: 'right',
              cell: (i) => (
                <span className="font-mono">{formatMoney(nMoney(i.precioUnitario, monedaCurrency))}</span>
              ),
            },
            {
              key: 'sub',
              header: 'Subtotal',
              align: 'right',
              cell: (i) => (
                <span className="font-mono">{formatMoney(nMoney(i.subtotal, monedaCurrency))}</span>
              ),
            },
            {
              key: 'iva',
              header: 'IVA',
              align: 'right',
              cell: (i) => (
                <span className="font-mono">{formatMoney(nMoney(i.ivaMonto, monedaCurrency))}</span>
              ),
            },
          ]}
        />
      </Section>

      {/* Totales */}
      <Section title="Totales">
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-4">
          <Row label="Subtotal">
            <span className="font-mono">{formatMoney(nMoney(totals.subtotal, monedaCurrency))}</span>
          </Row>
          <Row label="IVA">
            <span className="font-mono">{formatMoney(nMoney(totals.iva, monedaCurrency))}</span>
          </Row>
          <Row label="Total">
            <span className="font-mono text-base font-semibold text-slate-900">
              {formatMoney(factura.montoTotal ?? nMoney(totals.total, monedaCurrency))}
            </span>
          </Row>
        </dl>
      </Section>

      {/* OC relacionada */}
      <Section
        title="OC relacionada"
        action={
          <Link
            to={`/ocs/${factura.oc.id}`}
            className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800"
          >
            Ver OC <ExternalLink className="w-3.5 h-3.5" />
          </Link>
        }
      >
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-4">
          <Row label="Número OC">
            <Link to={`/ocs/${factura.oc.id}`} className="font-medium text-indigo-600 hover:underline">
              {factura.oc.numeroOc}
            </Link>
          </Row>
          <Row label="Proveedor">{factura.oc.proveedor?.nombre ?? '—'}</Row>
          <Row label="Monto OC">
            <span className="font-mono">{formatMoney(factura.oc.montoTotal ?? null)}</span>
          </Row>
        </dl>
      </Section>

      {/* Notas */}
      <Section title="Notas">
        {factura.notas ? (
          <p className="text-sm text-slate-700 whitespace-pre-wrap">{factura.notas}</p>
        ) : (
          <p className="text-sm text-slate-400 italic">Sin notas.</p>
        )}
      </Section>

      {/* Modal confirmar */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setConfirmOpen(false)} />
          <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <h3 className="text-base font-semibold text-slate-900">Confirmar factura</h3>
            <p className="mt-2 text-sm text-slate-600">
              ¿Confirmar la factura <strong>{factura.numeroConsecutivo ?? `#${factura.id}`}</strong> por{' '}
              <strong>{formatMoney(factura.montoTotal ?? null)}</strong>?
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Una vez confirmada quedará registrada como válida y vinculada a la OC {factura.oc.numeroOc}.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={confirmMutation.isPending}>
                Cancelar
              </Button>
              <Button
                onClick={() => confirmMutation.mutate()}
                disabled={confirmMutation.isPending}
                className="bg-emerald-600 hover:bg-emerald-700"
              >
                {confirmMutation.isPending ? 'Confirmando…' : 'Confirmar'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Drawer anular */}
      <Drawer
        open={anularOpen}
        onClose={() => setAnularOpen(false)}
        title="Anular factura"
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAnularOpen(false)} disabled={anularMutation.isPending}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              onClick={() => anularMutation.mutate({ motivo: motivo.trim() || undefined })}
              disabled={anularMutation.isPending}
            >
              {anularMutation.isPending ? 'Anulando…' : 'Anular factura'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Vas a marcar la factura <strong>{factura.numeroConsecutivo ?? `#${factura.id}`}</strong> como{' '}
            <Badge tone="red">Error</Badge>. Esta acción no la borra pero la deja inutilizable.
          </p>
          <Field label="Motivo (opcional)" hint="Se guardará en el campo errorMessage de la factura.">
            <Textarea
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Ej: factura duplicada, datos incorrectos, etc."
              rows={4}
            />
          </Field>
        </div>
      </Drawer>

      {/* Drawer subir de nuevo (factura en error) */}
      <Drawer
        open={reuploadOpen}
        onClose={() => setReuploadOpen(false)}
        title="Subir factura nuevamente"
        size="md"
      >
        {/* Lazy import evitado para no romper SSR; el form se monta solo cuando se abre. */}
        <ReuploadForm
          ocId={factura.oc.id}
          onDone={() => setReuploadOpen(false)}
        />
      </Drawer>
    </div>
  );
}

// Wrapper liviano para evitar ciclo de import: usa la versión real montándola dinámica.
import { FacturaUploadForm } from '../components/FacturaUploadForm';
function ReuploadForm({ ocId, onDone }: { ocId: number; onDone: () => void }) {
  return <FacturaUploadForm initialOcId={ocId} onUploaded={onDone} onCancel={onDone} />;
}
