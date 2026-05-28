import { useEffect, useRef, useState } from 'react';
import { Plus, Search, Loader2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import type { ApiError } from '../services/api';
import { Button } from './ui/Button';
import { Input, Select, Textarea, Field } from './ui/Input';
import { Drawer } from './ui/Drawer';
import { useToast } from '../context/ToastContext';
import { cn } from '../lib/cn';

/**
 * ItemCatalogoAutocomplete
 * -------------------------
 * Input con autocompletado contra `GET /api/items-catalogo/autocomplete?q=`.
 * Debounce 200ms. Si no hay match, ofrece botón inline "+ Crear nuevo material"
 * que abre un mini-drawer para crear el item sin salir del flujo.
 *
 * Pensado para usarse en Cotizaciones y Entregas (Fase siguiente).
 *
 * Uso:
 * ```tsx
 * const [itemId, setItemId] = useState<number | null>(null);
 * <ItemCatalogoAutocomplete
 *   value={itemId}
 *   onChange={(id, display) => setItemId(id)}
 *   placeholder="Buscar material o servicio..."
 * />
 * ```
 *
 * Props:
 * - `value`: ID seleccionado (controlado). Si se setea a null desde afuera y
 *   no hay `defaultDisplay`, limpia el input.
 * - `onChange`: callback con `(id, displayText)` donde `displayText` =
 *   "nombreCanonico (unidad)".
 * - `placeholder`: opcional.
 * - `defaultDisplay`: texto inicial cuando ya se conoce el item (caso edición).
 */

type ItemTipo = 'material' | 'servicio';

const UNIDADES = [
  'saco', 'kg', 'm3', 'm2', 'm', 'unidad', 'varilla',
  'galon', 'litro', 'hora', 'dia', 'visita', 'global', 'mes',
] as const;

interface AutocompleteItem {
  id: number;
  nombreCanonico: string;
  unidad: string;
  tipo: ItemTipo;
}

interface Props {
  value: number | null;
  onChange: (id: number, displayText: string) => void;
  placeholder?: string;
  defaultDisplay?: string;
}

export function ItemCatalogoAutocomplete({ value, onChange, placeholder, defaultDisplay }: Props) {
  const [query, setQuery] = useState(defaultDisplay ?? '');
  const [lastValue, setLastValue] = useState<number | null>(value);
  const [results, setResults] = useState<AutocompleteItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Si el value se limpia desde afuera, limpiar display (sin defaultDisplay).
  // Detectamos cambios comparando con el último value visto, durante render.
  if (value !== lastValue) {
    setLastValue(value);
    if (value === null && !defaultDisplay) {
      setQuery('');
    }
  }

  // Cerrar dropdown al hacer click afuera.
  useEffect(() => {
    const onClickAway = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickAway);
    return () => document.removeEventListener('mousedown', onClickAway);
  }, []);

  // Debounce 200ms del fetch. El estado lo seteamos siempre dentro del timer
  // (o en cleanup) para evitar cascadas síncronas durante el effect.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 1) {
      // Reset asíncrono para no provocar cascada de renders.
      const reset = setTimeout(() => {
        setResults([]);
        setLoading(false);
        setError(null);
      }, 0);
      return () => clearTimeout(reset);
    }
    const handle = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await api.get<AutocompleteItem[]>(
          `/items-catalogo/autocomplete?q=${encodeURIComponent(q)}`,
        );
        setResults(Array.isArray(data) ? data.slice(0, 10) : []);
      } catch (e) {
        setError((e as Error).message || 'Error al buscar');
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [query]);

  const handlePick = (item: AutocompleteItem) => {
    const display = `${item.nombreCanonico} (${item.unidad})`;
    setQuery(display);
    setOpen(false);
    onChange(item.id, display);
  };

  const handleCreated = (item: AutocompleteItem) => {
    setCreateOpen(false);
    handlePick(item);
  };

  const showCreateCTA =
    !loading && query.trim().length >= 2 && results.length === 0 && !error;

  return (
    <>
      <div ref={wrapRef} className="relative">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            placeholder={placeholder ?? 'Buscar item de catálogo...'}
            className="pl-8"
          />
          {loading && (
            <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 animate-spin" />
          )}
        </div>

        {open && (results.length > 0 || showCreateCTA || error) && (
          <div className="absolute z-30 mt-1 w-full bg-white rounded-md ring-1 ring-slate-200 shadow-lg max-h-72 overflow-y-auto">
            {error && (
              <div className="px-3 py-2 text-xs text-red-600">{error}</div>
            )}
            {results.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handlePick(item)}
                className={cn(
                  'w-full text-left px-3 py-2 text-sm hover:bg-indigo-50 flex items-center justify-between gap-3',
                  value === item.id && 'bg-indigo-50',
                )}
              >
                <span className="truncate">
                  <span className="font-medium text-slate-900">{item.nombreCanonico}</span>
                  <span className="text-slate-500 ml-1">({item.unidad})</span>
                </span>
                <span className={cn(
                  'text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded',
                  item.tipo === 'material' ? 'bg-indigo-100 text-indigo-700' : 'bg-blue-100 text-blue-700',
                )}>
                  {item.tipo}
                </span>
              </button>
            ))}
            {showCreateCTA && (
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="w-full text-left px-3 py-2 text-sm border-t border-slate-100 text-indigo-600 hover:bg-indigo-50 flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                Crear nuevo: <span className="font-medium">{query.trim()}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {createOpen && (
        <QuickCreateDrawer
          key={query.trim()}
          open={createOpen}
          initialName={query.trim()}
          onClose={() => setCreateOpen(false)}
          onCreated={handleCreated}
        />
      )}
    </>
  );
}

// --- Mini-drawer interno para crear un item rápido desde el autocomplete ---

interface QuickCreateProps {
  open: boolean;
  initialName: string;
  onClose: () => void;
  onCreated: (item: AutocompleteItem) => void;
}

function QuickCreateDrawer({ open, initialName, onClose, onCreated }: QuickCreateProps) {
  const { showToast } = useToast();
  const qc = useQueryClient();
  const [tipo, setTipo] = useState<ItemTipo>('material');
  // initialName se reinicia cada vez que el padre cambia el `key` del Drawer.
  const [nombre, setNombre] = useState(initialName);
  const [unidad, setUnidad] = useState<string>('unidad');
  const [alias, setAlias] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldErrors({});
    if (!nombre.trim()) {
      setFieldErrors({ nombreCanonico: 'Requerido' });
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        tipo,
        nombreCanonico: nombre.trim(),
        unidad,
      };
      const aliasList = alias.split('\n').map((s) => s.trim()).filter(Boolean);
      if (aliasList.length) body.alias = aliasList;

      const created = await api.post<{
        id: number; nombreCanonico: string; unidad: string; tipo: ItemTipo;
      }>('/items-catalogo', body);
      qc.invalidateQueries({ queryKey: ['items-catalogo'] });
      showToast('Item creado correctamente');
      onCreated({
        id: created.id,
        nombreCanonico: created.nombreCanonico,
        unidad: created.unidad,
        tipo: created.tipo,
      });
    } catch (e) {
      const err = e as ApiError;
      if (err.details && typeof err.details === 'object') {
        const fe: Record<string, string> = {};
        for (const [k, v] of Object.entries(err.details as Record<string, unknown>)) {
          fe[k] = Array.isArray(v) ? String(v[0]) : String(v);
        }
        setFieldErrors(fe);
      } else {
        showToast(err.message || 'Error al crear', 'error');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Crear item rápido"
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</Button>
          <Button type="submit" form="quick-create-item" disabled={submitting}>
            {submitting ? 'Guardando...' : 'Crear'}
          </Button>
        </div>
      }
    >
      <form id="quick-create-item" onSubmit={handleSubmit} className="space-y-4">
        <Field label="Tipo" required>
          <Select value={tipo} onChange={(e) => setTipo(e.target.value as ItemTipo)}>
            <option value="material">Material</option>
            <option value="servicio">Servicio</option>
          </Select>
        </Field>
        <Field label="Nombre canónico" required error={fieldErrors.nombreCanonico}>
          <Input value={nombre} onChange={(e) => setNombre(e.target.value)} autoFocus />
        </Field>
        <Field label="Unidad" required error={fieldErrors.unidad}>
          <Select value={unidad} onChange={(e) => setUnidad(e.target.value)}>
            {UNIDADES.map((u) => <option key={u} value={u}>{u}</option>)}
          </Select>
        </Field>
        <Field label="Alias" hint="Uno por línea para autocomplete" error={fieldErrors.alias}>
          <Textarea value={alias} onChange={(e) => setAlias(e.target.value)} rows={3} />
        </Field>
      </form>
    </Drawer>
  );
}
