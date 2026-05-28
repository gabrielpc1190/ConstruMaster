import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Ban, FileText, Pencil, Truck, Receipt, CreditCard } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useItem } from '../hooks/useApi';
import { api } from '../services/api';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Drawer } from '../components/ui/Drawer';
import { Input, Textarea, Field } from '../components/ui/Input';
import { PageHeader } from '../components/ui/PageHeader';
import { Table } from '../components/ui/Table';
import { formatDate, formatMoney } from '../lib/format';
import { ocMeta } from '../lib/badges';
import type { Oc, OcItem } from '../types/compras';

export default function OcDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id ? Number(params.id) : null;
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: oc, isLoading } = useItem<Oc>(['ocs', id] as const, `/ocs/${id}`, !!id);

  const [cancelOpen, setCancelOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [notas, setNotas] = useState('');
  const [pctAnticipo, setPctAnticipo] = useState('');
  const [tiempoEstimadoDias, setTiempoEstimadoDias] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!id) return <div className="p-4 text-sm text-red-600">ID inválido</div>;
  if (isLoading) return <div className="p-4 text-sm text-slate-500">Cargando…</div>;
  if (!oc) return <div className="p-4 text-sm text-red-600">OC no encontrada</div>;

  const meta = ocMeta(oc.estado);
  const isAdmin = String(user?.role ?? '') === 'admin';
  const canCancel =
    isAdmin && (oc._count?.pagos ?? 0) === 0 && (oc._count?.entregas ?? 0) === 0 && oc.estado !== 'cancelada';

  function openEdit() {
    setNotas(oc?.notas ?? '');
    setPctAnticipo(oc?.pctAnticipo != null ? String(oc.pctAnticipo) : '');
    setTiempoEstimadoDias(oc?.tiempoEstimadoDias != null ? String(oc.tiempoEstimadoDias) : '');
    setEditOpen(true);
  }

  async function handleCancel() {
    setSubmitting(true);
    try {
      await api.post(`/ocs/${id}/cancelar`, { motivo: motivo.trim() || undefined });
      qc.invalidateQueries({ queryKey: ['ocs'] });
      showToast('OC cancelada', 'success');
      setCancelOpen(false);
    } catch (err) {
      showToast((err as Error).message || 'Error al cancelar', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleEditSubmit() {
    setSubmitting(true);
    try {
      await api.put(`/ocs/${id}`, {
        notas: notas.trim() || null,
        pctAnticipo: pctAnticipo ? Number(pctAnticipo) : null,
        tiempoEstimadoDias: tiempoEstimadoDias ? Number(tiempoEstimadoDias) : null,
      });
      qc.invalidateQueries({ queryKey: ['ocs'] });
      showToast('OC actualizada', 'success');
      setEditOpen(false);
    } catch (err) {
      showToast((err as Error).message || 'Error al actualizar', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  const moneda = oc.moneda;

  return (
    <div>
      <PageHeader
        title={`OC ${oc.numeroOc}`}
        subtitle={`${oc.proveedor?.nombre ?? '—'} · ${oc.obra?.nombre ?? '—'}`}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate('/ocs')}>
              <ArrowLeft className="w-4 h-4" /> Volver
            </Button>
            <Button variant="secondary" onClick={openEdit}>
              <Pencil className="w-4 h-4" /> Editar
            </Button>
            {canCancel && (
              <Button variant="danger" onClick={() => setCancelOpen(true)}>
                <Ban className="w-4 h-4" /> Cancelar OC
              </Button>
            )}
          </>
        }
      />

      <div className="flex items-center gap-2 mb-6">
        <Badge tone={meta.tone}>{meta.label}</Badge>
      </div>

      <div className="space-y-6">
        {/* Sección 1: Info general */}
        <section className="bg-white rounded-lg ring-1 ring-slate-200 p-5">
          <h2 className="text-sm font-semibold text-slate-900 mb-4 uppercase tracking-wide">Información general</h2>
          <dl className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <Info label="Obra" value={oc.obra?.nombre ?? '—'} />
            <Info label="Proveedor" value={oc.proveedor?.nombre ?? '—'} />
            <Info label="Categoría" value={oc.categoria?.nombre ?? '—'} />
            <Info label="Fecha de aprobación" value={formatDate(oc.fechaAprobacion)} />
            <Info label="Moneda" value={oc.moneda} />
            <Info label="Monto total" value={<span className="text-indigo-700 font-bold">{formatMoney(oc.montoTotal)}</span>} />
            <Info
              label="TC aplicado"
              value={
                oc.fxRateApplied != null
                  ? `${Number(oc.fxRateApplied).toFixed(2)} ${oc.fxRateDate ? `(${formatDate(oc.fxRateDate)})` : ''}`
                  : '—'
              }
            />
            <Info label="% anticipo" value={oc.pctAnticipo != null ? `${oc.pctAnticipo}%` : '—'} />
            <Info
              label="Tiempo estimado"
              value={oc.tiempoEstimadoDias != null ? `${oc.tiempoEstimadoDias} días` : '—'}
            />
            {oc.cotizacionId && (
              <Info
                label="Cotización origen"
                value={
                  <Link to={`/cotizaciones/${oc.cotizacionId}`} className="text-indigo-600 hover:underline">
                    Ver cotización →
                  </Link>
                }
              />
            )}
          </dl>
        </section>

        {/* Sección 2: Items (snapshots) */}
        <section className="bg-white rounded-lg ring-1 ring-slate-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">Items (snapshot)</h2>
            <span className="text-xs text-slate-500">{oc.items?.length ?? 0} líneas</span>
          </div>

          <Table<OcItem>
            rows={oc.items ?? []}
            rowKey={(it) => it.id}
            empty={<span>Sin items.</span>}
            columns={[
              { key: 'orden', header: '#', cell: (it) => <span className="text-slate-400">{it.orden ?? '—'}</span> },
              {
                key: 'desc',
                header: 'Descripción',
                cell: (it) => <span className="text-slate-900">{it.descripcion}</span>,
              },
              { key: 'cant', header: 'Cant.', align: 'right', cell: (it) => <span className="tabular-nums">{Number(it.cantidad)}</span> },
              { key: 'unidad', header: 'Unidad', cell: (it) => it.unidad },
              {
                key: 'pu',
                header: 'P. Unitario',
                align: 'right',
                cell: (it) => <span className="tabular-nums">{formatMoney({ amount: it.precioUnitario, currency: moneda })}</span>,
              },
              {
                key: 'sub',
                header: 'Subtotal',
                align: 'right',
                cell: (it) => <span className="tabular-nums">{formatMoney({ amount: it.subtotal, currency: moneda })}</span>,
              },
              {
                key: 'iva',
                header: 'IVA',
                align: 'right',
                cell: (it) => <span className="tabular-nums text-slate-500">{formatMoney({ amount: it.ivaMonto ?? 0, currency: moneda })}</span>,
              },
            ]}
          />
        </section>

        {/* Sección 3: Pagos (placeholder) */}
        <PlaceholderSection
          icon={<CreditCard className="w-5 h-5 text-slate-400" />}
          title="Pagos"
          subtitle="Sin pagos registrados todavía"
          hint="TODO Fase 2: programar pagos contra esta OC, vincular a hitos y registrar comprobantes."
        />

        {/* Sección 4: Facturas (placeholder) */}
        <PlaceholderSection
          icon={<Receipt className="w-5 h-5 text-slate-400" />}
          title="Facturas"
          subtitle="Sin facturas vinculadas todavía"
          hint="TODO Fase 2: subir XML Hacienda CR v4.4, parsear inline y confirmar/anular."
        />

        {/* Sección 5: Entregas (placeholder) */}
        <PlaceholderSection
          icon={<Truck className="w-5 h-5 text-slate-400" />}
          title="Entregas"
          subtitle="Sin entregas registradas todavía"
          hint="TODO Fase 2: registrar recepción parcial/total en bodega, fotos y reconciliación."
        />

        {/* Sección 6: Notas */}
        {oc.notas && (
          <section className="bg-white rounded-lg ring-1 ring-slate-200 p-5">
            <h2 className="text-sm font-semibold text-slate-900 mb-3 uppercase tracking-wide flex items-center gap-2">
              <FileText className="w-4 h-4" /> Notas
            </h2>
            <p className="text-sm text-slate-700 whitespace-pre-wrap">{oc.notas}</p>
          </section>
        )}
      </div>

      {/* Drawer: editar notas/anticipo/tiempo */}
      <Drawer
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Editar OC"
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditOpen(false)} disabled={submitting}>
              Cancelar
            </Button>
            <Button onClick={handleEditSubmit} disabled={submitting}>
              {submitting ? 'Guardando…' : 'Guardar cambios'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-xs text-slate-500">
            Solo notas, % de anticipo y tiempo estimado pueden editarse después de autorizada.
          </p>
          <Field label="% anticipo">
            <Input
              type="number"
              min={0}
              max={100}
              value={pctAnticipo}
              onChange={(e) => setPctAnticipo(e.target.value)}
            />
          </Field>
          <Field label="Tiempo estimado (días)">
            <Input
              type="number"
              min={0}
              value={tiempoEstimadoDias}
              onChange={(e) => setTiempoEstimadoDias(e.target.value)}
            />
          </Field>
          <Field label="Notas">
            <Textarea value={notas} onChange={(e) => setNotas(e.target.value)} />
          </Field>
        </div>
      </Drawer>

      {/* Drawer: cancelar OC */}
      <Drawer
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancelar OC"
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCancelOpen(false)} disabled={submitting}>
              Volver
            </Button>
            <Button variant="danger" onClick={handleCancel} disabled={submitting}>
              {submitting ? 'Cancelando…' : 'Cancelar OC'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            Esta acción <strong>no se puede deshacer</strong>. Solo se permite si la OC no tiene pagos ni entregas
            registradas.
          </p>
          <Field label="Motivo">
            <Textarea
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Por qué se cancela (opcional pero recomendado)"
            />
          </Field>
        </div>
      </Drawer>
    </div>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm font-medium text-slate-900 mt-0.5">{value}</dd>
    </div>
  );
}

function PlaceholderSection({
  icon,
  title,
  subtitle,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  hint?: string;
}) {
  return (
    <section className="bg-slate-50 rounded-lg ring-1 ring-slate-200 p-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5">{icon}</div>
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">{title}</h2>
          <p className="text-sm text-slate-500 mt-1">{subtitle}</p>
          {hint && <p className="text-xs text-slate-400 mt-2 italic">{hint}</p>}
        </div>
      </div>
    </section>
  );
}
