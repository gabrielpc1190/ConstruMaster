import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Home, Building2, Warehouse, Users, Package,
  FileSearch, FileText, ClipboardList, CreditCard,
  Receipt, Truck, TrendingUp, BarChart3,
  Shield, Settings, Database,
  LogOut, Sun, Moon, HardHat,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';

interface NavItem {
  path: string;
  icon: LucideIcon;
  label: string;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();

  const navGroups: NavGroup[] = [
    {
      title: 'Gestión',
      items: [
        { path: '/', icon: Home, label: 'Inicio' },
        { path: '/obras', icon: Building2, label: 'Obras' },
        { path: '/bodegas', icon: Warehouse, label: 'Bodegas' },
        { path: '/proveedores', icon: Users, label: 'Proveedores' },
        { path: '/catalogo', icon: Package, label: 'Catálogo' },
      ],
    },
    {
      title: 'Compras',
      items: [
        { path: '/rfqs', icon: FileSearch, label: 'Solicitudes' },
        { path: '/cotizaciones', icon: FileText, label: 'Cotizaciones' },
        { path: '/ocs', icon: ClipboardList, label: 'Órdenes de compra' },
        { path: '/pagos', icon: CreditCard, label: 'Pagos' },
      ],
    },
    {
      title: 'Operación',
      items: [
        { path: '/facturas', icon: Receipt, label: 'Facturas' },
        { path: '/entregas', icon: Truck, label: 'Entregas' },
      ],
    },
    {
      title: 'Reportes',
      items: [
        { path: '/tipo-cambio', icon: TrendingUp, label: 'Tipo de cambio' },
        { path: '/reportes', icon: BarChart3, label: 'Reportes' },
      ],
    },
  ];

  if (user?.role === 'admin') {
    navGroups.push({
      title: 'Sistema',
      items: [
        { path: '/usuarios', icon: Shield, label: 'Usuarios' },
        { path: '/configuracion', icon: Settings, label: 'Configuración' },
        { path: '/respaldos', icon: Database, label: 'Respaldos' },
      ],
    });
  }

  const roleLabel: Record<string, string> = {
    admin: 'Administrador', supervisor: 'Supervisor',
    operativo: 'Operativo', lector: 'Lector',
  };

  const currentPath = location.pathname;

  return (
    <div className="flex min-h-screen bg-gray-50 dark:bg-gray-900 transition-colors duration-200">
      <aside className="hidden lg:flex flex-col w-64 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 fixed inset-y-0 left-0 z-30 transition-colors duration-200">
        <div className="p-6 border-b border-gray-100 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-600 rounded-lg">
              <HardHat className="w-6 h-6 text-white" />
            </div>
            <span className="text-xl font-bold text-gray-900 dark:text-white">ConstruMaster</span>
          </div>
        </div>

        <nav className="flex-1 px-4 py-6 space-y-8 overflow-y-auto">
          {navGroups.map((group) => (
            <div key={group.title}>
              <h3 className="px-2 mb-4 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                {group.title}
              </h3>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = currentPath === item.path;
                  return (
                    <button
                      key={item.path}
                      onClick={() => navigate(item.path)}
                      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                        isActive
                          ? 'bg-indigo-50 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400'
                          : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-200'
                      }`}
                    >
                      <Icon className="w-5 h-5" />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="p-4 border-t border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800">
          <button
            onClick={toggleTheme}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-200 transition-colors mb-2"
          >
            {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            {theme === 'dark' ? 'Modo Claro' : 'Modo Oscuro'}
          </button>

          <div className="flex items-center gap-3 px-3 py-2">
            <div className="w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-900 flex items-center justify-center text-indigo-600 dark:text-indigo-400 font-medium">
              {user?.username?.charAt(0).toUpperCase() || 'U'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                {user?.fullName || user?.username || 'Usuario'}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                {roleLabel[user?.role ?? ''] || 'Usuario'}
              </p>
            </div>
            <button
              onClick={logout}
              className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              title="Cerrar sesión"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 lg:pl-64 transition-all duration-300">
        <main className="flex-1 p-4 md:p-6 overflow-y-auto pb-24 md:pb-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
