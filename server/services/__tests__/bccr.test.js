/**
 * Tests del cliente BCCR.
 * Corre con: `node --test server/services/__tests__/bccr.test.js`
 *
 * Mockea `globalThis.fetch` con `mock.method` del test runner nativo.
 */
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { fetchSeries, valideSubscription, __internals } from '../bccr.js';

const { BASE_URL } = __internals;

// --- helpers ---------------------------------------------------------------

/** Devuelve un Response-like JSON. */
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

/** Devuelve un Response-like de texto plano (para 401 con body no-JSON). */
function textResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    },
    async json() {
      throw new Error('not json');
    },
  };
}

/**
 * Reemplaza globalThis.fetch con un mock que devuelve `response` y captura
 * los argumentos en `calls`.
 */
function installFetchMock(response) {
  const calls = [];
  const fn = mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return response;
  });
  return { calls, fn };
}

// --- setup -----------------------------------------------------------------

beforeEach(() => {
  process.env.BCCR_TOKEN = 'test-token-abc';
  process.env.BCCR_EMAIL = 'tester@example.com';
});

afterEach(() => {
  mock.restoreAll();
});

// --- happy path ------------------------------------------------------------

test('fetchSeries: happy path con 5 fechas, todas estado=true', async () => {
  const body = [
    { fecha: '2026-05-18', valor: 510.12, estado: true },
    { fecha: '2026-05-19', valor: 511.00, estado: true },
    { fecha: '2026-05-20', valor: 509.55, estado: true },
    { fecha: '2026-05-21', valor: 512.30, estado: true },
    { fecha: '2026-05-22', valor: 513.04, estado: true },
  ];
  const { calls } = installFetchMock(jsonResponse(body));

  const result = await fetchSeries('USD', '2026-05-18', '2026-05-22', 'sell');

  assert.equal(result.length, 5);
  assert.deepEqual(result[0], { date: '2026-05-18', value: '510.12', source: 'BCCR' });
  assert.deepEqual(result[4], { date: '2026-05-22', value: '513.04', source: 'BCCR' });

  // URL apunta a 318 (sell) y slashes van encoded a %2F.
  assert.equal(calls.length, 1);
  const url = calls[0].url;
  assert.ok(url.startsWith(`${BASE_URL}/indicadoresEconomicos/318/series?`), `url=${url}`);
  assert.ok(url.includes('fechaInicio=2026%2F05%2F18'), `expected encoded fechaInicio in: ${url}`);
  assert.ok(url.includes('fechaFin=2026%2F05%2F22'), `expected encoded fechaFin in: ${url}`);
  assert.ok(url.includes('idioma=es'));
});

test('fetchSeries: side=buy mapea a code 317', async () => {
  const { calls } = installFetchMock(jsonResponse([
    { fecha: '2026-05-22', valor: 504.10, estado: true },
  ]));

  const result = await fetchSeries('USD', '2026-05-22', '2026-05-22', 'buy');

  assert.equal(result.length, 1);
  assert.equal(result[0].value, '504.1');
  assert.ok(calls[0].url.includes('/indicadoresEconomicos/317/series?'));
});

// --- filtrado de estado=false ---------------------------------------------

test('fetchSeries: filtra items con estado=false (feriados/finde)', async () => {
  installFetchMock(jsonResponse([
    { fecha: '2026-05-22', valor: 513.04, estado: true },
    { fecha: '2026-05-23', valor: null, estado: false }, // sábado
    { fecha: '2026-05-24', valor: null, estado: false }, // domingo
    { fecha: '2026-05-25', valor: 513.20, estado: true },
  ]));

  const result = await fetchSeries('USD', '2026-05-22', '2026-05-25', 'sell');

  assert.equal(result.length, 2);
  assert.deepEqual(result.map((r) => r.date), ['2026-05-22', '2026-05-25']);
});

test('fetchSeries: rango puro fin de semana devuelve array vacío', async () => {
  installFetchMock(jsonResponse([
    { fecha: '2026-05-23', valor: null, estado: false },
    { fecha: '2026-05-24', valor: null, estado: false },
  ]));

  const result = await fetchSeries('USD', '2026-05-23', '2026-05-24', 'sell');

  assert.deepEqual(result, []);
});

// --- errores HTTP ----------------------------------------------------------

test('fetchSeries: HTTP 401 lanza con mensaje útil (body no JSON)', async () => {
  installFetchMock(textResponse('Unauthorized', 401));

  await assert.rejects(
    () => fetchSeries('USD', '2026-05-22', '2026-05-22', 'sell'),
    (err) => {
      assert.match(err.message, /HTTP 401/);
      assert.match(err.message, /Unauthorized/);
      return true;
    },
  );
});

test('fetchSeries: HTTP 400 con body JSON lanza con el Mensaje del BCCR', async () => {
  installFetchMock(jsonResponse(
    { CodigoError: '400', Mensaje: 'Parámetros inválidos' },
    400,
  ));

  await assert.rejects(
    () => fetchSeries('USD', '2026-05-22', '2026-05-22', 'sell'),
    (err) => {
      assert.match(err.message, /HTTP 400/);
      assert.match(err.message, /Parámetros inválidos/);
      return true;
    },
  );
});

test('fetchSeries: HTTP 403 lanza (token sin permisos / vencido)', async () => {
  installFetchMock(textResponse('Forbidden', 403));

  await assert.rejects(
    () => fetchSeries('USD', '2026-05-22', '2026-05-22', 'sell'),
    /HTTP 403/,
  );
});

// --- validación de inputs --------------------------------------------------

test('fetchSeries: currency no soportada lanza', async () => {
  // No instalamos fetch mock — debe fallar antes de llegar a la red.
  await assert.rejects(
    () => fetchSeries('EUR', '2026-05-22', '2026-05-22', 'sell'),
    /unsupported currency: EUR/,
  );
});

test('fetchSeries: side no soportado lanza', async () => {
  await assert.rejects(
    () => fetchSeries('USD', '2026-05-22', '2026-05-22', 'midpoint'),
    /unsupported side/,
  );
});

test('fetchSeries: falta BCCR_TOKEN lanza con mensaje claro', async () => {
  const prev = process.env.BCCR_TOKEN;
  delete process.env.BCCR_TOKEN;
  try {
    await assert.rejects(
      () => fetchSeries('USD', '2026-05-22', '2026-05-22', 'sell'),
      /BCCR_TOKEN is not set/,
    );
  } finally {
    process.env.BCCR_TOKEN = prev;
  }
});

// --- header Authorization --------------------------------------------------

test('fetchSeries: envía header Authorization: Bearer <token>', async () => {
  const { calls } = installFetchMock(jsonResponse([
    { fecha: '2026-05-22', valor: 513.04, estado: true },
  ]));

  await fetchSeries('USD', '2026-05-22', '2026-05-22', 'sell');

  assert.equal(calls.length, 1);
  const headers = calls[0].init?.headers ?? {};
  assert.equal(headers.Authorization, 'Bearer test-token-abc');
  assert.equal(headers.Accept, 'application/json');
});

test('fetchSeries: acepta Date objects (no solo strings)', async () => {
  const { calls } = installFetchMock(jsonResponse([
    { fecha: '2026-05-22', valor: 513.04, estado: true },
  ]));

  await fetchSeries('USD', new Date('2026-05-22T00:00:00Z'), new Date('2026-05-22T00:00:00Z'), 'sell');

  assert.ok(calls[0].url.includes('fechaInicio=2026%2F05%2F22'));
  assert.ok(calls[0].url.includes('fechaFin=2026%2F05%2F22'));
});

test('fetchSeries: normaliza fecha ISO con hora a YYYY-MM-DD', async () => {
  installFetchMock(jsonResponse([
    { fecha: '2026-05-22T00:00:00', valor: 513.04, estado: true },
  ]));

  const result = await fetchSeries('USD', '2026-05-22', '2026-05-22', 'sell');

  assert.equal(result[0].date, '2026-05-22');
});

// --- valideSubscription ----------------------------------------------------

test('valideSubscription: hace GET a serie 318 con rango [today-7d, today]', async () => {
  const { calls } = installFetchMock(jsonResponse([
    { fecha: '2026-05-22', valor: 513.04, estado: true },
    { fecha: '2026-05-23', valor: null, estado: false },
  ]));

  const result = await valideSubscription();

  assert.equal(result.ok, true);
  assert.equal(result.email, 'tester@example.com');
  assert.equal(result.sample, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes('/indicadoresEconomicos/318/series?'));
  assert.ok(calls[0].url.includes('idioma=es'));
});

test('valideSubscription: propaga error HTTP del BCCR', async () => {
  installFetchMock(textResponse('Unauthorized', 401));

  await assert.rejects(
    () => valideSubscription(),
    /HTTP 401/,
  );
});
