/**
 * EntregasSection — sección a embeber dentro de OcDetail.
 *
 * Lista las entregas de la OC, permite crear una nueva (con form que carga
 * los pendientes de la OC para precargar el formulario) y subir fotos
 * directamente al final del flujo de creación.
 *
 * Patrón de fotos: 2 pasos. Primero POST JSON crea la entrega (sin fotos);
 * después POST multipart /entregas/:id/fotos. Más simple y debuggeable.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Camera, Image as ImageIcon, Trash2 } from 'lucide-react';

import { useList, useItem } from '../../hooks/useApi';
import { api, type ApiError } from '../../services/api';
import { useToast } from '../../context/ToastContext';
import { Button } from '../ui/Button';
import { Input, Select, Textarea, Field } from '../ui/Input';
import { Drawer } from '../ui/Drawer';
import { Badge } from '../ui/Badge';
import { formatDate, toDateInput } from '../../lib/format';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EntregaRow {
  id: number;
  ocId: number;
  fecha: string;
  recibidoPor: string;
  completa: boolean;
  notas: string | null;
  registradaPor?: { id: number; username: string; fullName: string | null };
  bodegaDestino?: { id: number; nombre: string };
  _count?: { items: number; fotos: number };
}

interface PendienteItem {
  ocItemId: number;
  descripcion: string;
  unidad: string;
  cantidadOrdenada: number;
  cantidadEntregada: number;
  cantidadPendiente: number;
}

interface PendientesResponse {
  ocId: number;
  numeroOc: string;
  estado: string;
  items: PendienteItem[];
}

interface BodegaOption {
  id: number;
  nombre: string;
  activo: boolean;
}

interface EntregaItemForm {
  // null = item extra (no estaba en OC).
  ocItemId: number | null;
  descripcion: string;
  cantidad: string;
  unidad: string;
  notas?: string;
  enabled: boolean; // checkbox para entregar este item
}

interface CreateEntregaPayload {
  bodegaDestinoId?: number | null;
  fecha: string;
  recibidoPor: string;
  notas?: string;
  items: Array<{
    ocItemId: number | null;
    descripcion: string;
    cantidad: number;
    unidad: string;
    notas?: string;
  }>;
}

const PHOTO_MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const PHOTO_MAX_COUNT = 10;

function todayDateInput(): string {
  return toDateInput(new Date().toISOString());
}

function isValidPhoto(f: File): boolean {
  if (f.size > PHOTO_MAX_SIZE) return false;
  const ext = f.name.toLowerCase();
  return (
    /^image\/(jpeg|png|heif|heic|webp)$/.test(f.type) ||
    /\.(jpg|jpeg|png|heif|heic|webp)$/.test(ext)
  );
}

// ---------------------------------------------------------------------------
// EntregasSection
// ---------------------------------------------------------------------------

export function EntregasSection({ ocId }: { ocId: number }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { showToast } = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [createdEntregaId, setCreatedEntregaId] = useState<number | null>(null);

  const { data: entregasResponse, isLoading } = useItem<EntregaRow[]>(
    ['entregas', { ocId }],
    `/entregas?ocId=${ocId}`,
  );
  const entregas = entregasResponse ?? [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['entregas'] });
    qc.invalidateQueries({ queryKey: ['ocs', ocId] });
    qc.invalidateQueries({ queryKey: ['ocs', 'pendientes', ocId] });
  };

  return (
    <section className="bg-white rounded-lg ring-1 ring-slate-200">
      <header className="px-5 h-11 flex items-center justify-between border-b border-slate-100">
        <h3 className="text-sm font-semibold text-slate-900">
          Entregas {entregas.length > 0 && <span className="text-slate-500">({entregas.length})</span>}
        </h3>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="w-4 h-4" /> Registrar entrega
        </Button>
      </header>
      <div className="p-5 space-y-3">
        {isLoading ? (
          <p className="text-sm text-slate-400 italic">Cargando…</p>
        ) : entregas.length === 0 ? (
          <p className="text-sm text-slate-400 italic">Sin entregas registradas.</p>
        ) : (
          entregas.map((e) => (
            <button
              key={e.id}
              onClick={() => navigate(`/entregas/${e.id}`)}
              className="w-full text-left rounded-md ring-1 ring-slate-200 hover:ring-indigo-300 hover:bg-slate-50 px-4 py-3 transition flex items-center justify-between gap-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-900">
                    {formatDate(e.fecha)}
                  </span>
                  {e.completa && <Badge tone="emerald">Completa</Badge>}
                  {e.bodegaDestino && (
                    <Badge tone="slate">{e.bodegaDestino.nombre}</Badge>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-0.5 truncate">
                  Recibido por <strong>{e.recibidoPor}</strong>
                  {e.registradaPor && <> · Registró {e.registradaPor.fullName ?? e.registradaPor.username}</>}
                </p>
              </div>
              <div className="flex items-center gap-4 text-xs text-slate-500 shrink-0">
                <span className="inline-flex items-center gap-1">
                  <ImageIcon className="w-3.5 h-3.5" /> {e._count?.fotos ?? 0}
                </span>
                <span>{e._count?.items ?? 0} items</span>
              </div>
            </button>
          ))
        )}
      </div>

      <Drawer
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setCreatedEntregaId(null);
        }}
        title="Registrar entrega"
        size="lg"
      >
        {createdEntregaId == null ? (
          <CreateEntregaForm
            ocId={ocId}
            onCancel={() => setCreateOpen(false)}
            onCreated={(id) => {
              invalidate();
              setCreatedEntregaId(id);
            }}
          />
        ) : (
          <PhotoUploadStep
            entregaId={createdEntregaId}
            onDone={() => {
              invalidate();
              setCreateOpen(false);
              setCreatedEntregaId(null);
              showToast('Entrega registrada.', 'success');
            }}
            onSkip={() => {
              setCreateOpen(false);
              setCreatedEntregaId(null);
              showToast('Entrega registrada (sin fotos).', 'success');
            }}
          />
        )}
      </Drawer>
    </section>
  );
}

// ---------------------------------------------------------------------------
// CreateEntregaForm
// ---------------------------------------------------------------------------

function CreateEntregaForm({
  ocId,
  onCreated,
  onCancel,
}: {
  ocId: number;
  onCreated: (entregaId: number) => void;
  onCancel: () => void;
}) {
  const { showToast } = useToast();

  const { data: pendientes, isLoading: loadingPend } = useItem<PendientesResponse>(
    ['ocs', 'pendientes', ocId],
    `/ocs/${ocId}/pendientes`,
  );
  const { data: bodegasList = [] } = useList<BodegaOption>(
    ['bodegas', 'all'],
    '/bodegas',
  );
  const bodegas = useMemo(() => bodegasList.filter((b) => b.activo), [bodegasList]);

  const [fecha, setFecha] = useState(todayDateInput());
  const [recibidoPor, setRecibidoPor] = useState('');
  const [bodegaDestinoId, setBodegaDestinoId] = useState<number | ''>('');
  const [notas, setNotas] = useState('');
  // Items derivados de pendientes + overrides locales + extras agregados.
  // Overrides: por ocItemId (null para extras keyed por índice).
  type Override = Partial<Pick<EntregaItemForm, 'cantidad' | 'enabled' | 'notas'>>;
  const [overrides, setOverrides] = useState<Map<string, Override>>(new Map());
  const [extras, setExtras] = useState<EntregaItemForm[]>([]);

  const items: EntregaItemForm[] = useMemo(() => {
    const base: EntregaItemForm[] = (pendientes?.items ?? []).map((p) => {
      const ov = overrides.get(String(p.ocItemId)) ?? {};
      return {
        ocItemId: p.ocItemId,
        descripcion: p.descripcion,
        cantidad: ov.cantidad ?? String(p.cantidadPendiente > 0 ? p.cantidadPendiente : ''),
        unidad: p.unidad,
        enabled: ov.enabled ?? p.cantidadPendiente > 0,
        notas: ov.notas,
      };
    });
    return [...base, ...extras];
  }, [pendientes, overrides, extras]);

  const baseCount = pendientes?.items.length ?? 0;

  const addExtraItem = () => {
    setExtras((prev) => [
      ...prev,
      { ocItemId: null, descripcion: '', cantidad: '', unidad: '', enabled: true },
    ]);
  };

  const removeItem = (idx: number) => {
    // Solo se pueden remover extras (filas con índice >= baseCount).
    if (idx < baseCount) return;
    const extraIdx = idx - baseCount;
    setExtras((prev) => prev.filter((_, i) => i !== extraIdx));
  };

  const updateItem = (idx: number, patch: Partial<EntregaItemForm>) => {
    if (idx < baseCount) {
      // Update a un item base → guardar override por ocItemId.
      const it = items[idx];
      const key = String(it.ocItemId);
      setOverrides((prev) => {
        const next = new Map(prev);
        const merged = { ...(next.get(key) ?? {}), ...patch };
        next.set(key, merged);
        return next;
      });
    } else {
      // Update a extra.
      const extraIdx = idx - baseCount;
      setExtras((prev) => prev.map((it, i) => (i === extraIdx ? { ...it, ...patch } : it)));
    }
  };

  const mutation = useMutation<{ id: number }, ApiError, CreateEntregaPayload>({
    mutationFn: (body) => api.post(`/ocs/${ocId}/entregas`, body),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!recibidoPor.trim()) {
      showToast('Indicá quién recibió el material.', 'error');
      return;
    }
    const selected = items.filter((it) => it.enabled);
    if (selected.length === 0) {
      showToast('Marcá al menos un item para entregar.', 'error');
      return;
    }
    for (const it of selected) {
      const n = Number(it.cantidad);
      if (!Number.isFinite(n) || n <= 0) {
        showToast(`Cantidad inválida en "${it.descripcion}"`, 'error');
        return;
      }
      if (!it.descripcion.trim()) {
        showToast('Item sin descripción.', 'error');
        return;
      }
      if (!it.unidad.trim()) {
        showToast(`Falta unidad en "${it.descripcion}"`, 'error');
        return;
      }
    }

    mutation.mutate(
      {
        fecha,
        recibidoPor: recibidoPor.trim(),
        bodegaDestinoId: bodegaDestinoId === '' ? null : Number(bodegaDestinoId),
        notas: notas.trim() || undefined,
        items: selected.map((it) => ({
          ocItemId: it.ocItemId,
          descripcion: it.descripcion.trim(),
          cantidad: Number(it.cantidad),
          unidad: it.unidad.trim(),
          notas: it.notas?.trim() || undefined,
        })),
      },
      {
        onSuccess: (created) => onCreated(created.id),
        onError: (err) => showToast(err.message || 'Error al registrar entrega', 'error'),
      },
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Fecha" required>
          <Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} required />
        </Field>
        <Field label="Recibido por" required>
          <Input
            value={recibidoPor}
            onChange={(e) => setRecibidoPor(e.target.value)}
            placeholder="Ej: Tony Vargas"
            required
          />
        </Field>
        <Field label="Bodega destino" hint="Opcional.">
          <Select
            value={bodegaDestinoId === '' ? '' : String(bodegaDestinoId)}
            onChange={(e) => setBodegaDestinoId(e.target.value === '' ? '' : Number(e.target.value))}
          >
            <option value="">— Sin especificar —</option>
            {bodegas.map((b) => (
              <option key={b.id} value={b.id}>{b.nombre}</option>
            ))}
          </Select>
        </Field>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold text-slate-900">Items a recibir</h4>
          <Button type="button" variant="secondary" size="sm" onClick={addExtraItem}>
            <Plus className="w-3.5 h-3.5" /> Agregar item extra
          </Button>
        </div>
        {loadingPend ? (
          <p className="text-sm text-slate-400 italic">Cargando pendientes…</p>
        ) : (
          <div className="rounded-md ring-1 ring-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs font-medium text-slate-500 uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2 w-10"></th>
                  <th className="px-3 py-2 text-left">Descripción</th>
                  <th className="px-3 py-2 text-right">Pendiente</th>
                  <th className="px-3 py-2 text-right">Cantidad</th>
                  <th className="px-3 py-2 text-left">Unidad</th>
                  <th className="px-3 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-sm text-slate-400 italic">
                      La OC no tiene items o todos fueron entregados. Usá "Agregar item extra".
                    </td>
                  </tr>
                )}
                {items.map((it, idx) => {
                  const pend = pendientes?.items.find((p) => p.ocItemId === it.ocItemId);
                  const isExtra = it.ocItemId == null;
                  return (
                    <tr key={`${it.ocItemId ?? 'extra'}-${idx}`} className={!it.enabled ? 'opacity-50' : ''}>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={it.enabled}
                          onChange={(e) => updateItem(idx, { enabled: e.target.checked })}
                          className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        />
                      </td>
                      <td className="px-3 py-2">
                        {isExtra ? (
                          <div className="flex flex-col gap-1">
                            <Input
                              value={it.descripcion}
                              onChange={(e) => updateItem(idx, { descripcion: e.target.value })}
                              placeholder="Descripción (item extra)"
                              className="h-8 text-xs"
                            />
                            <span className="text-[10px] text-amber-700 uppercase tracking-wide">
                              No estaba en la OC
                            </span>
                          </div>
                        ) : (
                          <span className="text-slate-700">{it.descripcion}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-slate-500 font-mono">
                        {pend
                          ? `${pend.cantidadPendiente} / ${pend.cantidadOrdenada}`
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={it.cantidad}
                          onChange={(e) => updateItem(idx, { cantidad: e.target.value })}
                          disabled={!it.enabled}
                          className="h-8 text-xs text-right font-mono w-24 inline-block"
                        />
                      </td>
                      <td className="px-3 py-2">
                        {isExtra ? (
                          <Input
                            value={it.unidad}
                            onChange={(e) => updateItem(idx, { unidad: e.target.value })}
                            placeholder="ej: saco"
                            className="h-8 text-xs w-24 inline-block"
                          />
                        ) : (
                          <span className="text-xs text-slate-600">{it.unidad}</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {isExtra && (
                          <button
                            type="button"
                            onClick={() => removeItem(idx)}
                            className="text-slate-400 hover:text-red-600"
                            aria-label="Quitar"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Field label="Notas (opcional)">
        <Textarea
          value={notas}
          onChange={(e) => setNotas(e.target.value)}
          placeholder="Observaciones sobre la entrega"
          rows={2}
        />
      </Field>

      <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={mutation.isPending}>
          Cancelar
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Guardando…' : 'Registrar entrega'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// PhotoUploadStep
// ---------------------------------------------------------------------------

function PhotoUploadStep({
  entregaId,
  onDone,
  onSkip,
}: {
  entregaId: number;
  onDone: () => void;
  onSkip: () => void;
}) {
  const { showToast } = useToast();
  const [files, setFiles] = useState<File[]>([]);

  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  const mutation = useMutation<unknown, ApiError, File[]>({
    mutationFn: (fs) => {
      const fd = new FormData();
      for (const f of fs) fd.append('fotos', f, f.name);
      return api.upload(`/entregas/${entregaId}/fotos`, fd);
    },
  });

  const handleSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    const valid: File[] = [];
    for (const f of list) {
      if (!isValidPhoto(f)) {
        showToast(`${f.name}: formato/tamaño no válido`, 'error');
        continue;
      }
      valid.push(f);
    }
    const next = [...files, ...valid].slice(0, PHOTO_MAX_COUNT);
    if (next.length < files.length + valid.length) {
      showToast(`Máximo ${PHOTO_MAX_COUNT} fotos`, 'info');
    }
    setFiles(next);
    e.target.value = '';
  };

  const removeAt = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleUpload = () => {
    if (files.length === 0) {
      onSkip();
      return;
    }
    mutation.mutate(files, {
      onSuccess: () => onDone(),
      onError: (err) => showToast(err.message || 'Error subiendo fotos', 'error'),
    });
  };

  return (
    <div className="space-y-5">
      <div className="rounded-md bg-amber-50 ring-1 ring-amber-200 px-4 py-3 text-sm text-amber-900">
        <p className="font-medium">Entrega registrada. ¿Querés subir fotos del material recibido?</p>
        <p className="text-xs text-amber-800 mt-1">
          Las fotos son evidencia legal. Se preservan tal cual (sin recompresión).
        </p>
      </div>

      <Field label={`Fotos (${files.length}/${PHOTO_MAX_COUNT})`} hint="JPEG, PNG, HEIF o WEBP. Máx 10 MB cada una.">
        <label className="flex items-center justify-center gap-2 rounded-md border-2 border-dashed border-slate-300 bg-slate-50 px-4 py-6 cursor-pointer hover:border-slate-400">
          <Camera className="w-5 h-5 text-slate-500" />
          <span className="text-sm text-slate-600">Tocá para elegir o tomar fotos</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/heif,image/heic,image/webp"
            multiple
            capture="environment"
            onChange={handleSelect}
            className="hidden"
            disabled={files.length >= PHOTO_MAX_COUNT}
          />
        </label>
      </Field>

      {previews.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {previews.map((url, idx) => (
            <div key={url} className="relative group aspect-square rounded-md overflow-hidden ring-1 ring-slate-200">
              <img src={url} alt={files[idx]?.name} className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={() => removeAt(idx)}
                className="absolute top-1 right-1 bg-slate-900/60 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition"
                aria-label="Quitar"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
        <Button type="button" variant="secondary" onClick={onSkip} disabled={mutation.isPending}>
          Omitir
        </Button>
        <Button type="button" onClick={handleUpload} disabled={mutation.isPending}>
          {mutation.isPending
            ? 'Subiendo…'
            : files.length === 0
            ? 'Finalizar sin fotos'
            : `Subir ${files.length} foto${files.length === 1 ? '' : 's'}`}
        </Button>
      </div>
    </div>
  );
}

export default EntregasSection;
