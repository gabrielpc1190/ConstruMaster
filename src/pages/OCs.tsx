import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useList } from '../hooks/useApi';
import { Select, Field } from '../components/ui/Input';
import { Table } from '../components/ui/Table';
import { Badge } from '../components/ui/Badge';
import { PageHeader } from '../components/ui/PageHeader';
import { formatDate, formatMoney } from '../lib/format';
import { OC_ESTADO_META, ocMeta, type OcEstado } from '../lib/badges';
import type { Oc, ObraLite, ProveedorLite } from '../types/compras';

export default function OCs() {
  const navigate = useNavigate();

  const [obraId, setObraId] = useState<string>('');
  const [proveedorId, setProveedorId] = useState<string>('');
  const [estado, setEstado] = useState<OcEstado | ''>('');

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
    () => ['ocs', { obraId, proveedorId, estado }] as const,
    [obraId, proveedorId, estado],
  );

  const { data: ocs = [], isLoading } = useList<Oc>(queryKey, `/ocs${queryString}`);

  return (
    <div>
      <PageHeader
        title="Órdenes de Compra"
        subtitle="OCs generadas a partir de cotizaciones aprobadas"
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
          <Select value={estado} onChange={(e) => setEstado(e.target.value as OcEstado | '')}>
            <option value="">Todos</option>
            {(Object.keys(OC_ESTADO_META) as OcEstado[]).map((e) => (
              <option key={e} value={e}>
                {OC_ESTADO_META[e].label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Table<Oc>
        loading={isLoading}
        rows={ocs}
        rowKey={(o) => o.id}
        onRowClick={(o) => navigate(`/ocs/${o.id}`)}
        empty={<span>Sin órdenes de compra todavía.</span>}
        columns={[
          {
            key: 'numero',
            header: '#',
            cell: (o) => <span className="font-medium text-slate-900">{o.numeroOc}</span>,
          },
          { key: 'proveedor', header: 'Proveedor', cell: (o) => o.proveedor?.nombre ?? '—' },
          { key: 'obra', header: 'Obra', cell: (o) => o.obra?.nombre ?? '—' },
          { key: 'fecha', header: 'Aprobación', cell: (o) => formatDate(o.fechaAprobacion) },
          {
            key: 'monto',
            header: 'Monto',
            align: 'right',
            cell: (o) => <span className="tabular-nums">{formatMoney(o.montoTotal)}</span>,
          },
          {
            key: 'items',
            header: 'Items',
            align: 'right',
            cell: (o) => <span className="tabular-nums text-slate-500">{o._count?.items ?? '—'}</span>,
          },
          {
            key: 'pagos',
            header: 'Pagos',
            align: 'right',
            cell: (o) => <span className="tabular-nums text-slate-500">{o._count?.pagos ?? 0}</span>,
          },
          {
            key: 'entregas',
            header: 'Entregas',
            align: 'right',
            cell: (o) => <span className="tabular-nums text-slate-500">{o._count?.entregas ?? 0}</span>,
          },
          {
            key: 'estado',
            header: 'Estado',
            cell: (o) => {
              const meta = ocMeta(o.estado);
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
