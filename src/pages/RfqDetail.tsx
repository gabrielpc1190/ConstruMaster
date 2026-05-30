/**
 * Detalle de una Solicitud de Cotización + panel de comparación.
 *
 * - Encabezado con info (descripción, obra, categoría, estado, fecha requerida).
 * - Si estado=abierta: botón "+ Cargar cotización de proveedor" que navega
 *   a /cotizaciones/new pasando state {rfqId, obraId, categoriaId} y
 *   también `?rfqId=N` como query param (redundante, defensivo).
 * - Panel de comparación: una columna por cotización con proveedor, fecha,
 *   total, plazo, % anticipo, # items y acciones (Ver / Aprobar / Rechazar).
 * - Si estado=cerrada: la cotización ganadora se resalta.
 * - Si estado=cancelada: motivo visible, acciones bloqueadas.
 * - Botón "Cancelar SC" (admin/supervisor) si abierta y sin cotización aprobada.
 *
 * Aprobar acá llama el mismo POST /api/cotizaciones/:id/aprobar — el endpoint
 * de oc-flow ya cierra la SC automáticamente. Necesitamos pedirle al usuario
 * la categoría de la OC porque ese parámetro es obligatorio (igual que en
 * CotizacionDetail). Pre-llenamos con la categoría de la SC para acelerar.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, Plus, X, Eye } from 'lucide-react';
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
import { formatDate, formatMoney, toDateInput } from '../lib/format';
import { rfqMeta, cotizacionMeta } from '../lib/badges';
import type { CategoriaLite, Rfq, RfqCotizacionLite } from '../types/compras';

export default function RfqDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id ? Number(params.id) : null;
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: rfq, isLoading } = useItem<Rfq>(
    ['rfqs', id] as const,
    `/rfqs/${id}`,
    !!id,
  );

  const obraId = rfq?.obraId ?? null;
  const { data: categorias = [] } = useList<CategoriaLite>(
    ['obras', obraId, 'categorias'] as const,
    obraId ? `/obras/${obraId}/categorias` : '',
  );

  // Drawers
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [targetCotId, setTargetCotId] = useState<number | null>(null);
  const [categoriaId, setCategoriaId] = useState<string>('');
  const [fechaAprobacion, setFechaAprobacion] = useState<string>(toDateInput(new Date().toISOString()));
  const [motivo, setMotivo] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  const role = String(user?.role ?? '');
  const canApprove = role === 'admin' || role === 'supervisor';
  const canCancel = role === 'admin' || role === 'supervisor';
  const canCreateCotizacion = role === 'admin' || role === 'supervisor' || role === 'operativo';

  const meta = useMemo(() => (rfq ? rfqMeta(rfq.estado) : null), [rfq]);
  const cotizaciones: RfqCotizacionLite[] = rfq?.cotizaciones ?? [];
  const tieneAprobada = cotizaciones.some(c => c.estado === 'aprobada');
  const cotGanadora = cotizaciones.find(c => c.estado === 'aprobada') ?? null;

  if (!id) return <div className="p-4 text-sm text-red-600">ID inválido</div>;
  if (isLoading) return <div className="p-4 text-sm text-slate-500">Cargando…</div>;
  if (!rfq) return <div className="p-4 text-sm text-red-600">Solicitud no encontrada</div>;

  const isAbierta = rfq.estado === 'abierta';
  const isCerrada = rfq.estado === 'cerrada';
  const isCancelada = rfq.estado === 'cancelada';

  function openApprove(cotId: number) {
    setTargetCotId(cotId);
    setCategoriaId(rfq?.categoriaId ? String(rfq.categoriaId) : '');
    setFechaAprobacion(toDateInput(new Date().toISOString()));
    setApproveOpen(true);
  }

  function openReject(cotId: number) {
    setTargetCotId(cotId);
    setMotivo('');
    setRejectOpen(true);
  }

  async function handleApprove() {
    if (!targetCotId) return;
    if (!categoriaId) {
      showToast('Selecciona una categoría', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await api.post(`/cotizaciones/${targetCotId}/aprobar`, {
        categoriaId: Number(categoriaId),
        fechaAprobacion: fechaAprobacion || undefined,
      });
      qc.invalidateQueries({ queryKey: ['rfqs'] });
      qc.invalidateQueries({ queryKey: ['cotizaciones'] });
      qc.invalidateQueries({ queryKey: ['ocs'] });
      showToast('OC creada y solicitud de cotización cerrada', 'success');
      setApproveOpen(false);
      setTargetCotId(null);
    } catch (err) {
      showToast((err as Error).message || 'Error al aprobar', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReject() {
    if (!targetCotId) return;
    setSubmitting(true);
    try {
      await api.post(`/cotizaciones/${targetCotId}/rechazar`, {
        motivo: motivo.trim() || undefined,
      });
      qc.invalidateQueries({ queryKey: ['rfqs'] });
      qc.invalidateQueries({ queryKey: ['cotizaciones'] });
      showToast('Cotización rechazada', 'success');
      setRejectOpen(false);
      setTargetCotId(null);
      setMotivo('');
    } catch (err) {
      showToast((err as Error).message || 'Error al rechazar', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancelRfq() {
    setSubmitting(true);
    try {
      await api.post(`/rfqs/${id}/cancelar`, { motivo: motivo.trim() || undefined });
      qc.invalidateQueries({ queryKey: ['rfqs'] });
      showToast('Solicitud cancelada', 'success');
      setCancelOpen(false);
      setMotivo('');
    } catch (err) {
      showToast((err as Error).message || 'Error al cancelar', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  function handleCargarCotizacion() {
    // Doble vía para máxima compatibilidad con el CotizacionForm:
    //  1. `state.rfqId/obraId/categoriaId` para prefill (TODO: integrar en
    //     CotizacionForm — hoy el form NO lee este state, solo lee
    //     `state.prefill.{data,matches}` del flujo OCR).
    //  2. `?rfqId=N` como query param (también TODO de integración).
    // Mientras tanto, el operativo digita manualmente el campo rfqId
    // (visible en el form como número de SC).
    if (!rfq) return;
    navigate(`/cotizaciones/new?rfqId=${rfq.id}`, {
      state: {
        rfqId: rfq.id,
        obraId: rfq.obraId,
        categoriaId: rfq.categoriaId,
      },
    });
  }

  return (
    <div>
      <PageHeader
        title={`Solicitud de cotización #${rfq.id}`}
        subtitle={rfq.descripcion}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate('/solicitudes-cotizacion')}>
              <ArrowLeft className="w-4 h-4" /> Volver
            </Button>
            {isAbierta && canCreateCotizacion && (
              <Button onClick={handleCargarCotizacion}>
                <Plus className="w-4 h-4" /> Cargar cotización de proveedor
              </Button>
            )}
            {isAbierta && canCancel && !tieneAprobada && (
              <Button variant="danger" onClick={() => { setMotivo(''); setCancelOpen(true); }}>
                <X className="w-4 h-4" /> Cancelar SC
              </Button>
            )}
          </>
        }
      />

      <div className="flex items-center gap-2 mb-6">
        {meta && <Badge tone={meta.tone}>{meta.label}</Badge>}
        {rfq.esEspecial && <Badge tone="amber">Especial</Badge>}
      </div>

      <div className="space-y-6">
        {/* Sección 1: info general */}
        <section className="bg-white rounded-lg ring-1 ring-slate-200 p-5">
          <h2 className="text-sm font-semibold text-slate-900 mb-4 uppercase tracking-wide">Información</h2>
          <dl className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <Info label="Obra" value={rfq.obra?.nombre ?? '—'} />
            <Info label="Categoría" value={rfq.categoria?.nombre ?? '—'} />
            <Info label="Fecha requerida" value={formatDate(rfq.fechaRequerida)} />
            <Info label="Creada por" value={rfq.creadaPor?.fullName || rfq.creadaPor?.username || '—'} />
            <Info label="Creada el" value={formatDate(rfq.createdAt)} />
            <Info label="Cotizaciones recibidas" value={String(cotizaciones.length)} />
          </dl>
          {rfq.descripcion && (
            <div className="mt-4 pt-4 border-t border-slate-100">
              <dt className="text-xs uppercase tracking-wide text-slate-500 mb-1">Descripción</dt>
              <dd className="text-sm text-slate-800 whitespace-pre-wrap">{rfq.descripcion}</dd>
            </div>
          )}
        </section>

        {/* Sección 2: notas / motivo cancelación */}
        {rfq.notas && (
          <section className={
            isCancelada
              ? 'bg-red-50 rounded-lg ring-1 ring-red-200 p-5'
              : 'bg-white rounded-lg ring-1 ring-slate-200 p-5'
          }>
            <h2 className={`text-sm font-semibold uppercase tracking-wide mb-2 ${isCancelada ? 'text-red-900' : 'text-slate-900'}`}>
              {isCancelada ? 'Motivo de cancelación / Notas' : 'Notas'}
            </h2>
            <p className={`text-sm whitespace-pre-wrap ${isCancelada ? 'text-red-900' : 'text-slate-700'}`}>
              {rfq.notas}
            </p>
          </section>
        )}

        {/* Sección 3: panel de comparación */}
        <section className="bg-white rounded-lg ring-1 ring-slate-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">
              Comparación de cotizaciones recibidas
            </h2>
            <span className="text-xs text-slate-500">{cotizaciones.length} {cotizaciones.length === 1 ? 'cotización' : 'cotizaciones'}</span>
          </div>

          {cotizaciones.length === 0 ? (
            <div className="text-sm text-slate-400 italic py-8 text-center">
              {isAbierta
                ? 'Aún no hay cotizaciones cargadas. Pedile a los proveedores que envíen su presupuesto y cargá cada una con el botón de arriba.'
                : 'Esta solicitud no tiene cotizaciones cargadas.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-medium text-slate-500 uppercase tracking-wide border-b border-slate-200">
                    <th className="px-3 py-2 sticky left-0 bg-white z-10">Concepto</th>
                    {cotizaciones.map((c) => {
                      const isWinner = isCerrada && c.estado === 'aprobada';
                      return (
                        <th
                          key={c.id}
                          className={`px-3 py-2 min-w-[200px] ${isWinner ? 'bg-emerald-50' : ''}`}
                        >
                          <div className="flex flex-col gap-1">
                            <span className="font-semibold text-slate-900">{c.proveedor?.nombre ?? '—'}</span>
                            <span className="text-[10px] font-normal text-slate-500">#{c.numeroCotizacion}</span>
                            <span>
                              <Badge tone={cotizacionMeta(c.estado).tone}>{cotizacionMeta(c.estado).label}</Badge>
                              {isWinner && <span className="ml-1 text-emerald-700 font-semibold">✓ Ganadora</span>}
                            </span>
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  <Row label="Fecha">
                    {cotizaciones.map((c) => (
                      <td key={c.id} className="px-3 py-2 text-slate-700">{formatDate(c.fecha)}</td>
                    ))}
                  </Row>
                  <Row label="Validez">
                    {cotizaciones.map((c) => (
                      <td key={c.id} className="px-3 py-2 text-slate-700">{formatDate(c.fechaValidez)}</td>
                    ))}
                  </Row>
                  <Row label="Moneda">
                    {cotizaciones.map((c) => (
                      <td key={c.id} className="px-3 py-2 text-slate-700">{c.moneda}</td>
                    ))}
                  </Row>
                  <Row label="Total" highlight>
                    {cotizaciones.map((c) => {
                      const isWinner = isCerrada && c.estado === 'aprobada';
                      return (
                        <td
                          key={c.id}
                          className={`px-3 py-2 tabular-nums font-bold ${isWinner ? 'bg-emerald-50 text-emerald-700' : 'text-indigo-700'}`}
                        >
                          {formatMoney({ amount: c.totalAmount, currency: c.totalCurrency })}
                        </td>
                      );
                    })}
                  </Row>
                  <Row label="Plazo entrega">
                    {cotizaciones.map((c) => (
                      <td key={c.id} className="px-3 py-2 text-slate-700">
                        {c.plazoEntregaDias != null ? `${c.plazoEntregaDias} días` : '—'}
                      </td>
                    ))}
                  </Row>
                  <Row label="% anticipo">
                    {cotizaciones.map((c) => (
                      <td key={c.id} className="px-3 py-2 text-slate-700">
                        {c.pctAnticipo != null ? `${c.pctAnticipo}%` : '—'}
                      </td>
                    ))}
                  </Row>
                  <Row label="Condiciones">
                    {cotizaciones.map((c) => (
                      <td key={c.id} className="px-3 py-2 text-slate-700">{c.condicionesPago ?? '—'}</td>
                    ))}
                  </Row>
                  <Row label="# items">
                    {cotizaciones.map((c) => (
                      <td key={c.id} className="px-3 py-2 text-slate-700 tabular-nums">
                        {c._count?.items ?? '—'}
                      </td>
                    ))}
                  </Row>
                  <Row label="Acciones">
                    {cotizaciones.map((c) => {
                      const aprobable = isAbierta && (c.estado === 'recibida' || c.estado === 'en_revision');
                      return (
                        <td key={c.id} className="px-3 py-2">
                          <div className="flex flex-col gap-1.5">
                            <Link
                              to={`/cotizaciones/${c.id}`}
                              className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800"
                            >
                              <Eye className="w-3 h-3" /> Ver detalle
                            </Link>
                            {aprobable && canApprove && (
                              <>
                                <Button
                                  size="sm"
                                  onClick={() => openApprove(c.id)}
                                  className="bg-emerald-600 hover:bg-emerald-700 w-full"
                                >
                                  <Check className="w-3 h-3" /> Aprobar ESTA
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => openReject(c.id)}
                                  className="w-full"
                                >
                                  <X className="w-3 h-3" /> Rechazar
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </Row>
                </tbody>
              </table>
            </div>
          )}

          {isCerrada && cotGanadora && (
            <div className="mt-4 p-3 bg-emerald-50 rounded ring-1 ring-emerald-200 text-sm text-emerald-800">
              Ganadora: <strong>{cotGanadora.proveedor?.nombre ?? '—'}</strong> —{' '}
              {formatMoney({ amount: cotGanadora.totalAmount, currency: cotGanadora.totalCurrency })}.{' '}
              <Link to={`/cotizaciones/${cotGanadora.id}`} className="underline hover:text-emerald-900">
                Ver cotización
              </Link>
              .
            </div>
          )}
        </section>
      </div>

      {/* Drawer aprobación */}
      <Drawer
        open={approveOpen}
        onClose={() => setApproveOpen(false)}
        title="Aprobar cotización y crear OC"
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
            Esto creará automáticamente una <strong>Orden de Compra</strong> con número correlativo
            por obra y <strong>cerrará</strong> esta solicitud. Las demás cotizaciones quedan como están.
          </p>
          <Field label="Categoría de la OC" required>
            <Select value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)}>
              <option value="">— Selecciona categoría —</option>
              {categorias.map((c) => (
                <option key={c.id} value={c.id}>{c.nombre}</option>
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

      {/* Drawer rechazo */}
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
          <p className="text-sm text-slate-600">Indicá brevemente por qué (opcional).</p>
          <Field label="Motivo">
            <Textarea
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Precio fuera de mercado, plazo no aceptable, etc."
            />
          </Field>
        </div>
      </Drawer>

      {/* Drawer cancelar SC */}
      <Drawer
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancelar solicitud de cotización"
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCancelOpen(false)} disabled={submitting}>
              Volver
            </Button>
            <Button variant="danger" onClick={handleCancelRfq} disabled={submitting}>
              {submitting ? 'Cancelando…' : 'Cancelar solicitud'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            La solicitud quedará en estado <strong>cancelada</strong> y no se podrán cargar
            más cotizaciones contra ella. Esta acción no se puede deshacer.
          </p>
          <Field label="Motivo (opcional)">
            <Textarea
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Ej: Cliente cambió de opinión, ya no se necesita el material…"
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

function Row({ label, children, highlight }: { label: string; children: React.ReactNode; highlight?: boolean }) {
  return (
    <tr className={highlight ? 'bg-slate-50' : undefined}>
      <th className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide sticky left-0 bg-white z-10">
        {label}
      </th>
      {children}
    </tr>
  );
}
