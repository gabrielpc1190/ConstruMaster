/**
 * Página /tipo-cambio: gestión de tipos de cambio (USD).
 *
 * - Card destacada con último rate (compra/venta).
 * - Tabla con últimos N rates (filtro from/to).
 * - Botón "Actualizar ahora" → POST /exchange-rates/fetch-today (WRITE_ROLES).
 * - Botón "+ Manual" → drawer con form para crear rate manual (WRITE_ROLES).
 * - Botón borrar (admin) por row.
 *
 * Gráfico: placeholder (TODO Fase 2). Para mantener el ticket de scope no
 * implementamos SVG line chart todavía.
 */

import { useMemo, useState } from 'react';
import { Plus, RefreshCw, Trash2, ArrowDownUp } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { useToast } from '../context/ToastContext';
import { useAuth, WRITE_ROLES } from '../context/AuthContext';
import { Button } from '../components/ui/Button';
import { Input, Field } from '../components/ui/Input';
import { Table } from '../components/ui/Table';
import { Drawer } from '../components/ui/Drawer';
import { Badge } from '../components/ui/Badge';
import { PageHeader } from '../components/ui/PageHeader';
import { formatDate } from '../lib/format';

interface ExchangeRate {
  id: number;
  currency: string;
  date: string; // YYYY-MM-DD
  buy: string;
  sell: string;
  source: 'bccr' | 'manual';
  fetchedAt: string;
}

interface ManualForm {
  date: string;
  buy: string;
  sell: string;
}

const emptyForm: ManualForm = { date: '', buy: '', sell: '' };

/** Formatea string decimal como ₡xxx,xxx.xx. */
function formatColon(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return `₡${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)}`;
}

/** Hoy en YYYY-MM-DD (local timezone). */
function todayInput(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export default function TipoDeCambio() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const qc = useQueryClient();

  const canWrite = !!user && WRITE_ROLES.includes(user.role);
  const isAdmin = user?.role === 'admin';

  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState<ManualForm>(emptyForm);
  const [errors, setErrors] = useState<Partial<Record<keyof ManualForm, string>>>({});

  const queryKey = useMemo(
    () => ['exchange-rates', { from: from || undefined, to: to || undefined }] as const,
    [from, to],
  );

  const queryPath = useMemo(() => {
    const params = new URLSearchParams({ currency: 'USD', limit: '180' });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return `/exchange-rates?${params.toString()}`;
  }, [from, to]);

  const { data: rates = [], isLoading } = useQuery<ExchangeRate[]>({
    queryKey,
    queryFn: () => api.get<ExchangeRate[]>(queryPath),
  });

  const { data: latest } = useQuery<ExchangeRate | null>({
    queryKey: ['exchange-rates', 'latest'],
    queryFn: async () => {
      try {
        return await api.get<ExchangeRate>('/exchange-rates/latest?currency=USD');
      } catch {
        return null;
      }
    },
  });

  const fetchTodayMut = useMutation({
    mutationFn: () => api.post('/exchange-rates/fetch-today'),
    onSuccess: (data: { created?: number; updated?: number; skipped?: number }) => {
      const { created = 0, updated = 0, skipped = 0 } = data ?? {};
      showToast(
        `Tipos de cambio actualizados: ${created} nuevos, ${updated} actualizados, ${skipped} preservados`,
        'success',
      );
      qc.invalidateQueries({ queryKey: ['exchange-rates'] });
    },
    onError: (err: Error) => showToast(err.message || 'Error al actualizar', 'error'),
  });

  const createManualMut = useMutation({
    mutationFn: (payload: ManualForm) =>
      api.post('/exchange-rates', { currency: 'USD', ...payload }),
    onSuccess: () => {
      showToast('Tipo de cambio manual guardado', 'success');
      qc.invalidateQueries({ queryKey: ['exchange-rates'] });
      setDrawerOpen(false);
      setForm(emptyForm);
    },
    onError: (err: Error) => showToast(err.message || 'Error al crear', 'error'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/exchange-rates/${id}`),
    onSuccess: () => {
      showToast('Tipo de cambio borrado', 'success');
      qc.invalidateQueries({ queryKey: ['exchange-rates'] });
    },
    onError: (err: Error) => showToast(err.message || 'Error al borrar', 'error'),
  });

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (!form.date) next.date = 'Fecha requerida';
    if (!form.buy || !/^\d+(\.\d+)?$/.test(form.buy)) next.buy = 'Compra inválida';
    if (!form.sell || !/^\d+(\.\d+)?$/.test(form.sell)) next.sell = 'Venta inválida';
    if (Object.keys(next).length) { setErrors(next); return; }
    setErrors({});
    createManualMut.mutate(form);
  };

  const handleDelete = (r: ExchangeRate) => {
    if (!window.confirm(`¿Borrar tipo de cambio del ${r.date} (${r.source})?`)) return;
    deleteMut.mutate(r.id);
  };

  return (
    <div>
      <PageHeader
        title="Tipo de cambio"
        subtitle="Tipos de cambio USD/CRC (fuente: BCCR + overrides manuales)"
        actions={
          <div className="flex items-center gap-2">
            {canWrite && (
              <Button
                variant="secondary"
                onClick={() => fetchTodayMut.mutate()}
                disabled={fetchTodayMut.isPending}
              >
                <RefreshCw className={`w-4 h-4 ${fetchTodayMut.isPending ? 'animate-spin' : ''}`} />
                {fetchTodayMut.isPending ? 'Actualizando…' : 'Actualizar ahora'}
              </Button>
            )}
            {canWrite && (
              <Button onClick={() => { setForm({ ...emptyForm, date: todayInput() }); setDrawerOpen(true); }}>
                <Plus className="w-4 h-4" /> Manual
              </Button>
            )}
          </div>
        }
      />

      {/* Card destacada con último rate */}
      <div className="bg-gradient-to-br from-indigo-600 to-indigo-700 rounded-lg shadow-lg p-6 mb-6 text-white">
        <div className="flex items-center gap-2 text-indigo-100 text-sm uppercase tracking-wide mb-2">
          <ArrowDownUp className="w-4 h-4" />
          Último tipo de cambio USD
        </div>
        {latest ? (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
            <div>
              <div className="text-xs text-indigo-200">Compra</div>
              <div className="text-3xl font-bold">{formatColon(latest.buy)}</div>
            </div>
            <div>
              <div className="text-xs text-indigo-200">Venta</div>
              <div className="text-3xl font-bold">{formatColon(latest.sell)}</div>
            </div>
            <div>
              <div className="text-xs text-indigo-200">Fecha</div>
              <div className="text-lg font-medium">{formatDate(latest.date)}</div>
              <div className="text-xs text-indigo-200 mt-1">Fuente: {latest.source.toUpperCase()}</div>
            </div>
          </div>
        ) : (
          <div className="text-indigo-100 italic">Sin tipos de cambio cargados todavía.</div>
        )}
      </div>

      {/* TODO Fase 2: SVG line chart de últimos 30 días (compra+venta). */}
      <div className="bg-white rounded-lg ring-1 ring-slate-200 p-4 mb-6">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-medium text-slate-700">Tendencia 30 días</h3>
          <Badge tone="amber">Pendiente</Badge>
        </div>
        <p className="text-xs text-slate-500">
          Gráfico de líneas (compra/venta) — pendiente para Fase 2.
        </p>
      </div>

      {/* Filtros */}
      <div className="bg-white rounded-lg ring-1 ring-slate-200 p-4 mb-4 flex flex-wrap items-end gap-3">
        <Field label="Desde" className="w-44">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Hasta" className="w-44">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        {(from || to) && (
          <Button variant="ghost" onClick={() => { setFrom(''); setTo(''); }}>
            Limpiar
          </Button>
        )}
        <div className="ml-auto text-xs text-slate-500">
          {rates.length} {rates.length === 1 ? 'registro' : 'registros'}
        </div>
      </div>

      <Table<ExchangeRate>
        loading={isLoading}
        rows={rates}
        rowKey={(r) => r.id}
        empty={<span>Sin tipos de cambio en el rango. Pulsá "Actualizar ahora" para traer del BCCR.</span>}
        columns={[
          { key: 'date', header: 'Fecha', cell: (r) => <span className="font-medium text-slate-900">{formatDate(r.date)}</span> },
          { key: 'buy', header: 'Compra', align: 'right', cell: (r) => formatColon(r.buy) },
          { key: 'sell', header: 'Venta', align: 'right', cell: (r) => formatColon(r.sell) },
          {
            key: 'source',
            header: 'Fuente',
            cell: (r) =>
              r.source === 'bccr'
                ? <Badge tone="blue">BCCR</Badge>
                : <Badge tone="amber">Manual</Badge>,
          },
          {
            key: 'acciones',
            header: '',
            align: 'right',
            cell: (r) => (
              <div className="flex justify-end gap-1">
                {isAdmin && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleDelete(r)}
                    aria-label="Borrar"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />

      <Drawer
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setForm(emptyForm); setErrors({}); }}
        title="Tipo de cambio manual"
        size="md"
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => { setDrawerOpen(false); setForm(emptyForm); setErrors({}); }}
              disabled={createManualMut.isPending}
            >
              Cancelar
            </Button>
            <Button onClick={handleManualSubmit} disabled={createManualMut.isPending}>
              {createManualMut.isPending ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        }
      >
        <form onSubmit={handleManualSubmit} className="space-y-4">
          <Field label="Moneda">
            <Input value="USD" disabled />
          </Field>

          <Field label="Fecha" required error={errors.date}>
            <Input
              type="date"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              autoFocus
            />
          </Field>

          <Field label="Compra" required error={errors.buy} hint="Ej: 510.12345">
            <Input
              value={form.buy}
              onChange={(e) => setForm({ ...form, buy: e.target.value })}
              placeholder="510.12345"
              inputMode="decimal"
            />
          </Field>

          <Field label="Venta" required error={errors.sell} hint="Ej: 520.67890">
            <Input
              value={form.sell}
              onChange={(e) => setForm({ ...form, sell: e.target.value })}
              placeholder="520.67890"
              inputMode="decimal"
            />
          </Field>

          <p className="text-xs text-slate-500">
            Crear un rate manual sobrescribe cualquier rate previo para esa fecha
            (incluso si vino del BCCR). Útil cuando el BCCR está caído o publicó un valor incorrecto.
          </p>

          <button type="submit" className="hidden" aria-hidden />
        </form>
      </Drawer>
    </div>
  );
}
