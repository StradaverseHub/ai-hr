-- The original-employer read calls the principal and payroll permission checks.
-- Their company ancestry lookup uses a FORCE ROW LEVEL SECURITY table, even
-- for the function owner. Keep row security on for the whole nested read.
ALTER FUNCTION app.payroll_tax_basis_original_employer_read(uuid)
  SET row_security = on;
