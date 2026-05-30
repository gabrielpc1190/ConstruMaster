import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'node:path';
import 'dotenv/config';

// Prisma BigInt IDs need an explicit JSON serializer. Values < 2^53 fit Number safely.
BigInt.prototype.toJSON = function () { return Number(this); };

import authRoutes from './routes/auth.routes.js';
import obrasRoutes from './routes/obras.routes.js';
import bodegasRoutes from './routes/bodegas.routes.js';
import clientesRoutes from './routes/clientes.routes.js';
import usersRoutes from './routes/users.routes.js';
import proveedoresRoutes from './routes/proveedores.routes.js';
import itemsCatalogoRoutes from './routes/items-catalogo.routes.js';
import cotizacionesRoutes from './routes/cotizaciones.routes.js';
import ocsRoutes from './routes/ocs.routes.js';
import facturasRoutes from './routes/facturas.routes.js';
import { pagosRouter, pagosOcRouter } from './routes/pagos.routes.js';
import entregasRoutes, { entregasUnderOcs } from './routes/entregas.routes.js';
import exchangeRatesRoutes from './routes/exchange-rates.routes.js';
import auditLogRoutes from './routes/audit-log.routes.js';
import rfqsRoutes from './routes/rfqs.routes.js';
import reportesRoutes from './routes/reportes.routes.js';
import { startBccrCron } from './cron/bccr-daily.js';
import prisma from './db.js';
import { errorHandler } from './middleware/errorHandler.js';
import { isQueueReady } from './queues/factura-queue.js';

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
app.use('/api/clientes', clientesRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/proveedores', proveedoresRoutes);
app.use('/api/items-catalogo', itemsCatalogoRoutes);
app.use('/api/cotizaciones', cotizacionesRoutes);
app.use('/api/ocs', ocsRoutes);
app.use('/api/ocs', pagosOcRouter);
app.use('/api/ocs', entregasUnderOcs);
app.use('/api/pagos', pagosRouter);
app.use('/api/entregas', entregasRoutes);
app.use('/api/facturas', facturasRoutes);
app.use('/api/exchange-rates', exchangeRatesRoutes);
app.use('/api/audit-log', auditLogRoutes);
app.use('/api/rfqs', rfqsRoutes);
app.use('/api/reportes', reportesRoutes);

// Production: serve the Vite-built SPA from dist/ in the same process as the
// API. This block MUST sit after all /api/* routers (otherwise the SPA fallback
// would swallow API requests) and before the 404 handler (otherwise the 404
// would beat the fallback). In dev, Vite serves the frontend on :8000 with a
// proxy to :3001, so we skip this entirely.
if (process.env.NODE_ENV === 'production') {
  const distPath = path.resolve('dist');
  // Hashed asset filenames -> immutable + long-lived cache. index.html is
  // served by the SPA fallback below with default no-cache behavior so users
  // pick up new bundle hashes on the next navigation.
  app.use(express.static(distPath, { index: false, maxAge: '1y', immutable: true }));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
}

app.use((req, res, _next) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  // El estado real de Redis es asíncrono (el 'ready' del ioredis llega después).
  // Acá solo reportamos si la queue se inicializó (es decir, si REDIS_URL está).
  // Si la queue está inicializada pero Redis aún no respondió, el log dirá
  // "redis missing" — se actualiza correctamente en el primer 'ready' event.
  // En modo sync (REDIS_URL vacío) confirmamos que las facturas se procesan inline.
  const hasRedisUrl = Boolean(process.env.REDIS_URL && process.env.REDIS_URL.trim());
  console.log(`[server] queue: ${hasRedisUrl ? (isQueueReady() ? 'redis ok' : 'redis configured (connecting)') : 'redis missing (sync mode)'}`);
  startBccrCron(prisma);
});
