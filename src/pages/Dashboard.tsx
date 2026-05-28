import { Link } from 'react-router-dom';
import { Building2, FileText, ClipboardList, Receipt, AlertCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useList } from '../hooks/useApi';
import { useAuth } from '../context/AuthContext';
import { PageHeader } from '../components/ui/PageHeader';
import { Badge } from '../components/ui/Badge';
import { formatMoney, formatDate } from '../lib/format';

interface Stat { label: string; value: number; icon: LucideIcon; color: string; link?: string; }
interface ObraLite { id: number; nombre: string; estado: string; monedaReporte: 'CRC' | 'USD'; cliente: { nombre: string }; nextOcSeq: number; }
interface CotLite { id: number; numeroCotizacion: string; fecha: string; estado: string; proveedor: { nombre: string }; obra: { nombre: string }; totalAmount: string; totalCurrency: 'CRC' | 'USD'; }
interface FacturaLite { id: number; tipoComprobante: string | null; numeroConsecutivo: string | null; status: string; oc: { numeroOc: string; proveedor: { nombre: string } }; }
interface OcLite { id: number; numeroOc: string; estado: string; }

const ESTADO_TONES: Record<string, 'slate' | 'indigo' | 'blue' | 'amber' | 'emerald' | 'orange' | 'red'> = {
  planificada: 'slate', en_curso: 'indigo', pausada: 'amber', finalizada: 'emerald',
  recibida: 'slate', en_revision: 'blue', aprobada: 'emerald', rechazada: 'red', vencida: 'orange',
  autorizada: 'blue', pagada_parcial: 'amber', pagada: 'emerald', entregada_parcial: 'amber', completada: 'emerald', cancelada: 'red',
};

export default function Dashboard() {
  const { user } = useAuth();
  const obras = useList<ObraLite>(['obras', 'activas'], '/obras?estado=en_curso');
  const cotPendientes = useList<CotLite>(['cotizaciones', 'pendientes'], '/cotizaciones?estado=recibida');
  const ocsActivas = useList<OcLite>(['ocs', 'activas'], '/ocs?estado=autorizada');
  const facturasExtracted = useList<FacturaLite>(['facturas', 'extracted'], '/facturas?status=extracted');

  const stats: Stat[] = [
    { label: 'Obras activas', value: obras.data?.length ?? 0, icon: Building2, color: 'bg-indigo-500', link: '/obras' },
    { label: 'Cotizaciones por aprobar', value: cotPendientes.data?.length ?? 0, icon: FileText, color: 'bg-amber-500', link: '/cotizaciones' },
    { label: 'OCs autorizadas', value: ocsActivas.data?.length ?? 0, icon: ClipboardList, color: 'bg-emerald-500', link: '/ocs' },
    { label: 'Facturas por confirmar', value: facturasExtracted.data?.length ?? 0, icon: Receipt, color: 'bg-rose-500', link: '/facturas' },
  ];

  const greeting = user?.fullName || user?.username;

  return (
    <div className="space-y-6">
      <PageHeader title={`Hola, ${greeting}`} subtitle="Resumen del día." />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {stats.map((s) => {
          const Icon = s.icon;
          const body = (
            <div className="bg-white rounded-lg ring-1 ring-slate-200 p-4 hover:shadow-sm transition-shadow">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{s.label}</p>
                  <p className="text-2xl font-semibold text-slate-900 mt-1">{s.value}</p>
                </div>
                <div className={`${s.color} p-2.5 rounded-lg text-white shrink-0`}>
                  <Icon className="w-5 h-5" />
                </div>
              </div>
            </div>
          );
          return s.link ? <Link key={s.label} to={s.link}>{body}</Link> : <div key={s.label}>{body}</div>;
        })}
      </div>

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-base font-semibold text-slate-900">Mis obras</h2>
          <Link to="/obras" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">Ver todas →</Link>
        </div>
        {obras.isLoading ? (
          <div className="bg-white rounded-lg ring-1 ring-slate-200 p-6 text-slate-400 italic text-center">Cargando…</div>
        ) : obras.data && obras.data.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {obras.data.map((o) => (
              <Link key={o.id} to={`/obras/${o.id}`} className="bg-white rounded-lg ring-1 ring-slate-200 hover:ring-indigo-300 hover:shadow-sm transition p-4 block">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-slate-900 truncate">{o.nombre}</h3>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">{o.cliente.nombre}</p>
                  </div>
                  <Badge tone={ESTADO_TONES[o.estado] ?? 'slate'}>{o.estado}</Badge>
                </div>
                <div className="mt-3 text-xs text-slate-500 flex justify-between">
                  <span>Próx. OC: <span className="font-mono">#{o.nextOcSeq}</span></span>
                  <span>Reporte en {o.monedaReporte}</span>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="bg-white rounded-lg ring-1 ring-slate-200 p-6 text-center">
            <p className="text-slate-600">No hay obras activas.</p>
            <Link to="/obras" className="inline-block mt-3 px-4 py-2 text-sm font-medium rounded-md bg-indigo-600 text-white hover:bg-indigo-700">Crear primera obra</Link>
          </div>
        )}
      </section>

      <div className="grid gap-3 md:grid-cols-2">
        <section className="bg-white rounded-lg ring-1 ring-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <h3 className="font-semibold text-slate-900 text-sm">Cotizaciones por aprobar</h3>
            <Badge tone={cotPendientes.data && cotPendientes.data.length > 0 ? 'amber' : 'slate'}>{cotPendientes.data?.length ?? 0}</Badge>
          </div>
          <ul className="divide-y divide-slate-100">
            {(cotPendientes.data ?? []).slice(0, 5).map((c) => (
              <li key={c.id} className="px-4 py-2.5 text-sm hover:bg-slate-50">
                <Link to={`/cotizaciones/${c.id}`} className="flex justify-between gap-2">
                  <span className="text-slate-700 truncate">{c.numeroCotizacion} — {c.proveedor.nombre}</span>
                  <span className="text-slate-500 shrink-0">{formatMoney({ amount: c.totalAmount, currency: c.totalCurrency })}</span>
                </Link>
                <p className="text-xs text-slate-500 mt-0.5 flex justify-between">
                  <span>{c.obra.nombre}</span>
                  <span>{formatDate(c.fecha)}</span>
                </p>
              </li>
            ))}
            {(cotPendientes.data?.length ?? 0) === 0 && (
              <li className="px-4 py-6 text-sm text-slate-400 italic text-center">Sin pendientes</li>
            )}
          </ul>
        </section>

        <section className="bg-white rounded-lg ring-1 ring-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <h3 className="font-semibold text-slate-900 text-sm">Facturas por confirmar</h3>
            <Badge tone={facturasExtracted.data && facturasExtracted.data.length > 0 ? 'amber' : 'slate'}>{facturasExtracted.data?.length ?? 0}</Badge>
          </div>
          <ul className="divide-y divide-slate-100">
            {(facturasExtracted.data ?? []).slice(0, 5).map((f) => (
              <li key={f.id} className="px-4 py-2.5 text-sm hover:bg-slate-50">
                <Link to={`/facturas/${f.id}`} className="block">
                  <span className="text-slate-700">{f.tipoComprobante ?? '—'} · {f.numeroConsecutivo ?? `#${f.id}`}</span>
                  <p className="text-xs text-slate-500 mt-0.5">OC {f.oc.numeroOc} — {f.oc.proveedor.nombre}</p>
                </Link>
              </li>
            ))}
            {(facturasExtracted.data?.length ?? 0) === 0 && (
              <li className="px-4 py-6 text-sm text-slate-400 italic text-center">Sin pendientes</li>
            )}
          </ul>
        </section>
      </div>

      {user?.role === 'admin' && (
        <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3 text-sm text-amber-900 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <strong>Modo desarrollo:</strong> sistema en Fase 2. Algunas secciones (solicitudes formales, reportes, etc.) están en construcción.
          </div>
        </div>
      )}
    </div>
  );
}
