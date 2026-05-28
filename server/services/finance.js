/**
 * [finance] Helpers de conversión de moneda y lookup de tipo de cambio.
 *
 * Convenciones:
 *  - Sólo manejamos CRC ↔ USD por ahora (la tabla `exchange_rates` guarda
 *    siempre `currency='USD'` con tasas buy/sell relativas a CRC).
 *  - `side='sell'` → tasa que usamos cuando convertimos USD → CRC (compramos
 *    dólares al banco) o cuando normalizamos al CRC equivalente de un pago en
 *    USD. Esto es el patrón consistente con el snapshot de OC (`oc.fxRateApplied`
 *    se toma de `ExchangeRate.sell`).
 *  - `side='buy'` se deja preparado por simetría (CRC → USD vendiendo dólares),
 *    aunque hoy nadie lo usa en este servicio.
 *
 * Decisiones:
 *  - El lookup usa el ExchangeRate más cercano hacia atrás (`date <= target`).
 *    Si no hay TC en DB → throw `NoExchangeRateError`. El caller decide si
 *    bloquea o degrada (en `pago-flow` lo degradamos a warning).
 *  - Trabajamos sobre `Number` para math simple. Las cantidades involucradas
 *    en este proyecto caben en double sin problema (mayor pago razonable
 *    ~ ₡100M = 1e8; double tiene 15-16 dígitos significativos).
 */

export class NoExchangeRateError extends Error {
  constructor(message, { currency, date } = {}) {
    super(message);
    this.name = 'NoExchangeRateError';
    this.code = 'NO_EXCHANGE_RATE';
    this.currency = currency ?? null;
    this.date = date ?? null;
  }
}

/**
 * Normaliza una fecha a `Date` a medianoche UTC. Tolera Date, string ISO,
 * `YYYY-MM-DD`. Throws si no se puede parsear.
 */
function normDate(value) {
  if (value == null) {
    throw new Error('finance: fecha requerida');
  }
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`finance: fecha inválida: ${value}`);
  }
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Devuelve el ExchangeRate row más cercano hacia atrás. Si no existe, throw.
 *
 * @param {'USD'|'CRC'} currency Sólo USD es relevante (CRC es base).
 * @param {Date|string} date
 * @param {'sell'|'buy'} side
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<{rate: number, fxRateDate: Date, side: 'sell'|'buy'}>}
 */
export async function getRateForDate(currency, date, side = 'sell', prisma) {
  if (!prisma) {
    throw new Error('finance: prisma client requerido');
  }
  if (currency === 'CRC') {
    // No tiene sentido pedir TC para CRC (es la base).
    return { rate: 1, fxRateDate: normDate(date), side };
  }
  if (currency !== 'USD') {
    throw new Error(`finance: moneda no soportada: ${currency}`);
  }
  const targetDate = normDate(date);
  const row = await prisma.exchangeRate.findFirst({
    where: {
      currency: 'USD',
      date: { lte: targetDate },
    },
    orderBy: { date: 'desc' },
  });
  if (!row) {
    throw new NoExchangeRateError(
      `No hay ExchangeRate USD para fecha ${targetDate.toISOString().slice(0, 10)}`,
      { currency: 'USD', date: targetDate },
    );
  }
  const rate = Number(row[side]);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`finance: TC inválido en DB: row.id=${row.id} side=${side}`);
  }
  return { rate, fxRateDate: row.date, side };
}

/**
 * Convierte `{amount, currency}` a `{amount, currency: targetCurrency}` usando
 * el ExchangeRate más cercano hacia atrás desde `date`.
 *
 * Reglas:
 *  - CRC → CRC y USD → USD pasan derecho (no DB lookup).
 *  - CRC → USD: divide CRC entre `sell` (mismo TC que usamos para snapshot
 *    de OC; mantiene simetría con la valoración aplicada).
 *  - USD → CRC: multiplica USD por `sell`.
 *
 * @param {{amount: string|number, currency: string}} money
 * @param {'CRC'|'USD'} targetCurrency
 * @param {Date|string} date Fecha de referencia (suele ser fechaRealizada).
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<{amount: string, currency: 'CRC'|'USD', fxRateApplied: number, fxRateDate: Date}>}
 */
export async function convert(money, targetCurrency, date, prisma) {
  if (!money || money.amount == null) {
    throw new Error('finance: money inválido');
  }
  const sourceCurrency = money.currency;
  const amountNum = typeof money.amount === 'number' ? money.amount : Number(money.amount);
  if (!Number.isFinite(amountNum)) {
    throw new Error(`finance: amount inválido: ${money.amount}`);
  }

  // Same currency → passthrough.
  if (sourceCurrency === targetCurrency) {
    return {
      amount: amountNum.toFixed(2),
      currency: targetCurrency,
      fxRateApplied: 1,
      fxRateDate: normDate(date),
    };
  }

  // CRC ↔ USD: necesitamos TC.
  const { rate, fxRateDate } = await getRateForDate('USD', date, 'sell', prisma);
  let resultAmount;
  if (sourceCurrency === 'USD' && targetCurrency === 'CRC') {
    resultAmount = amountNum * rate;
  } else if (sourceCurrency === 'CRC' && targetCurrency === 'USD') {
    resultAmount = amountNum / rate;
  } else {
    throw new Error(`finance: conversión no soportada ${sourceCurrency}→${targetCurrency}`);
  }
  return {
    amount: resultAmount.toFixed(2),
    currency: targetCurrency,
    fxRateApplied: rate,
    fxRateDate,
  };
}
