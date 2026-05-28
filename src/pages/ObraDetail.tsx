import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Trash2, Plus, FileText, Receipt, Hash } from 'lucide-react';
import { useItem, useCreate, useUpdate, useDelete } from '../hooks/useApi';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { Button } from '../components/ui/Button';
import { Input, Select, Textarea, Field } from '../components/ui/Input';
import { Drawer } from '../components/ui/Drawer';
import { Badge } from '../components/ui/Badge';
import { PageHeader } from '../components/ui/PageHeader';
import { formatDate, formatMoney, toDateInput } from '../lib/format';

type ObraEstado = 'planificada' | 'en_curso' | 'pausada' | 'finalizada';
type Moneda = 'CRC' | 'USD';

interface MoneyValue {
  amount: string;
  currency: Moneda;
}

interface Categoria {
  id: number;
  obraId: number;
  nombre: string;
  orden: number;
}

interface Presupuesto {
  id: number;
  obraId: number;
  categoriaId: number;
  categoria: Categoria;
  monto: MoneyValue;
  notas: string | null;
}

interface ObraDetailData {
  id: number;
  clienteId: number;
  cliente: { id: number; nombre: string };
  nombre: string;
  slug: string;
  direccion: string | null;
  fechaInicio: string | null;
  fechaFinEstimada: string | null;
  monedaReporte: Moneda;
  estado: ObraEstado;
  nextOcSeq: number;
  notas: string | null;
  createdAt: string;
  updatedAt: string;
  categorias: Categoria[];
  presupuestos: Presupuesto[];
}

const ESTADO_LABELS: Record<ObraEstado, string> = {
  planificada: 'Planificada',
  en_curso: 'En curso',
  pausada: 'Pausada',
  finalizada: 'Finalizada',
};

const ESTADO_TONES: Record<ObraEstado, 'slate' | 'indigo' | 'emerald' | 'amber' | 'orange' | 'red' | 'blue'> = {
  planificada: 'blue',
  en_curso: 'emerald',
  pausada: 'amber',
  finalizada: 'slate',
};

type Tab = 'resumen' | 'categorias' | 'notas';

interface EditObraInput {
  nombre?: string;
  direccion?: string | null;
  fechaInicio?: string | null;
  fechaFinEstimada?: string | null;
  monedaReporte?: Moneda;
  estado?: ObraEstado;
  notas?: string | null;
}

interface EditForm {
  nombre: string;
  direccion: string;
  fechaInicio: string;
  fechaFinEstimada: string;
  monedaReporte: Moneda;
  estado: ObraEstado;
  notas: string;
}

interface CategoriaForm {
  open: boolean;
  nombre: string;
  orden: string;
  editingId: number | null;
}

interface PresupuestoForm {
  open: boolean;
  categoriaId: number | null;
  amount: string;
  currency: Moneda;
  notas: string;
  editingId: number | null;
}

export default function ObraDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { showToast } = useToast();
  const isAdmin = user?.role === 'admin';

  const [tab, setTab] = useState<Tab>('resumen');
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [editErrors, setEditErrors] = useState<Partial<Record<keyof EditForm, string>>>({});

  const [catForm, setCatForm] = useState<CategoriaForm>({ open: false, nombre: '', orden: '0', editingId: null });
  const [presForm, setPresForm] = useState<PresupuestoForm>({
    open: false,
    categoriaId: null,
    amount: '',
    currency: 'USD',
    notas: '',
    editingId: null,
  });

  const { data: obra, isLoading, isError, error } = useItem<ObraDetailData>(
    ['obras', id],
    `/obras/${id}`,
    Boolean(id),
  );

  const invalidate: readonly unknown[][] = [['obras'], ['obras', id]];

  const updateObra = useUpdate<EditObraInput, ObraDetailData>((oid) => `/obras/${oid}`, invalidate);
  const deleteObra = useDelete((oid) => `/obras/${oid}`, [['obras']]);

  const createCategoria = useCreate<{ nombre: string; orden?: number }, Categoria>(
    `/obras/${id}/categorias`,
    invalidate,
  );
  const updateCategoria = useUpdate<{ nombre?: string; orden?: number }, Categoria>(
    (cid) => `/obras/categorias/${cid}`,
    invalidate,
  );
  const deleteCategoria = useDelete((cid) => `/obras/categorias/${cid}`, invalidate);

  const createPresupuesto = useCreate<
    { categoriaId: number; monto: MoneyValue; notas?: string },
    Presupuesto
  >(`/obras/${id}/presupuestos`, invalidate);
  const updatePresupuesto = useUpdate<
    { monto?: MoneyValue; notas?: string | null },
    Presupuesto
  >((pid) => `/obras/presupuestos/${pid}`, invalidate);
  const deletePresupuesto = useDelete((pid) => `/obras/presupuestos/${pid}`, invalidate);

  const presupuestosPorCategoria = useMemo(() => {
    const map = new Map<number, Presupuesto[]>();
    obra?.presupuestos?.forEach((p) => {
      const arr = map.get(p.categoriaId) ?? [];
      arr.push(p);
      map.set(p.categoriaId, arr);
    });
    return map;
  }, [obra]);

  const openEdit = () => {
    if (!obra) return;
    setEditForm({
      nombre: obra.nombre,
      direccion: obra.direccion ?? '',
      fechaInicio: toDateInput(obra.fechaInicio),
      fechaFinEstimada: toDateInput(obra.fechaFinEstimada),
      monedaReporte: obra.monedaReporte,
      estado: obra.estado,
      notas: obra.notas ?? '',
    });
    setEditErrors({});
    setEditOpen(true);
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!obra || !editForm) return;
    const next: typeof editErrors = {};
    if (!editForm.nombre.trim()) next.nombre = 'Nombre es requerido';
    if (Object.keys(next).length) {
      setEditErrors(next);
      return;
    }
    const payload: EditObraInput = {
      nombre: editForm.nombre.trim(),
      direccion: editForm.direccion.trim() || null,
      fechaInicio: editForm.fechaInicio || null,
      fechaFinEstimada: editForm.fechaFinEstimada || null,
      monedaReporte: editForm.monedaReporte,
      estado: editForm.estado,
      notas: editForm.notas.trim() || null,
    };
    updateObra.mutate(
      { id: obra.id, data: payload },
      {
        onSuccess: () => {
          showToast('Obra actualizada', 'success');
          setEditOpen(false);
        },
        onError: (err) => showToast(err.message || 'Error al actualizar', 'error'),
      },
    );
  };

  const handleDelete = () => {
    if (!obra) return;
    deleteObra.mutate(obra.id, {
      onSuccess: () => {
        showToast('Obra eliminada', 'success');
        navigate('/obras');
      },
      onError: (err) => showToast(err.message || 'Error al eliminar', 'error'),
    });
  };

  const openCategoriaCreate = () => {
    setCatForm({
      open: true,
      nombre: '',
      orden: String((obra?.categorias?.length ?? 0)),
      editingId: null,
    });
  };

  const openCategoriaEdit = (c: Categoria) => {
    setCatForm({ open: true, nombre: c.nombre, orden: String(c.orden), editingId: c.id });
  };

  const submitCategoria = (e: React.FormEvent) => {
    e.preventDefault();
    if (!catForm.nombre.trim()) {
      showToast('Nombre de categoría requerido', 'error');
      return;
    }
    const orden = Number(catForm.orden) || 0;
    if (catForm.editingId) {
      updateCategoria.mutate(
        { id: catForm.editingId, data: { nombre: catForm.nombre.trim(), orden } },
        {
          onSuccess: () => {
            showToast('Categoría actualizada', 'success');
            setCatForm({ ...catForm, open: false });
          },
          onError: (err) => showToast(err.message || 'Error', 'error'),
        },
      );
    } else {
      createCategoria.mutate(
        { nombre: catForm.nombre.trim(), orden },
        {
          onSuccess: () => {
            showToast('Categoría creada', 'success');
            setCatForm({ ...catForm, open: false });
          },
          onError: (err) => showToast(err.message || 'Error', 'error'),
        },
      );
    }
  };

  const handleDeleteCategoria = (c: Categoria) => {
    if (!window.confirm(`Eliminar categoría "${c.nombre}"?`)) return;
    deleteCategoria.mutate(c.id, {
      onSuccess: () => showToast('Categoría eliminada', 'success'),
      onError: (err) => showToast(err.message || 'No se pudo eliminar', 'error'),
    });
  };

  const openPresupuestoCreate = (categoriaId: number) => {
    setPresForm({
      open: true,
      categoriaId,
      amount: '',
      currency: obra?.monedaReporte ?? 'USD',
      notas: '',
      editingId: null,
    });
  };

  const openPresupuestoEdit = (p: Presupuesto) => {
    setPresForm({
      open: true,
      categoriaId: p.categoriaId,
      amount: String(p.monto.amount),
      currency: p.monto.currency,
      notas: p.notas ?? '',
      editingId: p.id,
    });
  };

  const submitPresupuesto = (e: React.FormEvent) => {
    e.preventDefault();
    if (!presForm.categoriaId) return;
    const amount = presForm.amount.trim();
    if (!amount || !Number.isFinite(Number(amount))) {
      showToast('Monto inválido', 'error');
      return;
    }
    const monto: MoneyValue = { amount, currency: presForm.currency };
    const notas = presForm.notas.trim() || undefined;
    if (presForm.editingId) {
      updatePresupuesto.mutate(
        { id: presForm.editingId, data: { monto, notas: notas ?? null } },
        {
          onSuccess: () => {
            showToast('Presupuesto actualizado', 'success');
            setPresForm({ ...presForm, open: false });
          },
          onError: (err) => showToast(err.message || 'Error', 'error'),
        },
      );
    } else {
      createPresupuesto.mutate(
        { categoriaId: presForm.categoriaId, monto, notas },
        {
          onSuccess: () => {
            showToast('Presupuesto guardado', 'success');
            setPresForm({ ...presForm, open: false });
          },
          onError: (err) => showToast(err.message || 'Error', 'error'),
        },
      );
    }
  };

  const handleDeletePresupuesto = (p: Presupuesto) => {
    if (!window.confirm('Eliminar presupuesto?')) return;
    deletePresupuesto.mutate(p.id, {
      onSuccess: () => showToast('Presupuesto eliminado', 'success'),
      onError: (err) => showToast(err.message || 'Error', 'error'),
    });
  };

  if (isLoading) {
    return <p className="text-slate-400 italic text-center py-8">Cargando obra…</p>;
  }
  if (isError || !obra) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate('/obras')}>
          <ArrowLeft className="w-4 h-4" /> Volver
        </Button>
        <p className="text-red-600">No se pudo cargar la obra: {error?.message ?? 'desconocido'}</p>
      </div>
    );
  }

  return (
    <div>
      <Button variant="ghost" size="sm" onClick={() => navigate('/obras')} className="mb-2">
        <ArrowLeft className="w-4 h-4" /> Obras
      </Button>

      <PageHeader
        title={obra.nombre}
        subtitle={obra.cliente?.nombre}
        actions={
          <>
            <Badge tone={ESTADO_TONES[obra.estado]}>{ESTADO_LABELS[obra.estado]}</Badge>
            <Button variant="secondary" onClick={openEdit}>
              <Pencil className="w-4 h-4" /> Editar
            </Button>
            {isAdmin && (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="w-4 h-4" /> Eliminar
              </Button>
            )}
          </>
        }
      />

      {confirmDelete && (
        <div className="mb-4 bg-red-50 ring-1 ring-red-200 rounded-lg p-4 flex items-center justify-between gap-3">
          <p className="text-sm text-red-800">
            Confirmar eliminación de "<strong>{obra.nombre}</strong>". Esta acción la marcará como finalizada (soft delete).
          </p>
          <div className="flex gap-2 shrink-0">
            <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(false)} disabled={deleteObra.isPending}>
              Cancelar
            </Button>
            <Button variant="danger" size="sm" onClick={handleDelete} disabled={deleteObra.isPending}>
              {deleteObra.isPending ? 'Eliminando…' : 'Confirmar'}
            </Button>
          </div>
        </div>
      )}

      <div className="border-b border-slate-200 mb-6 flex gap-1">
        {([
          ['resumen', 'Resumen'],
          ['categorias', 'Categorías y presupuestos'],
          ['notas', 'Notas'],
        ] as [Tab, string][]).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={
              tab === k
                ? 'px-4 py-2 text-sm font-medium text-indigo-700 border-b-2 border-indigo-600 -mb-px'
                : 'px-4 py-2 text-sm font-medium text-slate-500 hover:text-slate-800'
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'resumen' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <StatCard label="Próximo número OC" value={obra.nextOcSeq} icon={<Hash className="w-5 h-5" />} />
            <StatCard label="Cotizaciones" value="—" hint="Fase 2" icon={<FileText className="w-5 h-5" />} />
            <StatCard label="Órdenes de compra" value="—" hint="Fase 2" icon={<Receipt className="w-5 h-5" />} />
          </div>

          <div className="bg-white rounded-lg ring-1 ring-slate-200 p-4">
            <h3 className="text-base font-semibold text-slate-900 mb-3">Información general</h3>
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-y-2 gap-x-6 text-sm">
              <Row label="Dirección" value={obra.direccion} />
              <Row label="Moneda de reporte" value={obra.monedaReporte} />
              <Row label="Fecha de inicio" value={formatDate(obra.fechaInicio)} />
              <Row label="Fin estimada" value={formatDate(obra.fechaFinEstimada)} />
              <Row label="Slug" value={<code className="text-xs text-slate-600">{obra.slug}</code>} />
              <Row label="Creada" value={formatDate(obra.createdAt)} />
            </dl>
          </div>
        </div>
      )}

      {tab === 'categorias' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={openCategoriaCreate}>
              <Plus className="w-4 h-4" /> Nueva categoría
            </Button>
          </div>

          {obra.categorias.length === 0 ? (
            <p className="text-slate-400 italic text-center py-8">
              Sin categorías todavía. Crea la primera para asignar presupuestos.
            </p>
          ) : (
            <div className="space-y-4">
              {[...obra.categorias]
                .sort((a, b) => a.orden - b.orden)
                .map((c) => {
                  const presus = presupuestosPorCategoria.get(c.id) ?? [];
                  return (
                    <div key={c.id} className="bg-white rounded-lg ring-1 ring-slate-200 overflow-hidden">
                      <div className="px-4 py-3 flex items-center justify-between border-b border-slate-100">
                        <div>
                          <h4 className="text-sm font-semibold text-slate-900">{c.nombre}</h4>
                          <p className="text-xs text-slate-500">Orden: {c.orden}</p>
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" variant="secondary" onClick={() => openPresupuestoCreate(c.id)}>
                            <Plus className="w-3.5 h-3.5" /> Presupuesto
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => openCategoriaEdit(c)}>
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          {isAdmin && (
                            <Button size="sm" variant="ghost" onClick={() => handleDeleteCategoria(c)}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>
                      {presus.length === 0 ? (
                        <p className="px-4 py-4 text-xs text-slate-400 italic">Sin presupuestos.</p>
                      ) : (
                        <table className="w-full text-sm">
                          <thead className="bg-slate-50 text-xs font-medium text-slate-500 uppercase tracking-wide">
                            <tr>
                              <th className="px-4 py-2 text-left">Monto</th>
                              <th className="px-4 py-2 text-left">Notas</th>
                              <th className="px-4 py-2 text-right"></th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {presus.map((p) => (
                              <tr key={p.id}>
                                <td className="px-4 py-2 font-medium text-slate-900">{formatMoney(p.monto)}</td>
                                <td className="px-4 py-2 text-slate-600">{p.notas ?? '—'}</td>
                                <td className="px-4 py-2 text-right">
                                  <Button size="sm" variant="ghost" onClick={() => openPresupuestoEdit(p)}>
                                    <Pencil className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button size="sm" variant="ghost" onClick={() => handleDeletePresupuesto(p)}>
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </Button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      )}

      {tab === 'notas' && (
        <div className="bg-white rounded-lg ring-1 ring-slate-200 p-4">
          {obra.notas ? (
            <p className="text-sm text-slate-700 whitespace-pre-wrap">{obra.notas}</p>
          ) : (
            <p className="text-slate-400 italic text-center py-8">Sin notas.</p>
          )}
        </div>
      )}

      {/* Drawer: Editar obra */}
      <Drawer
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Editar obra"
        size="md"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditOpen(false)} disabled={updateObra.isPending}>
              Cancelar
            </Button>
            <Button onClick={handleEditSubmit} disabled={updateObra.isPending}>
              {updateObra.isPending ? 'Guardando…' : 'Guardar cambios'}
            </Button>
          </div>
        }
      >
        {editForm && (
          <form onSubmit={handleEditSubmit} className="space-y-4">
            <Field label="Nombre" required error={editErrors.nombre}>
              <Input
                value={editForm.nombre}
                onChange={(e) => setEditForm({ ...editForm, nombre: e.target.value })}
              />
            </Field>
            <Field label="Dirección">
              <Input
                value={editForm.direccion}
                onChange={(e) => setEditForm({ ...editForm, direccion: e.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Inicio">
                <Input
                  type="date"
                  value={editForm.fechaInicio}
                  onChange={(e) => setEditForm({ ...editForm, fechaInicio: e.target.value })}
                />
              </Field>
              <Field label="Fin estimada">
                <Input
                  type="date"
                  value={editForm.fechaFinEstimada}
                  onChange={(e) => setEditForm({ ...editForm, fechaFinEstimada: e.target.value })}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Moneda">
                <Select
                  value={editForm.monedaReporte}
                  onChange={(e) => setEditForm({ ...editForm, monedaReporte: e.target.value as Moneda })}
                >
                  <option value="USD">USD ($)</option>
                  <option value="CRC">CRC (₡)</option>
                </Select>
              </Field>
              <Field label="Estado">
                <Select
                  value={editForm.estado}
                  onChange={(e) => setEditForm({ ...editForm, estado: e.target.value as ObraEstado })}
                >
                  {(Object.keys(ESTADO_LABELS) as ObraEstado[]).map((est) => (
                    <option key={est} value={est}>
                      {ESTADO_LABELS[est]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Notas">
              <Textarea
                value={editForm.notas}
                onChange={(e) => setEditForm({ ...editForm, notas: e.target.value })}
              />
            </Field>
            <button type="submit" className="hidden" aria-hidden />
          </form>
        )}
      </Drawer>

      {/* Drawer: Categoría */}
      <Drawer
        open={catForm.open}
        onClose={() => setCatForm({ ...catForm, open: false })}
        title={catForm.editingId ? 'Editar categoría' : 'Nueva categoría'}
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setCatForm({ ...catForm, open: false })}
              disabled={createCategoria.isPending || updateCategoria.isPending}
            >
              Cancelar
            </Button>
            <Button
              onClick={submitCategoria}
              disabled={createCategoria.isPending || updateCategoria.isPending}
            >
              {createCategoria.isPending || updateCategoria.isPending ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        }
      >
        <form onSubmit={submitCategoria} className="space-y-4">
          <Field label="Nombre" required>
            <Input
              autoFocus
              value={catForm.nombre}
              onChange={(e) => setCatForm({ ...catForm, nombre: e.target.value })}
              placeholder="Ej: Estructura, Eléctrico, Acabados"
            />
          </Field>
          <Field label="Orden" hint="Número para ordenar la lista (menor = arriba)">
            <Input
              type="number"
              value={catForm.orden}
              onChange={(e) => setCatForm({ ...catForm, orden: e.target.value })}
            />
          </Field>
          <button type="submit" className="hidden" aria-hidden />
        </form>
      </Drawer>

      {/* Drawer: Presupuesto */}
      <Drawer
        open={presForm.open}
        onClose={() => setPresForm({ ...presForm, open: false })}
        title={presForm.editingId ? 'Editar presupuesto' : 'Nuevo presupuesto'}
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setPresForm({ ...presForm, open: false })}
              disabled={createPresupuesto.isPending || updatePresupuesto.isPending}
            >
              Cancelar
            </Button>
            <Button
              onClick={submitPresupuesto}
              disabled={createPresupuesto.isPending || updatePresupuesto.isPending}
            >
              {createPresupuesto.isPending || updatePresupuesto.isPending ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        }
      >
        <form onSubmit={submitPresupuesto} className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Moneda" className="col-span-1">
              <Select
                value={presForm.currency}
                onChange={(e) => setPresForm({ ...presForm, currency: e.target.value as Moneda })}
              >
                <option value="USD">USD</option>
                <option value="CRC">CRC</option>
              </Select>
            </Field>
            <Field label="Monto" required className="col-span-2">
              <Input
                autoFocus
                inputMode="decimal"
                value={presForm.amount}
                onChange={(e) => setPresForm({ ...presForm, amount: e.target.value })}
                placeholder="0.00"
              />
            </Field>
          </div>
          <Field label="Notas">
            <Textarea
              value={presForm.notas}
              onChange={(e) => setPresForm({ ...presForm, notas: e.target.value })}
            />
          </Field>
          <button type="submit" className="hidden" aria-hidden />
        </form>
      </Drawer>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: number | string;
  hint?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-lg ring-1 ring-slate-200 p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">{label}</p>
          <p className="text-2xl font-bold text-slate-900 mt-1">{value}</p>
          {hint && <p className="text-xs text-slate-400 mt-1">{hint}</p>}
        </div>
        {icon && <div className="text-indigo-500">{icon}</div>}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-40 shrink-0 text-slate-500">{label}:</dt>
      <dd className="text-slate-800">{value ?? '—'}</dd>
    </div>
  );
}
