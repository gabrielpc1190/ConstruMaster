import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import 'dotenv/config';

// Prisma BigInt IDs need an explicit JSON serializer. Values < 2^53 fit Number safely.
BigInt.prototype.toJSON = function () { return Number(this); };

import authRoutes from './routes/auth.routes.js';
import obrasRoutes from './routes/obras.routes.js';
import bodegasRoutes from './routes/bodegas.routes.js';
import proveedoresRoutes from './routes/proveedores.routes.js';
import itemsCatalogoRoutes from './routes/items-catalogo.routes.js';
import cotizacionesRoutes from './routes/cotizaciones.routes.js';
import ocsRoutes from './routes/ocs.routes.js';
import facturasRoutes from './routes/facturas.routes.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()) || 'http://localhost:8000',
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/obras', obrasRoutes);
app.use('/api/bodegas', bodegasRoutes);
app.use('/api/proveedores', proveedoresRoutes);
app.use('/api/items-catalogo', itemsCatalogoRoutes);
app.use('/api/cotizaciones', cotizacionesRoutes);
app.use('/api/ocs', ocsRoutes);
app.use('/api/facturas', facturasRoutes);

app.use((req, res, _next) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
