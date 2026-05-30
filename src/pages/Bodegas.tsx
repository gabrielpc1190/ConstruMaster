import { useMemo, useState } from 'react';
import { Plus, Search, Pencil, Power } from 'lucide-react';
import { useList, useCreate, useUpdate } from '../hooks/useApi';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { Button } from '../components/ui/Button';
import { Input, Select, Textarea, Field } from '../components/ui/Input';
import { Table } from '../components/ui/Table';
import { Drawer } from '../components/ui/Drawer';
import { Badge } from '../components/ui/Badge';
import { PageHeader } from '../components/ui/PageHeader';

interface Bodega {
  id: number;
  clienteId: number;
  cliente: { id: number; nombre: string };
  nombre: string;
  direccion: string | null;
  responsableId: number | null;
  responsable: { id: number; username: string; fullName: string | null } | null;
  activo: boolean;
  notas: string | null;
  createdAt: string;
}

interface Cliente {
  id: number;
  nombre: string;
}

interface UserRow {
  id: number;
  username: string;
  fullName: string | null;
  role: 'admin' | 'supervisor' | 'operativo' | 'lector';
  isActive: boolean;
}

interface CreateBodegaInput {
  clienteId: number;
  nombre: string;
  direccion?: string;
  responsableId?: number | null;
  notas?: string;
}

interface UpdateBodegaInput {
  clienteId?: number;
  nombre?: string;
  direccion?: string | null;
  responsableId?: number | null;
  notas?: string | null;
  activo?: boolean;
}

interface FormState {
  clienteId: number | '';
  nombre: string;
  direccion: string;
  responsableId: number | '';
  notas: string;
}

const emptyForm: FormState = {
  clienteId: '',
  nombre: '',
  direccion: '',
  responsableId: '',
  notas: '',
};

// Roles aptos para ser responsable de bodega (excluimos lectores).
const RESPONSABLE_ROLES: ReadonlyArray<UserRow['role']> = ['admin', 'supervisor', 'operativo'];

export default function Bodegas() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const isAdmin = user?.role === 'admin';

  const [activoFilter, setActivoFilter] = useState<'true' | 'false' | ''>('true');
  const [search, setSearch] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>(
    {},
  );

  const queryKey = useMemo(
    () => ['bodegas', { activo: activoFilter || undefined }] as const,
    [activoFilter],
  );
  const path = activoFilter ? `/bodegas?activo=${activoFilter}` : '/bodegas';
  const { data: bodegas = [], isLoading } = useList<Bodega>(queryKey, path);
  const { data: clientes = [] } = useList<Cliente>(['clientes'], '/clientes');
  const { data: users = [] } = useList<UserRow>(['users'], '/users');
  const responsableOptions = useMemo(
    () => users.filter((u) => RESPONSABLE_ROLES.includes(u.role)),
    [users],
  );

  const createBodega = useCreate<CreateBodegaInput, Bodega>('/bodegas', [['bodegas']]);
  const updateBodega = useUpdate<UpdateBodegaInput, Bodega>((id) => `/bodegas/${id}`, [['bodegas']]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return bodegas;
    return bodegas.filter(
      (b) =>
        b.nombre.toLowerCase().includes(q) ||
        b.cliente?.nombre?.toLowerCase().includes(q) ||
        b.responsable?.username?.toLowerCase().includes(q),
    );
  }, [bodegas, search]);

  const resetForm = () => {
    setForm(emptyForm);
    setErrors({});
    setEditingId(null);
  };

  const openCreate = () => {
    // Preselección de cliente si solo hay uno.
    const preselectedCliente =
      clientes.length === 1 ? clientes[0].id : '';
    setForm({ ...emptyForm, clienteId: preselectedCliente });
    setErrors({});
    setEditingId(null);
    setDrawerOpen(true);
  };

  const openEdit = (b: Bodega) => {
    setForm({
      clienteId: b.clienteId,
      nombre: b.nombre,
      direccion: b.direccion ?? '',
      responsableId: b.responsableId ?? '',
      notas: b.notas ?? '',
    });
    setErrors({});
    setEditingId(b.id);
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    resetForm();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (!form.nombre.trim()) next.nombre = 'Nombre es requerido';
    if (!editingId && form.clienteId === '') next.clienteId = 'Seleccioná un cliente';
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    const responsableId =
      form.responsableId === '' ? null : Number(form.responsableId);
    if (editingId) {
      const payload: UpdateBodegaInput = {
        nombre: form.nombre.trim(),
        direccion: form.direccion.trim() || null,
        responsableId,
        notas: form.notas.trim() || null,
      };
      updateBodega.mutate(
        { id: editingId, data: payload },
        {
          onSuccess: () => {
            showToast('Bodega actualizada', 'success');
            closeDrawer();
          },
          onError: (err) => showToast(err.message || 'Error al actualizar', 'error'),
        },
      );
    } else {
      const payload: CreateBodegaInput = {
        clienteId: Number(form.clienteId),
        nombre: form.nombre.trim(),
        direccion: form.direccion.trim() || undefined,
        responsableId,
        notas: form.notas.trim() || undefined,
      };
      createBodega.mutate(payload, {
        onSuccess: () => {
          showToast('Bodega creada', 'success');
          closeDrawer();
        },
        onError: (err) => showToast(err.message || 'Error al crear bodega', 'error'),
      });
    }
  };

  const handleToggleActivo = (b: Bodega) => {
    const action = b.activo ? 'desactivar' : 'activar';
    if (!window.confirm(`¿Seguro que querés ${action} la bodega "${b.nombre}"?`)) return;
    updateBodega.mutate(
      { id: b.id, data: { activo: !b.activo } },
      {
        onSuccess: () => showToast(`Bodega ${b.activo ? 'desactivada' : 'activada'}`, 'success'),
        onError: (err) => showToast(err.message || 'Error', 'error'),
      },
    );
  };

  const pending = createBodega.isPending || updateBodega.isPending;

  return (
    <div>
      <PageHeader
        title="Bodegas"
        subtitle="Puntos de almacenamiento de materiales"
        actions={
          <Button onClick={openCreate}>
            <Plus className="w-4 h-4" /> Nueva bodega
          </Button>
        }
      />

      <div className="bg-white rounded-lg ring-1 ring-slate-200 p-4 mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre, cliente o responsable…"
            className="pl-9"
          />
        </div>
        <Select
          value={activoFilter}
          onChange={(e) => setActivoFilter(e.target.value as 'true' | 'false' | '')}
          className="w-48"
        >
          <option value="true">Solo activas</option>
          <option value="false">Solo inactivas</option>
          <option value="">Todas</option>
        </Select>
      </div>

      <Table<Bodega>
        loading={isLoading}
        rows={filtered}
        rowKey={(b) => b.id}
        empty={<span>Sin bodegas todavía. Crea la primera.</span>}
        columns={[
          { key: 'nombre', header: 'Nombre', cell: (b) => <span className="font-medium text-slate-900">{b.nombre}</span> },
          { key: 'cliente', header: 'Cliente', cell: (b) => b.cliente?.nombre ?? '—' },
          {
            key: 'responsable',
            header: 'Responsable',
            cell: (b) =>
              b.responsable ? (
                <span>
                  {b.responsable.fullName ?? b.responsable.username}{' '}
                  <span className="text-xs text-slate-400">@{b.responsable.username}</span>
                </span>
              ) : (
                <span className="text-slate-400">—</span>
              ),
          },
          {
            key: 'estado',
            header: 'Estado',
            cell: (b) =>
              b.activo ? <Badge tone="emerald">Activa</Badge> : <Badge tone="slate">Inactiva</Badge>,
          },
          {
            key: 'acciones',
            header: '',
            align: 'right',
            cell: (b) => (
              <div className="flex justify-end gap-1">
                <Button size="sm" variant="ghost" onClick={() => openEdit(b)} aria-label="Editar">
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
                {isAdmin && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleToggleActivo(b)}
                    aria-label={b.activo ? 'Desactivar' : 'Activar'}
                  >
                    <Power className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />

      <Drawer
        open={drawerOpen}
        onClose={closeDrawer}
        title={editingId ? 'Editar bodega' : 'Nueva bodega'}
        size="md"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={closeDrawer} disabled={pending}>
              Cancelar
            </Button>
            <Button onClick={handleSubmit} disabled={pending}>
              {pending ? 'Guardando…' : editingId ? 'Guardar cambios' : 'Crear bodega'}
            </Button>
          </div>
        }
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field
            label="Cliente"
            required
            error={errors.clienteId}
            hint={
              clientes.length === 1
                ? 'Único cliente disponible; preseleccionado.'
                : undefined
            }
          >
            <Select
              value={form.clienteId === '' ? '' : String(form.clienteId)}
              onChange={(e) =>
                setForm({
                  ...form,
                  clienteId: e.target.value === '' ? '' : Number(e.target.value),
                })
              }
              disabled={!!editingId || clientes.length <= 1}
            >
              <option value="">— Seleccionar cliente —</option>
              {clientes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Nombre" required error={errors.nombre}>
            <Input
              value={form.nombre}
              onChange={(e) => setForm({ ...form, nombre: e.target.value })}
              placeholder="Ej: Bodega central"
              autoFocus
            />
          </Field>

          <Field label="Dirección">
            <Input
              value={form.direccion}
              onChange={(e) => setForm({ ...form, direccion: e.target.value })}
              placeholder="Ubicación física"
            />
          </Field>

          <Field label="Responsable" hint="Operativo a cargo de la bodega.">
            <Select
              value={form.responsableId === '' ? '' : String(form.responsableId)}
              onChange={(e) =>
                setForm({
                  ...form,
                  responsableId:
                    e.target.value === '' ? '' : Number(e.target.value),
                })
              }
            >
              <option value="">— Sin responsable —</option>
              {responsableOptions.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName ?? u.username}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Notas">
            <Textarea
              value={form.notas}
              onChange={(e) => setForm({ ...form, notas: e.target.value })}
            />
          </Field>
          <button type="submit" className="hidden" aria-hidden />
        </form>
      </Drawer>
    </div>
  );
}
