import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, Pencil, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useItem, useList } from '../hooks/useApi';
import { api } from '../services/api';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Drawer } from '../components/ui/Drawer';
import { Input, Select, Textarea, Field } from '../components/ui/Input';
import { PageHeader } from '../components/ui/PageHeader';
import { Table } from '../components/ui/Table';
import { CotizacionArchivoUpload } from '../components/CotizacionArchivoUpload';
import { formatDate, formatMoney, toDateInput } from '../lib/format';
import { cotizacionMeta } from '../lib/badges';
import type { CategoriaLite, Cotizacion, CotizacionItem, Oc } from '../types/compras';

const EDITABLE_STATES = new Set(['recibida', 'en_revision']);
const APPROVABLE_STATES = new Set(['recibida', 'en_revision']);

export default function CotizacionDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id ? Number(params.id) : null;
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: cotizacion, isLoading } = useItem<Cotizacion>(
    ['cotizaciones', id] as const,
    `/cotizaciones/${id}`,
    !!id,
  );

  const obraId = cotizacion?.obraId ?? null;
  const { data: categorias = [] } = useList<CategoriaLite>(
    ['obras', obraId, 'categorias'] as const,
    obraId ? `/obras/${obraId}/categorias` : '',
  );

  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [categoriaId, setCategoriaId] = useState<string>('');
  const [fechaAprobacion, setFechaAprobacion] = useState<string>(toDateInput(new Date().toISOString()));
  const [motivo, setMotivo] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  // El backend acepta admin + supervisor. AuthContext.User.role está tipado
  // como 'admin' | 'user' pero el backend puede devolver 'supervisor' o
  // 'operativo' — comparamos string a string sin estrechar el tipo.
  const role = String(user?.role ?? '');
  const canApprove = role === 'admin' || role === 'supervisor';
  const canArchivoWrite = role === 'admin' || role === 'supervisor' || role === 'operativo';
  const canArchivoDelete = role === 'admin' || role === 'supervisor';

  const meta = useMemo(() => (cotizacion ? cotizacionMeta(cotizacion.estado) : null), [cotizacion]);

  if (!id) return <div className="p-4 text-sm text-red-600">ID inválido</div>;
  if (isLoading) return <div className="p-4 text-sm text-slate-500">Cargando…</div>;
  if (!cotizacion) return <div className="p-4 text-sm text-red-600">Cotización no encontrada</div>;

  const editable = EDITABLE_STATES.has(cotizacion.estado);
  const approvable = APPROVABLE_STATES.has(cotizacion.estado);

  async function handleApprove() {
    if (!categoriaId) {
      showToast('Selecciona una categoría', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const resp = await api.post<{ cotizacion: Cotizacion; oc: Oc }>(`/cotizaciones/${id}/aprobar`, {
        categoriaId: Number(categoriaId),
        fechaAprobacion: fechaAprobacion || undefined,
      });
      qc.invalidateQueries({ queryKey: ['cotizaciones'] });
      qc.invalidateQueries({ queryKey: ['ocs'] });
      showToast('Cotización aprobada y OC creada', 'success');
      setApproveOpen(false);
      if (resp?.oc?.id) navigate(`/ocs/${resp.oc.id}`);
    } catch (err) {
      showToast((err as Error).message || 'Error al aprobar', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReject() {
    setSubmitting(true);
    try {
      await api.post(`/cotizaciones/${id}/rechazar`, { motivo: motivo.trim() || undefined });
      qc.invalidateQueries({ queryKey: ['cotizaciones'] });
      showToast('Cotización rechazada', 'success');
      setRejectOpen(false);
      setMotivo('');
    } catch (err) {
      showToast((err as Error).message || 'Error al rechazar', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  const moneda = cotizacion.moneda;

  return (
    <div>
      <PageHeader
        title={`Cotización ${cotizacion.numeroCotizacion}`}
        subtitle={cotizacion.proveedor?.nombre ?? '—'}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate('/cotizaciones')}>
              <ArrowLeft className="w-4 h-4" /> Volver
            </Button>
            {editable && (
              <Link
                to={`/cotizaciones/${cotizacion.id}/edit`}
                className="inline-flex items-center gap-1.5 h-9 px-4 text-sm rounded-md bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
              >
                <Pencil className="w-4 h-4" /> Editar
              </Link>
            )}
            {approvable && canApprove && (
              <>
                <Button variant="danger" onClick={() => setRejectOpen(true)}>
                  <X className="w-4 h-4" /> Rechazar
                </Button>
                <Button onClick={() => setApproveOpen(true)} className="bg-emerald-600 hover:bg-emerald-700">
                  <Check className="w-4 h-4" /> Aprobar
                </Button>
              </>
            )}
          </>
        }
      />

      <div className="flex items-center gap-2 mb-6">
        {meta && <Badge tone={meta.tone}>{meta.label}</Badge>}
        {cotizacion.esEspecial && <Badge tone="amber">Especial</Badge>}
      </div>

      <div className="space-y-6">
        {/* Sección 1: Info general */}
        <section className="bg-white rounded-lg ring-1 ring-slate-200 p-5">
          <h2 className="text-sm font-semibold text-slate-900 mb-4 uppercase tracking-wide">Información general</h2>
          <dl className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <Info label="Proveedor" value={cotizacion.proveedor?.nombre ?? '—'} />
            <Info label="Obra" value={cotizacion.obra?.nombre ?? '—'} />
            <Info label="Moneda" value={cotizacion.moneda} />
            <Info label="Fecha" value={formatDate(cotizacion.fecha)} />
            <Info label="Fecha de validez" value={formatDate(cotizacion.fechaValidez)} />
            <Info label="Plazo entrega" value={cotizacion.plazoEntregaDias != null ? `${cotizacion.plazoEntregaDias} días` : '—'} />
            <Info label="Condiciones de pago" value={cotizacion.condicionesPago ?? '—'} />
            <Info label="% anticipo" value={cotizacion.pctAnticipo != null ? `${cotizacion.pctAnticipo}%` : '—'} />
            <Info label="Solicitud de cotización" value={cotizacion.rfqId ? `#${cotizacion.rfqId}` : '—'} />
          </dl>
        </section>

        {/* Sección 2: Items */}
        <section className="bg-white rounded-lg ring-1 ring-slate-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">Items</h2>
            <span className="text-xs text-slate-500">{cotizacion.items?.length ?? 0} líneas</span>
          </div>

          <Table<CotizacionItem>
            rows={cotizacion.items ?? []}
            rowKey={(it) => it.id ?? `tmp-${it.orden ?? Math.random()}`}
            empty={<span>Sin items registrados.</span>}
            columns={[
              {
                key: 'orden',
                header: '#',
                cell: (it) => <span className="text-slate-400">{it.orden ?? '—'}</span>,
              },
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

          <div className="flex justify-end mt-4">
            <dl className="w-full max-w-xs space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500">Subtotal</dt>
                <dd className="tabular-nums">{formatMoney(cotizacion.subtotal)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">IVA</dt>
                <dd className="tabular-nums">{formatMoney(cotizacion.iva)}</dd>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-2 text-base">
                <dt className="font-semibold">Total</dt>
                <dd className="font-bold tabular-nums text-indigo-700">{formatMoney(cotizacion.total)}</dd>
              </div>
            </dl>
          </div>
        </section>

        {/* Sección 3: Archivo de evidencia */}
        <section className="bg-white rounded-lg ring-1 ring-slate-200 p-5">
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">Archivo de evidencia</h2>
            <p className="text-xs text-slate-500 mt-1">
              PDF, foto o escaneo de la cotización del proveedor.
            </p>
          </div>
          <CotizacionArchivoUpload
            cotizacionId={cotizacion.id}
            currentPath={cotizacion.archivoPath ?? null}
            canWrite={canArchivoWrite}
            canDelete={canArchivoDelete}
            // En el detail, cuando cambia el archivo invalidamos la query y
            // la prop `currentPath` se refresca solo a través de cotizacion.
            onChange={() => qc.invalidateQueries({ queryKey: ['cotizaciones', id] })}
          />
        </section>

        {/* Sección 4: OC vinculada si aprobada */}
        {cotizacion.estado === 'aprobada' && cotizacion.oc && (
          <section className="bg-emerald-50 rounded-lg ring-1 ring-emerald-200 p-5">
            <h2 className="text-sm font-semibold text-emerald-900 mb-2 uppercase tracking-wide">
              Orden de Compra generada
            </h2>
            <p className="text-sm text-emerald-800">
              Esta cotización fue aprobada y generó la OC{' '}
              <Link
                to={`/ocs/${cotizacion.oc.id}`}
                className="font-semibold underline hover:text-emerald-900"
              >
                {cotizacion.oc.numeroOc}
              </Link>.
            </p>
          </section>
        )}

        {/* Sección 5: Notas */}
        {cotizacion.notas && (
          <section className="bg-white rounded-lg ring-1 ring-slate-200 p-5">
            <h2 className="text-sm font-semibold text-slate-900 mb-3 uppercase tracking-wide">Notas</h2>
            <p className="text-sm text-slate-700 whitespace-pre-wrap">{cotizacion.notas}</p>
          </section>
        )}
      </div>

      {/* Drawer de Aprobación */}
      <Drawer
        open={approveOpen}
        onClose={() => setApproveOpen(false)}
        title="Aprobar cotización"
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setApproveOpen(false)} disabled={submitting}>
              Cancelar
            </Button>
            <Button onClick={handleApprove} disabled={submitting} className="bg-emerald-600 hover:bg-emerald-700">
              {submitting ? 'Aprobando…' : 'Aprobar y crear OC'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Al aprobar, se creará automáticamente una <strong>Orden de Compra</strong> con número correlativo
            por obra. Esta acción no se puede deshacer.
          </p>

          <Field label="Categoría de la OC" required>
            <Select value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)}>
              <option value="">— Selecciona categoría —</option>
              {categorias.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Fecha de aprobación">
            <Input
              type="date"
              value={fechaAprobacion}
              onChange={(e) => setFechaAprobacion(e.target.value)}
            />
          </Field>
        </div>
      </Drawer>

      {/* Drawer de Rechazo */}
      <Drawer
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title="Rechazar cotización"
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRejectOpen(false)} disabled={submitting}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={handleReject} disabled={submitting}>
              {submitting ? 'Rechazando…' : 'Rechazar'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Indicá brevemente por qué se rechaza esta cotización (opcional pero recomendado).
          </p>
          <Field label="Motivo">
            <Textarea
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Precio fuera de mercado, plazo no aceptable, etc."
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
