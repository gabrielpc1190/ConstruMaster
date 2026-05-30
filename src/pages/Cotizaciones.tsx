import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, FileText } from 'lucide-react';
import { useList } from '../hooks/useApi';
import { Button } from '../components/ui/Button';
import { Select, Field } from '../components/ui/Input';
import { Table } from '../components/ui/Table';
import { Badge } from '../components/ui/Badge';
import { PageHeader } from '../components/ui/PageHeader';
import { CotizacionOcrModal, type ParsedCotizacion } from '../components/CotizacionOcrModal';
import { formatDate, formatMoney } from '../lib/format';
import { COTIZACION_ESTADO_META, cotizacionMeta, type CotizacionEstado } from '../lib/badges';
import type { Cotizacion, ObraLite, ProveedorLite } from '../types/compras';

export default function Cotizaciones() {
  const navigate = useNavigate();

  const [obraId, setObraId] = useState<string>('');
  const [proveedorId, setProveedorId] = useState<string>('');
  const [estado, setEstado] = useState<CotizacionEstado | ''>('');
  const [ocrOpen, setOcrOpen] = useState(false);

  const handleOcrParsed = (parsed: ParsedCotizacion) => {
    setOcrOpen(false);
    // Navegamos al form de nueva cotización con el JSON extraído + matches.
    // CotizacionForm lee `location.state.prefill` y siembra los inputs.
    navigate('/cotizaciones/new', { state: { prefill: parsed } });
  };

  const { data: obras = [] } = useList<ObraLite>(['obras', 'lite'], '/obras');
  const { data: proveedores = [] } = useList<ProveedorLite>(['proveedores', 'lite'], '/proveedores');

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (obraId) params.set('obraId', obraId);
    if (proveedorId) params.set('proveedorId', proveedorId);
    if (estado) params.set('estado', estado);
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }, [obraId, proveedorId, estado]);

  const queryKey = useMemo(
    () => ['cotizaciones', { obraId, proveedorId, estado }] as const,
    [obraId, proveedorId, estado],
  );

  const { data: cotizaciones = [], isLoading } = useList<Cotizacion>(queryKey, `/cotizaciones${queryString}`);

  return (
    <div>
      <PageHeader
        title="Cotizaciones"
        subtitle="Recepción, revisión y aprobación de cotizaciones de proveedores"
        actions={
          <>
            <Button variant="secondary" onClick={() => setOcrOpen(true)}>
              <FileText className="w-4 h-4" /> Importar desde PDF
            </Button>
            <Button onClick={() => navigate('/cotizaciones/new')}>
              <Plus className="w-4 h-4" /> Nueva cotización
            </Button>
          </>
        }
      />

      <CotizacionOcrModal
        open={ocrOpen}
        onClose={() => setOcrOpen(false)}
        onParsed={handleOcrParsed}
      />

      <div className="bg-white rounded-lg ring-1 ring-slate-200 p-4 mb-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="Obra">
          <Select value={obraId} onChange={(e) => setObraId(e.target.value)}>
            <option value="">Todas</option>
            {obras.map((o) => (
              <option key={o.id} value={o.id}>
                {o.nombre}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Proveedor">
          <Select value={proveedorId} onChange={(e) => setProveedorId(e.target.value)}>
            <option value="">Todos</option>
            {proveedores.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nombre}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Estado">
          <Select value={estado} onChange={(e) => setEstado(e.target.value as CotizacionEstado | '')}>
            <option value="">Todos</option>
            {(Object.keys(COTIZACION_ESTADO_META) as CotizacionEstado[]).map((e) => (
              <option key={e} value={e}>
                {COTIZACION_ESTADO_META[e].label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Table<Cotizacion>
        loading={isLoading}
        rows={cotizaciones}
        rowKey={(c) => c.id}
        onRowClick={(c) => navigate(`/cotizaciones/${c.id}`)}
        empty={<span>Sin cotizaciones todavía.</span>}
        columns={[
          {
            key: 'numero',
            header: '#',
            cell: (c) => <span className="font-medium text-slate-900">{c.numeroCotizacion}</span>,
          },
          { key: 'proveedor', header: 'Proveedor', cell: (c) => c.proveedor?.nombre ?? '—' },
          { key: 'obra', header: 'Obra', cell: (c) => c.obra?.nombre ?? '—' },
          {
            key: 'rfq',
            header: 'SC',
            cell: (c) =>
              c.rfqId ? (
                <Link
                  to={`/solicitudes-cotizacion/${c.rfqId}`}
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex"
                  title="Ver solicitud de cotización"
                >
                  <Badge tone="indigo" className="hover:underline cursor-pointer">SC #{c.rfqId}</Badge>
                </Link>
              ) : (
                <span className="text-slate-300">—</span>
              ),
          },
          { key: 'fecha', header: 'Fecha', cell: (c) => formatDate(c.fecha) },
          {
            key: 'total',
            header: 'Total',
            align: 'right',
            cell: (c) => <span className="tabular-nums">{formatMoney(c.total)}</span>,
          },
          {
            key: 'estado',
            header: 'Estado',
            cell: (c) => {
              const meta = cotizacionMeta(c.estado);
              return <Badge tone={meta.tone}>{meta.label}</Badge>;
            },
          },
          {
            key: 'acciones',
            header: '',
            align: 'right',
            cell: () => <span className="text-xs text-indigo-600">Ver →</span>,
          },
        ]}
      />
    </div>
  );
}
