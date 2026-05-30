/**
 * Controllers de Reportes (`/api/reportes`).
 *
 * Endpoints (todos requieren auth):
 *   - GET /proveedor/:proveedorId?desde=&hasta=&format=json|csv
 *   - GET /reconciliacion/:obraId?format=json|csv
 *   - GET /tipo-cambio?desde=&hasta=&currency=&format=json|csv
 *
 * Política CSV:
 *   - Cualquier rol autenticado puede descargar. Logueamos quién pidió qué
 *     para auditoría manual; cuando los helpers de `audit.js` se integren a
 *     los controllers existentes, este log se reemplaza por `auditExport`.
 */
import { z } from 'zod';
import prisma from '../db.js';
import {
  reporteProveedor,
  reporteReconciliacionObra,
  reporteTipoCambio,
  serializeToCSV,
} from '../services/reportes.js';

// ---------------------------------------------------------------------------
// Schemas (zod)
// ---------------------------------------------------------------------------

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha debe ser YYYY-MM-DD');

const formatQuery = z.enum(['json', 'csv']).default('json');

const bigIntParam = z
  .string()
  .regex(/^\d+$/, 'id debe ser un número entero positivo');

const proveedorQuerySchema = z.object({
  desde: dateString.optional(),
  hasta: dateString.optional(),
  format: formatQuery.optional(),
});

const reconciliacionQuerySchema = z.object({
  format: formatQuery.optional(),
});

const tipoCambioQuerySchema = z.object({
  desde: dateString.optional(),
  hasta: dateString.optional(),
  currency: z
    .string()
    .trim()
    .min(3)
    .max(3)
    .transform((s) => s.toUpperCase())
    .optional(),
  format: formatQuery.optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zodError(res, error) {
  return res.status(400).json({
    error: 'Validation error',
    issues: error.issues.map((i) => ({ path: i.path, message: i.message })),
  });
}

function sendCsv(res, filename, body) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename.replace(/"/g, '')}"`,
  );
  return res.send(body);
}

function logExport(req, kind, params) {
  const username = req?.user?.username ?? '?';
  console.log(`[reportes] export ${kind} user=${username} params=${JSON.stringify(params)}`);
}

function mapStatus(err) {
  return Number.isInteger(err?.status) ? err.status : 500;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/reportes/proveedor/:proveedorId
 */
export async function getReporteProveedor(req, res) {
  try {
    if (!bigIntParam.safeParse(req.params.proveedorId).success) {
      return res.status(400).json({ error: 'proveedorId inválido' });
    }
    const parsed = proveedorQuerySchema.safeParse(req.query || {});
    if (!parsed.success) return zodError(res, parsed.error);

    const data = await reporteProveedor(prisma, {
      proveedorId: req.params.proveedorId,
      desde: parsed.data.desde,
      hasta: parsed.data.hasta,
    });

    if ((parsed.data.format ?? 'json') === 'csv') {
      logExport(req, 'proveedor', {
        proveedorId: req.params.proveedorId,
        desde: parsed.data.desde,
        hasta: parsed.data.hasta,
      });
      const csv = serializeToCSV(data.ocs, [
        { key: 'numeroOc', header: 'Número OC' },
        { key: 'fechaAprobacion', header: 'Fecha aprobación' },
        { key: 'estado', header: 'Estado' },
        { key: 'monto', header: 'Monto OC', value: (r) => `${r.monto.amount} ${r.monto.currency}` },
        { key: 'totalPagado', header: 'Total pagado', value: (r) => `${r.totalPagado.amount} ${r.totalPagado.currency}` },
        { key: 'totalEntregado', header: 'Total entregado', value: (r) => `${r.totalEntregado.amount} ${r.totalEntregado.currency}` },
      ]);
      const fn = `proveedor-${data.proveedor.id}-${new Date().toISOString().slice(0, 10)}.csv`;
      return sendCsv(res, fn, csv);
    }
    return res.json(data);
  } catch (err) {
    console.error('[reportes.proveedor] error:', err);
    return res.status(mapStatus(err)).json({ error: err.message || 'Internal error' });
  }
}

/**
 * GET /api/reportes/reconciliacion/:obraId
 */
export async function getReporteReconciliacion(req, res) {
  try {
    if (!bigIntParam.safeParse(req.params.obraId).success) {
      return res.status(400).json({ error: 'obraId inválido' });
    }
    const parsed = reconciliacionQuerySchema.safeParse(req.query || {});
    if (!parsed.success) return zodError(res, parsed.error);

    const data = await reporteReconciliacionObra(prisma, {
      obraId: req.params.obraId,
    });

    if ((parsed.data.format ?? 'json') === 'csv') {
      logExport(req, 'reconciliacion', { obraId: req.params.obraId });
      const csv = serializeToCSV(data.items, [
        { key: 'material', header: 'Material', value: (r) => r.material.nombre },
        { key: 'unidad', header: 'Unidad', value: (r) => r.material.unidad ?? '' },
        { key: 'compradoCantidad', header: 'Cant. comprada', value: (r) => r.comprado.cantidad },
        { key: 'compradoMonto', header: 'Monto comprado', value: (r) => `${r.comprado.monto.amount} ${r.comprado.monto.currency}` },
        { key: 'entregadoCantidad', header: 'Cant. entregada', value: (r) => r.entregado.cantidad },
        { key: 'entregadoMonto', header: 'Monto entregado', value: (r) => `${r.entregado.monto.amount} ${r.entregado.monto.currency}` },
        { key: 'pendienteCantidad', header: 'Cant. pendiente', value: (r) => r.pendiente.cantidad },
        { key: 'pendienteMonto', header: 'Monto pendiente', value: (r) => `${r.pendiente.monto.amount} ${r.pendiente.monto.currency}` },
      ]);
      const fn = `reconciliacion-${data.obra.slug}-${new Date().toISOString().slice(0, 10)}.csv`;
      return sendCsv(res, fn, csv);
    }
    return res.json(data);
  } catch (err) {
    console.error('[reportes.reconciliacion] error:', err);
    return res.status(mapStatus(err)).json({ error: err.message || 'Internal error' });
  }
}

/**
 * GET /api/reportes/tipo-cambio
 */
export async function getReporteTipoCambio(req, res) {
  try {
    const parsed = tipoCambioQuerySchema.safeParse(req.query || {});
    if (!parsed.success) return zodError(res, parsed.error);

    const rows = await reporteTipoCambio(prisma, {
      desde: parsed.data.desde,
      hasta: parsed.data.hasta,
      currency: parsed.data.currency ?? 'USD',
    });

    if ((parsed.data.format ?? 'json') === 'csv') {
      logExport(req, 'tipo-cambio', {
        desde: parsed.data.desde,
        hasta: parsed.data.hasta,
        currency: parsed.data.currency ?? 'USD',
      });
      const csv = serializeToCSV(rows, [
        { key: 'date', header: 'Fecha' },
        { key: 'buy', header: 'Compra' },
        { key: 'sell', header: 'Venta' },
        { key: 'source', header: 'Fuente' },
      ]);
      const fn = `tipo-cambio-${parsed.data.currency ?? 'USD'}-${new Date().toISOString().slice(0, 10)}.csv`;
      return sendCsv(res, fn, csv);
    }
    return res.json(rows);
  } catch (err) {
    console.error('[reportes.tipo-cambio] error:', err);
    return res.status(mapStatus(err)).json({ error: err.message || 'Internal error' });
  }
}

export const __testables = {
  proveedorQuerySchema,
  reconciliacionQuerySchema,
  tipoCambioQuerySchema,
  bigIntParam,
};
