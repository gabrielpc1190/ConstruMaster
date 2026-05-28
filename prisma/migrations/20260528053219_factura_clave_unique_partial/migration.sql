-- Postgres allows multiple NULLs in a UNIQUE column, but we want clave_numerica
-- to be unique only when present (an electronic invoice MUST have one and only one).
CREATE UNIQUE INDEX factura_clave_numerica_unique
  ON facturas (clave_numerica)
  WHERE clave_numerica IS NOT NULL;
