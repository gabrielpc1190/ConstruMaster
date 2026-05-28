/**
 * Pagos.tsx — listing global de pagos (sidebar / Compras).
 *
 * No tiene "crear pago global": los pagos siempre se programan desde un OC.
 * Banner informativo lo aclara arriba.
 *
 * Tabla: # · OC (link a /ocs/:id) · Proveedor · Fecha programada ·
 * Fecha realizada · Monto · Método · Estado · Acciones.
 * Click en fila → navega al detalle de OC.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CreditCard, Info } from 'lucide-react';

import { useList } from '../hooks/useApi';
import { Select, Input, Field } from '../components/ui/Input';
import { Table } from '../components/ui/Table';
import { Badge } from '../components/ui/Badge';
import { PageHeader } from '../components/ui/PageHeader';
import { formatDate, formatMoney } from '../lib/format';
import type { Oc } from '../types/compras';

type Moneda = 'CRC' | 'USD';
type Metodo = 'transferencia' | 'cheque' | 'efectivo' | 'tarjeta' | 'otro';
type EstadoFilter = '' | 'programado' | 'pagado';

interface PagoRow {
  id: number;
  ocId: number;
  fechaProgramada: string;
  fechaRealizada: string | null;
  montoAmount: string | number;
  montoCurrency: Moneda;
  metodo: Metodo;
  referencia: string | null;
  oc?: {
    id: number;
    numeroOc: string;
    estado: string;
    proveedor: { id: number; nombre: string } | null;
  };
}

const METODO_LABELS: Record<Metodo, string> = {
  transferencia: 'Transferencia',
  cheque: 'Cheque',
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  otro: 'Otro',
};
const METODOS: Metodo[] = ['transferencia', 'cheque', 'efectivo', 'tarjeta', 'otro'];

export default function Pagos() {
  const navigate = useNavigate();
  const [ocId, setOcId] = useState<string>('');
  const [estado, setEstado] = useState<EstadoFilter>('');
  const [metodo, setMetodo] = useState<Metodo | ''>('');
  const [fechaDesde, setFechaDesde] = useState('');
  const [fechaHasta, setFechaHasta] = useState('');

  const { data: ocs = [] } = useList<Oc>(['ocs', 'lite'], '/ocs');

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (ocId) params.set('ocId', ocId);
    if (estado === 'pagado') params.set('fechaRealizada', 'notnull');
    if (estado === 'programado') params.set('fechaRealizada', 'null');
    if (metodo) params.set('metodo', metodo);
    if (fechaDesde) params.set('fechaProgramadaFrom', fechaDesde);
    if (fechaHasta) params.set('fechaProgramadaTo', fechaHasta);
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }, [ocId, estado, metodo, fechaDesde, fechaHasta]);

  const queryKey = useMemo(
    () => ['pagos', { ocId, estado, metodo, fechaDesde, fechaHasta }] as const,
    [ocId, estado, metodo, fechaDesde, fechaHasta],
  );

  const { data: pagos = [], isLoading } = useList<PagoRow>(queryKey, `/pagos${queryString}`);

  return (
    <div>
      <PageHeader
        title="Pagos"
        subtitle="Programación y conciliación financiera de las OCs"
      />

      <div className="bg-blue-50 ring-1 ring-blue-200 rounded-lg px-4 py-3 mb-4 flex items-start gap-2 text-sm text-blue-900">
        <Info className="w-4 h-4 mt-0.5 shrink-0" />
        <span>
          Los pagos se programan desde el detalle de una Orden de Compra. Esta
          pantalla es solo lectura global con filtros.
        </span>
      </div>

      <div className="bg-white rounded-lg ring-1 ring-slate-200 p-4 mb-4 grid grid-cols-1 md:grid-cols-5 gap-3">
        <Field label="OC">
          <Select value={ocId} onChange={(e) => setOcId(e.target.value)}>
            <option value="">Todas</option>
            {ocs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.numeroOc}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Estado">
          <Select value={estado} onChange={(e) => setEstado(e.target.value as EstadoFilter)}>
            <option value="">Todos</option>
            <option value="programado">Programado</option>
            <option value="pagado">Pagado</option>
          </Select>
        </Field>
        <Field label="Método">
          <Select value={metodo} onChange={(e) => setMetodo(e.target.value as Metodo | '')}>
            <option value="">Todos</option>
            {METODOS.map((m) => (
              <option key={m} value={m}>
                {METODO_LABELS[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Desde">
          <Input type="date" value={fechaDesde} onChange={(e) => setFechaDesde(e.target.value)} />
        </Field>
        <Field label="Hasta">
          <Input type="date" value={fechaHasta} onChange={(e) => setFechaHasta(e.target.value)} />
        </Field>
      </div>

      <Table<PagoRow>
        loading={isLoading}
        rows={pagos}
        rowKey={(p) => p.id}
        onRowClick={(p) => navigate(`/ocs/${p.ocId}`)}
        empty={
          <span className="inline-flex items-center gap-2">
            <CreditCard className="w-4 h-4" /> Sin pagos registrados.
          </span>
        }
        columns={[
          { key: 'id', header: '#', cell: (p) => <span className="text-slate-400">{p.id}</span> },
          {
            key: 'oc',
            header: 'OC',
            cell: (p) =>
              p.oc ? (
                <Link
                  to={`/ocs/${p.ocId}`}
                  className="text-indigo-600 hover:underline font-medium"
                  onClick={(e) => e.stopPropagation()}
                >
                  {p.oc.numeroOc}
                </Link>
              ) : (
                <span className="text-slate-400">—</span>
              ),
          },
          {
            key: 'proveedor',
            header: 'Proveedor',
            cell: (p) => p.oc?.proveedor?.nombre ?? '—',
          },
          { key: 'prog', header: 'Programada', cell: (p) => formatDate(p.fechaProgramada) },
          {
            key: 'real',
            header: 'Realizada',
            cell: (p) =>
              p.fechaRealizada ? (
                <span>{formatDate(p.fechaRealizada)}</span>
              ) : (
                <span className="text-slate-400 italic">Pendiente</span>
              ),
          },
          {
            key: 'monto',
            header: 'Monto',
            align: 'right',
            cell: (p) => (
              <span className="tabular-nums">
                {formatMoney({ amount: p.montoAmount, currency: p.montoCurrency })}
              </span>
            ),
          },
          { key: 'metodo', header: 'Método', cell: (p) => METODO_LABELS[p.metodo] ?? p.metodo },
          {
            key: 'estado',
            header: 'Estado',
            cell: (p) =>
              p.fechaRealizada ? (
                <Badge tone="emerald">Pagado</Badge>
              ) : (
                <Badge tone="blue">Programado</Badge>
              ),
          },
          {
            key: 'acciones',
            header: '',
            align: 'right',
            cell: () => <span className="text-xs text-indigo-600">Ver OC →</span>,
          },
        ]}
      />
    </div>
  );
}
