import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, AUTH_UNAUTHORIZED_EVENT } from '../services/api';

export type Role = 'admin' | 'supervisor' | 'operativo' | 'lector';

export interface User {
  id: number;
  username: string;
  fullName?: string | null;
  email?: string | null;
  role: Role;
}

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Administrador',
  supervisor: 'Supervisor',
  operativo: 'Operativo',
  lector: 'Lector',
};

export const WRITE_ROLES: Role[] = ['admin', 'supervisor'];
export const CATALOG_WRITE_ROLES: Role[] = ['admin', 'supervisor', 'operativo'];

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (token: string, user: User) => void;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const init = async () => {
      const stored = localStorage.getItem('token');
      if (stored) {
        try {
          const userData = await api.get('/auth/me');
          setUser(userData);
          setToken(stored);
        } catch {
          localStorage.removeItem('token');
          setToken(null);
          setUser(null);
        }
      }
      setIsLoading(false);
    };
    init();
  }, []);

  useEffect(() => {
    const handler = () => {
      localStorage.removeItem('token');
      setToken(null);
      setUser(null);
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    };
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handler);
    return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handler);
  }, []);

  const login = (newToken: string, newUser: User) => {
    localStorage.setItem('token', newToken);
    setToken(newToken);
    setUser(newUser);
  };

  const logout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
    window.location.href = '/login';
  };

  return (
    <AuthContext.Provider value={{ user, token, login, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
