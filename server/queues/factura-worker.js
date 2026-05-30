/**
 * Worker BullMQ para procesar facturas (XML + OCR) async.
 *
 * Proceso separado del web server. Arranca con:
 *   node server/queues/factura-worker.js
 *   ./manage.sh worker   # alias dev/prod
 *
 * Diseño:
 *  - Usa la misma conexión Redis singleton que `factura-queue.js`.
 *  - Si `REDIS_URL` no está seteado, el worker loguea y exit(0). No retry loop.
 *  - Concurrency configurable via `WORKER_CONCURRENCY` (default 2).
 *  - Retry: `defaultJobOptions.attempts = 3` (1 + 2 reintentos), backoff
 *    exponencial 5s/30s (definido en factura-queue.js).
 *  - Errores permanentes (`XmlSyntaxError`, `UnknownComprobanteError`, `OCRError`)
 *    deben ser señalizados con `UnrecoverableError` de BullMQ para NO reintentar.
 *    Sin embargo, el processor YA captura esos errores y devuelve la factura
 *    en `status='error'` (no re-lanza) — el worker considera el job exitoso.
 *    Solo si pasa algo inesperado (DB caída, etc), el job falla y BullMQ
 *    reintenta con backoff.
 *
 *  Logs prefijados con `[worker-factura]`.
 *
 *  Shutdown limpio en SIGTERM/SIGINT (espera jobs en curso).
 */
import 'dotenv/config';
import { Worker, UnrecoverableError } from 'bullmq';

import prisma from '../db.js';
import { processFacturaXml, processFacturaImagen } from '../services/factura-processor.js';
import { QUEUE_NAME, getConnection, shutdownQueue } from './factura-queue.js';

function log(msg, ...rest) {
  console.log(`[worker-factura] ${msg}`, ...rest);
}
function warn(msg, ...rest) {
  console.warn(`[worker-factura] ${msg}`, ...rest);
}
function error(msg, ...rest) {
  console.error(`[worker-factura] ${msg}`, ...rest);
}

async function main() {
  if (!process.env.REDIS_URL || !process.env.REDIS_URL.trim()) {
    warn('Redis no disponible (REDIS_URL vacío), saliendo. Las facturas se procesan inline desde el web server.');
    process.exit(0);
  }

  const connection = getConnection();
  if (!connection) {
    error('No se pudo inicializar la conexión Redis');
    process.exit(1);
  }

  const concurrency = Number(process.env.WORKER_CONCURRENCY) || 2;
  log(`arrancando worker (concurrency=${concurrency}, queue=${QUEUE_NAME})`);

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { facturaId, kind } = job.data || {};
      log(`job ${job.id} → facturaId=${facturaId} kind=${kind} attempt=${job.attemptsMade + 1}`);
      if (!facturaId || !kind) {
        throw new UnrecoverableError(`job ${job.id} sin facturaId/kind: ${JSON.stringify(job.data)}`);
      }
      try {
        if (kind === 'xml') {
          const result = await processFacturaXml(prisma, facturaId);
          log(`job ${job.id} → factura ${facturaId} terminada con status=${result.status}`);
          return { facturaId: String(result.id), status: result.status };
        }
        if (kind === 'imagen') {
          const result = await processFacturaImagen(prisma, facturaId);
          log(`job ${job.id} → factura ${facturaId} terminada con status=${result.status}`);
          return { facturaId: String(result.id), status: result.status };
        }
        throw new UnrecoverableError(`job ${job.id} kind desconocido: ${kind}`);
      } catch (err) {
        // Errores permanentes ya fueron interceptados por el processor (status=error).
        // Si llegamos acá es por un bug o un transient (DB down). Dejamos que
        // BullMQ haga retry según `attempts` + backoff.
        // Solo señalizamos `UnrecoverableError` cuando estamos seguros de que
        // reintentar no sirve (ej. facturaId inválido — ya cubierto arriba).
        if (err.code === 'NOT_FOUND' || err.code === 'WRONG_SOURCE') {
          throw new UnrecoverableError(err.message);
        }
        throw err;
      }
    },
    {
      connection,
      concurrency,
    },
  );

  worker.on('completed', (job, result) => {
    log(`job ${job.id} ✓ completed (factura ${result?.facturaId} status=${result?.status})`);
  });
  worker.on('failed', (job, err) => {
    const attempts = job?.attemptsMade ?? '?';
    if (err instanceof UnrecoverableError) {
      warn(`job ${job?.id} ✗ unrecoverable: ${err.message}`);
    } else {
      warn(`job ${job?.id} ✗ failed (attempt ${attempts}): ${err.message}`);
    }
  });
  worker.on('error', (err) => {
    error('worker error:', err.message);
  });

  // Shutdown limpio
  const shutdown = async (signal) => {
    log(`recibido ${signal}, cerrando worker...`);
    try {
      await worker.close();
      await shutdownQueue();
      await prisma.$disconnect();
    } catch (err) {
      error('error durante shutdown:', err.message);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  error('fatal:', err);
  process.exit(1);
});
