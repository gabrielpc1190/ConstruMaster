/**
 * BullMQ queue para procesamiento async de facturas (XML + OCR).
 *
 * Opt-in via env `REDIS_URL`. Si la env está vacía/no definida, este módulo
 * NO se conecta a Redis y `enqueueFacturaParse` queda como **no-op que retorna
 * null**. El controller upstream chequea ese null y cae al path síncrono
 * (parsing/OCR inline en el mismo request).
 *
 * Esto da backwards compat 100% — el deployment existente (sin Redis) sigue
 * funcionando exactamente igual.
 *
 * Decisiones:
 *  - Connection singleton (BullMQ recomienda reutilizar). `maxRetriesPerRequest`
 *    debe ser `null` para que BullMQ pueda bloquear lpop con tiempo infinito.
 *  - El worker NO se arranca acá — vive en `factura-worker.js` como proceso
 *    separado. Este módulo solo expone la *interfaz de productor*.
 *  - `isQueueReady()` permite al startup loguear el estado sin tirar.
 */
import IORedis from 'ioredis';
import { Queue } from 'bullmq';

export const QUEUE_NAME = 'factura-process';

// Singleton state. Inicializa lazy en `init()` para evitar conexiones
// accidentales al importar el módulo en tests.
let connection = null;
let queue = null;
let ready = false;

function getRedisUrl() {
  const url = process.env.REDIS_URL;
  return url && url.trim() ? url.trim() : null;
}

/**
 * Crea (idempotentemente) el cliente ioredis y la Queue de BullMQ.
 * Si REDIS_URL no está seteado, no hace nada.
 */
function init() {
  if (queue || !getRedisUrl()) return;
  const url = getRedisUrl();
  connection = new IORedis(url, {
    // BullMQ requiere `maxRetriesPerRequest: null` para que los blocking calls
    // del worker no se cancelen tras los reintentos default.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  connection.on('ready', () => {
    ready = true;
    console.log('[queue] redis ready');
  });
  connection.on('error', (err) => {
    ready = false;
    console.warn('[queue] redis error:', err.message);
  });
  connection.on('end', () => {
    ready = false;
  });
  queue = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3, // 1 inicial + 2 reintentos (se controla en el worker con UnrecoverableError)
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 60 * 60 * 24, count: 1000 }, // 24h o 1000 jobs
      removeOnFail: { age: 60 * 60 * 24 * 7 }, // 7 días para diagnóstico
    },
  });
}

/**
 * Devuelve la Queue (o null si REDIS_URL no está). Útil para el worker.
 */
export function getQueue() {
  init();
  return queue;
}

/**
 * Devuelve la conexión ioredis (o null). Útil para el worker que necesita
 * la misma conexión.
 */
export function getConnection() {
  init();
  return connection;
}

/**
 * True si la queue está inicializada Y la conexión Redis está lista.
 * Llamala en el startup para loguear el estado.
 */
export function isQueueReady() {
  init();
  return Boolean(queue && ready);
}

/**
 * Encola un job de procesamiento de factura.
 *
 * @param {{ facturaId: bigint|number|string, kind: 'xml'|'imagen' }} payload
 * @returns {Promise<{ id: string } | null>} `null` si la queue no está
 *          configurada (Redis no disponible). El caller debe caer al path
 *          síncrono cuando recibe null.
 */
export async function enqueueFacturaParse(payload) {
  init();
  if (!queue) return null;
  if (!payload || !payload.facturaId || !payload.kind) {
    throw new Error('enqueueFacturaParse: facturaId y kind son requeridos');
  }
  if (payload.kind !== 'xml' && payload.kind !== 'imagen') {
    throw new Error(`enqueueFacturaParse: kind inválido "${payload.kind}"`);
  }
  // BigInt no es serializable en JSON (Redis); convertimos a string.
  const facturaId = String(payload.facturaId);
  const job = await queue.add(
    `factura-${payload.kind}-${facturaId}`,
    { facturaId, kind: payload.kind },
    {
      // jobId determinístico evita duplicados si el cliente reintenta.
      jobId: `factura:${payload.kind}:${facturaId}`,
    },
  );
  return { id: job.id };
}

/**
 * Cierra la queue + conexión (para shutdown limpio o tests).
 */
export async function shutdownQueue() {
  if (queue) {
    await queue.close().catch(() => {});
    queue = null;
  }
  if (connection) {
    await connection.quit().catch(() => {});
    connection = null;
  }
  ready = false;
}
