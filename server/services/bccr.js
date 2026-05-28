/**
 * Cliente HTTP para la API REST SDDE del BCCR.
 *
 * Endpoint:
 *   https://apim.bccr.fi.cr/SDDE/api/Bccr.GE.SDDE.Publico.Indicadores.API
 *
 * Auth: header `Authorization: Bearer <JWT>` (token desde sdd.bccr.fi.cr).
 *
 * Indicadores relevantes (USD/CRC):
 *   - 317 = tipo de cambio COMPRA
 *   - 318 = tipo de cambio VENTA (default para cumplimiento Hacienda)
 *
 * Notas:
 *   - El endpoint oficial `/Usuario/ValideSuscripcion` devuelve 500 (bug del BCCR).
 *     Usamos GET de la serie 318 con rango de 7d como smoke test.
 *   - NO usar el equivalente de `raise_for_status()` ciego: el body de error
 *     trae mensaje útil que hay que leer antes de lanzar.
 */

const BASE_URL = 'https://apim.bccr.fi.cr/SDDE/api/Bccr.GE.SDDE.Publico.Indicadores.API';

const CURRENCY_CODES = {
  // currency -> { buy, sell }
  USD: { buy: 317, sell: 318 },
};

/**
 * Convierte un Date u ISO-string a 'YYYY/MM/DD' (formato que pide el BCCR).
 * El encoding de los slashes lo hace URLSearchParams (a `%2F`).
 */
function toBccrDate(input) {
  if (input == null) {
    throw new Error('[bccr] date is required');
  }
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`[bccr] invalid date: ${String(input)}`);
  }
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

/**
 * Normaliza la fecha que devuelve el BCCR (`fecha` puede venir como ISO
 * completo con hora) al formato 'YYYY-MM-DD'.
 */
function normalizeDate(fecha) {
  if (typeof fecha !== 'string') {
    throw new Error(`[bccr] unexpected fecha type: ${typeof fecha}`);
  }
  return fecha.slice(0, 10);
}

/**
 * Resuelve el código de indicador para una moneda + lado (buy/sell).
 */
function resolveCode(currency, side) {
  const entry = CURRENCY_CODES[currency];
  if (!entry) {
    throw new Error(`[bccr] unsupported currency: ${currency}`);
  }
  const code = entry[side];
  if (!code) {
    throw new Error(`[bccr] unsupported side: ${side} (expected 'buy' | 'sell')`);
  }
  return code;
}

/**
 * Lee BCCR_TOKEN desde env. Lanza si falta — no caemos a string vacío
 * porque el BCCR responde 401 sin pista clara cuando el header está vacío.
 */
function getToken() {
  const token = process.env.BCCR_TOKEN;
  if (!token) {
    throw new Error('[bccr] BCCR_TOKEN is not set in environment');
  }
  return token;
}

/**
 * Hace GET autenticado a un código de indicador.
 * Maneja errores HTTP leyendo el body antes de lanzar.
 *
 * Response real del BCCR:
 *   {estado: bool, mensaje?: string,
 *    datos: [{series: [{fecha, valorDatoPorPeriodo}]}]}
 *
 * Esta función lo desenvuelve a un array plano de
 *   {fecha, valor}
 * donde `valor` puede ser null (fin de semana, feriado, sin datos).
 */
async function rawFetch(code, fechaInicio, fechaFin) {
  const token = getToken();
  const params = new URLSearchParams({
    fechaInicio: toBccrDate(fechaInicio),
    fechaFin: toBccrDate(fechaFin),
    idioma: 'es',
  });
  const url = `${BASE_URL}/indicadoresEconomicos/${code}/series?${params.toString()}`;

  console.log(`[bccr] GET ${url}`);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    // NO raise_for_status ciego: leemos el body porque el BCCR mete mensaje útil ahí.
    const rawBody = await res.text();
    let bodyMsg = rawBody;
    try {
      const parsed = JSON.parse(rawBody);
      bodyMsg = parsed.Mensaje || parsed.mensaje || rawBody;
    } catch {
      // body no es JSON (ej. HTML 401), dejamos el texto crudo
    }
    const snippet = String(bodyMsg).slice(0, 300);
    throw new Error(`[bccr] HTTP ${res.status}: ${snippet}`);
  }

  const data = await res.json();

  // Compat con la respuesta vieja (algunos endpoints SDDE devolvían array plano).
  if (Array.isArray(data)) return data;

  if (data && typeof data === 'object') {
    if (data.estado === false) {
      const msg = data.mensaje || 'BCCR returned estado=false';
      throw new Error(`[bccr] ${msg}`);
    }
    const datos = Array.isArray(data.datos) ? data.datos : [];
    if (datos.length === 0) return [];
    const series = Array.isArray(datos[0]?.series) ? datos[0].series : [];
    return series.map((s) => ({
      fecha: s.fecha,
      valor: s.valorDatoPorPeriodo,
    }));
  }

  throw new Error(`[bccr] unexpected response shape: ${typeof data}`);
}

/**
 * Consulta la serie de tipo de cambio para una moneda en un rango.
 *
 * @param {'USD'} currency
 * @param {Date|string} fechaInicio
 * @param {Date|string} fechaFin
 * @param {'buy'|'sell'} side
 * @returns {Promise<Array<{date: string, value: string, source: 'BCCR'}>>}
 *   Solo items con `estado=true`. `value` se devuelve como string para
 *   preservar precisión decimal (la capa de conversion usa Decimal-as-string).
 */
export async function fetchSeries(currency, fechaInicio, fechaFin, side) {
  const code = resolveCode(currency, side);
  const items = await rawFetch(code, fechaInicio, fechaFin);

  return items
    // valor === null en fines de semana / feriados → omitir.
    .filter((item) => item && item.valor != null)
    .map((item) => ({
      date: normalizeDate(item.fecha),
      // El BCCR retorna `valor` como number; lo serializamos a string para
      // que la capa de conversion (futuro Decimal) no pierda precisión.
      value: String(item.valor),
      source: 'BCCR',
    }));
}

/**
 * Smoke test del token. Pide la serie 318 (TC venta) de los últimos 7 días.
 * Si la llamada no lanza, el token está vivo.
 *
 * Usamos esto en lugar de `/Usuario/ValideSuscripcion` porque ese endpoint
 * oficial devuelve HTTP 500 (bug del BCCR documentado en HANDOFF.md).
 *
 * @returns {Promise<{ok: true, email?: string, sample: number}>}
 */
export async function valideSubscription() {
  const today = new Date();
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);

  const items = await rawFetch(318, sevenDaysAgo, today);
  const validCount = items.filter((i) => i && i.valor != null).length;

  const email = process.env.BCCR_EMAIL || undefined;
  console.log(`[bccr] valideSubscription ok (email=${email ?? 'n/a'}, samples=${validCount})`);
  return { ok: true, email, sample: validCount };
}

// Exports auxiliares para tests / introspección.
export const __internals = { BASE_URL, CURRENCY_CODES, toBccrDate, resolveCode };
