/**
 * Helpers de autorización por rol.
 *
 * Asume que `authenticateToken` ya corrió y dejó `req.user = { id, username, role }`.
 *
 * Compartido entre agentes: si lo extendés, mantené `requireRole` y las
 * constantes (`WRITE_ROLES`, `CATALOG_WRITE`, `ALL_ROLES`) con su semántica.
 */

export const WRITE_ROLES = ['admin', 'supervisor'];
export const CATALOG_WRITE = ['admin', 'supervisor', 'operativo'];
export const ALL_ROLES = ['admin', 'supervisor', 'operativo', 'lector'];
// Alias requerido por la spec de los CRUDs Obras/Bodegas.
export const ALL_AUTH_ROLES = ALL_ROLES;

/**
 * Factory de middleware: devuelve 403 si `req.user.role` no está en `roles`.
 * @param  {...string} roles
 * @returns {import('express').RequestHandler}
 */
export function requireRole(...roles) {
  const allowed = new Set(roles);
  return function requireRoleMiddleware(req, res, next) {
    if (!req.user || !req.user.role) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!allowed.has(req.user.role)) {
      return res.status(403).json({
        error: `Role not allowed (need one of: ${[...allowed].join(', ')})`,
      });
    }
    return next();
  };
}
