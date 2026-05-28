/**
 * Tests de unidad para los helpers de Obras.
 *
 * Correr con: `node --test server/routes/__tests__/obras.test.js`
 *
 * `supertest` no está instalado (ver package.json). Decisión: testeo unitario
 * directo de:
 *   - `slugify` (input → output)
 *   - `uniqueSlug` (con un prisma mock que controla las colisiones)
 *   - `requireRole` (Express middleware contract)
 *   - Serializers expuestos vía `__internals`.
 *
 * La integración HTTP end-to-end queda para Fase 2 cuando agreguemos supertest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { slugify, uniqueSlug } from '../../lib/slug.js';
import { requireRole, WRITE_ROLES, ALL_AUTH_ROLES } from '../../lib/permissions.js';
import { __internals as obraInternals } from '../../controllers/obras.controller.js';

// --- slugify ---------------------------------------------------------------

test("slugify('San José Centro') === 'san-jose-centro'", () => {
  assert.equal(slugify('San José Centro'), 'san-jose-centro');
});

test('slugify strips múltiples tipos de tildes/diacríticos', () => {
  assert.equal(slugify('Ñandú & Ávila'), 'nandu-avila');
  assert.equal(slugify('Müller über Straße'), 'muller-uber-strae'); // ß no se ASCII-iza vía NFD
});

test('slugify colapsa espacios, slashes y bajos a un solo guión', () => {
  assert.equal(slugify('  hola   mundo  '), 'hola-mundo');
  assert.equal(slugify('foo/bar\\baz_qux'), 'foo-bar-baz-qux');
});

test('slugify quita símbolos no [a-z0-9-]', () => {
  assert.equal(slugify("Casa #5 — calle's"), 'casa-5-calles');
});

test('slugify respeta max 80 chars y no deja `-` al final', () => {
  const long = 'a'.repeat(100);
  const out = slugify(long);
  assert.equal(out.length, 80);
  assert.equal(out, 'a'.repeat(80));

  const longWithSep = `${'b'.repeat(78)} cd`; // → 78 b's + '-' + 'cd' = 82 → trunc a 80
  const out2 = slugify(longWithSep);
  assert.ok(out2.length <= 80, `len=${out2.length}`);
  assert.ok(!out2.endsWith('-'), `endsWith hyphen: ${out2}`);
});

test('slugify devuelve "" para input vacío / null / sólo símbolos', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');
  assert.equal(slugify(undefined), '');
  assert.equal(slugify('   '), '');
  assert.equal(slugify('!!!---???'), '');
});

// --- uniqueSlug ------------------------------------------------------------

/** Construye un prisma mock cuyo `obra.findUnique` "ocupa" los slugs en `taken`. */
function mockPrisma(taken) {
  const set = new Set(taken);
  return {
    obra: {
      async findUnique({ where: { slug } }) {
        return set.has(slug) ? { id: 1n, slug } : null;
      },
    },
  };
}

test('uniqueSlug devuelve el base si está libre', async () => {
  const prisma = mockPrisma([]);
  const s = await uniqueSlug(prisma, 'San José Centro');
  assert.equal(s, 'san-jose-centro');
});

test('uniqueSlug encuentra próximo libre tras colisión', async () => {
  const prisma = mockPrisma(['casa-azul', 'casa-azul-2', 'casa-azul-3']);
  const s = await uniqueSlug(prisma, 'Casa Azul');
  assert.equal(s, 'casa-azul-4');
});

test('uniqueSlug genera fallback si base es vacío', async () => {
  const prisma = mockPrisma([]);
  const s = await uniqueSlug(prisma, '   ');
  assert.match(s, /^obra-[a-z0-9]{1,6}$/);
});

test('uniqueSlug respeta MAX_LEN 80 incluso con sufijo numérico', async () => {
  // base de 80 chars; el `-2` no puede pasar de 80.
  const baseStr = 'a'.repeat(80);
  const prisma = mockPrisma([baseStr]);
  const s = await uniqueSlug(prisma, baseStr);
  assert.ok(s.length <= 80, `slug too long: ${s.length}`);
  assert.ok(s.endsWith('-2'), `expected to end with -2: ${s}`);
});

// --- requireRole middleware ------------------------------------------------

/** Pequeño driver para correr un middleware estilo Express en memoria. */
function runMiddleware(middleware, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; resolve({ res: this, called: false }); return this; },
    };
    const next = () => resolve({ res, called: true });
    middleware(req, res, next);
  });
}

test('requireRole permite paso si rol está en la lista', async () => {
  const mw = requireRole('admin', 'supervisor');
  const { called, res } = await runMiddleware(mw, { user: { role: 'admin' } });
  assert.equal(called, true);
  assert.equal(res.statusCode, 200);
});

test('requireRole devuelve 403 si rol no está permitido (operativo intentando write)', async () => {
  const mw = requireRole(...WRITE_ROLES);
  const { called, res } = await runMiddleware(mw, { user: { role: 'operativo' } });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /not allowed/i);
});

test('requireRole devuelve 401 si no hay req.user (token ausente / middleware mal ordenado)', async () => {
  const mw = requireRole('admin');
  const { called, res } = await runMiddleware(mw, {});
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test('WRITE_ROLES y ALL_AUTH_ROLES exponen las listas esperadas', () => {
  assert.deepEqual([...WRITE_ROLES], ['admin', 'supervisor']);
  assert.deepEqual([...ALL_AUTH_ROLES], ['admin', 'supervisor', 'operativo', 'lector']);
});

// --- serializers + money helper -------------------------------------------

test('moneyOut serializa Decimal-like a string con dos decimales', () => {
  const fakeDecimal = { toFixed: (n) => Number(123456.789).toFixed(n) };
  assert.deepEqual(obraInternals.moneyOut(fakeDecimal, 'CRC'), {
    amount: '123456.79',
    currency: 'CRC',
  });
  assert.equal(obraInternals.moneyOut(null, 'CRC'), null);
});

test('serializeObra mapea BigInt → Number y formatea fechas YYYY-MM-DD', () => {
  const out = obraInternals.serializeObra({
    id: 10n,
    clienteId: 5n,
    cliente: { id: 5n, nombre: 'ADITA' },
    nombre: 'Obra',
    slug: 'obra',
    direccion: null,
    fechaInicio: new Date('2026-05-27T00:00:00Z'),
    fechaFinEstimada: null,
    monedaReporte: 'USD',
    estado: 'planificada',
    nextOcSeq: 1,
    notas: null,
    createdAt: new Date('2026-05-27T10:00:00Z'),
    updatedAt: new Date('2026-05-27T10:00:00Z'),
  });
  assert.equal(out.id, 10);
  assert.equal(out.clienteId, 5);
  assert.deepEqual(out.cliente, { id: 5, nombre: 'ADITA' });
  assert.equal(out.fechaInicio, '2026-05-27');
  assert.equal(out.fechaFinEstimada, null);
});
