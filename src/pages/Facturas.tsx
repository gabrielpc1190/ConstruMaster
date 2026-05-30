import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Sparkles } from 'lucide-react';
import { useList } from '../hooks/useApi';
import { Button } from '../components/ui/Button';
import { Select, Field } from '../components/ui/Input';
import { Table } from '../components/ui/Table';
import { Drawer } from '../components/ui/Drawer';
import { Badge } from '../components/ui/Badge';
import { PageHeader } from '../components/ui/PageHeader';
import { FacturaUploadForm } from '../components/FacturaUploadForm';
import { FacturaImagenUploadForm } from '../components/FacturaImagenUploadForm';
import { formatMoney, formatDate, type Money } from '../lib/format';

type FacturaStatus = 'pending' | 'processing' | 'extracted' | 'confirmed' | 'error';
type FacturaTipo = 'FE' | 'TE' | 'NC' | 'ND' | 'FEC' | 'FEE';
type FacturaSourceType = 'xml' | 'pdf' | 'imagen';

interface ProveedorMini { id: number; nombre: string }
interface OcMini { id: number; numeroOc: string; proveedor: ProveedorMini }

interface FacturaRow {
  id: number;
  ocId: number;
  oc: OcMini;
  sourceType: FacturaSourceType;
  tipoComprobante: FacturaTipo | null;
  status: FacturaStatus;
  numeroConsecutivo?: string | null;
  fechaEmision?: string | null;
  montoTotal?: Money | null;
  createdAt: string;
}

interface OcOption {
  id: number;
  numeroOc: string;
  proveedor: ProveedorMini;
}

const STATUS_LABELS: Record<FacturaStatus, string> = {
  pending: 'Pendiente',
  processing: 'Procesando',
  extracted: 'Pendiente confirmar',
  confirmed: 'Confirmada',
  error: 'Error',
};

export const FACTURA_STATUS_TONES: Record<
  FacturaStatus,
  'slate' | 'blue' | 'amber' | 'emerald' | 'red'
> = {
  pending: 'slate',
  processing: 'blue',
  extracted: 'amber',
  confirmed: 'emerald',
  error: 'red',
};

const TIPO_LABELS: Record<FacturaTipo, string> = {
  FE: 'Factura Electrónica',
  TE: 'Tiquete Electrónico',
  NC: 'Nota de Crédito',
  ND: 'Nota de Débito',
  FEC: 'Factura Electrónica de Compra',
  FEE: 'Factura Electrónica de Exportación',
};

export function FacturaTipoBadge({
  tipo,
  sourceType,
}: {
  tipo: FacturaTipo | null;
  sourceType?: FacturaSourceType;
}) {
  if (!tipo) {
    const label =
      sourceType === 'pdf' || sourceType === 'imagen'
        ? 'Escaneada (OCR)'
        : 'Sin tipo';
    return (
      <span title={label}>
        <Badge tone="amber" className="font-mono">
          OCR
        </Badge>
      </span>
    );
  }
  return (
    <span title={TIPO_LABELS[tipo]}>
      <Badge tone="indigo" className="font-mono">
        {tipo}
      </Badge>
    </span>
  );
}

export default function Facturas() {
  const navigate = useNavigate();

  const [ocFilter, setOcFilter] = useState<number | ''>('');
  const [statusFilter, setStatusFilter] = useState<FacturaStatus | ''>('');
  const [tipoFilter, setTipoFilter] = useState<FacturaTipo | ''>('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [imagenDrawerOpen, setImagenDrawerOpen] = useState(false);

  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    if (ocFilter) params.set('ocId', String(ocFilter));
    if (statusFilter) params.set('status', statusFilter);
    if (tipoFilter) params.set('tipoComprobante', tipoFilter);
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }, [ocFilter, statusFilter, tipoFilter]);

  const queryKey = useMemo(
    () => ['facturas', { ocId: ocFilter || undefined, status: statusFilter || undefined, tipo: tipoFilter || undefined }] as const,
    [ocFilter, statusFilter, tipoFilter],
  );

  const { data: facturas = [], isLoading } = useList<FacturaRow>(queryKey, `/facturas${queryParams}`);

  // OCs para filtro: todas, no solo las facturables.
  const { data: ocs = [] } = useList<OcOption>(['ocs', 'all-for-filter'], '/ocs');

  return (
    <div>
      <PageHeader
        title="Facturas"
        subtitle="Comprobantes electrónicos vinculados a órdenes de compra"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => setDrawerOpen(true)}>
              <FileText className="w-4 h-4" />
              Subir comprobante electrónico (.xml)
            </Button>
            <Button onClick={() => setImagenDrawerOpen(true)}>
              <Sparkles className="w-4 h-4" />
              Subir factura escaneada (PDF/foto)
            </Button>
          </div>
        }
      />

      <div className="bg-white rounded-lg ring-1 ring-slate-200 p-4 mb-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Orden de compra">
          <Select
            value={ocFilter === '' ? '' : String(ocFilter)}
            onChange={(e) => setOcFilter(e.target.value === '' ? '' : Number(e.target.value))}
          >
            <option value="">Todas las OCs</option>
            {ocs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.numeroOc} — {o.proveedor?.nombre ?? '—'}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Estado">
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as FacturaStatus | '')}>
            <option value="">Todos los estados</option>
            {(Object.keys(STATUS_LABELS) as FacturaStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Tipo de comprobante">
          <Select value={tipoFilter} onChange={(e) => setTipoFilter(e.target.value as FacturaTipo | '')}>
            <option value="">Todos los tipos</option>
            {(Object.keys(TIPO_LABELS) as FacturaTipo[]).map((t) => (
              <option key={t} value={t}>
                {t} — {TIPO_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Table<FacturaRow>
        loading={isLoading}
        rows={facturas}
        rowKey={(f) => f.id}
        onRowClick={(f) => navigate(`/facturas/${f.id}`)}
        empty={<span>Sin facturas todavía. Subí la primera.</span>}
        columns={[
          {
            key: 'tipo',
            header: 'Tipo',
            cell: (f) => (
              <FacturaTipoBadge tipo={f.tipoComprobante} sourceType={f.sourceType} />
            ),
          },
          {
            key: 'consecutivo',
            header: 'Consecutivo',
            cell: (f) => (
              <span className="font-mono text-xs text-slate-600">{f.numeroConsecutivo ?? '—'}</span>
            ),
          },
          {
            key: 'proveedor',
            header: 'Proveedor',
            cell: (f) => f.oc?.proveedor?.nombre ?? '—',
          },
          {
            key: 'oc',
            header: 'OC',
            cell: (f) => <span className="font-medium text-slate-900">{f.oc?.numeroOc ?? '—'}</span>,
          },
          { key: 'fechaEmision', header: 'Fecha emisión', cell: (f) => formatDate(f.fechaEmision) },
          {
            key: 'monto',
            header: 'Monto',
            align: 'right',
            cell: (f) => <span className="font-mono">{formatMoney(f.montoTotal ?? null)}</span>,
          },
          {
            key: 'estado',
            header: 'Estado',
            cell: (f) => (
              <Badge tone={FACTURA_STATUS_TONES[f.status]}>{STATUS_LABELS[f.status]}</Badge>
            ),
          },
          {
            key: 'acciones',
            header: '',
            align: 'right',
            cell: () => <span className="text-xs text-indigo-600">Ver →</span>,
          },
        ]}
      />

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Subir comprobante electrónico (.xml)"
        size="md"
      >
        <FacturaUploadForm
          onUploaded={() => setDrawerOpen(false)}
          onCancel={() => setDrawerOpen(false)}
        />
      </Drawer>

      <Drawer
        open={imagenDrawerOpen}
        onClose={() => setImagenDrawerOpen(false)}
        title="Subir factura escaneada (OCR)"
        size="md"
      >
        <FacturaImagenUploadForm
          onUploaded={() => setImagenDrawerOpen(false)}
          onCancel={() => setImagenDrawerOpen(false)}
        />
      </Drawer>
    </div>
  );
}

export { STATUS_LABELS as FACTURA_STATUS_LABELS, TIPO_LABELS as FACTURA_TIPO_LABELS };
