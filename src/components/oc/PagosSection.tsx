/**
 * PagosSection — sección a embeber dentro de OcDetail.
 *
 * Lista los pagos de la OC, permite programar pagos nuevos, marcarlos como
 * realizados, editarlos y eliminarlos. Cierra el ciclo financiero de la OC
 * (autorizada → pagada_parcial → pagada).
 *
 * Diseño:
 *  - Tabla compacta con columnas: # · fecha programada · fecha realizada
 *    (o "pendiente") · monto · método · estado · acciones.
 *  - Drawer de creación con hito-vinculación opcional (multi-select).
 *  - Modal de "marcar como pagado" que pregunta solo la fecha.
 *  - Resumen abajo: total programado · total pagado · saldo. Calculado
 *    cliente-side asumiendo misma moneda; pagos en otra moneda se muestran
 *    con un asterisco y se excluyen del total (la normalización real vive en
 *    el backend).
 */
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, CheckCircle, Pencil, Trash2 } from 'lucide-react';

import { useList } from '../../hooks/useApi';
import { api, type ApiError } from '../../services/api';
import { useToast } from '../../context/ToastContext';
import { useAuth } from '../../context/AuthContext';
import { Button } from '../ui/Button';
import { Input, Select, Textarea, Field } from '../ui/Input';
import { Drawer } from '../ui/Drawer';
import { Badge } from '../ui/Badge';
import { Table } from '../ui/Table';
import { formatDate, formatMoney, toDateInput, type Money } from '../../lib/format';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Moneda = 'CRC' | 'USD';
type Metodo = 'transferencia' | 'cheque' | 'efectivo' | 'tarjeta' | 'otro';

interface PagoRow {
  id: number;
  ocId: number;
  fechaProgramada: string;
  fechaRealizada: string | null;
  montoAmount: string | number;
  montoCurrency: Moneda;
  metodo: Metodo;
  referencia: string | null;
  notas: string | null;
  fxRateApplied: string | number | null;
  fxRateDate: string | null;
}

interface HitoForSelect {
  id: number;
  nombre: string;
  ocItemId: number;
  completado: boolean;
}

interface OcItemWithHitos {
  id: number;
  descripcion: string;
  material?: { tipo: string } | null;
  hitos: HitoForSelect[];
}

interface Props {
  ocId: number;
  ocMoneda: Moneda;
  ocMontoTotal: Money;
  ocEstado: string;
}

const METODO_LABELS: Record<Metodo, string> = {
  transferencia: 'Transferencia',
  cheque: 'Cheque',
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  otro: 'Otro',
};

const METODOS: Metodo[] = ['transferencia', 'cheque', 'efectivo', 'tarjeta', 'otro'];

function todayDateInput(): string {
  return toDateInput(new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function PagosSection({ ocId, ocMoneda, ocMontoTotal, ocEstado }: Props) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const { user } = useAuth();

  const role = String(user?.role ?? '');
  const canCreate = ['admin', 'supervisor', 'operativo'].includes(role);
  const canMarkPaid = ['admin', 'supervisor'].includes(role);
  const canEdit = ['admin', 'supervisor'].includes(role);
  const canDelete = role === 'admin';

  const ocCancelled = ocEstado === 'cancelada';

  const { data: pagos = [], isLoading } = useList<PagoRow>(
    ['pagos', { ocId }] as const,
    `/pagos?ocId=${ocId}`,
  );

  // Hitos de la OC (para vincular en el form de crear/editar pago).
  const { data: ocItemsWithHitos = [] } = useList<OcItemWithHitos>(
    ['ocs', ocId, 'hitos'] as const,
    `/ocs/${ocId}/hitos`,
  );
  const allHitos = useMemo(
    () => ocItemsWithHitos.flatMap((it) => (it.hitos ?? []).map((h) => ({ ...h, itemDescripcion: it.descripcion }))),
    [ocItemsWithHitos],
  );

  // ---- Form states ----
  const [createOpen, setCreateOpen] = useState(false);
  const [editingPago, setEditingPago] = useState<PagoRow | null>(null);
  const [markPaidPago, setMarkPaidPago] = useState<PagoRow | null>(null);
  const [deletePago, setDeletePago] = useState<PagoRow | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isEditing = editingPago != null;
  const drawerOpen = createOpen || isEditing;
  const drawerTitle = isEditing ? 'Editar pago' : 'Programar pago';

  const [fechaProgramada, setFechaProgramada] = useState('');
  const [montoAmount, setMontoAmount] = useState('');
  const [montoCurrency, setMontoCurrency] = useState<Moneda>(ocMoneda);
  const [metodo, setMetodo] = useState<Metodo>('transferencia');
  const [referencia, setReferencia] = useState('');
  const [notas, setNotas] = useState('');
  const [selectedHitoIds, setSelectedHitoIds] = useState<Set<number>>(new Set());

  // Mark-paid modal state
  const [fechaRealizada, setFechaRealizada] = useState('');

  function openCreate() {
    setFechaProgramada(todayDateInput());
    setMontoAmount('');
    setMontoCurrency(ocMoneda);
    setMetodo('transferencia');
    setReferencia('');
    setNotas('');
    setSelectedHitoIds(new Set());
    setCreateOpen(true);
  }

  function openEdit(p: PagoRow) {
    setFechaProgramada(toDateInput(p.fechaProgramada));
    setMontoAmount(String(p.montoAmount));
    setMontoCurrency(p.montoCurrency);
    setMetodo(p.metodo);
    setReferencia(p.referencia ?? '');
    setNotas(p.notas ?? '');
    // hitoIds vienen sólo en el detail, no en list. Para simplicidad
    // arrancamos vacío en edit (el usuario los re-selecciona si quiere).
    setSelectedHitoIds(new Set());
    setEditingPago(p);
  }

  function closeDrawer() {
    setCreateOpen(false);
    setEditingPago(null);
  }

  function toggleHito(id: number) {
    setSelectedHitoIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmit() {
    if (!fechaProgramada) {
      showToast('Fecha programada requerida', 'error');
      return;
    }
    if (!montoAmount || Number(montoAmount) <= 0) {
      showToast('Monto debe ser > 0', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        fechaProgramada,
        monto: { amount: montoAmount, currency: montoCurrency },
        metodo,
        referencia: referencia.trim() || null,
        notas: notas.trim() || null,
        hitoIds: [...selectedHitoIds],
      };
      if (isEditing && editingPago) {
        await api.put(`/pagos/${editingPago.id}`, payload);
        showToast('Pago actualizado', 'success');
      } else {
        await api.post(`/ocs/${ocId}/pagos`, payload);
        showToast('Pago programado', 'success');
      }
      qc.invalidateQueries({ queryKey: ['pagos'] });
      qc.invalidateQueries({ queryKey: ['ocs'] });
      closeDrawer();
    } catch (err) {
      showToast((err as ApiError).message || 'Error al guardar pago', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMarkPaid() {
    if (!markPaidPago) return;
    setSubmitting(true);
    try {
      const body = fechaRealizada ? { fechaRealizada } : {};
      const res = await api.post<{ transitionedTo?: string; oc?: { estado: string } }>(
        `/pagos/${markPaidPago.id}/marcar-pagado`,
        body,
      );
      qc.invalidateQueries({ queryKey: ['pagos'] });
      qc.invalidateQueries({ queryKey: ['ocs'] });
      const tail = res?.transitionedTo
        ? ` · OC ahora: ${res.transitionedTo}`
        : res?.oc?.estado
          ? ` · OC: ${res.oc.estado}`
          : '';
      showToast(`Pago marcado${tail}`, 'success');
      setMarkPaidPago(null);
      setFechaRealizada('');
    } catch (err) {
      showToast((err as ApiError).message || 'Error al marcar pago', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!deletePago) return;
    setSubmitting(true);
    try {
      await api.delete(`/pagos/${deletePago.id}`);
      qc.invalidateQueries({ queryKey: ['pagos'] });
      qc.invalidateQueries({ queryKey: ['ocs'] });
      showToast('Pago eliminado', 'success');
      setDeletePago(null);
    } catch (err) {
      showToast((err as ApiError).message || 'Error al eliminar pago', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  // ---- Cálculos de resumen (client-side, mismo currency only) ----
  const resumen = useMemo(() => {
    let programado = 0;
    let pagado = 0;
    let mixedCurrencies = false;
    for (const p of pagos) {
      if (p.montoCurrency !== ocMoneda) {
        mixedCurrencies = true;
        continue;
      }
      const n = Number(p.montoAmount);
      if (!Number.isFinite(n)) continue;
      programado += n;
      if (p.fechaRealizada) pagado += n;
    }
    const totalOc = Number(ocMontoTotal.amount);
    const saldo = totalOc - pagado;
    return { programado, pagado, saldo, mixedCurrencies, totalOc };
  }, [pagos, ocMoneda, ocMontoTotal.amount]);

  return (
    <section className="bg-white rounded-lg ring-1 ring-slate-200 p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">Pagos</h2>
        {canCreate && !ocCancelled && (
          <Button size="sm" onClick={openCreate}>
            <Plus className="w-4 h-4" /> Programar pago
          </Button>
        )}
      </div>

      <Table<PagoRow>
        loading={isLoading}
        rows={pagos}
        rowKey={(p) => p.id}
        empty={<span>Sin pagos registrados todavía.</span>}
        columns={[
          { key: 'id', header: '#', cell: (p) => <span className="text-slate-400">{p.id}</span> },
          { key: 'prog', header: 'Programada', cell: (p) => formatDate(p.fechaProgramada) },
          {
            key: 'real',
            header: 'Realizada',
            cell: (p) =>
              p.fechaRealizada ? (
                <span className="text-slate-900">{formatDate(p.fechaRealizada)}</span>
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
                {p.montoCurrency !== ocMoneda && (
                  <span className="text-xs text-amber-600 ml-1" title="Moneda distinta a la OC">*</span>
                )}
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
            cell: (p) => (
              <div className="flex justify-end gap-1">
                {canMarkPaid && !p.fechaRealizada && (
                  <button
                    className="text-emerald-600 hover:text-emerald-800 p-1"
                    title="Marcar como pagado"
                    onClick={() => {
                      setMarkPaidPago(p);
                      setFechaRealizada(todayDateInput());
                    }}
                  >
                    <CheckCircle className="w-4 h-4" />
                  </button>
                )}
                {canEdit && !p.fechaRealizada && (
                  <button
                    className="text-slate-500 hover:text-slate-900 p-1"
                    title="Editar"
                    onClick={() => openEdit(p)}
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                )}
                {canDelete && !p.fechaRealizada && (
                  <button
                    className="text-red-500 hover:text-red-700 p-1"
                    title="Eliminar"
                    onClick={() => setDeletePago(p)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ),
          },
        ]}
      />

      {/* Resumen financiero */}
      <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
        <SummaryCard
          label="Total programado"
          value={formatMoney({ amount: resumen.programado, currency: ocMoneda })}
        />
        <SummaryCard
          label="Total pagado"
          value={formatMoney({ amount: resumen.pagado, currency: ocMoneda })}
          tone="emerald"
        />
        <SummaryCard
          label="Saldo pendiente"
          value={formatMoney({ amount: resumen.saldo, currency: ocMoneda })}
          tone={resumen.saldo <= 0.01 ? 'emerald' : 'amber'}
        />
      </div>
      {resumen.mixedCurrencies && (
        <p className="mt-2 text-xs text-amber-600">
          * Hay pagos en moneda distinta a la OC. El servidor los normaliza para el estado real;
          este resumen los excluye.
        </p>
      )}

      {/* Drawer crear/editar */}
      <Drawer
        open={drawerOpen}
        onClose={closeDrawer}
        title={drawerTitle}
        size="md"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={closeDrawer} disabled={submitting}>
              Cancelar
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Guardando…' : isEditing ? 'Guardar cambios' : 'Programar pago'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Field label="Fecha programada" required>
            <Input
              type="date"
              value={fechaProgramada}
              onChange={(e) => setFechaProgramada(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Monto" required className="col-span-2">
              <Input
                type="number"
                step="0.01"
                min={0}
                value={montoAmount}
                onChange={(e) => setMontoAmount(e.target.value)}
                placeholder="0.00"
              />
            </Field>
            <Field label="Moneda">
              <Select
                value={montoCurrency}
                onChange={(e) => setMontoCurrency(e.target.value as Moneda)}
              >
                <option value="CRC">CRC</option>
                <option value="USD">USD</option>
              </Select>
            </Field>
          </div>
          <Field label="Método" required>
            <Select value={metodo} onChange={(e) => setMetodo(e.target.value as Metodo)}>
              {METODOS.map((m) => (
                <option key={m} value={m}>
                  {METODO_LABELS[m]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Referencia" hint="Número de transferencia, cheque, etc.">
            <Input value={referencia} onChange={(e) => setReferencia(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Notas">
            <Textarea value={notas} onChange={(e) => setNotas(e.target.value)} />
          </Field>
          {allHitos.length > 0 && (
            <Field label="Hitos vinculados" hint="Opcional. Marca uno o más hitos cubiertos por este pago.">
              <div className="border border-slate-200 rounded-md max-h-40 overflow-y-auto divide-y divide-slate-100">
                {allHitos.map((h) => (
                  <label
                    key={h.id}
                    className="flex items-start gap-2 px-3 py-2 text-sm hover:bg-slate-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedHitoIds.has(h.id)}
                      onChange={() => toggleHito(h.id)}
                      className="mt-0.5"
                    />
                    <span className="flex-1 min-w-0">
                      <span className="text-slate-900 font-medium">{h.nombre}</span>
                      <span className="text-xs text-slate-500 block truncate">
                        Item: {h.itemDescripcion}
                      </span>
                    </span>
                    {h.completado && <Badge tone="emerald">Completado</Badge>}
                  </label>
                ))}
              </div>
            </Field>
          )}
        </div>
      </Drawer>

      {/* Modal marcar como pagado */}
      <Drawer
        open={markPaidPago != null}
        onClose={() => setMarkPaidPago(null)}
        title="Marcar pago como realizado"
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setMarkPaidPago(null)} disabled={submitting}>
              Cancelar
            </Button>
            <Button onClick={handleMarkPaid} disabled={submitting}>
              {submitting ? 'Marcando…' : 'Marcar como pagado'}
            </Button>
          </div>
        }
      >
        {markPaidPago && (
          <div className="space-y-4">
            <div className="text-sm text-slate-700">
              <div>Monto: <strong>{formatMoney({ amount: markPaidPago.montoAmount, currency: markPaidPago.montoCurrency })}</strong></div>
              <div>Método: {METODO_LABELS[markPaidPago.metodo]}</div>
              {markPaidPago.referencia && <div>Referencia: {markPaidPago.referencia}</div>}
            </div>
            <Field label="Fecha realizada" required hint="Se usará para snapshot de TC si aplica.">
              <Input
                type="date"
                value={fechaRealizada}
                onChange={(e) => setFechaRealizada(e.target.value)}
              />
            </Field>
            <p className="text-xs text-slate-500">
              Al marcar, el sistema recalcula el estado financiero de la OC
              (parcial / pagada) con base en la suma normalizada.
            </p>
          </div>
        )}
      </Drawer>

      {/* Confirm delete */}
      <Drawer
        open={deletePago != null}
        onClose={() => setDeletePago(null)}
        title="Eliminar pago"
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeletePago(null)} disabled={submitting}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={handleDelete} disabled={submitting}>
              {submitting ? 'Eliminando…' : 'Eliminar'}
            </Button>
          </div>
        }
      >
        {deletePago && (
          <div className="space-y-3 text-sm text-slate-700">
            <p>
              ¿Eliminar el pago de{' '}
              <strong>{formatMoney({ amount: deletePago.montoAmount, currency: deletePago.montoCurrency })}</strong>
              {' '}programado para {formatDate(deletePago.fechaProgramada)}?
            </p>
            <p className="text-xs text-slate-500">
              Esta acción no se puede deshacer.
            </p>
          </div>
        )}
      </Drawer>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SummaryCard({
  label,
  value,
  tone = 'slate',
}: {
  label: string;
  value: string;
  tone?: 'slate' | 'emerald' | 'amber';
}) {
  const toneClasses: Record<string, string> = {
    slate: 'text-slate-900',
    emerald: 'text-emerald-700',
    amber: 'text-amber-700',
  };
  return (
    <div className="bg-slate-50 rounded-md ring-1 ring-slate-200 px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${toneClasses[tone]}`}>{value}</div>
    </div>
  );
}
