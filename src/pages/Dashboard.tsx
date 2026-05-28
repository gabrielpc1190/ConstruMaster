import { Building2, FileText, CreditCard, Receipt } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface Stat {
  label: string;
  value: number | string;
  icon: LucideIcon;
  color: string;
}

const stats: Stat[] = [
  { label: 'Obras', value: 0, icon: Building2, color: 'bg-indigo-500' },
  { label: 'Cotizaciones', value: 0, icon: FileText, color: 'bg-emerald-500' },
  { label: 'Pagos', value: 0, icon: CreditCard, color: 'bg-amber-500' },
  { label: 'Facturas', value: 0, icon: Receipt, color: 'bg-rose-500' },
];

export default function Dashboard() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-gray-800 dark:text-white">Dashboard</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Sin datos todavía — sistema recién migrado.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div
              key={stat.label}
              className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-gray-500 dark:text-gray-400 text-sm font-medium">{stat.label}</p>
                  <p className="text-3xl font-bold text-gray-900 dark:text-white mt-2">{stat.value}</p>
                </div>
                <div className={`${stat.color} p-3 rounded-lg text-white`}>
                  <Icon className="w-6 h-6" />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
        <h2 className="text-lg font-bold text-gray-800 dark:text-white mb-2">Bienvenido a ConstruMaster v2</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Esta es la fase inicial del rewrite. Los módulos de Obras, Cotizaciones, Pagos y Facturas se irán habilitando
          en fases siguientes a medida que se porte la lógica de negocio desde la versión anterior.
        </p>
      </div>
    </div>
  );
}
