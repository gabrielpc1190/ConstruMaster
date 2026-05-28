/**
 * Slug helpers para ConstruMaster.
 *
 * `slugify(text)` produce un slug lowercase ASCII separado por `-` con un
 * máximo configurable de chars (default 80). `uniqueSlug(prisma, base, tableName?, maxLen?)`
 * busca el primer slug libre en la tabla indicada probando `base`, `base-2`, etc.
 *
 * Compartido entre agentes (Obras + Items + cualquier futuro). Si modificás:
 * mantené las firmas y la semántica retro-compatible.
 */

const DEFAULT_MAX_LEN = 80;

/**
 * Convierte texto libre a slug ASCII URL-safe.
 *
 * @param {string} text
 * @param {number} [maxLen=80]
 * @returns {string}
 */
export function slugify(text, maxLen = DEFAULT_MAX_LEN) {
  if (text === null || text === undefined) return '';
  const str = String(text);

  // NFD normalize y descarte de marcas diacríticas (tildes).
  // ̀-ͯ es el rango "Combining Diacritical Marks".
  let s = str.normalize('NFD').replace(/[̀-ͯ]/g, '');

  s = s.toLowerCase();

  // Reemplazo de espacios y separadores comunes por `-`.
  s = s.replace(/[\s_/\\]+/g, '-');

  // Eliminar todo lo que no sea [a-z0-9-].
  s = s.replace(/[^a-z0-9-]+/g, '');

  // Collapse múltiples `-` consecutivos.
  s = s.replace(/-+/g, '-');

  // Trim `-` extremos.
  s = s.replace(/^-+|-+$/g, '');

  if (s.length > maxLen) {
    s = s.slice(0, maxLen).replace(/-+$/g, '');
  }

  return s;
}

/**
 * Encuentra el primer slug libre en `tableName` probando `base`, `base-2`, etc.
 *
 * Acepta nombre de tabla SQL como argumento para reusar el helper en cualquier
 * modelo con columna `slug` (obras: longitud 80; items_catalogo: 220).
 *
 * Retro-compatible: si `tableName` se omite, default `obras` con maxLen 80.
 *
 * Si `base` queda vacío tras slugificar, usa fallback `item-<random>` (o
 * `obra-<random>` para la tabla obras, por nostalgia).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} base
 * @param {string} [tableName='obras']
 * @param {number} [maxLen=80]
 * @returns {Promise<string>}
 */
export async function uniqueSlug(prisma, base, tableName = 'obras', maxLen = DEFAULT_MAX_LEN) {
  // Whitelist del nombre de tabla para evitar SQL injection en $queryRawUnsafe.
  if (!/^[a-z_][a-z0-9_]*$/.test(tableName)) {
    throw new Error(`uniqueSlug: invalid tableName "${tableName}"`);
  }

  let root = slugify(base, maxLen);
  if (!root) {
    const prefix = tableName === 'obras' ? 'obra' : 'item';
    root = `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
  }

  const truncate = (candidate) => {
    if (candidate.length <= maxLen) return candidate;
    return candidate.slice(0, maxLen).replace(/-+$/g, '');
  };

  // Helper para chequear existencia: usa el delegate de Prisma cuando lo
  // conocemos (obras), si no, raw SQL parametrizado contra la tabla.
  async function slugExists(candidate) {
    if (tableName === 'obras' && prisma.obra && typeof prisma.obra.findUnique === 'function') {
      const row = await prisma.obra.findUnique({ where: { slug: candidate } });
      return !!row;
    }
    const rows = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM "${tableName}" WHERE slug = $1 LIMIT 1`,
      candidate
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  let candidate = truncate(root);
  let n = 2;
  // Hard cap defensivo: 10_000 intentos. Si llegamos ahí, algo anda muy mal.
  while (n < 10_000) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await slugExists(candidate);
    if (!exists) return candidate;
    const suffix = `-${n}`;
    const headRoom = maxLen - suffix.length;
    const head = root.slice(0, headRoom).replace(/-+$/g, '');
    candidate = `${head}${suffix}`;
    n += 1;
  }
  throw new Error('uniqueSlug: too many collisions');
}
