/**
 * Entregas — listado global (sidebar item).
 *
 * Filtros: OC, fechaDesde, fechaHasta. (filtro por registradaPor queda como
 * TODO Fase 3 cuando exista /api/users).
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Filter } from 'lucide-react';

import { useItem, useList } from '../hooks/useApi';
import { Input, Select, Field } from '../components/ui/Input';
import { Table } from '../components/ui/Table';
import { Badge } from '../components/ui/Badge';
import { PageHeader } from '../components/ui/PageHeader';
import { formatDate } from '../lib/format';

interface EntregaRow {
  id: number;
  ocId: number;
  fecha: string;
  recibidoPor: string;
  completa: boolean;
  bodegaDestino?: { id: number; nombre: string };
  oc?: { id: number; numeroOc: string; proveedor: { id: number; nombre: string } | null };
  registradaPor?: { id: number; username: string; fullName: string | null };
  _count?: { items: number; fotos: number };
}

interface OcOption {
  id: number;
  numeroOc: string;
  proveedor?: { id: number; nombre: string } | null;
}

export default function Entregas() {
  const navigate = useNavigate();

  const [ocFilter, setOcFilter] = useState<number | ''>('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');

  const queryParams = useMemo(() => {
    const p = new URLSearchParams();
    if (ocFilter) p.set('ocId', String(ocFilter));
    if (desde) p.set('desde', desde);
    if (hasta) p.set('hasta', hasta);
    const qs = p.toString();
    return qs ? `?${qs}` : '';
  }, [ocFilter, desde, hasta]);

  const queryKey = useMemo(
    () => ['entregas', { ocFilter: ocFilter || undefined, desde: desde || undefined, hasta: hasta || undefined }] as const,
    [ocFilter, desde, hasta],
  );

  const { data, isLoading } = useItem<EntregaRow[]>(queryKey, `/entregas${queryParams}`);
  const rows = data ?? [];

  const { data: ocs = [] } = useList<OcOption>(['ocs', 'all-for-filter'], '/ocs');

  return (
    <div>
      <PageHeader
        title="Entregas"
        subtitle="Recepción de material en bodega"
      />

      <div className="bg-white rounded-lg ring-1 ring-slate-200 p-4 mb-4 grid grid-cols-1 sm:grid-cols-4 gap-3">
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
        <Field label="Desde">
          <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
        </Field>
        <Field label="Hasta">
          <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
        </Field>
        <div className="flex items-end">
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
            <Filter className="w-3.5 h-3.5" />
            {rows.length} resultado{rows.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      <Table<EntregaRow>
        loading={isLoading}
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/entregas/${r.id}`)}
        empty={<span>Sin entregas registradas.</span>}
        columns={[
          {
            key: 'id',
            header: '#',
            cell: (r) => <span className="font-mono text-xs text-slate-500">#{r.id}</span>,
          },
          {
            key: 'oc',
            header: 'OC',
            cell: (r) => (
              <span className="font-medium text-slate-900">{r.oc?.numeroOc ?? '—'}</span>
            ),
          },
          {
            key: 'prov',
            header: 'Proveedor',
            cell: (r) => r.oc?.proveedor?.nombre ?? '—',
          },
          { key: 'fecha', header: 'Fecha', cell: (r) => formatDate(r.fecha) },
          { key: 'recibido', header: 'Recibido por', cell: (r) => r.recibidoPor },
          {
            key: 'items',
            header: 'Items',
            align: 'right',
            cell: (r) => <span className="font-mono">{r._count?.items ?? 0}</span>,
          },
          {
            key: 'fotos',
            header: 'Fotos',
            align: 'right',
            cell: (r) => <span className="font-mono">{r._count?.fotos ?? 0}</span>,
          },
          {
            key: 'estado',
            header: 'Estado',
            cell: (r) =>
              r.completa
                ? <Badge tone="emerald">Completa</Badge>
                : <Badge tone="slate">Parcial</Badge>,
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
