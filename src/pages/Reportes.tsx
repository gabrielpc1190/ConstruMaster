/**
 * Página /reportes — landing de los tres reportes agregados:
 *  1. Estado de cuenta por proveedor (con rango fecha de pagos).
 *  2. Reconciliación pedido-vs-entregado por obra.
 *  3. Histórico de tipo de cambio (con gráfico + tabla).
 *
 * Cada reporte arranca con un panel de selección; al pulsar "Generar" se
 * dispara el query y se muestran resultados + botón "Exportar CSV".
 *
 * Las descargas CSV usan `downloadAuthenticatedBlob` para incluir el header
 * `Authorization: Bearer <token>` (no podemos usar `<a download>` directo).
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileBarChart, Users, Building2, ArrowDownUp } from 'lucide-react';
import { api } from '../services/api';
import { downloadAuthenticatedBlob } from '../lib/blob-download';
import { useToast } from '../context/ToastContext';
import { Button } from '../components/ui/Button';
import { Field, Input, Select } from '../components/ui/Input';
import { Table } from '../components/ui/Table';
import { Badge } from '../components/ui/Badge';
import { PageHeader } from '../components/ui/PageHeader';
import { Chart } from '../components/Chart';
import { formatDate, formatMoney } from '../lib/format';
import type { Money } from '../lib/format';

// ---------------------------------------------------------------------------
// Tipos compartidos
// ---------------------------------------------------------------------------

interface Proveedor { id: number; nombre: string; identificacion: string | null; activo: boolean; }
interface Obra { id: number; nombre: string; slug: string; monedaReporte: 'CRC' | 'USD'; }

interface ReporteProveedor {
  proveedor: { id: number; nombre: string; identificacion: string | null };
  rango: { desde: string | null; hasta: string | null };
  ocs: Array<{
    id: number;
    numeroOc: string;
    fechaAprobacion: string;
    estado: string;
    monto: Money;
    totalPagado: Money;
    totalEntregado: Money;
  }>;
  totales: {
    ocsCount: number;
    porMoneda: {
      CRC: { montoOcs: string; montoPagado: string };
      USD: { montoOcs: string; montoPagado: string };
    };
  };
}

interface ReporteReconciliacionItem {
  material: { id: number | null; nombre: string; unidad: string | null };
  comprado: { cantidad: number; monto: Money };
  entregado: { cantidad: number; monto: Money };
  pendiente: { cantidad: number; monto: Money };
}
interface ReporteReconciliacion {
  obra: { id: number; nombre: string; slug: string; monedaReporte: 'CRC' | 'USD' };
  items: ReporteReconciliacionItem[];
  totales: {
    compradoMonto: Money;
    entregadoMonto: Money;
    pendienteMonto: Money;
  };
  warnings: Array<{ ocId: number; numeroOc: string; message: string }>;
}

interface TipoCambioRow {
  date: string;
  buy: string;
  sell: string;
  source: 'bccr' | 'manual';
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

type Tab = 'proveedor' | 'reconciliacion' | 'tipo-cambio';

export default function Reportes() {
  const [tab, setTab] = useState<Tab>('proveedor');

  return (
    <div>
      <PageHeader
        title="Reportes"
        subtitle="Estados de cuenta, reconciliación de entregas y serie histórica de tipo de cambio."
      />

      {/* Tarjetas selector */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        <ReporteCard
          active={tab === 'proveedor'}
          onClick={() => setTab('proveedor')}
          icon={Users}
          title="Estado de cuenta por proveedor"
          desc="OCs + pagos realizados en un rango de fechas."
        />
        <ReporteCard
          active={tab === 'reconciliacion'}
          onClick={() => setTab('reconciliacion')}
          icon={Building2}
          title="Reconciliación pedido-vs-entregado"
          desc="Para cada material de la obra: comprado, entregado y pendiente."
        />
        <ReporteCard
          active={tab === 'tipo-cambio'}
          onClick={() => setTab('tipo-cambio')}
          icon={ArrowDownUp}
          title="Histórico tipo de cambio"
          desc="Serie temporal (gráfico + tabla) con export CSV."
        />
      </div>

      {tab === 'proveedor' && <ReporteProveedorPanel />}
      {tab === 'reconciliacion' && <ReporteReconciliacionPanel />}
      {tab === 'tipo-cambio' && <ReporteTipoCambioPanel />}
    </div>
  );
}

interface CardProps {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  desc: string;
}
function ReporteCard({ active, onClick, icon: Icon, title, desc }: CardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-lg p-4 ring-1 transition-colors ${
        active
          ? 'bg-indigo-50 ring-indigo-300'
          : 'bg-white ring-slate-200 hover:bg-slate-50'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className={`p-2 rounded-md ${active ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-600'}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-slate-900">{title}</div>
          <div className="text-xs text-slate-500 mt-0.5">{desc}</div>
        </div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Panel: Estado de cuenta por proveedor
// ---------------------------------------------------------------------------

function ReporteProveedorPanel() {
  const { showToast } = useToast();
  const [proveedorId, setProveedorId] = useState<string>('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [generated, setGenerated] = useState<{ id: string; desde: string; hasta: string } | null>(null);

  const { data: proveedores = [] } = useQuery<Proveedor[]>({
    queryKey: ['proveedores', 'activos-reportes'],
    queryFn: () => api.get<Proveedor[]>('/proveedores?activo=true'),
  });

  const queryPath = useMemo(() => {
    if (!generated) return '';
    const params = new URLSearchParams();
    if (generated.desde) params.set('desde', generated.desde);
    if (generated.hasta) params.set('hasta', generated.hasta);
    const qs = params.toString();
    return `/reportes/proveedor/${generated.id}${qs ? `?${qs}` : ''}`;
  }, [generated]);

  const { data, isLoading, isError, error } = useQuery<ReporteProveedor>({
    queryKey: ['reportes', 'proveedor', generated],
    queryFn: () => api.get<ReporteProveedor>(queryPath),
    enabled: !!generated,
  });

  const handleGenerate = () => {
    if (!proveedorId) {
      showToast('Seleccioná un proveedor', 'error');
      return;
    }
    setGenerated({ id: proveedorId, desde, hasta });
  };

  const handleExport = async () => {
    if (!generated) return;
    const params = new URLSearchParams({ format: 'csv' });
    if (generated.desde) params.set('desde', generated.desde);
    if (generated.hasta) params.set('hasta', generated.hasta);
    try {
      await downloadAuthenticatedBlob({
        path: `/reportes/proveedor/${generated.id}?${params.toString()}`,
        filename: `proveedor-${generated.id}.csv`,
      });
    } catch (e) {
      showToast((e as Error).message || 'Error al exportar', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg ring-1 ring-slate-200 p-4 flex flex-wrap items-end gap-3">
        <Field label="Proveedor" required className="w-72">
          <Select value={proveedorId} onChange={(e) => setProveedorId(e.target.value)}>
            <option value="">— Seleccionar —</option>
            {proveedores.map((p) => (
              <option key={p.id} value={p.id}>{p.nombre}</option>
            ))}
          </Select>
        </Field>
        <Field label="Desde (fecha pago)" className="w-44">
          <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
        </Field>
        <Field label="Hasta (fecha pago)" className="w-44">
          <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
        </Field>
        <Button onClick={handleGenerate}>
          <FileBarChart className="w-4 h-4" /> Generar
        </Button>
        {data && (
          <Button variant="secondary" onClick={handleExport}>
            <Download className="w-4 h-4" /> Exportar CSV
          </Button>
        )}
      </div>

      {isError && (
        <div className="bg-red-50 ring-1 ring-red-200 rounded p-3 text-sm text-red-700">
          {(error as Error)?.message || 'Error al cargar el reporte'}
        </div>
      )}

      {data && (
        <>
          <div className="bg-white rounded-lg ring-1 ring-slate-200 p-4">
            <div className="text-sm text-slate-500 mb-1">Proveedor</div>
            <div className="text-lg font-semibold text-slate-900">{data.proveedor.nombre}</div>
            {data.proveedor.identificacion && (
              <div className="text-xs text-slate-500">Identificación: {data.proveedor.identificacion}</div>
            )}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
              <Kpi label="OCs en el rango" value={String(data.totales.ocsCount)} />
              <Kpi
                label="Total OCs CRC"
                value={formatMoney({ amount: data.totales.porMoneda.CRC.montoOcs, currency: 'CRC' })}
              />
              <Kpi
                label="Pagado CRC"
                value={formatMoney({ amount: data.totales.porMoneda.CRC.montoPagado, currency: 'CRC' })}
              />
              <Kpi
                label="Pagado USD"
                value={formatMoney({ amount: data.totales.porMoneda.USD.montoPagado, currency: 'USD' })}
              />
            </div>
          </div>

          <Table<ReporteProveedor['ocs'][number]>
            loading={isLoading}
            rows={data.ocs}
            rowKey={(o) => o.id}
            empty={<span>Sin OCs para este proveedor.</span>}
            columns={[
              { key: 'numero', header: 'OC', cell: (o) => <span className="font-medium">{o.numeroOc}</span> },
              { key: 'fecha', header: 'Aprobación', cell: (o) => formatDate(o.fechaAprobacion) },
              { key: 'estado', header: 'Estado', cell: (o) => <Badge tone="slate">{o.estado}</Badge> },
              { key: 'monto', header: 'Monto OC', align: 'right', cell: (o) => formatMoney(o.monto) },
              { key: 'pagado', header: 'Pagado', align: 'right', cell: (o) => formatMoney(o.totalPagado) },
            ]}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel: Reconciliación pedido-vs-entregado
// ---------------------------------------------------------------------------

function ReporteReconciliacionPanel() {
  const { showToast } = useToast();
  const [obraId, setObraId] = useState<string>('');
  const [generated, setGenerated] = useState<string | null>(null);

  const { data: obras = [] } = useQuery<Obra[]>({
    queryKey: ['obras', 'reportes'],
    queryFn: () => api.get<Obra[]>('/obras'),
  });

  const { data, isLoading, isError, error } = useQuery<ReporteReconciliacion>({
    queryKey: ['reportes', 'reconciliacion', generated],
    queryFn: () => api.get<ReporteReconciliacion>(`/reportes/reconciliacion/${generated}`),
    enabled: !!generated,
  });

  const handleGenerate = () => {
    if (!obraId) { showToast('Seleccioná una obra', 'error'); return; }
    setGenerated(obraId);
  };

  const handleExport = async () => {
    if (!generated) return;
    try {
      await downloadAuthenticatedBlob({
        path: `/reportes/reconciliacion/${generated}?format=csv`,
        filename: `reconciliacion-${generated}.csv`,
      });
    } catch (e) {
      showToast((e as Error).message || 'Error al exportar', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg ring-1 ring-slate-200 p-4 flex flex-wrap items-end gap-3">
        <Field label="Obra" required className="w-72">
          <Select value={obraId} onChange={(e) => setObraId(e.target.value)}>
            <option value="">— Seleccionar —</option>
            {obras.map((o) => (
              <option key={o.id} value={o.id}>{o.nombre}</option>
            ))}
          </Select>
        </Field>
        <Button onClick={handleGenerate}>
          <FileBarChart className="w-4 h-4" /> Generar
        </Button>
        {data && (
          <Button variant="secondary" onClick={handleExport}>
            <Download className="w-4 h-4" /> Exportar CSV
          </Button>
        )}
      </div>

      {isError && (
        <div className="bg-red-50 ring-1 ring-red-200 rounded p-3 text-sm text-red-700">
          {(error as Error)?.message || 'Error al cargar el reporte'}
        </div>
      )}

      {data && (
        <>
          <div className="bg-white rounded-lg ring-1 ring-slate-200 p-4">
            <div className="text-sm text-slate-500 mb-1">Obra</div>
            <div className="text-lg font-semibold text-slate-900">{data.obra.nombre}</div>
            <div className="text-xs text-slate-500">Moneda de reporte: {data.obra.monedaReporte}</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
              <Kpi label="Comprado total" value={formatMoney(data.totales.compradoMonto)} />
              <Kpi label="Entregado total" value={formatMoney(data.totales.entregadoMonto)} />
              <Kpi label="Pendiente total" value={formatMoney(data.totales.pendienteMonto)} />
            </div>
          </div>

          {data.warnings.length > 0 && (
            <div className="bg-amber-50 ring-1 ring-amber-200 rounded p-3 text-xs text-amber-800">
              <div className="font-medium mb-1">Advertencias ({data.warnings.length})</div>
              <ul className="list-disc list-inside space-y-0.5">
                {data.warnings.map((w) => (
                  <li key={w.ocId}><span className="font-medium">{w.numeroOc}:</span> {w.message}</li>
                ))}
              </ul>
            </div>
          )}

          <Table<ReporteReconciliacionItem>
            loading={isLoading}
            rows={data.items}
            rowKey={(it) => `${it.material.id ?? 'null'}-${it.material.nombre}`}
            empty={<span>Sin items en OCs activas de la obra.</span>}
            columns={[
              { key: 'mat', header: 'Material', cell: (it) => <span className="font-medium">{it.material.nombre}</span> },
              { key: 'un', header: 'Unidad', cell: (it) => it.material.unidad ?? '—' },
              { key: 'compC', header: 'Cant. comprada', align: 'right', cell: (it) => it.comprado.cantidad },
              { key: 'compM', header: 'Monto comprado', align: 'right', cell: (it) => formatMoney(it.comprado.monto) },
              { key: 'entC', header: 'Cant. entregada', align: 'right', cell: (it) => it.entregado.cantidad },
              { key: 'entM', header: 'Monto entregado', align: 'right', cell: (it) => formatMoney(it.entregado.monto) },
              { key: 'penC', header: 'Cant. pendiente', align: 'right', cell: (it) => it.pendiente.cantidad },
              { key: 'penM', header: 'Monto pendiente', align: 'right', cell: (it) => formatMoney(it.pendiente.monto) },
            ]}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel: Histórico tipo de cambio
// ---------------------------------------------------------------------------

function ReporteTipoCambioPanel() {
  const { showToast } = useToast();
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [currency, setCurrency] = useState<'USD'>('USD');
  const [generated, setGenerated] = useState<{ desde: string; hasta: string; currency: string } | null>(null);

  const queryPath = useMemo(() => {
    if (!generated) return '';
    const params = new URLSearchParams({ currency: generated.currency });
    if (generated.desde) params.set('desde', generated.desde);
    if (generated.hasta) params.set('hasta', generated.hasta);
    return `/reportes/tipo-cambio?${params.toString()}`;
  }, [generated]);

  const { data: rows = [], isLoading, isError, error } = useQuery<TipoCambioRow[]>({
    queryKey: ['reportes', 'tipo-cambio', generated],
    queryFn: () => api.get<TipoCambioRow[]>(queryPath),
    enabled: !!generated,
  });

  const handleGenerate = () => {
    setGenerated({ desde, hasta, currency });
  };

  const handleExport = async () => {
    if (!generated) return;
    const params = new URLSearchParams({ format: 'csv', currency: generated.currency });
    if (generated.desde) params.set('desde', generated.desde);
    if (generated.hasta) params.set('hasta', generated.hasta);
    try {
      await downloadAuthenticatedBlob({
        path: `/reportes/tipo-cambio?${params.toString()}`,
        filename: `tipo-cambio-${generated.currency}.csv`,
      });
    } catch (e) {
      showToast((e as Error).message || 'Error al exportar', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg ring-1 ring-slate-200 p-4 flex flex-wrap items-end gap-3">
        <Field label="Moneda" className="w-32">
          <Select value={currency} onChange={(e) => setCurrency(e.target.value as 'USD')}>
            <option value="USD">USD</option>
          </Select>
        </Field>
        <Field label="Desde" className="w-44">
          <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
        </Field>
        <Field label="Hasta" className="w-44">
          <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
        </Field>
        <Button onClick={handleGenerate}>
          <FileBarChart className="w-4 h-4" /> Generar
        </Button>
        {rows.length > 0 && (
          <Button variant="secondary" onClick={handleExport}>
            <Download className="w-4 h-4" /> Exportar CSV
          </Button>
        )}
      </div>

      {isError && (
        <div className="bg-red-50 ring-1 ring-red-200 rounded p-3 text-sm text-red-700">
          {(error as Error)?.message || 'Error al cargar el reporte'}
        </div>
      )}

      {generated && (
        <div className="bg-white rounded-lg ring-1 ring-slate-200 p-4">
          <h3 className="text-sm font-medium text-slate-700 mb-2">
            Serie {generated.currency} ({rows.length} registros)
          </h3>
          <Chart
            height={260}
            yLabel="₡ por USD"
            formatY={(n) =>
              new Intl.NumberFormat('en-US', {
                minimumFractionDigits: 0,
                maximumFractionDigits: 0,
              }).format(n)
            }
            series={[
              {
                label: 'Compra',
                color: '#64748b',
                points: rows.map((r) => ({ x: new Date(r.date), y: Number(r.buy) })),
              },
              {
                label: 'Venta',
                color: '#4f46e5',
                points: rows.map((r) => ({ x: new Date(r.date), y: Number(r.sell) })),
              },
            ]}
          />
        </div>
      )}

      {generated && (
        <Table<TipoCambioRow>
          loading={isLoading}
          rows={rows}
          rowKey={(r) => r.date}
          empty={<span>Sin tipos de cambio en el rango.</span>}
          columns={[
            { key: 'date', header: 'Fecha', cell: (r) => formatDate(r.date) },
            { key: 'buy', header: 'Compra', align: 'right', cell: (r) => Number(r.buy).toFixed(2) },
            { key: 'sell', header: 'Venta', align: 'right', cell: (r) => Number(r.sell).toFixed(2) },
            {
              key: 'source',
              header: 'Fuente',
              cell: (r) =>
                r.source === 'bccr' ? <Badge tone="blue">BCCR</Badge> : <Badge tone="amber">Manual</Badge>,
            },
          ]}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI helper
// ---------------------------------------------------------------------------
function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-slate-50 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-lg font-semibold text-slate-900 mt-1">{value}</div>
    </div>
  );
}
