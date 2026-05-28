/**
 * EntregaDetail — vista de una entrega.
 *
 * Header con # entrega · fecha · OC link.
 * Sección items recibidos.
 * Sección fotos (grid con thumbnails). Download autenticado (blob + URL).
 * Acciones: editar (drawer), eliminar (admin only).
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Camera, ExternalLink, Pencil, Trash2 } from 'lucide-react';

import { useItem, useList } from '../hooks/useApi';
import { api, type ApiError } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { Button } from '../components/ui/Button';
import { Input, Select, Textarea, Field } from '../components/ui/Input';
import { Drawer } from '../components/ui/Drawer';
import { Badge } from '../components/ui/Badge';
import { Table } from '../components/ui/Table';
import { formatDate, formatDateTime, toDateInput } from '../lib/format';

interface EntregaItemDetail {
  id: number;
  ocItemId: number | null;
  materialId: number | null;
  descripcion: string;
  cantidad: string;
  unidad: string;
  notas: string | null;
  material?: { id: number; nombreCanonico: string; unidad: string };
}

interface EntregaFotoDetail {
  id: number;
  entregaId: number;
  archivoPath: string;
  subidaPorId: number;
  fecha: string;
  subidaPor?: { id: number; username: string; fullName: string | null };
}

interface EntregaDetail {
  id: number;
  ocId: number;
  bodegaDestinoId: number | null;
  fecha: string;
  recibidoPor: string;
  registradaPorId: number;
  completa: boolean;
  notas: string | null;
  createdAt: string;
  updatedAt: string;
  items: EntregaItemDetail[];
  fotos: EntregaFotoDetail[];
  oc?: { id: number; numeroOc: string; proveedor: { id: number; nombre: string } | null };
  bodegaDestino?: { id: number; nombre: string };
  registradaPor?: { id: number; username: string; fullName: string | null };
}

interface BodegaOption {
  id: number;
  nombre: string;
  activo: boolean;
}

// ---------------------------------------------------------------------------
// Helpers de descarga autenticada de foto (blob + URL.createObjectURL).
// ---------------------------------------------------------------------------

async function fetchFotoBlob(token: string | null, entregaId: number, fotoId: number): Promise<Blob> {
  const res = await fetch(`/api/entregas/${entregaId}/fotos/${fotoId}/archivo`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

function useFotoUrl(entregaId: number, fotoId: number) {
  const { token } = useAuth();
  const [state, setState] = useState<{ url: string | null; error: string | null }>(
    { url: null, error: null },
  );

  useEffect(() => {
    let cancelled = false;
    let currentUrl: string | null = null;
    fetchFotoBlob(token, entregaId, fotoId)
      .then((blob) => {
        if (cancelled) return;
        currentUrl = URL.createObjectURL(blob);
        setState({ url: currentUrl, error: null });
      })
      .catch((e: Error) => {
        if (!cancelled) setState({ url: null, error: e.message });
      });
    return () => {
      cancelled = true;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [token, entregaId, fotoId]);

  return state;
}

function FotoThumb({
  entregaId,
  foto,
  onClick,
}: {
  entregaId: number;
  foto: EntregaFotoDetail;
  onClick: () => void;
}) {
  const { url, error } = useFotoUrl(entregaId, foto.id);
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative aspect-square rounded-md overflow-hidden ring-1 ring-slate-200 hover:ring-indigo-400 bg-slate-100"
    >
      {url ? (
        <img src={url} alt={foto.archivoPath.split('/').pop()} className="w-full h-full object-cover" />
      ) : error ? (
        <div className="flex items-center justify-center w-full h-full text-xs text-red-500 p-2 text-center">
          {error}
        </div>
      ) : (
        <div className="flex items-center justify-center w-full h-full text-xs text-slate-400">
          Cargando…
        </div>
      )}
    </button>
  );
}

function FotoModal({
  open,
  entregaId,
  foto,
  onClose,
}: {
  open: boolean;
  entregaId: number;
  foto: EntregaFotoDetail | null;
  onClose: () => void;
}) {
  const { url } = useFotoUrl(entregaId, foto?.id ?? 0);
  if (!open || !foto) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/70" />
      <div className="relative max-w-5xl max-h-[90vh] w-full">
        {url ? (
          <img src={url} alt={foto.archivoPath} className="w-full h-full object-contain max-h-[90vh]" />
        ) : (
          <p className="text-white text-center">Cargando…</p>
        )}
        <button
          onClick={onClose}
          className="absolute top-2 right-2 bg-white/90 hover:bg-white rounded-md px-3 py-1 text-sm font-medium"
        >
          Cerrar
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="bg-white rounded-lg ring-1 ring-slate-200">
      <header className="px-5 h-11 flex items-center justify-between border-b border-slate-100">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {action}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

export default function EntregaDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { showToast } = useToast();

  const entregaId = Number(id);
  const { data: entrega, isLoading, error } = useItem<EntregaDetail>(
    ['entregas', entregaId],
    `/entregas/${entregaId}`,
    Number.isFinite(entregaId),
  );

  const [editOpen, setEditOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [modalFoto, setModalFoto] = useState<EntregaFotoDetail | null>(null);

  const canEdit = user?.role === 'admin' || user?.role === 'supervisor';
  const canDelete = user?.role === 'admin';

  const deleteMutation = useMutation<unknown, ApiError, void>({
    mutationFn: () => api.delete(`/entregas/${entregaId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['entregas'] });
      showToast('Entrega eliminada.', 'success');
      navigate('/entregas');
    },
    onError: (err) => showToast(err.message || 'Error eliminando', 'error'),
  });

  if (isLoading) return <div className="p-6 text-sm text-slate-500">Cargando entrega…</div>;
  if (error || !entrega) {
    return (
      <div className="p-6">
        <Button variant="secondary" onClick={() => navigate('/entregas')}>
          <ArrowLeft className="w-4 h-4" /> Volver
        </Button>
        <p className="mt-4 text-sm text-red-600">Entrega no encontrada.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <button
          onClick={() => navigate('/entregas')}
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800 mb-2"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Entregas
        </button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-xl font-bold text-slate-900">Entrega #{entrega.id}</h1>
              {entrega.completa && <Badge tone="emerald">Completa</Badge>}
              {entrega.bodegaDestino && <Badge tone="slate">{entrega.bodegaDestino.nombre}</Badge>}
            </div>
            <p className="text-xs text-slate-500 mt-1">
              {formatDate(entrega.fecha)} ·{' '}
              {entrega.oc && (
                <Link to={`/ocs/${entrega.oc.id}`} className="text-indigo-600 hover:underline inline-flex items-center gap-1">
                  {entrega.oc.numeroOc} <ExternalLink className="w-3 h-3" />
                </Link>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {canEdit && (
              <Button variant="secondary" onClick={() => setEditOpen(true)}>
                <Pencil className="w-4 h-4" /> Editar
              </Button>
            )}
            {canDelete && (
              <Button variant="danger" onClick={() => setConfirmDeleteOpen(true)}>
                <Trash2 className="w-4 h-4" /> Eliminar
              </Button>
            )}
          </div>
        </div>
      </div>

      <Section title={`Items recibidos (${entrega.items.length})`}>
        <Table<EntregaItemDetail>
          rows={entrega.items}
          rowKey={(it) => it.id}
          empty={<span>Sin items.</span>}
          columns={[
            {
              key: 'desc',
              header: 'Descripción',
              cell: (it) => (
                <div>
                  <span className="text-slate-700">{it.descripcion}</span>
                  {it.ocItemId == null && (
                    <span className="ml-2 text-[10px] uppercase tracking-wide text-amber-700">Extra</span>
                  )}
                </div>
              ),
            },
            { key: 'cant', header: 'Cantidad', align: 'right', cell: (it) => <span className="font-mono">{it.cantidad}</span> },
            { key: 'unidad', header: 'Unidad', cell: (it) => it.unidad },
            {
              key: 'notas',
              header: 'Notas',
              cell: (it) => it.notas ?? <span className="text-slate-400 italic">—</span>,
            },
          ]}
        />
      </Section>

      <Section
        title={`Fotos (${entrega.fotos.length})`}
        action={
          <Button size="sm" variant="secondary" onClick={() => setUploadOpen(true)}>
            <Camera className="w-3.5 h-3.5" /> Subir más fotos
          </Button>
        }
      >
        {entrega.fotos.length === 0 ? (
          <p className="text-sm text-slate-400 italic">Sin fotos.</p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
            {entrega.fotos.map((f) => (
              <FotoThumb key={f.id} entregaId={entrega.id} foto={f} onClick={() => setModalFoto(f)} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Notas">
        {entrega.notas ? (
          <p className="text-sm text-slate-700 whitespace-pre-wrap">{entrega.notas}</p>
        ) : (
          <p className="text-sm text-slate-400 italic">Sin notas.</p>
        )}
      </Section>

      <Section title="Metadatos">
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-3 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Recibido por</dt>
            <dd className="text-slate-900">{entrega.recibidoPor}</dd>
          </div>
          {entrega.registradaPor && (
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Registró</dt>
              <dd className="text-slate-900">{entrega.registradaPor.fullName ?? entrega.registradaPor.username}</dd>
            </div>
          )}
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Creada</dt>
            <dd className="text-slate-900">{formatDateTime(entrega.createdAt)}</dd>
          </div>
        </dl>
      </Section>

      <Drawer open={editOpen} onClose={() => setEditOpen(false)} title="Editar entrega" size="sm">
        <EditEntregaForm
          entrega={entrega}
          onCancel={() => setEditOpen(false)}
          onDone={() => {
            setEditOpen(false);
            qc.invalidateQueries({ queryKey: ['entregas', entregaId] });
            qc.invalidateQueries({ queryKey: ['entregas'] });
          }}
        />
      </Drawer>

      <Drawer open={uploadOpen} onClose={() => setUploadOpen(false)} title="Subir más fotos" size="md">
        <UploadMoreFotos
          entregaId={entrega.id}
          onDone={() => {
            setUploadOpen(false);
            qc.invalidateQueries({ queryKey: ['entregas', entregaId] });
          }}
          onCancel={() => setUploadOpen(false)}
        />
      </Drawer>

      <FotoModal
        open={!!modalFoto}
        entregaId={entrega.id}
        foto={modalFoto}
        onClose={() => setModalFoto(null)}
      />

      {confirmDeleteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setConfirmDeleteOpen(false)} />
          <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <h3 className="text-base font-semibold text-slate-900">Eliminar entrega</h3>
            <p className="mt-2 text-sm text-slate-600">
              Vas a eliminar la entrega <strong>#{entrega.id}</strong> y sus {entrega.fotos.length} foto(s).
              Esto puede modificar el estado de la OC asociada.
            </p>
            <p className="mt-1 text-xs text-slate-500">No se puede deshacer.</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirmDeleteOpen(false)} disabled={deleteMutation.isPending}>
                Cancelar
              </Button>
              <Button variant="danger" onClick={() => deleteMutation.mutate()} disabled={deleteMutation.isPending}>
                {deleteMutation.isPending ? 'Eliminando…' : 'Eliminar'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EditEntregaForm
// ---------------------------------------------------------------------------

function EditEntregaForm({
  entrega,
  onCancel,
  onDone,
}: {
  entrega: EntregaDetail;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { showToast } = useToast();
  const [fecha, setFecha] = useState(toDateInput(entrega.fecha));
  const [recibidoPor, setRecibidoPor] = useState(entrega.recibidoPor);
  const [bodegaDestinoId, setBodegaDestinoId] = useState<number | ''>(entrega.bodegaDestinoId ?? '');
  const [notas, setNotas] = useState(entrega.notas ?? '');

  const { data: bodegasList = [] } = useList<BodegaOption>(['bodegas', 'all'], '/bodegas');
  const bodegas = useMemo(() => bodegasList.filter((b) => b.activo), [bodegasList]);

  const mutation = useMutation<unknown, ApiError, Record<string, unknown>>({
    mutationFn: (body) => api.put(`/entregas/${entrega.id}`, body),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate(
      {
        fecha,
        recibidoPor: recibidoPor.trim(),
        bodegaDestinoId: bodegaDestinoId === '' ? null : Number(bodegaDestinoId),
        notas: notas.trim() || null,
      },
      {
        onSuccess: () => {
          showToast('Entrega actualizada.', 'success');
          onDone();
        },
        onError: (err) => showToast(err.message || 'Error actualizando', 'error'),
      },
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field label="Fecha">
        <Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
      </Field>
      <Field label="Recibido por">
        <Input value={recibidoPor} onChange={(e) => setRecibidoPor(e.target.value)} />
      </Field>
      <Field label="Bodega destino">
        <Select
          value={bodegaDestinoId === '' ? '' : String(bodegaDestinoId)}
          onChange={(e) => setBodegaDestinoId(e.target.value === '' ? '' : Number(e.target.value))}
        >
          <option value="">— Sin especificar —</option>
          {bodegas.map((b) => (
            <option key={b.id} value={b.id}>{b.nombre}</option>
          ))}
        </Select>
      </Field>
      <Field label="Notas">
        <Textarea value={notas} onChange={(e) => setNotas(e.target.value)} rows={3} />
      </Field>
      <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={mutation.isPending}>
          Cancelar
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Guardando…' : 'Guardar'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// UploadMoreFotos
// ---------------------------------------------------------------------------

const PHOTO_MAX_SIZE = 10 * 1024 * 1024;
const PHOTO_MAX_COUNT = 10;

function isValidPhoto(f: File): boolean {
  if (f.size > PHOTO_MAX_SIZE) return false;
  const ext = f.name.toLowerCase();
  return (
    /^image\/(jpeg|png|heif|heic|webp)$/.test(f.type) ||
    /\.(jpg|jpeg|png|heif|heic|webp)$/.test(ext)
  );
}

function UploadMoreFotos({
  entregaId,
  onCancel,
  onDone,
}: {
  entregaId: number;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { showToast } = useToast();
  const [files, setFiles] = useState<File[]>([]);

  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  const mutation = useMutation<unknown, ApiError, File[]>({
    mutationFn: (fs) => {
      const fd = new FormData();
      for (const f of fs) fd.append('fotos', f, f.name);
      return api.upload(`/entregas/${entregaId}/fotos`, fd);
    },
  });

  const handleSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    const valid: File[] = [];
    for (const f of list) {
      if (!isValidPhoto(f)) {
        showToast(`${f.name}: formato/tamaño no válido`, 'error');
        continue;
      }
      valid.push(f);
    }
    setFiles((prev) => [...prev, ...valid].slice(0, PHOTO_MAX_COUNT));
    e.target.value = '';
  };

  const handleUpload = () => {
    if (files.length === 0) return;
    mutation.mutate(files, {
      onSuccess: () => {
        showToast(`${files.length} foto(s) subida(s).`, 'success');
        onDone();
      },
      onError: (err) => showToast(err.message || 'Error subiendo fotos', 'error'),
    });
  };

  return (
    <div className="space-y-4">
      <Field label={`Fotos (${files.length}/${PHOTO_MAX_COUNT})`} hint="JPEG, PNG, HEIF o WEBP. Máx 10 MB cada una.">
        <label className="flex items-center justify-center gap-2 rounded-md border-2 border-dashed border-slate-300 bg-slate-50 px-4 py-6 cursor-pointer hover:border-slate-400">
          <Camera className="w-5 h-5 text-slate-500" />
          <span className="text-sm text-slate-600">Tocá para elegir o tomar fotos</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/heif,image/heic,image/webp"
            multiple
            capture="environment"
            onChange={handleSelect}
            className="hidden"
            disabled={files.length >= PHOTO_MAX_COUNT}
          />
        </label>
      </Field>

      {previews.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {previews.map((url, idx) => (
            <div key={url} className="relative aspect-square rounded-md overflow-hidden ring-1 ring-slate-200">
              <img src={url} alt={files[idx]?.name} className="w-full h-full object-cover" />
            </div>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={mutation.isPending}>
          Cancelar
        </Button>
        <Button type="button" onClick={handleUpload} disabled={mutation.isPending || files.length === 0}>
          {mutation.isPending ? 'Subiendo…' : `Subir ${files.length}`}
        </Button>
      </div>
    </div>
  );
}
