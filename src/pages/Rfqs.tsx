/**
 * Listado de Solicitudes de Cotización (SC).
 *
 * En UI siempre "Solicitud de cotización" (no "RFQ"). El nombre del archivo
 * matchea el modelo Prisma `SolicitudCotizacion` / `rfqId` para que el código
 * sea grep-able. La URL pública es `/solicitudes-cotizacion`.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { useList } from '../hooks/useApi';
import type { ApiError } from '../services/api';
import { api } from '../services/api';
import { useToast } from '../context/ToastContext';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../components/ui/Button';
import { Input, Select, Textarea, Field } from '../components/ui/Input';
import { Table } from '../components/ui/Table';
import { Drawer } from '../components/ui/Drawer';
import { Badge } from '../components/ui/Badge';
import { PageHeader } from '../components/ui/PageHeader';
import { formatDate } from '../lib/format';
import { RFQ_ESTADO_META, rfqMeta, type RfqEstado } from '../lib/badges';
import type { CategoriaLite, ObraLite, Rfq } from '../types/compras';

interface FormState {
  obraId: string;
  categoriaId: string;
  descripcion: string;
  fechaRequerida: string;
  notas: string;
}

const emptyForm: FormState = {
  obraId: '',
  categoriaId: '',
  descripcion: '',
  fechaRequerida: '',
  notas: '',
};

export default function Rfqs() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const qc = useQueryClient();

  const [obraFilter, setObraFilter] = useState<string>('');
  const [estado, setEstado] = useState<RfqEstado | ''>('');
  const [search, setSearch] = useState<string>('');

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [submitting, setSubmitting] = useState(false);

  const { data: obras = [] } = useList<ObraLite>(['obras', 'lite'], '/obras');

  // Categorías cargadas reactivamente cuando se elige obra en el form.
  const obraIdForCategorias = form.obraId || '';
  const { data: categorias = [] } = useList<CategoriaLite>(
    ['obras', obraIdForCategorias, 'categorias'] as const,
    obraIdForCategorias ? `/obras/${obraIdForCategorias}/categorias` : '',
  );

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (obraFilter) params.set('obraId', obraFilter);
    if (estado) params.set('estado', estado);
    if (search.trim()) params.set('search', search.trim());
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }, [obraFilter, estado, search]);

  const queryKey = useMemo(
    () => ['rfqs', { obraFilter, estado, search }] as const,
    [obraFilter, estado, search],
  );

  const { data: rfqs = [], isLoading } = useList<Rfq>(queryKey, `/rfqs${queryString}`);

  const openCreate = () => {
    setForm(emptyForm);
    setErrors({});
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setForm(emptyForm);
    setErrors({});
  };

  const validate = (): boolean => {
    const next: Partial<Record<keyof FormState, string>> = {};
    if (!form.obraId) next.obraId = 'Selecciona la obra';
    if (!form.categoriaId) next.categoriaId = 'Selecciona la categoría';
    if (!form.descripcion.trim()) next.descripcion = 'Descripción requerida';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      const created = await api.post<Rfq>('/rfqs', {
        obraId: Number(form.obraId),
        categoriaId: Number(form.categoriaId),
        descripcion: form.descripcion.trim(),
        fechaRequerida: form.fechaRequerida || undefined,
        notas: form.notas.trim() || undefined,
      });
      qc.invalidateQueries({ queryKey: ['rfqs'] });
      showToast('Solicitud de cotización creada', 'success');
      closeDrawer();
      if (created?.id) navigate(`/solicitudes-cotizacion/${created.id}`);
    } catch (err) {
      showToast((err as ApiError).message || 'Error al crear', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Solicitudes de cotización"
        subtitle="Pedile cotizaciones a varios proveedores y compará lado a lado antes de aprobar"
        actions={
          <Button onClick={openCreate}>
            <Plus className="w-4 h-4" /> Nueva solicitud
          </Button>
        }
      />

      <div className="bg-white rounded-lg ring-1 ring-slate-200 p-4 mb-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="Obra">
          <Select value={obraFilter} onChange={(e) => setObraFilter(e.target.value)}>
            <option value="">Todas</option>
            {obras.map((o) => (
              <option key={o.id} value={o.id}>{o.nombre}</option>
            ))}
          </Select>
        </Field>
        <Field label="Estado">
          <Select value={estado} onChange={(e) => setEstado(e.target.value as RfqEstado | '')}>
            <option value="">Todos</option>
            {(Object.keys(RFQ_ESTADO_META) as RfqEstado[]).map((e) => (
              <option key={e} value={e}>{RFQ_ESTADO_META[e].label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Buscar en descripción">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cemento, varilla, …"
              className="pl-9"
            />
          </div>
        </Field>
      </div>

      <Table<Rfq>
        loading={isLoading}
        rows={rfqs}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/solicitudes-cotizacion/${r.id}`)}
        empty={<span>Sin solicitudes todavía.</span>}
        columns={[
          {
            key: 'numero',
            header: '#',
            cell: (r) => <span className="font-medium text-slate-900">{r.id}</span>,
          },
          {
            key: 'descripcion',
            header: 'Descripción',
            cell: (r) => (
              <span className="text-slate-900 line-clamp-1 max-w-[420px] block">
                {r.descripcion}
              </span>
            ),
          },
          { key: 'obra', header: 'Obra', cell: (r) => r.obra?.nombre ?? '—' },
          { key: 'categoria', header: 'Categoría', cell: (r) => r.categoria?.nombre ?? '—' },
          {
            key: 'estado',
            header: 'Estado',
            cell: (r) => {
              const meta = rfqMeta(r.estado);
              return <Badge tone={meta.tone}>{meta.label}</Badge>;
            },
          },
          {
            key: 'cotizaciones',
            header: 'Cotizaciones',
            align: 'center',
            cell: (r) => (
              <span className="tabular-nums text-slate-700">
                {r._count?.cotizaciones ?? 0}
              </span>
            ),
          },
          {
            key: 'fechaRequerida',
            header: 'Fecha requerida',
            cell: (r) => formatDate(r.fechaRequerida),
          },
          {
            key: 'creadaPor',
            header: 'Creada por',
            cell: (r) => r.creadaPor?.username ?? '—',
          },
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
        title="Nueva solicitud de cotización"
        size="md"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={closeDrawer} disabled={submitting}>
              Cancelar
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Creando…' : 'Crear solicitud'}
            </Button>
          </div>
        }
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Obra" required error={errors.obraId}>
            <Select
              value={form.obraId}
              onChange={(e) => setForm({ ...form, obraId: e.target.value, categoriaId: '' })}
            >
              <option value="">— Selecciona obra —</option>
              {obras.map((o) => (
                <option key={o.id} value={o.id}>{o.nombre}</option>
              ))}
            </Select>
          </Field>

          <Field label="Categoría de presupuesto" required error={errors.categoriaId}>
            <Select
              value={form.categoriaId}
              onChange={(e) => setForm({ ...form, categoriaId: e.target.value })}
              disabled={!form.obraId}
            >
              <option value="">{form.obraId ? '— Selecciona categoría —' : 'Elegí una obra primero'}</option>
              {categorias.map((c) => (
                <option key={c.id} value={c.id}>{c.nombre}</option>
              ))}
            </Select>
          </Field>

          <Field label="Descripción" required error={errors.descripcion}>
            <Textarea
              value={form.descripcion}
              onChange={(e) => setForm({ ...form, descripcion: e.target.value })}
              placeholder="Ej: 100 sacos cemento UGC 50kg + 20 varillas #3 grado 60"
            />
          </Field>

          <Field label="Fecha requerida" error={errors.fechaRequerida} hint="Cuándo necesitamos el material en sitio">
            <Input
              type="date"
              value={form.fechaRequerida}
              onChange={(e) => setForm({ ...form, fechaRequerida: e.target.value })}
            />
          </Field>

          <Field label="Notas" error={errors.notas}>
            <Textarea
              value={form.notas}
              onChange={(e) => setForm({ ...form, notas: e.target.value })}
              placeholder="Detalles internos, urgencia, condiciones esperadas…"
            />
          </Field>

          <button type="submit" className="hidden" aria-hidden />
        </form>
      </Drawer>
    </div>
  );
}
