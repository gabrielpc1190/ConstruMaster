/**
 * [compras] Cotizaciones controller.
 *
 * Endpoints públicos:
 *   - list      GET    /api/cotizaciones
 *   - create    POST   /api/cotizaciones
 *   - detail    GET    /api/cotizaciones/:id
 *   - update    PUT    /api/cotizaciones/:id   (solo en estados editables)
 *   - aprobar   POST   /api/cotizaciones/:id/aprobar  → delega en oc-flow
 *   - rechazar  POST   /api/cotizaciones/:id/rechazar
 *
 * El flow de aprobación vive en `services/oc-flow.js` para mantener este
 * controller delgado y testeable.
 */
import { z } from 'zod';
import prisma from '../db.js';
import { approveCotizacion } from '../services/oc-flow.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const moneyShape = z.object({
  amount: z.union([z.number(), z.string()]),
  currency: z.enum(['CRC', 'USD']),
});

const itemShape = z.object({
  materialId: z.union([z.number(), z.string()]).optional().nullable(),
  descripcion: z.string().min(1).max(300),
  cantidad: z.union([z.number(), z.string()]),
  unidad: z.string().min(1).max(20),
  precioUnitario: z.union([z.number(), z.string()]),
  subtotal: z.union([z.number(), z.string()]),
  ivaMonto: z.union([z.number(), z.string()]).optional(),
  codigoCabys: z.string().max(13).optional().nullable(),
  orden: z.number().int().optional(),
});

const createSchema = z.object({
  obraId: z.union([z.number(), z.string()]),
  proveedorId: z.union([z.number(), z.string()]),
  rfqId: z.union([z.number(), z.string()]).optional().nullable(),
  numeroCotizacion: z.string().min(1).max(80),
  fecha: z.string().min(1),
  fechaValidez: z.string().optional().nullable(),
  moneda: z.enum(['CRC', 'USD']).optional(),
  subtotal: moneyShape,
  iva: moneyShape,
  total: moneyShape,
  condicionesPago: z.string().max(200).optional().nullable(),
  plazoEntregaDias: z.number().int().nonnegative().optional().nullable(),
  pctAnticipo: z.union([z.number(), z.string()]).optional().nullable(),
  esEspecial: z.boolean().optional(),
  archivoPath: z.string().optional().nullable(),
  notas: z.string().optional().nullable(),
  items: z.array(itemShape).min(1, 'Al menos un item es requerido'),
});

const updateSchema = z.object({
  numeroCotizacion: z.string().min(1).max(80).optional(),
  fecha: z.string().optional(),
  fechaValidez: z.string().optional().nullable(),
  condicionesPago: z.string().max(200).optional().nullable(),
  plazoEntregaDias: z.number().int().nonnegative().optional().nullable(),
  pctAnticipo: z.union([z.number(), z.string()]).optional().nullable(),
  esEspecial: z.boolean().optional(),
  estado: z.enum(['recibida', 'en_revision', 'vencida']).optional(),
  archivoPath: z.string().optional().nullable(),
  notas: z.string().optional().nullable(),
});

const approveSchema = z.object({
  categoriaId: z.union([z.number(), z.string()]),
  fechaAprobacion: z.string().optional().nullable(),
});

const rejectSchema = z.object({
  motivo: z.string().max(500).optional().nullable(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROLES_CREATE = new Set(['admin', 'supervisor', 'operativo']);
const ROLES_APPROVE = new Set(['admin', 'supervisor']);
const ROLES_UPDATE = new Set(['admin', 'supervisor', 'operativo']);

const EDITABLE_ESTADOS = new Set(['recibida', 'en_revision']);
const MONEY_TOLERANCE = 1; // ₡1 (o USD 1) — el spec dice "tolerancia ₡1".

function toBig(v) {
  try {
    return v == null ? null : BigInt(v);
  } catch {
    return null;
  }
}

function toDec(v) {
  if (v == null || v === '') return null;
  // Prisma Decimal acepta number o string. Forzamos string para precisión.
  return typeof v === 'string' ? v : String(v);
}

function toDecNum(v) {
  if (v == null || v === '') return 0;
  return typeof v === 'number' ? v : Number(v);
}

function parseDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function bad(res, msg, status = 400) {
  return res.status(status).json({ error: msg });
}

function logHandlerError(handler, err) {
  console.error(`[compras] ${handler} error:`, err);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function listCotizaciones(req, res) {
  try {
    const { obraId, proveedorId, estado, rfqId } = req.query;
    const where = {};
    if (obraId) where.obraId = toBig(obraId) ?? undefined;
    if (proveedorId) where.proveedorId = toBig(proveedorId) ?? undefined;
    if (estado) where.estado = String(estado);
    if (rfqId) where.rfqId = toBig(rfqId) ?? undefined;

    const rows = await prisma.cotizacion.findMany({
      where,
      orderBy: [{ fecha: 'desc' }, { createdAt: 'desc' }],
      include: { proveedor: true, obra: true },
    });
    return res.json(rows);
  } catch (err) {
    logHandlerError('listCotizaciones', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function getCotizacion(req, res) {
  try {
    const id = toBig(req.params.id);
    if (id == null) return bad(res, 'id inválido', 400);
    const row = await prisma.cotizacion.findUnique({
      where: { id },
      include: {
        items: { orderBy: { orden: 'asc' } },
        proveedor: true,
        obra: true,
        rfq: true,
      },
    });
    if (!row) return bad(res, 'Cotización no encontrada', 404);
    return res.json(row);
  } catch (err) {
    logHandlerError('getCotizacion', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function createCotizacion(req, res) {
  try {
    if (!ROLES_CREATE.has(req.user?.role)) {
      return bad(res, 'No autorizado para crear cotizaciones', 403);
    }

    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return bad(res, `Payload inválido: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 400);
    }
    const data = parsed.data;

    // Validar consistencia de moneda: subtotal, iva, total deben coincidir.
    const moneda = data.moneda ?? data.total.currency;
    if (data.subtotal.currency !== moneda || data.iva.currency !== moneda || data.total.currency !== moneda) {
      return bad(res, 'Moneda inconsistente entre subtotal/iva/total/moneda', 400);
    }

    // Validar sumas con tolerancia.
    const subtotalDoc = toDecNum(data.subtotal.amount);
    const ivaDoc = toDecNum(data.iva.amount);
    const totalDoc = toDecNum(data.total.amount);

    const sumItemsSubtotal = data.items.reduce((acc, it) => acc + toDecNum(it.subtotal), 0);
    const sumItemsIva = data.items.reduce((acc, it) => acc + toDecNum(it.ivaMonto), 0);

    if (Math.abs(sumItemsSubtotal - subtotalDoc) > MONEY_TOLERANCE) {
      return bad(res, `Suma de subtotales de items (${sumItemsSubtotal.toFixed(2)}) ≠ subtotal documento (${subtotalDoc.toFixed(2)})`, 400);
    }
    if (Math.abs((sumItemsSubtotal + sumItemsIva) - totalDoc) > MONEY_TOLERANCE) {
      return bad(res, `Suma items (sub+iva = ${(sumItemsSubtotal + sumItemsIva).toFixed(2)}) ≠ total documento (${totalDoc.toFixed(2)})`, 400);
    }

    const obraId = toBig(data.obraId);
    const proveedorId = toBig(data.proveedorId);
    const rfqId = data.rfqId != null ? toBig(data.rfqId) : null;
    if (obraId == null || proveedorId == null) return bad(res, 'obraId/proveedorId inválidos', 400);

    // Verificar FK existence rápido (Prisma da error críptico si no existe).
    const [obra, proveedor] = await Promise.all([
      prisma.obra.findUnique({ where: { id: obraId } }),
      prisma.proveedor.findUnique({ where: { id: proveedorId } }),
    ]);
    if (!obra) return bad(res, 'Obra no encontrada', 404);
    if (!proveedor) return bad(res, 'Proveedor no encontrado', 404);
    if (rfqId != null) {
      const rfq = await prisma.solicitudCotizacion.findUnique({ where: { id: rfqId } });
      if (!rfq) return bad(res, 'RFQ no encontrada', 404);
      if (rfq.obraId !== obraId) return bad(res, 'La RFQ no pertenece a la obra indicada', 400);
    }

    const fecha = parseDateOrNull(data.fecha);
    if (!fecha) return bad(res, 'fecha inválida', 400);
    const fechaValidez = parseDateOrNull(data.fechaValidez);

    const created = await prisma.$transaction(async (tx) => {
      return tx.cotizacion.create({
        data: {
          obraId,
          proveedorId,
          rfqId,
          numeroCotizacion: data.numeroCotizacion,
          fecha,
          fechaValidez,
          moneda,
          subtotalAmount: toDec(data.subtotal.amount),
          subtotalCurrency: data.subtotal.currency,
          ivaAmount: toDec(data.iva.amount),
          ivaCurrency: data.iva.currency,
          totalAmount: toDec(data.total.amount),
          totalCurrency: data.total.currency,
          condicionesPago: data.condicionesPago ?? null,
          plazoEntregaDias: data.plazoEntregaDias ?? null,
          pctAnticipo: data.pctAnticipo != null ? toDec(data.pctAnticipo) : null,
          esEspecial: data.esEspecial ?? false,
          archivoPath: data.archivoPath ?? null,
          notas: data.notas ?? null,
          items: {
            create: data.items.map((it, idx) => ({
              materialId: it.materialId != null ? toBig(it.materialId) : null,
              descripcion: it.descripcion,
              cantidad: toDec(it.cantidad),
              unidad: it.unidad,
              precioUnitario: toDec(it.precioUnitario),
              subtotal: toDec(it.subtotal),
              ivaMonto: it.ivaMonto != null ? toDec(it.ivaMonto) : '0',
              codigoCabys: it.codigoCabys ?? null,
              orden: it.orden ?? idx,
            })),
          },
        },
        include: {
          items: { orderBy: { orden: 'asc' } },
          proveedor: true,
          obra: true,
        },
      });
    });

    console.log(`[compras] cotizacion creada id=${created.id} (${data.items.length} items)`);
    return res.status(201).json(created);
  } catch (err) {
    logHandlerError('createCotizacion', err);
    if (err.code === 'P2002') {
      return bad(res, 'Cotización duplicada (constraint unique)', 409);
    }
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function updateCotizacion(req, res) {
  try {
    if (!ROLES_UPDATE.has(req.user?.role)) {
      return bad(res, 'No autorizado', 403);
    }
    const id = toBig(req.params.id);
    if (id == null) return bad(res, 'id inválido', 400);

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return bad(res, `Payload inválido: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 400);
    }

    const existing = await prisma.cotizacion.findUnique({ where: { id } });
    if (!existing) return bad(res, 'Cotización no encontrada', 404);
    if (!EDITABLE_ESTADOS.has(existing.estado)) {
      return res.status(409).json({
        error: 'Cotización no editable en estado actual',
        estado: existing.estado,
      });
    }

    const data = parsed.data;
    const payload = {};
    if (data.numeroCotizacion !== undefined) payload.numeroCotizacion = data.numeroCotizacion;
    if (data.fecha !== undefined) {
      const f = parseDateOrNull(data.fecha);
      if (!f) return bad(res, 'fecha inválida', 400);
      payload.fecha = f;
    }
    if (data.fechaValidez !== undefined) payload.fechaValidez = parseDateOrNull(data.fechaValidez);
    if (data.condicionesPago !== undefined) payload.condicionesPago = data.condicionesPago;
    if (data.plazoEntregaDias !== undefined) payload.plazoEntregaDias = data.plazoEntregaDias;
    if (data.pctAnticipo !== undefined) payload.pctAnticipo = data.pctAnticipo != null ? toDec(data.pctAnticipo) : null;
    if (data.esEspecial !== undefined) payload.esEspecial = data.esEspecial;
    if (data.estado !== undefined) payload.estado = data.estado;
    if (data.archivoPath !== undefined) payload.archivoPath = data.archivoPath;
    if (data.notas !== undefined) payload.notas = data.notas;

    const updated = await prisma.cotizacion.update({
      where: { id },
      data: payload,
      include: { items: { orderBy: { orden: 'asc' } }, proveedor: true, obra: true },
    });
    return res.json(updated);
  } catch (err) {
    logHandlerError('updateCotizacion', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function aprobarCotizacion(req, res) {
  try {
    if (!ROLES_APPROVE.has(req.user?.role)) {
      return bad(res, 'Solo admin/supervisor pueden aprobar cotizaciones', 403);
    }
    const id = toBig(req.params.id);
    if (id == null) return bad(res, 'id inválido', 400);

    const parsed = approveSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return bad(res, `Payload inválido: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 400);
    }

    const { categoriaId, fechaAprobacion } = parsed.data;
    const result = await approveCotizacion(prisma, {
      cotizacionId: id,
      categoriaId,
      fechaAprobacion: fechaAprobacion ?? null,
      approverId: req.user?.id ?? null,
    });
    return res.status(201).json(result);
  } catch (err) {
    if (err.code === 'COTIZACION_TERMINAL') {
      return res.status(409).json({ error: 'Cotización ya está en estado terminal', estado: err.estado });
    }
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'numeroOc duplicado (race condition no manejado)' });
    }
    logHandlerError('aprobarCotizacion', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function rechazarCotizacion(req, res) {
  try {
    if (!ROLES_APPROVE.has(req.user?.role)) {
      return bad(res, 'Solo admin/supervisor pueden rechazar cotizaciones', 403);
    }
    const id = toBig(req.params.id);
    if (id == null) return bad(res, 'id inválido', 400);

    const parsed = rejectSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return bad(res, 'Payload inválido', 400);
    }

    const existing = await prisma.cotizacion.findUnique({ where: { id } });
    if (!existing) return bad(res, 'Cotización no encontrada', 404);
    if (existing.estado === 'aprobada' || existing.estado === 'rechazada') {
      return res.status(409).json({ error: 'Cotización ya está en estado terminal', estado: existing.estado });
    }

    const motivo = parsed.data.motivo?.trim();
    let notas = existing.notas ?? null;
    if (motivo) {
      const stamp = `[RECHAZO ${new Date().toISOString().slice(0, 10)}] ${motivo}`;
      notas = notas ? `${notas}\n${stamp}` : stamp;
    }

    const updated = await prisma.cotizacion.update({
      where: { id },
      data: { estado: 'rechazada', notas },
      include: { items: { orderBy: { orden: 'asc' } }, proveedor: true, obra: true },
    });
    console.log(`[compras] cotizacion ${id} rechazada`);
    return res.json(updated);
  } catch (err) {
    logHandlerError('rechazarCotizacion', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
