import { useMemo, useState } from 'react';
import { Plus, Search, Pencil, PowerOff, Power, CheckCircle2, Info, AlertCircle } from 'lucide-react';
import { useList, useCreate, useUpdate, useDelete } from '../hooks/useApi';
import { api } from '../services/api';
import type { ApiError } from '../services/api';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { Button } from '../components/ui/Button';
import { Input, Select, Textarea, Field } from '../components/ui/Input';
import { Table } from '../components/ui/Table';
import { Drawer } from '../components/ui/Drawer';
import { Badge } from '../components/ui/Badge';
import { PageHeader } from '../components/ui/PageHeader';
import { cn } from '../lib/cn';
import { useQueryClient } from '@tanstack/react-query';

type ItemTipo = 'material' | 'servicio';
type ItemEstado = 'pendiente' | 'aprobado' | 'inactivo';

const UNIDADES = [
  'saco', 'kg', 'm3', 'm2', 'm', 'unidad', 'varilla',
  'galon', 'litro', 'hora', 'dia', 'visita', 'global', 'mes',
] as const;

type Unidad = typeof UNIDADES[number];

interface UserMin {
  id: number;
  username: string;
  fullName?: string | null;
}

interface ItemCatalogo {
  id: number;
  tipo: ItemTipo;
  nombreCanonico: string;
  unidad: string;
  slug: string;
  alias: string[] | null;
  estado: ItemEstado;
  sugeridoPorId: number | null;
  sugeridoPor?: UserMin | null;
  activo: boolean;
  createdAt: string;
}

interface CreateInput {
  tipo: ItemTipo;
  nombreCanonico: string;
  unidad: Unidad;
  alias?: string[];
  categoriaSugeridaId?: number;
}

interface UpdateInput {
  nombreCanonico?: string;
  unidad?: Unidad;
  alias?: string[];
  estado?: ItemEstado;
  categoriaSugeridaId?: number;
}

interface FormState {
  tipo: ItemTipo;
  nombreCanonico: string;
  unidad: Unidad;
  alias: string;
  estado: ItemEstado;
}

const emptyForm: FormState = {
  tipo: 'material',
  nombreCanonico: '',
  unidad: 'unidad',
  alias: '',
  estado: 'aprobado',
};

const ESTADO_LABELS: Record<ItemEstado, string> = {
  pendiente: 'Pendiente',
  aprobado: 'Aprobado',
  inactivo: 'Inactivo',
};

const ESTADO_TONES: Record<ItemEstado, 'emerald' | 'amber' | 'slate'> = {
  aprobado: 'emerald',
  pendiente: 'amber',
  inactivo: 'slate',
};

type TipoFilter = '' | ItemTipo;

export default function Catalogo() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const qc = useQueryClient();

  // El AuthContext tipa role como 'admin' | 'user'; el spec habla de
  // 'operativo' | 'supervisor' | 'admin'. Comparamos contra strings sin asumir
  // el tipo exacto, así soportamos ambos.
  const role = (user?.role ?? '') as string;
  const isOperativo = role === 'operativo';
  const canApprove = role === 'admin' || role === 'supervisor';

  const [tipoFilter, setTipoFilter] = useState<TipoFilter>('');
  const [estadoFilter, setEstadoFilter] = useState<ItemEstado>('aprobado');
  const [search, setSearch] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});

  const queryKey = useMemo(
    () => ['items-catalogo', { tipo: tipoFilter, estado: estadoFilter }] as const,
    [tipoFilter, estadoFilter],
  );
  const path = useMemo(() => {
    const params = new URLSearchParams();
    if (tipoFilter) params.set('tipo', tipoFilter);
    if (estadoFilter) params.set('estado', estadoFilter);
    const qs = params.toString();
    return qs ? `/items-catalogo?${qs}` : '/items-catalogo';
  }, [tipoFilter, estadoFilter]);

  const { data: items = [], isLoading } = useList<ItemCatalogo>(queryKey, path);

  // Para el banner: ¿hay pendientes? Si ya estamos viendo pendientes, usamos esos.
  // Si no, hacemos un fetch separado liviano.
  const { data: pendientes = [] } = useList<ItemCatalogo>(
    ['items-catalogo', { tipo: '', estado: 'pendiente' }],
    '/items-catalogo?estado=pendiente',
  );

  const createItem = useCreate<CreateInput, ItemCatalogo>('/items-catalogo', [['items-catalogo']]);
  const updateItem = useUpdate<UpdateInput, ItemCatalogo>(
    (id) => `/items-catalogo/${id}`,
    [['items-catalogo']],
  );
  const deleteItem = useDelete((id) => `/items-catalogo/${id}`, [['items-catalogo']]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      if (it.nombreCanonico.toLowerCase().includes(q)) return true;
      if (it.slug?.toLowerCase().includes(q)) return true;
      if (it.alias?.some((a) => a.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [items, search]);

  const resetForm = () => {
    setForm(emptyForm);
    setErrors({});
    setEditingId(null);
  };

  const openCreate = () => {
    resetForm();
    setDrawerOpen(true);
  };

  const openEdit = (it: ItemCatalogo) => {
    setEditingId(it.id);
    setForm({
      tipo: it.tipo,
      nombreCanonico: it.nombreCanonico,
      unidad: (UNIDADES as readonly string[]).includes(it.unidad) ? (it.unidad as Unidad) : 'unidad',
      alias: (it.alias ?? []).join('\n'),
      estado: it.estado,
    });
    setErrors({});
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    resetForm();
  };

  const handleZodError = (err: ApiError) => {
    if (err.details && typeof err.details === 'object') {
      const fe: Partial<Record<keyof FormState, string>> = {};
      for (const [k, v] of Object.entries(err.details as Record<string, unknown>)) {
        const key = k as keyof FormState;
        fe[key] = Array.isArray(v) ? String(v[0]) : String(v);
      }
      setErrors(fe);
      return true;
    }
    return false;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const next: Partial<Record<keyof FormState, string>> = {};
    if (!form.nombreCanonico.trim()) next.nombreCanonico = 'Nombre canónico es requerido';
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    const aliasList = form.alias
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    if (editingId) {
      const payload: UpdateInput = {
        nombreCanonico: form.nombreCanonico.trim(),
        unidad: form.unidad,
        alias: aliasList.length ? aliasList : [],
      };
      if (canApprove) payload.estado = form.estado;
      updateItem.mutate(
        { id: editingId, data: payload },
        {
          onSuccess: () => {
            showToast('Item actualizado');
            closeDrawer();
          },
          onError: (err) => {
            if (!handleZodError(err as ApiError)) {
              showToast((err as Error).message || 'Error al actualizar', 'error');
            }
          },
        },
      );
    } else {
      const payload: CreateInput = {
        tipo: form.tipo,
        nombreCanonico: form.nombreCanonico.trim(),
        unidad: form.unidad,
      };
      if (aliasList.length) payload.alias = aliasList;
      createItem.mutate(payload, {
        onSuccess: () => {
          showToast(
            isOperativo
              ? 'Item enviado para aprobación'
              : 'Item creado',
          );
          closeDrawer();
        },
        onError: (err) => {
          if (!handleZodError(err as ApiError)) {
            showToast((err as Error).message || 'Error al crear', 'error');
          }
        },
      });
    }
  };

  const handleApprove = async (it: ItemCatalogo) => {
    try {
      await api.post(`/items-catalogo/${it.id}/aprobar`);
      qc.invalidateQueries({ queryKey: ['items-catalogo'] });
      showToast(`"${it.nombreCanonico}" aprobado`);
    } catch (e) {
      showToast((e as Error).message || 'Error al aprobar', 'error');
    }
  };

  const handleDeactivate = (it: ItemCatalogo) => {
    if (!confirm(`¿Desactivar "${it.nombreCanonico}"?`)) return;
    deleteItem.mutate(it.id, {
      onSuccess: () => showToast('Item desactivado'),
      onError: (err) => showToast((err as Error).message || 'Error al desactivar', 'error'),
    });
  };

  const handleReactivate = (it: ItemCatalogo) => {
    updateItem.mutate(
      { id: it.id, data: { estado: 'aprobado' } as UpdateInput },
      {
        onSuccess: () => showToast('Item reactivado'),
        onError: (err) => showToast((err as Error).message || 'Error al reactivar', 'error'),
      },
    );
  };

  const submitting = createItem.isPending || updateItem.isPending;
  const pendientesCount = pendientes.length;

  return (
    <div>
      <PageHeader
        title="Catálogo"
        subtitle="Materiales y servicios reutilizables en cotizaciones y entregas"
        actions={
          <Button onClick={openCreate}>
            <Plus className="w-4 h-4" /> Nuevo item
          </Button>
        }
      />

      {/* Banner aprobador */}
      {canApprove && pendientesCount > 0 && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-amber-50 ring-1 ring-amber-200 px-4 py-3">
          <div className="flex items-center gap-2.5 text-amber-900 text-sm">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <span>
              Tienes <span className="font-semibold">{pendientesCount}</span>{' '}
              {pendientesCount === 1 ? 'item pendiente' : 'items pendientes'} de aprobación.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setEstadoFilter('pendiente')}
            className="text-sm font-medium text-amber-900 hover:text-amber-700 underline underline-offset-2"
          >
            Ver pendientes →
          </button>
        </div>
      )}

      {/* Banner operativo */}
      {isOperativo && (
        <div className="mb-4 flex items-start gap-2.5 rounded-lg bg-indigo-50 ring-1 ring-indigo-200 px-4 py-3 text-sm text-indigo-900">
          <Info className="w-5 h-5 shrink-0 mt-0.5" />
          <p>
            Como operativo, los items que crees quedan{' '}
            <span className="font-semibold">pendientes</span> de aprobación por un supervisor.
          </p>
        </div>
      )}

      {/* Filtros */}
      <div className="bg-white rounded-lg ring-1 ring-slate-200 p-4 mb-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {([
            ['', 'Todos'],
            ['material', 'Materiales'],
            ['servicio', 'Servicios'],
          ] as Array<[TipoFilter, string]>).map(([val, label]) => (
            <button
              key={val || 'all'}
              type="button"
              onClick={() => setTipoFilter(val)}
              className={cn(
                'px-3 h-8 rounded-md text-sm font-medium transition-colors',
                tipoFilter === val
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nombre o alias…"
              className="pl-9"
            />
          </div>
          <Select
            value={estadoFilter}
            onChange={(e) => setEstadoFilter(e.target.value as ItemEstado)}
            className="w-44"
          >
            <option value="aprobado">Aprobados</option>
            <option value="pendiente">Pendientes</option>
            <option value="inactivo">Inactivos</option>
          </Select>
        </div>
      </div>

      <Table<ItemCatalogo>
        loading={isLoading}
        rows={filtered}
        rowKey={(it) => it.id}
        empty={
          <span>
            Sin items con estos filtros.{' '}
            <button
              type="button"
              onClick={openCreate}
              className="text-indigo-600 hover:underline not-italic"
            >
              Crear el primero
            </button>
            .
          </span>
        }
        columns={[
          {
            key: 'tipo',
            header: 'Tipo',
            cell: (it) => (
              <Badge tone={it.tipo === 'material' ? 'indigo' : 'blue'}>
                {it.tipo}
              </Badge>
            ),
          },
          {
            key: 'nombre',
            header: 'Nombre',
            cell: (it) => (
              <div>
                <div className="font-medium text-slate-900">{it.nombreCanonico}</div>
                {it.alias && it.alias.length > 0 && (
                  <div className="text-xs text-slate-500 truncate max-w-xs">
                    aka {it.alias.slice(0, 3).join(', ')}
                    {it.alias.length > 3 && '…'}
                  </div>
                )}
              </div>
            ),
          },
          { key: 'unidad', header: 'Unidad', cell: (it) => it.unidad },
          {
            key: 'estado',
            header: 'Estado',
            cell: (it) => (
              <Badge tone={ESTADO_TONES[it.estado]}>{ESTADO_LABELS[it.estado]}</Badge>
            ),
          },
          {
            key: 'sugerido',
            header: 'Sugerido por',
            cell: (it) =>
              it.sugeridoPor
                ? <span className="text-xs text-slate-600">{it.sugeridoPor.fullName || it.sugeridoPor.username}</span>
                : <span className="text-xs text-slate-400">—</span>,
          },
          {
            key: 'acciones',
            header: '',
            align: 'right',
            cell: (it) => (
              <div className="flex items-center justify-end gap-1">
                {canApprove && it.estado === 'pendiente' && (
                  <button
                    type="button"
                    onClick={() => handleApprove(it)}
                    className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700"
                    title="Aprobar"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Aprobar
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => openEdit(it)}
                  className="p-1.5 rounded text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                  title="Editar"
                  aria-label="Editar"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                {it.estado !== 'inactivo' ? (
                  <button
                    type="button"
                    onClick={() => handleDeactivate(it)}
                    className="p-1.5 rounded text-slate-500 hover:bg-red-50 hover:text-red-600"
                    title="Desactivar"
                    aria-label="Desactivar"
                  >
                    <PowerOff className="w-4 h-4" />
                  </button>
                ) : (
                  canApprove && (
                    <button
                      type="button"
                      onClick={() => handleReactivate(it)}
                      className="p-1.5 rounded text-slate-500 hover:bg-emerald-50 hover:text-emerald-600"
                      title="Reactivar"
                      aria-label="Reactivar"
                    >
                      <Power className="w-4 h-4" />
                    </button>
                  )
                )}
              </div>
            ),
          },
        ]}
      />

      <Drawer
        open={drawerOpen}
        onClose={closeDrawer}
        title={editingId ? 'Editar item' : 'Nuevo item de catálogo'}
        size="md"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={closeDrawer} disabled={submitting}>
              Cancelar
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting
                ? (editingId ? 'Guardando…' : 'Creando…')
                : (editingId ? 'Guardar cambios' : 'Crear item')}
            </Button>
          </div>
        }
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Tipo" required error={errors.tipo}>
            <Select
              value={form.tipo}
              onChange={(e) => setForm({ ...form, tipo: e.target.value as ItemTipo })}
              disabled={!!editingId}
            >
              <option value="material">Material</option>
              <option value="servicio">Servicio</option>
            </Select>
          </Field>

          <Field label="Nombre canónico" required error={errors.nombreCanonico}>
            <Input
              value={form.nombreCanonico}
              onChange={(e) => setForm({ ...form, nombreCanonico: e.target.value })}
              placeholder="Ej: Cemento UNO 50 kg"
              autoFocus
            />
          </Field>

          <Field label="Unidad" required error={errors.unidad}>
            <Select
              value={form.unidad}
              onChange={(e) => setForm({ ...form, unidad: e.target.value as Unidad })}
            >
              {UNIDADES.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </Select>
          </Field>

          <Field label="Alias" hint="Uno por línea para autocomplete" error={errors.alias}>
            <Textarea
              value={form.alias}
              onChange={(e) => setForm({ ...form, alias: e.target.value })}
              rows={4}
              placeholder={'cemento\nsaco cemento\ncemento gris'}
            />
          </Field>

          {editingId && canApprove && (
            <Field label="Estado" error={errors.estado}>
              <Select
                value={form.estado}
                onChange={(e) => setForm({ ...form, estado: e.target.value as ItemEstado })}
              >
                <option value="aprobado">Aprobado</option>
                <option value="pendiente">Pendiente</option>
                <option value="inactivo">Inactivo</option>
              </Select>
            </Field>
          )}

          <button type="submit" className="hidden" aria-hidden />
        </form>
      </Drawer>
    </div>
  );
}
