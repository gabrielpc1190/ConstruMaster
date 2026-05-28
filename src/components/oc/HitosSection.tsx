/**
 * HitosSection — sección para mostrar hitos por item de OC.
 *
 * Renderiza una card por cada OrdenCompraItem que sea de tipo `servicio`
 * (o que no tenga material, i.e. ad-hoc) con sus hitos listados y barra de
 * progreso. Cada card permite agregar un hito nuevo y marcar como completado.
 *
 * Si todos los items son materiales, no se renderiza nada (sección oculta).
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, CheckCircle, Circle } from 'lucide-react';

import { useList } from '../../hooks/useApi';
import { api, type ApiError } from '../../services/api';
import { useToast } from '../../context/ToastContext';
import { useAuth } from '../../context/AuthContext';
import { Button } from '../ui/Button';
import { Input, Textarea, Field } from '../ui/Input';
import { Drawer } from '../ui/Drawer';
import { Badge } from '../ui/Badge';
import { formatDate, formatMoney } from '../../lib/format';

interface HitoRow {
  id: number;
  ocItemId: number;
  nombre: string;
  monto: string | number | null;
  fechaEstimada: string | null;
  fechaCompletado: string | null;
  completado: boolean;
  orden: number;
  notas: string | null;
}

interface OcItemWithHitos {
  id: number;
  descripcion: string;
  cantidad: string | number;
  unidad: string;
  material?: { id: number; nombreCanonico: string; tipo: 'material' | 'servicio' } | null;
  hitos: HitoRow[];
}

export function HitosSection({ ocId }: { ocId: number }) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const { user } = useAuth();

  const role = String(user?.role ?? '');
  const canWrite = ['admin', 'supervisor'].includes(role);

  const { data: items = [], isLoading } = useList<OcItemWithHitos>(
    ['ocs', ocId, 'hitos'] as const,
    `/ocs/${ocId}/hitos`,
  );

  // Filtrar items que tengan al menos sentido para hitos:
  //  - material.tipo === 'servicio'
  //  - o no tienen material (ad-hoc)
  const servicios = items.filter((it) => !it.material || it.material.tipo === 'servicio');

  const [createForItemId, setCreateForItemId] = useState<number | null>(null);
  const [nombre, setNombre] = useState('');
  const [monto, setMonto] = useState('');
  const [fechaEstimada, setFechaEstimada] = useState('');
  const [notas, setNotas] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function openCreate(itemId: number) {
    setCreateForItemId(itemId);
    setNombre('');
    setMonto('');
    setFechaEstimada('');
    setNotas('');
  }

  async function handleCreate() {
    if (!createForItemId) return;
    if (!nombre.trim()) {
      showToast('Nombre del hito requerido', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await api.post(`/ocs/${ocId}/items/${createForItemId}/hitos`, {
        nombre: nombre.trim(),
        monto: monto ? monto : null,
        fechaEstimada: fechaEstimada || null,
        notas: notas.trim() || null,
      });
      qc.invalidateQueries({ queryKey: ['ocs', ocId, 'hitos'] });
      showToast('Hito creado', 'success');
      setCreateForItemId(null);
    } catch (err) {
      showToast((err as ApiError).message || 'Error al crear hito', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleComplete(hitoId: number) {
    try {
      await api.post(`/ocs/hitos/${hitoId}/completar`);
      qc.invalidateQueries({ queryKey: ['ocs', ocId, 'hitos'] });
      showToast('Hito completado', 'success');
    } catch (err) {
      showToast((err as ApiError).message || 'Error al completar hito', 'error');
    }
  }

  if (isLoading) {
    return (
      <section className="bg-white rounded-lg ring-1 ring-slate-200 p-5">
        <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide mb-3">Hitos</h2>
        <p className="text-sm text-slate-400 italic">Cargando…</p>
      </section>
    );
  }

  if (servicios.length === 0) {
    return null;
  }

  return (
    <section className="bg-white rounded-lg ring-1 ring-slate-200 p-5">
      <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide mb-4">
        Hitos de servicios
      </h2>
      <div className="space-y-4">
        {servicios.map((item) => {
          const total = item.hitos.length;
          const done = item.hitos.filter((h) => h.completado).length;
          const pct = total > 0 ? Math.round((done / total) * 100) : 0;
          return (
            <div key={item.id} className="rounded-md ring-1 ring-slate-200 p-4 bg-slate-50">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-900 truncate">{item.descripcion}</div>
                  <div className="text-xs text-slate-500">
                    {item.material ? item.material.nombreCanonico : 'Ad-hoc'} ·{' '}
                    {Number(item.cantidad)} {item.unidad}
                  </div>
                </div>
                {canWrite && (
                  <Button size="sm" variant="secondary" onClick={() => openCreate(item.id)}>
                    <Plus className="w-4 h-4" /> Agregar hito
                  </Button>
                )}
              </div>

              {total > 0 ? (
                <>
                  <div className="flex items-center gap-3 mb-3">
                    <div className="flex-1 h-2 bg-slate-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-emerald-500 transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs text-slate-500 tabular-nums">
                      {done}/{total} ({pct}%)
                    </span>
                  </div>

                  <ul className="space-y-1.5">
                    {item.hitos.map((h) => (
                      <li
                        key={h.id}
                        className="flex items-center gap-2 text-sm bg-white rounded px-3 py-2 ring-1 ring-slate-200"
                      >
                        <button
                          onClick={() => canWrite && !h.completado && handleComplete(h.id)}
                          disabled={!canWrite || h.completado}
                          className={
                            h.completado
                              ? 'text-emerald-600'
                              : canWrite
                                ? 'text-slate-400 hover:text-emerald-600'
                                : 'text-slate-400'
                          }
                          title={h.completado ? 'Completado' : 'Marcar completado'}
                        >
                          {h.completado ? (
                            <CheckCircle className="w-4 h-4" />
                          ) : (
                            <Circle className="w-4 h-4" />
                          )}
                        </button>
                        <span className={`flex-1 ${h.completado ? 'line-through text-slate-400' : 'text-slate-800'}`}>
                          {h.nombre}
                        </span>
                        {h.monto != null && (
                          <span className="text-xs text-slate-500 tabular-nums">
                            {formatMoney({ amount: h.monto, currency: 'CRC' })}
                          </span>
                        )}
                        {h.fechaEstimada && (
                          <Badge tone="slate">{formatDate(h.fechaEstimada)}</Badge>
                        )}
                        {h.completado && h.fechaCompletado && (
                          <Badge tone="emerald">{formatDate(h.fechaCompletado)}</Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-xs text-slate-400 italic">Sin hitos definidos.</p>
              )}
            </div>
          );
        })}
      </div>

      <Drawer
        open={createForItemId != null}
        onClose={() => setCreateForItemId(null)}
        title="Nuevo hito"
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateForItemId(null)} disabled={submitting}>
              Cancelar
            </Button>
            <Button onClick={handleCreate} disabled={submitting}>
              {submitting ? 'Creando…' : 'Crear hito'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Field label="Nombre" required>
            <Input value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Monto" hint="Opcional. Submonto del item correspondiente al hito.">
            <Input
              type="number"
              step="0.01"
              min={0}
              value={monto}
              onChange={(e) => setMonto(e.target.value)}
            />
          </Field>
          <Field label="Fecha estimada">
            <Input type="date" value={fechaEstimada} onChange={(e) => setFechaEstimada(e.target.value)} />
          </Field>
          <Field label="Notas">
            <Textarea value={notas} onChange={(e) => setNotas(e.target.value)} />
          </Field>
        </div>
      </Drawer>
    </section>
  );
}
