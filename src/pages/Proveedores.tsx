import { useMemo, useState } from 'react';
import { Plus, Search, Pencil, PowerOff, Power } from 'lucide-react';
import { useList, useCreate, useUpdate, useDelete } from '../hooks/useApi';
import type { ApiError } from '../services/api';
import { useToast } from '../context/ToastContext';
import { Button } from '../components/ui/Button';
import { Input, Textarea, Field } from '../components/ui/Input';
import { Table } from '../components/ui/Table';
import { Drawer } from '../components/ui/Drawer';
import { Badge } from '../components/ui/Badge';
import { PageHeader } from '../components/ui/PageHeader';

interface Proveedor {
  id: number;
  nombre: string;
  identificacion: string | null;
  emailFacturacion: string | null;
  telefono: string | null;
  notas: string | null;
  activo: boolean;
  createdAt: string;
}

interface ProveedorInput {
  nombre: string;
  identificacion?: string;
  emailFacturacion?: string;
  telefono?: string;
  notas?: string;
}

interface FormState {
  nombre: string;
  identificacion: string;
  emailFacturacion: string;
  telefono: string;
  notas: string;
}

const emptyForm: FormState = {
  nombre: '',
  identificacion: '',
  emailFacturacion: '',
  telefono: '',
  notas: '',
};

export default function Proveedores() {
  const { showToast } = useToast();

  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});

  const queryKey = useMemo(
    () => ['proveedores', { includeInactive }] as const,
    [includeInactive],
  );
  const path = includeInactive ? '/proveedores' : '/proveedores?activo=true';
  const { data: proveedores = [], isLoading } = useList<Proveedor>(queryKey, path);

  const createProv = useCreate<ProveedorInput, Proveedor>('/proveedores', [['proveedores']]);
  const updateProv = useUpdate<Partial<ProveedorInput>, Proveedor>(
    (id) => `/proveedores/${id}`,
    [['proveedores']],
  );
  const deleteProv = useDelete((id) => `/proveedores/${id}`, [['proveedores']]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return proveedores;
    return proveedores.filter((p) =>
      [p.nombre, p.identificacion, p.emailFacturacion, p.telefono]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q)),
    );
  }, [proveedores, search]);

  const resetForm = () => {
    setForm(emptyForm);
    setErrors({});
    setEditingId(null);
  };

  const openCreate = () => {
    resetForm();
    setDrawerOpen(true);
  };

  const openEdit = (p: Proveedor) => {
    setEditingId(p.id);
    setForm({
      nombre: p.nombre,
      identificacion: p.identificacion ?? '',
      emailFacturacion: p.emailFacturacion ?? '',
      telefono: p.telefono ?? '',
      notas: p.notas ?? '',
    });
    setErrors({});
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    resetForm();
  };

  const buildPayload = (): ProveedorInput => ({
    nombre: form.nombre.trim(),
    identificacion: form.identificacion.trim() || undefined,
    emailFacturacion: form.emailFacturacion.trim() || undefined,
    telefono: form.telefono.trim() || undefined,
    notas: form.notas.trim() || undefined,
  });

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
    if (!form.nombre.trim()) next.nombre = 'Nombre es requerido';
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    const payload = buildPayload();

    if (editingId) {
      updateProv.mutate(
        { id: editingId, data: payload },
        {
          onSuccess: () => {
            showToast('Proveedor actualizado');
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
      createProv.mutate(payload, {
        onSuccess: () => {
          showToast('Proveedor creado');
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

  const handleDeactivate = (p: Proveedor) => {
    if (!confirm(`¿Desactivar proveedor "${p.nombre}"?`)) return;
    deleteProv.mutate(p.id, {
      onSuccess: () => showToast('Proveedor desactivado'),
      onError: (err) => showToast((err as Error).message || 'Error al desactivar', 'error'),
    });
  };

  const handleReactivate = (p: Proveedor) => {
    updateProv.mutate(
      // El server expone PUT; reactivamos seteando activo=true.
      { id: p.id, data: { ...buildFromProveedor(p), activo: true } as Partial<ProveedorInput> & { activo: boolean } },
      {
        onSuccess: () => showToast('Proveedor reactivado'),
        onError: (err) => showToast((err as Error).message || 'Error al reactivar', 'error'),
      },
    );
  };

  const submitting = createProv.isPending || updateProv.isPending;

  return (
    <div>
      <PageHeader
        title="Proveedores"
        subtitle="Empresas e individuos que suministran materiales y servicios"
        actions={
          <Button onClick={openCreate}>
            <Plus className="w-4 h-4" /> Nuevo proveedor
          </Button>
        }
      />

      <div className="bg-white rounded-lg ring-1 ring-slate-200 p-4 mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre, identificación, email o teléfono…"
            className="pl-9"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
          />
          Mostrar inactivos
        </label>
      </div>

      <Table<Proveedor>
        loading={isLoading}
        rows={filtered}
        rowKey={(p) => p.id}
        empty={
          <span>
            Sin proveedores todavía.{' '}
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
            key: 'nombre',
            header: 'Nombre',
            cell: (p) => (
              <div className="flex items-center gap-2">
                <span className={p.activo ? 'font-medium text-slate-900' : 'text-slate-500 line-through'}>
                  {p.nombre}
                </span>
                {!p.activo && <Badge tone="slate">Inactivo</Badge>}
              </div>
            ),
          },
          { key: 'identificacion', header: 'Identificación', cell: (p) => p.identificacion || '—' },
          { key: 'email', header: 'Email', cell: (p) => p.emailFacturacion || '—' },
          { key: 'telefono', header: 'Teléfono', cell: (p) => p.telefono || '—' },
          {
            key: 'acciones',
            header: '',
            align: 'right',
            cell: (p) => (
              <div className="flex items-center justify-end gap-1">
                <button
                  type="button"
                  onClick={() => openEdit(p)}
                  className="p-1.5 rounded text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                  title="Editar"
                  aria-label="Editar"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                {p.activo ? (
                  <button
                    type="button"
                    onClick={() => handleDeactivate(p)}
                    className="p-1.5 rounded text-slate-500 hover:bg-red-50 hover:text-red-600"
                    title="Desactivar"
                    aria-label="Desactivar"
                  >
                    <PowerOff className="w-4 h-4" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleReactivate(p)}
                    className="p-1.5 rounded text-slate-500 hover:bg-emerald-50 hover:text-emerald-600"
                    title="Reactivar"
                    aria-label="Reactivar"
                  >
                    <Power className="w-4 h-4" />
                  </button>
                )}
              </div>
            ),
          },
        ]}
      />

      <Drawer
        open={drawerOpen}
        onClose={closeDrawer}
        title={editingId ? 'Editar proveedor' : 'Nuevo proveedor'}
        size="md"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={closeDrawer} disabled={submitting}>
              Cancelar
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting
                ? (editingId ? 'Guardando…' : 'Creando…')
                : (editingId ? 'Guardar cambios' : 'Crear proveedor')}
            </Button>
          </div>
        }
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Nombre" required error={errors.nombre}>
            <Input
              value={form.nombre}
              onChange={(e) => setForm({ ...form, nombre: e.target.value })}
              placeholder="Ej: Ferretería La Económica S.A."
              autoFocus
            />
          </Field>

          <Field
            label="Identificación"
            hint="9-12 dígitos: cédula física, jurídica o DIMEX"
            error={errors.identificacion}
          >
            <Input
              value={form.identificacion}
              onChange={(e) => setForm({ ...form, identificacion: e.target.value })}
              placeholder="Ej: 3101123456"
              inputMode="numeric"
            />
          </Field>

          <Field label="Email de facturación" error={errors.emailFacturacion}>
            <Input
              type="email"
              value={form.emailFacturacion}
              onChange={(e) => setForm({ ...form, emailFacturacion: e.target.value })}
              placeholder="facturacion@proveedor.cr"
            />
          </Field>

          <Field label="Teléfono" error={errors.telefono}>
            <Input
              value={form.telefono}
              onChange={(e) => setForm({ ...form, telefono: e.target.value })}
              placeholder="2222-3333 / 8888-9999"
            />
          </Field>

          <Field label="Notas" error={errors.notas}>
            <Textarea
              value={form.notas}
              onChange={(e) => setForm({ ...form, notas: e.target.value })}
              placeholder="Contactos, condiciones de pago, observaciones internas…"
            />
          </Field>

          <button type="submit" className="hidden" aria-hidden />
        </form>
      </Drawer>
    </div>
  );
}

/** Toma un Proveedor y lo convierte a ProveedorInput limpio (sin nulls). */
function buildFromProveedor(p: Proveedor): ProveedorInput {
  return {
    nombre: p.nombre,
    identificacion: p.identificacion ?? undefined,
    emailFacturacion: p.emailFacturacion ?? undefined,
    telefono: p.telefono ?? undefined,
    notas: p.notas ?? undefined,
  };
}
