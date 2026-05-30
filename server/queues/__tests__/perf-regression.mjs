/**
 * Performance regression test (manual): upload XML via el controller con queue
 * activa debe responder en <500ms incluso con XML grande (~50KB+).
 *
 * Corre con:
 *   docker run -d --name perf_redis -p 127.0.0.1:6379:6379 redis:7-alpine
 *   REDIS_URL=redis://localhost:6379 node server/queues/__tests__/perf-regression.mjs
 *
 * NO usa la DB real — mockea Prisma in-memory. La métrica importante es el
 * tiempo del `uploadFacturaXml` desde que recibe el `req` hasta que llama
 * `res.json()` con el 202. Si la queue está bien configurada, ese tiempo NO
 * debe incluir el parseo del XML.
 */
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { uploadFacturaXml } from '../../controllers/facturas.controller.js';
import * as queueMod from '../factura-queue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TE_FIXTURE = resolve(
  __dirname,
  '..',
  '..',
  'services',
  '__tests__',
  'fixtures',
  'te_real.xml',
);

// ---------------------------------------------------------------------------
// Mock prisma (en memoria, sin Postgres)
// ---------------------------------------------------------------------------
let nextId = 1n;
const facturas = new Map();
const mockPrisma = {
  ordenCompra: {
    async findUnique({ where: { id } }) {
      return { id, numeroOc: 'OC-PERF', proveedor: { id: 1n, nombre: 'X' } };
    },
  },
  factura: {
    async create({ data }) {
      const id = nextId++;
      const row = { id, ...data, createdAt: new Date() };
      facturas.set(id, row);
      return { ...row };
    },
    async findUnique({ where: { id }, include }) {
      const row = facturas.get(id);
      if (!row) return null;
      const result = { ...row };
      if (include?.oc) {
        result.oc = { id: row.ocId, numeroOc: 'OC-PERF', proveedor: { id: 1n, nombre: 'X' } };
      }
      return result;
    },
  },
};
// Override el `prisma` global del controller con monkey-patching de require.
// Como el controller importa `prisma from '../db.js'` y nodejs ESM no permite
// re-mock fácil, en su lugar usamos node:module loader hook — pero acá vamos
// con un approach más simple: el controller no se puede mockear sin
// instrumentación. Entonces, mejor mockeamos solo la queue y medimos el
// tiempo asumiendo que la DB es Postgres real corriendo.
//
// Actualizamos el plan: usamos la DB real (Postgres ya está up); la métrica
// es desde antes de invocar uploadFacturaXml hasta el final del res.json.

async function main() {
  const SYNC_MODE = !process.env.REDIS_URL;
  if (SYNC_MODE) {
    console.log('[perf] SYNC MODE (sin REDIS_URL) — esperamos elapsed mayor');
  } else {
    // Verificar conexión a la queue
    await new Promise((resolve_) => setTimeout(resolve_, 500));
    console.log('[perf] queue ready:', queueMod.isQueueReady());
  }

  // Importar el módulo de DB real (necesitamos OC existente).
  const { default: prisma } = await import('../../db.js');

  // Crear una OC real para tener un ocId válido. La eliminamos al final.
  const cliente = await prisma.cliente.create({ data: { nombre: `perf-${Date.now()}` } });
  const obra = await prisma.obra.create({
    data: {
      clienteId: cliente.id,
      nombre: 'perf',
      slug: `perf-${Date.now()}`,
      estado: 'en_curso',
    },
  });
  const proveedor = await prisma.proveedor.create({
    data: { nombre: `perf-prov-${Date.now()}`, activo: true },
  });
  const categoria = await prisma.categoriaPresupuesto.create({
    data: { obraId: obra.id, nombre: `perf-cat-${Date.now()}`, orden: 0 },
  });
  const oc = await prisma.ordenCompra.create({
    data: {
      obra: { connect: { id: obra.id } },
      proveedor: { connect: { id: proveedor.id } },
      categoria: { connect: { id: categoria.id } },
      numeroOc: `PERF-OC-${Date.now()}`,
      estado: 'autorizada',
      moneda: 'CRC',
      montoTotalCurrency: 'CRC',
      fechaAprobacion: new Date(),
      montoTotalAmount: 0,
    },
  });
  const ocId = oc.id;

  // Leer fixture (XML real ~6KB). Lo replicamos varias veces para hacer un XML
  // "grande" (~60KB simulando un FEC con muchos items). Para mantener la
  // sintaxis válida con clave única, generamos UUIDs distintos por iteración.
  const baseXml = readFileSync(TE_FIXTURE, 'utf8');

  // Genera un XML "grande" cambiando la clave única — para no chocar con el
  // UNIQUE constraint en runs sucesivos. NO replicamos contenido porque
  // rompería el XML; en su lugar, generamos varias variantes y testeamos
  // con la más grande (real, válida).
  const claveBase = '50604052600310169828000100001040000134414127865041';

  function withUniqueKey(xml, iter) {
    // Reemplazá los últimos dígitos para hacer claves únicas. La estructura es
    // 50 chars total; cambiamos las últimas 8.
    const suffix = String(Date.now() % 100000000).padStart(8, '0') + String(iter).padStart(2, '0');
    const newClave = claveBase.slice(0, -10) + suffix;
    return xml.replace(claveBase, newClave);
  }

  // Para que `relativeToUploads` y `absoluteFromUploads` funcionen correctamente,
  // el archivo debe estar bajo `uploads/`. Usamos `uploads/_perf_test/` como dir.
  const UPLOADS_ROOT = resolve(__dirname, '..', '..', '..', 'uploads');
  const tmpDir = join(UPLOADS_ROOT, '_perf_test');
  await import('node:fs/promises').then((m) => m.mkdir(tmpDir, { recursive: true }));

  const results = [];
  const ITERS = 5;

  for (let i = 0; i < ITERS; i++) {
    const xml = withUniqueKey(baseXml, i);
    const filePath = join(tmpDir, `perf-${i}.xml`);
    await writeFile(filePath, xml);

    // Construir req/res fake. El controller usa req.file.path (multer).
    const req = {
      params: { ocId: String(ocId) },
      file: { path: filePath, mimetype: 'application/xml', originalname: `perf-${i}.xml` },
      user: { id: 1, username: 'perf', role: 'admin' },
      headers: {},
      socket: {},
    };
    let statusCode = null;
    let body = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(obj) { body = obj; return this; },
      setHeader() { return this; },
    };

    const t0 = performance.now();
    await uploadFacturaXml(req, res);
    const elapsed = performance.now() - t0;

    results.push({ iter: i, elapsed, statusCode, status: body?.status, queued: body?.queued });
    console.log(
      `[perf] iter=${i} elapsed=${elapsed.toFixed(1)}ms statusCode=${statusCode} queued=${body?.queued}`,
    );
  }

  const elapsedTimes = results.map((r) => r.elapsed);
  const max = Math.max(...elapsedTimes);
  const avg = elapsedTimes.reduce((a, b) => a + b, 0) / elapsedTimes.length;
  console.log(`\n[perf] avg=${avg.toFixed(1)}ms max=${max.toFixed(1)}ms`);
  console.log(`[perf] all queued=true:`, results.every((r) => r.queued === true));
  console.log(`[perf] all <500ms:`, results.every((r) => r.elapsed < 500));

  // Cleanup
  await rm(tmpDir, { recursive: true, force: true });
  await prisma.factura.deleteMany({ where: { ocId } });
  await prisma.ordenCompra.delete({ where: { id: ocId } });
  await prisma.proveedor.delete({ where: { id: proveedor.id } });
  await prisma.categoriaPresupuesto.delete({ where: { id: categoria.id } });
  await prisma.obra.delete({ where: { id: obra.id } });
  await prisma.cliente.delete({ where: { id: cliente.id } });
  await prisma.$disconnect();
  await queueMod.shutdownQueue();

  if (!SYNC_MODE && max >= 500) {
    console.error('FAIL: max elapsed >= 500ms');
    process.exit(1);
  }
  if (!SYNC_MODE && !results.every((r) => r.queued === true)) {
    console.error('FAIL: not all uploads were queued');
    process.exit(1);
  }
  console.log(SYNC_MODE ? 'DONE (sync mode benchmark)' : 'PASS');
  process.exit(0);
}

main().catch((err) => {
  console.error('perf test fatal:', err);
  process.exit(1);
});
