import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import { ThemeProvider } from './context/ThemeContext';
import Layout from './components/Layout';
import PrivateRoute from './components/PrivateRoute';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';

import Obras from './pages/Obras';
import ObraDetail from './pages/ObraDetail';
import Bodegas from './pages/Bodegas';
import Proveedores from './pages/Proveedores';
import Catalogo from './pages/Catalogo';
import Cotizaciones from './pages/Cotizaciones';
import CotizacionForm from './pages/CotizacionForm';
import CotizacionDetail from './pages/CotizacionDetail';
import OCs from './pages/OCs';
import OcDetail from './pages/OcDetail';
import Facturas from './pages/Facturas';
import FacturaDetail from './pages/FacturaDetail';

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeProvider>
          <ToastProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/login" element={<Login />} />

                <Route element={<PrivateRoute />}>
                  <Route element={<Layout />}>
                    <Route path="/" element={<Dashboard />} />

                    <Route path="/obras" element={<Obras />} />
                    <Route path="/obras/:id" element={<ObraDetail />} />
                    <Route path="/bodegas" element={<Bodegas />} />
                    <Route path="/proveedores" element={<Proveedores />} />
                    <Route path="/catalogo" element={<Catalogo />} />

                    <Route path="/cotizaciones" element={<Cotizaciones />} />
                    <Route path="/cotizaciones/new" element={<CotizacionForm />} />
                    <Route path="/cotizaciones/:id" element={<CotizacionDetail />} />
                    <Route path="/cotizaciones/:id/edit" element={<CotizacionForm />} />

                    <Route path="/ocs" element={<OCs />} />
                    <Route path="/ocs/:id" element={<OcDetail />} />

                    <Route path="/facturas" element={<Facturas />} />
                    <Route path="/facturas/:id" element={<FacturaDetail />} />
                  </Route>
                </Route>

                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </BrowserRouter>
          </ToastProvider>
        </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
