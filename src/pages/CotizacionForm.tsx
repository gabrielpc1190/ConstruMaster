import { useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { useItem, useList, useCreate, useUpdate } from '../hooks/useApi';
import { useToast } from '../context/ToastContext';
import { Button } from '../components/ui/Button';
import { Input, Select, Textarea, Field } from '../components/ui/Input';
import { PageHeader } from '../components/ui/PageHeader';
import { ItemCatalogoAutocomplete } from '../components/ItemCatalogoAutocomplete';
// Nota: ItemCatalogoAutocomplete (creado por el agente de Catálogo) siempre
// devuelve un id numérico real (autocrea si el usuario elige "+ Crear nuevo").
// El displayText viene como "nombreCanonico (unidad)" — lo usamos para sembrar
// `descripcion` y `unidad` si aún están vacíos, sin pisar ediciones manuales.
import { formatMoney, toDateInput } from '../lib/format';
import type { Cotizacion, Moneda, ObraLite, ProveedorLite } from '../types/compras';

interface ItemRow {
  rid: string; // local row id (uuid-ish, for React keys)
  materialId: number | null;
  descripcion: string;
  cantidad: string; // strings para inputs controlados; parseamos al calcular
  unidad: string;
  precioUnitario: string;
  ivaPct: string; // '0' | '13' | …
  codigoCabys: string;
}

interface FormState {
  obraId: string;
  proveedorId: string;
  numeroCotizacion: string;
  fecha: string;
  fechaValidez: string;
  moneda: Moneda;
  condicionesPago: string;
  plazoEntregaDias: string;
  pctAnticipo: string;
  esEspecial: boolean;
  notas: string;
  items: ItemRow[];
}

function newRow(): ItemRow {
  return {
    rid: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    materialId: null,
    descripcion: '',
    cantidad: '',
    unidad: '',
    precioUnitario: '',
    ivaPct: '13',
    codigoCabys: '',
  };
}

const emptyForm: FormState = {
  obraId: '',
  proveedorId: '',
  numeroCotizacion: '',
  fecha: toDateInput(new Date().toISOString()),
  fechaValidez: '',
  moneda: 'CRC',
  condicionesPago: '',
  plazoEntregaDias: '',
  pctAnticipo: '',
  esEspecial: false,
  notas: '',
  items: [newRow()],
};

function num(v: string | number | null | undefined): number {
  if (v === '' || v == null) return 0;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export default function CotizacionForm() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const params = useParams<{ id?: string }>();
  const editingId = params.id ? Number(params.id) : null;
  const isEdit = Boolean(editingId);

  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const { data: obras = [] } = useList<ObraLite>(['obras', 'lite'], '/obras');
  const { data: proveedores = [] } = useList<ProveedorLite>(['proveedores', 'lite'], '/proveedores');

  const { data: existing } = useItem<Cotizacion>(
    ['cotizaciones', editingId] as const,
    `/cotizaciones/${editingId}`,
    isEdit,
  );

  // Hidratar el form una sola vez cuando llegan los datos del servidor (en modo
  // edición). Patrón "adjust state while rendering" recomendado por React 19
  // (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes):
  // si `hydratedId` no coincide con el id cargado, seteamos ambos y React
  // re-renderiza inmediatamente con el form ya poblado, sin disparar effects.
  const [hydratedId, setHydratedId] = useState<number | null>(null);
  if (isEdit && existing && hydratedId !== existing.id) {
    setHydratedId(existing.id);
    setForm({
      obraId: String(existing.obraId),
      proveedorId: String(existing.proveedorId),
      numeroCotizacion: existing.numeroCotizacion ?? '',
      fecha: toDateInput(existing.fecha),
      fechaValidez: toDateInput(existing.fechaValidez ?? undefined),
      moneda: existing.moneda,
      condicionesPago: existing.condicionesPago ?? '',
      plazoEntregaDias: existing.plazoEntregaDias != null ? String(existing.plazoEntregaDias) : '',
      pctAnticipo: existing.pctAnticipo != null ? String(existing.pctAnticipo) : '',
      esEspecial: Boolean(existing.esEspecial),
      notas: existing.notas ?? '',
      items:
        existing.items && existing.items.length > 0
          ? existing.items.map((it, idx) => ({
              rid: `srv-${it.id ?? idx}`,
              materialId: it.materialId ?? null,
              descripcion: it.descripcion ?? '',
              cantidad: String(it.cantidad ?? ''),
              unidad: it.unidad ?? '',
              precioUnitario: String(it.precioUnitario ?? ''),
              ivaPct: it.ivaPct != null ? String(it.ivaPct) : '13',
              codigoCabys: it.codigoCabys ?? '',
            }))
          : [newRow()],
    });
  }

  // Totales reactivos
  const totals = useMemo(() => {
    let subtotal = 0;
    let iva = 0;
    for (const it of form.items) {
      const lineSub = round2(num(it.cantidad) * num(it.precioUnitario));
      const lineIva = round2(lineSub * (num(it.ivaPct) / 100));
      subtotal += lineSub;
      iva += lineIva;
    }
    subtotal = round2(subtotal);
    iva = round2(iva);
    return { subtotal, iva, total: round2(subtotal + iva) };
  }, [form.items]);

  const createMut = useCreate<Record<string, unknown>, Cotizacion>('/cotizaciones', [['cotizaciones']]);
  const updateMut = useUpdate<Record<string, unknown>, Cotizacion>(
    (id) => `/cotizaciones/${id}`,
    [['cotizaciones'], ['cotizaciones', editingId]],
  );

  function setItem(rid: string, patch: Partial<ItemRow>) {
    setForm((f) => ({
      ...f,
      items: f.items.map((it) => (it.rid === rid ? { ...it, ...patch } : it)),
    }));
  }

  function addRow() {
    setForm((f) => ({ ...f, items: [...f.items, newRow()] }));
  }

  function removeRow(rid: string) {
    setForm((f) => ({
      ...f,
      items: f.items.length <= 1 ? [newRow()] : f.items.filter((it) => it.rid !== rid),
    }));
  }

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!form.obraId) e.obraId = 'Selecciona una obra';
    if (!form.proveedorId) e.proveedorId = 'Selecciona un proveedor';
    if (!form.numeroCotizacion.trim()) e.numeroCotizacion = 'Requerido';
    if (!form.fecha) e.fecha = 'Requerida';
    const validItems = form.items.filter(
      (it) => num(it.cantidad) > 0 && num(it.precioUnitario) > 0 && it.descripcion.trim(),
    );
    if (validItems.length === 0) e.items = 'Agregá al menos un ítem con cantidad, precio y descripción';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function buildPayload() {
    const items = form.items
      .filter((it) => num(it.cantidad) > 0 && num(it.precioUnitario) > 0 && it.descripcion.trim())
      .map((it, idx) => {
        const subtotal = round2(num(it.cantidad) * num(it.precioUnitario));
        const ivaMonto = round2(subtotal * (num(it.ivaPct) / 100));
        return {
          materialId: it.materialId ?? undefined,
          descripcion: it.descripcion.trim(),
          cantidad: num(it.cantidad),
          unidad: it.unidad.trim() || 'u',
          precioUnitario: num(it.precioUnitario),
          subtotal,
          ivaMonto,
          codigoCabys: it.codigoCabys.trim() || undefined,
          orden: idx + 1,
        };
      });

    return {
      obraId: Number(form.obraId),
      proveedorId: Number(form.proveedorId),
      numeroCotizacion: form.numeroCotizacion.trim(),
      fecha: form.fecha,
      fechaValidez: form.fechaValidez || undefined,
      moneda: form.moneda,
      subtotal: { amount: totals.subtotal, currency: form.moneda },
      iva: { amount: totals.iva, currency: form.moneda },
      total: { amount: totals.total, currency: form.moneda },
      condicionesPago: form.condicionesPago.trim() || undefined,
      plazoEntregaDias: form.plazoEntregaDias ? Number(form.plazoEntregaDias) : undefined,
      pctAnticipo: form.pctAnticipo ? Number(form.pctAnticipo) : undefined,
      esEspecial: form.esEspecial || undefined,
      notas: form.notas.trim() || undefined,
      items,
    };
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    const payload = buildPayload();

    if (isEdit && editingId) {
      updateMut.mutate(
        { id: editingId, data: payload },
        {
          onSuccess: (resp) => {
            showToast('Cotización actualizada', 'success');
            navigate(`/cotizaciones/${resp?.id ?? editingId}`);
          },
          onError: (err) => showToast(err.message || 'Error al actualizar', 'error'),
        },
      );
    } else {
      createMut.mutate(payload, {
        onSuccess: (resp) => {
          showToast('Cotización creada', 'success');
          if (resp?.id) navigate(`/cotizaciones/${resp.id}`);
          else navigate('/cotizaciones');
        },
        onError: (err) => showToast(err.message || 'Error al crear cotización', 'error'),
      });
    }
  }

  const pending = createMut.isPending || updateMut.isPending;

  return (
    <div>
      <PageHeader
        title={isEdit ? 'Editar cotización' : 'Nueva cotización'}
        subtitle="Captura cabecera + items para registrar una cotización del proveedor."
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate('/cotizaciones')} disabled={pending}>
              Cancelar
            </Button>
            <Button onClick={handleSubmit} disabled={pending}>
              {pending ? 'Guardando…' : 'Guardar cotización'}
            </Button>
          </>
        }
      />

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Cabecera */}
        <section className="bg-white rounded-lg ring-1 ring-slate-200 p-5">
          <h2 className="text-sm font-semibold text-slate-900 mb-4 uppercase tracking-wide">Información general</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Obra" required error={errors.obraId}>
              <Select value={form.obraId} onChange={(e) => setForm({ ...form, obraId: e.target.value })}>
                <option value="">— Selecciona obra —</option>
                {obras.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.nombre}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Proveedor" required error={errors.proveedorId}>
              <Select
                value={form.proveedorId}
                onChange={(e) => setForm({ ...form, proveedorId: e.target.value })}
              >
                <option value="">— Selecciona proveedor —</option>
                {proveedores.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Número de cotización" required error={errors.numeroCotizacion}>
              <Input
                value={form.numeroCotizacion}
                onChange={(e) => setForm({ ...form, numeroCotizacion: e.target.value })}
                placeholder="Ej: COT-2026-0451"
              />
            </Field>

            <Field label="Moneda" required>
              <Select
                value={form.moneda}
                onChange={(e) => setForm({ ...form, moneda: e.target.value as Moneda })}
              >
                <option value="CRC">CRC (₡)</option>
                <option value="USD">USD ($)</option>
              </Select>
            </Field>

            <Field label="Fecha" required error={errors.fecha}>
              <Input
                type="date"
                value={form.fecha}
                onChange={(e) => setForm({ ...form, fecha: e.target.value })}
              />
            </Field>

            <Field label="Fecha de validez">
              <Input
                type="date"
                value={form.fechaValidez}
                onChange={(e) => setForm({ ...form, fechaValidez: e.target.value })}
              />
            </Field>

            <Field label="Condiciones de pago">
              <Input
                value={form.condicionesPago}
                onChange={(e) => setForm({ ...form, condicionesPago: e.target.value })}
                placeholder="Ej: 50% anticipo, 50% contra entrega"
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Plazo entrega (días)">
                <Input
                  type="number"
                  min={0}
                  value={form.plazoEntregaDias}
                  onChange={(e) => setForm({ ...form, plazoEntregaDias: e.target.value })}
                />
              </Field>
              <Field label="% anticipo">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={form.pctAnticipo}
                  onChange={(e) => setForm({ ...form, pctAnticipo: e.target.value })}
                />
              </Field>
            </div>

            <div className="md:col-span-2 flex items-center gap-2">
              <input
                id="esEspecial"
                type="checkbox"
                checked={form.esEspecial}
                onChange={(e) => setForm({ ...form, esEspecial: e.target.checked })}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              <label htmlFor="esEspecial" className="text-sm text-slate-700">
                Cotización especial (sin RFQ, ej. compra urgente)
              </label>
            </div>

            <Field label="Notas" className="md:col-span-2">
              <Textarea
                value={form.notas}
                onChange={(e) => setForm({ ...form, notas: e.target.value })}
                placeholder="Observaciones internas, contexto de la cotización…"
              />
            </Field>
          </div>
        </section>

        {/* Items + totales */}
        <section className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4 items-start">
          <div className="bg-white rounded-lg ring-1 ring-slate-200 p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">Items</h2>
              <Button type="button" variant="secondary" size="sm" onClick={addRow}>
                <Plus className="w-4 h-4" /> Agregar línea
              </Button>
            </div>
            {errors.items && <p className="text-xs text-red-600 mb-2">{errors.items}</p>}

            <div className="overflow-hidden ring-1 ring-slate-200 rounded-md">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500 uppercase tracking-wide">
                  <tr>
                    <th className="px-2 py-2 text-left w-8">#</th>
                    <th className="px-2 py-2 text-left w-[18%]">Material</th>
                    <th className="px-2 py-2 text-left">Descripción</th>
                    <th className="px-2 py-2 text-right w-[8%]">Cant.</th>
                    <th className="px-2 py-2 text-left w-[8%]">Unidad</th>
                    <th className="px-2 py-2 text-right w-[12%]">P. Unitario</th>
                    <th className="px-2 py-2 text-right w-[10%]">Subtotal</th>
                    <th className="px-2 py-2 text-right w-[6%]">IVA %</th>
                    <th className="px-2 py-2 text-right w-[10%]">IVA</th>
                    <th className="px-2 py-2 w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {form.items.map((it, idx) => {
                    const lineSub = round2(num(it.cantidad) * num(it.precioUnitario));
                    const lineIva = round2(lineSub * (num(it.ivaPct) / 100));
                    return (
                      <tr key={it.rid} className="align-top">
                        <td className="px-2 py-2 text-slate-400">{idx + 1}</td>
                        <td className="px-1 py-1">
                          <ItemCatalogoAutocomplete
                            value={it.materialId}
                            defaultDisplay={it.descripcion}
                            onChange={(id, text) => {
                              // Parsear "nombreCanonico (unidad)" → si la unidad
                              // detectada está disponible y el row no tenía una,
                              // la autocompletamos.
                              const match = text.match(/^(.*)\s\(([^)]+)\)\s*$/);
                              const nombre = match ? match[1] : text;
                              const unidadAuto = match ? match[2] : '';
                              setItem(it.rid, {
                                materialId: id,
                                descripcion: it.descripcion.trim() ? it.descripcion : nombre,
                                unidad: it.unidad.trim() ? it.unidad : unidadAuto,
                              });
                            }}
                          />
                        </td>
                        <td className="px-1 py-1">
                          <Input
                            value={it.descripcion}
                            onChange={(e) => setItem(it.rid, { descripcion: e.target.value })}
                            placeholder="Descripción"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <Input
                            type="number"
                            min={0}
                            step="any"
                            value={it.cantidad}
                            onChange={(e) => setItem(it.rid, { cantidad: e.target.value })}
                            className="text-right tabular-nums"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <Input
                            value={it.unidad}
                            onChange={(e) => setItem(it.rid, { unidad: e.target.value })}
                            placeholder="u"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <Input
                            type="number"
                            min={0}
                            step="any"
                            value={it.precioUnitario}
                            onChange={(e) => setItem(it.rid, { precioUnitario: e.target.value })}
                            className="text-right tabular-nums"
                          />
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-slate-700">
                          {formatMoney({ amount: lineSub, currency: form.moneda })}
                        </td>
                        <td className="px-1 py-1">
                          <Select
                            value={it.ivaPct}
                            onChange={(e) => setItem(it.rid, { ivaPct: e.target.value })}
                            className="text-right"
                          >
                            <option value="0">0%</option>
                            <option value="1">1%</option>
                            <option value="2">2%</option>
                            <option value="4">4%</option>
                            <option value="8">8%</option>
                            <option value="13">13%</option>
                          </Select>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-slate-600">
                          {formatMoney({ amount: lineIva, currency: form.moneda })}
                        </td>
                        <td className="px-1 py-1 text-center">
                          <button
                            type="button"
                            onClick={() => removeRow(it.rid)}
                            className="text-slate-400 hover:text-red-600"
                            aria-label="Eliminar línea"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Totales sticky a la derecha en desktop */}
          <aside className="bg-white rounded-lg ring-1 ring-slate-200 p-5 lg:sticky lg:top-4">
            <h3 className="text-sm font-semibold text-slate-900 mb-4 uppercase tracking-wide">Totales</h3>
            <dl className="space-y-3">
              <div className="flex justify-between text-sm">
                <dt className="text-slate-500">Subtotal</dt>
                <dd className="font-medium tabular-nums text-slate-900">
                  {formatMoney({ amount: totals.subtotal, currency: form.moneda })}
                </dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-slate-500">IVA</dt>
                <dd className="font-medium tabular-nums text-slate-900">
                  {formatMoney({ amount: totals.iva, currency: form.moneda })}
                </dd>
              </div>
              <div className="border-t border-slate-200 pt-3 flex justify-between text-base">
                <dt className="font-semibold text-slate-900">Total</dt>
                <dd className="font-bold tabular-nums text-indigo-700">
                  {formatMoney({ amount: totals.total, currency: form.moneda })}
                </dd>
              </div>
            </dl>
            <p className="text-xs text-slate-400 mt-4 leading-snug">
              Calculado a partir de los items. El servidor revalida (tolerancia ₡1) y rechaza si no cuadra.
            </p>
          </aside>
        </section>

        <div className="flex justify-end gap-2">
          <Link
            to="/cotizaciones"
            className="inline-flex items-center justify-center h-9 px-4 text-sm rounded-md bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
          >
            Cancelar
          </Link>
          <Button type="submit" disabled={pending}>
            {pending ? 'Guardando…' : 'Guardar cotización'}
          </Button>
        </div>
      </form>
    </div>
  );
}
