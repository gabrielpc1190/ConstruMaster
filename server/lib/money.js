/**
 * Helpers para serializar Money en respuestas API.
 *
 * En el schema Prisma cada campo "money" vive como dos columnas planas:
 * `<campo>Amount Decimal` + `<campo>Currency` (enum). El frontend consume
 * `Money = { amount: string, currency: 'CRC'|'USD' }`. Sin estos helpers,
 * el frontend recibe `montoTotalAmount` separado de `montoTotalCurrency` y
 * cualquier `.amount` revienta con "Cannot read properties of undefined".
 *
 * Pattern: cada controller que devuelva un model con campos money llama a
 * `withMoney(row, ['monto', 'subtotal', ...])` o el alias específico
 * (`ocOut`, `cotizacionOut`, etc.) antes de res.json(...).
 */

export function money(amount, currency) {
  if (amount == null || currency == null) return null;
  return { amount: String(amount), currency };
}

/**
 * Mapea N pares `<base>Amount`/`<base>Currency` a `<base>: Money | null`.
 * Conserva el resto del objeto intacto. Retorna copia.
 */
export function withMoney(row, bases) {
  if (row == null) return row;
  const out = { ...row };
  for (const base of bases) {
    const amount = row[`${base}Amount`];
    const currency = row[`${base}Currency`];
    out[base] = money(amount, currency);
  }
  return out;
}

// Aliases específicos por entidad ----------------------------------------

export function ocOut(row, { includeMeta = true } = {}) {
  if (row == null) return row;
  const out = withMoney(row, ['montoTotal']);
  if (includeMeta) {
    // Mantener fxRateApplied como string para preservar precisión Decimal.
    if (row.fxRateApplied != null) out.fxRateApplied = String(row.fxRateApplied);
    if (row.pctAnticipo != null) out.pctAnticipo = String(row.pctAnticipo);
  }
  if (Array.isArray(row.items)) out.items = row.items.map(ocItemOut);
  if (Array.isArray(row.pagos)) out.pagos = row.pagos.map(pagoOut);
  return out;
}

export function ocItemOut(row) {
  if (row == null) return row;
  return {
    ...row,
    cantidad: row.cantidad != null ? String(row.cantidad) : null,
    precioUnitario: row.precioUnitario != null ? String(row.precioUnitario) : null,
    subtotal: row.subtotal != null ? String(row.subtotal) : null,
    ivaMonto: row.ivaMonto != null ? String(row.ivaMonto) : null,
  };
}

export function cotizacionOut(row) {
  if (row == null) return row;
  const out = withMoney(row, ['subtotal', 'iva', 'total']);
  if (row.pctAnticipo != null) out.pctAnticipo = String(row.pctAnticipo);
  if (Array.isArray(row.items)) out.items = row.items.map(cotizacionItemOut);
  if (row.oc) out.oc = ocOut(row.oc);
  return out;
}

export function cotizacionItemOut(row) {
  if (row == null) return row;
  return {
    ...row,
    cantidad: row.cantidad != null ? String(row.cantidad) : null,
    precioUnitario: row.precioUnitario != null ? String(row.precioUnitario) : null,
    subtotal: row.subtotal != null ? String(row.subtotal) : null,
    ivaMonto: row.ivaMonto != null ? String(row.ivaMonto) : null,
  };
}

export function pagoOut(row) {
  if (row == null) return row;
  const out = withMoney(row, ['monto']);
  if (row.fxRateApplied != null) out.fxRateApplied = String(row.fxRateApplied);
  return out;
}

export function facturaOut(row) {
  if (row == null) return row;
  const out = withMoney(row, ['montoTotal']);
  if (row.fxRateApplied != null) out.fxRateApplied = String(row.fxRateApplied);
  if (row.oc) out.oc = ocOut(row.oc, { includeMeta: false });
  return out;
}
