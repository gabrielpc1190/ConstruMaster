import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { useList, useCreate } from '../hooks/useApi';
import { useToast } from '../context/ToastContext';
import { Button } from '../components/ui/Button';
import { Input, Select, Textarea, Field } from '../components/ui/Input';
import { Table } from '../components/ui/Table';
import { Drawer } from '../components/ui/Drawer';
import { Badge } from '../components/ui/Badge';
import { PageHeader } from '../components/ui/PageHeader';
import { formatDate } from '../lib/format';

type ObraEstado = 'planificada' | 'en_curso' | 'pausada' | 'finalizada';
type Moneda = 'CRC' | 'USD';

interface Obra {
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

interface Cliente {
  id: number;
  nombre: string;
}

interface CreateObraInput {
  nombre: string;
  clienteId: number;
  direccion?: string;
  fechaInicio?: string;
  fechaFinEstimada?: string;
  monedaReporte?: Moneda;
  estado?: ObraEstado;
  notas?: string;
}

interface FormState {
  clienteId: number | '';
  nombre: string;
  direccion: string;
  fechaInicio: string;
  fechaFinEstimada: string;
  monedaReporte: Moneda;
  estado: ObraEstado;
  notas: string;
}

const emptyForm: FormState = {
  clienteId: '',
  nombre: '',
  direccion: '',
  fechaInicio: '',
  fechaFinEstimada: '',
  monedaReporte: 'USD',
  estado: 'planificada',
  notas: '',
};

export default function Obras() {
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [estadoFilter, setEstadoFilter] = useState<ObraEstado | ''>('');
  const [search, setSearch] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});

  const queryKey = useMemo(() => ['obras', { estado: estadoFilter || undefined }] as const, [estadoFilter]);
  const path = estadoFilter ? `/obras?estado=${estadoFilter}` : '/obras';
  const { data: obras = [], isLoading } = useList<Obra>(queryKey, path);
  const { data: clientes = [] } = useList<Cliente>(['clientes'], '/clientes');

  const createObra = useCreate<CreateObraInput, Obra>('/obras', [['obras']]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return obras;
    return obras.filter((o) => o.nombre.toLowerCase().includes(q) || o.cliente?.nombre?.toLowerCase().includes(q));
  }, [obras, search]);

  const resetForm = () => {
    setForm(emptyForm);
    setErrors({});
  };

  const openCreate = () => {
    const preselectedCliente = clientes.length === 1 ? clientes[0].id : '';
    setForm({ ...emptyForm, clienteId: preselectedCliente });
    setErrors({});
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
    if (form.clienteId === '') next.clienteId = 'Seleccioná un cliente';
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    const payload: CreateObraInput = {
      nombre: form.nombre.trim(),
      clienteId: Number(form.clienteId),
      direccion: form.direccion.trim() || undefined,
      fechaInicio: form.fechaInicio || undefined,
      fechaFinEstimada: form.fechaFinEstimada || undefined,
      monedaReporte: form.monedaReporte,
      estado: form.estado,
      notas: form.notas.trim() || undefined,
    };
    createObra.mutate(payload, {
      onSuccess: (created) => {
        showToast('Obra creada', 'success');
        closeDrawer();
        if (created?.id) navigate(`/obras/${created.id}`);
      },
      onError: (err) => showToast(err.message || 'Error al crear obra', 'error'),
    });
  };

  return (
    <div>
      <PageHeader
        title="Obras"
        subtitle="Proyectos en ejecución y planificación"
        actions={
          <Button onClick={openCreate}>
            <Plus className="w-4 h-4" /> Nueva obra
          </Button>
        }
      />

      <div className="bg-white rounded-lg ring-1 ring-slate-200 p-4 mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre o cliente…"
            className="pl-9"
          />
        </div>
        <Select
          value={estadoFilter}
          onChange={(e) => setEstadoFilter(e.target.value as ObraEstado | '')}
          className="w-48"
        >
          <option value="">Todos los estados</option>
          {(Object.keys(ESTADO_LABELS) as ObraEstado[]).map((e) => (
            <option key={e} value={e}>
              {ESTADO_LABELS[e]}
            </option>
          ))}
        </Select>
      </div>

      <Table<Obra>
        loading={isLoading}
        rows={filtered}
        rowKey={(o) => o.id}
        onRowClick={(o) => navigate(`/obras/${o.id}`)}
        empty={<span>Sin obras todavía. Crea la primera.</span>}
        columns={[
          { key: 'nombre', header: 'Nombre', cell: (o) => <span className="font-medium text-slate-900">{o.nombre}</span> },
          { key: 'cliente', header: 'Cliente', cell: (o) => o.cliente?.nombre ?? '—' },
          {
            key: 'estado',
            header: 'Estado',
            cell: (o) => <Badge tone={ESTADO_TONES[o.estado]}>{ESTADO_LABELS[o.estado]}</Badge>,
          },
          { key: 'fechaInicio', header: 'Inicio', cell: (o) => formatDate(o.fechaInicio) },
          { key: 'fechaFin', header: 'Fin estimada', cell: (o) => formatDate(o.fechaFinEstimada) },
          {
            key: 'acciones',
            header: '',
            align: 'right',
            cell: () => <span className="text-xs text-indigo-600">Ver →</span>,
          },
        ]}
      />

      <Drawer
        open={drawerOpen}
        onClose={closeDrawer}
        title="Nueva obra"
        size="md"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={closeDrawer} disabled={createObra.isPending}>
              Cancelar
            </Button>
            <Button onClick={handleSubmit} disabled={createObra.isPending}>
              {createObra.isPending ? 'Creando…' : 'Crear obra'}
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
                  clienteId:
                    e.target.value === '' ? '' : Number(e.target.value),
                })
              }
              disabled={clientes.length <= 1}
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
              placeholder="Ej: Casa Rowley Escazú"
              autoFocus
            />
          </Field>

          <Field label="Dirección">
            <Input
              value={form.direccion}
              onChange={(e) => setForm({ ...form, direccion: e.target.value })}
              placeholder="Provincia, cantón, señas"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Fecha de inicio">
              <Input
                type="date"
                value={form.fechaInicio}
                onChange={(e) => setForm({ ...form, fechaInicio: e.target.value })}
              />
            </Field>
            <Field label="Fin estimada">
              <Input
                type="date"
                value={form.fechaFinEstimada}
                onChange={(e) => setForm({ ...form, fechaFinEstimada: e.target.value })}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Moneda de reporte">
              <Select
                value={form.monedaReporte}
                onChange={(e) => setForm({ ...form, monedaReporte: e.target.value as Moneda })}
              >
                <option value="USD">USD ($)</option>
                <option value="CRC">CRC (₡)</option>
              </Select>
            </Field>
            <Field label="Estado">
              <Select
                value={form.estado}
                onChange={(e) => setForm({ ...form, estado: e.target.value as ObraEstado })}
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
              value={form.notas}
              onChange={(e) => setForm({ ...form, notas: e.target.value })}
              placeholder="Detalles internos, contexto del proyecto…"
            />
          </Field>
          {/* submit accesible vía Enter; el botón está en el footer */}
          <button type="submit" className="hidden" aria-hidden />
        </form>
      </Drawer>
    </div>
  );
}
