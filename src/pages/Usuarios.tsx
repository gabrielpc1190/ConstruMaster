import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Shield, Plus, KeyRound, UserMinus } from 'lucide-react';
import { useList } from '../hooks/useApi';
import { api, type ApiError } from '../services/api';
import { PageHeader } from '../components/ui/PageHeader';
import { Button } from '../components/ui/Button';
import { Input, Select, Field } from '../components/ui/Input';
import { Table } from '../components/ui/Table';
import { Drawer } from '../components/ui/Drawer';
import { Badge } from '../components/ui/Badge';
import { useToast } from '../context/ToastContext';
import { ROLE_LABEL, type Role } from '../context/AuthContext';
import { formatDate } from '../lib/format';

interface User {
  id: number;
  username: string;
  fullName: string | null;
  email: string | null;
  role: Role;
  isActive: boolean;
  createdAt: string;
}

const ROLE_TONES: Record<Role, 'indigo' | 'blue' | 'emerald' | 'slate'> = {
  admin: 'indigo', supervisor: 'blue', operativo: 'emerald', lector: 'slate',
};

export default function Usuarios() {
  const qc = useQueryClient();
  const toast = useToast();
  const users = useList<User>(['users'], '/users');
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ username: '', fullName: '', email: '', role: 'operativo' as Role });
  const [lastPwd, setLastPwd] = useState<{ user: string; pwd: string } | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    setPending(true);
    try {
      const created: User & { passwordPlain?: string } = await api.post('/users', {
        username: form.username,
        fullName: form.fullName || undefined,
        email: form.email || undefined,
        role: form.role,
      });
      toast.showToast('Usuario creado', 'success');
      if (created.passwordPlain) setLastPwd({ user: created.username, pwd: created.passwordPlain });
      setForm({ username: '', fullName: '', email: '', role: 'operativo' });
      setCreateOpen(false);
      qc.invalidateQueries({ queryKey: ['users'] });
    } catch (err) {
      const e = err as ApiError;
      toast.showToast(e.message || 'Error creando usuario', 'error');
    } finally {
      setPending(false);
    }
  };

  const reset = async (u: User) => {
    if (!confirm(`Resetear password de ${u.username}? Se generará una nueva.`)) return;
    try {
      const r: { passwordPlain?: string } = await api.post(`/users/${u.id}/reset-password`, {});
      if (r.passwordPlain) setLastPwd({ user: u.username, pwd: r.passwordPlain });
      toast.showToast(`Password de ${u.username} reseteada`, 'success');
    } catch (err) {
      toast.showToast((err as ApiError).message || 'Error reseteando password', 'error');
    }
  };

  const deactivate = async (u: User) => {
    if (!confirm(`Desactivar ${u.username}? Ya no podrá entrar.`)) return;
    try {
      await api.post(`/users/${u.id}/deactivate`, {});
      toast.showToast(`${u.username} desactivado`, 'success');
      qc.invalidateQueries({ queryKey: ['users'] });
    } catch (err) {
      toast.showToast((err as ApiError).message || 'Error', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Usuarios"
        subtitle="Gestión de cuentas y roles. Solo administradores."
        actions={<Button onClick={() => setCreateOpen(true)}><Plus className="w-4 h-4" /> Nuevo usuario</Button>}
      />

      {lastPwd && (
        <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3 text-sm text-amber-900 flex items-start gap-2">
          <Shield className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="flex-1">
            <strong>Password generada para {lastPwd.user}:</strong>{' '}
            <code className="font-mono bg-white px-2 py-0.5 rounded ring-1 ring-amber-200">{lastPwd.pwd}</code>
            <p className="text-xs mt-1">Copialo ya. No se vuelve a mostrar.</p>
          </div>
          <button onClick={() => setLastPwd(null)} className="text-amber-600 hover:text-amber-900">×</button>
        </div>
      )}

      <Table<User>
        rowKey={(u) => u.id}
        loading={users.isLoading}
        rows={users.data ?? []}
        empty="Sin usuarios."
        columns={[
          { key: 'username', header: 'Usuario', cell: (u) => <span className="font-medium">{u.username}</span> },
          { key: 'fullName', header: 'Nombre', cell: (u) => u.fullName ?? '—' },
          { key: 'email', header: 'Email', cell: (u) => u.email ?? '—' },
          { key: 'role', header: 'Rol', cell: (u) => <Badge tone={ROLE_TONES[u.role]}>{ROLE_LABEL[u.role]}</Badge> },
          { key: 'createdAt', header: 'Alta', cell: (u) => <span className="text-slate-500">{formatDate(u.createdAt)}</span> },
          {
            key: 'actions', header: '', align: 'right',
            cell: (u) => (
              <div className="flex items-center gap-1 justify-end">
                <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); reset(u); }} title="Resetear password">
                  <KeyRound className="w-4 h-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); deactivate(u); }} title="Desactivar">
                  <UserMinus className="w-4 h-4 text-red-600" />
                </Button>
              </div>
            ),
          },
        ]}
      />

      <Drawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Nuevo usuario"
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancelar</Button>
            <Button onClick={submit} disabled={!form.username || pending}>{pending ? 'Creando…' : 'Crear'}</Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Field label="Username" required hint="Mínimo 2 chars, alfanumérico. Ej: 'diana'">
            <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} autoFocus />
          </Field>
          <Field label="Nombre completo">
            <Input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          </Field>
          <Field label="Email">
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label="Rol" required>
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              <option value="admin">Administrador</option>
              <option value="supervisor">Supervisor</option>
              <option value="operativo">Operativo</option>
              <option value="lector">Lector</option>
            </Select>
          </Field>
          <p className="text-xs text-slate-500">
            La password se genera automáticamente y se muestra una sola vez al crear.
          </p>
        </div>
      </Drawer>
    </div>
  );
}
