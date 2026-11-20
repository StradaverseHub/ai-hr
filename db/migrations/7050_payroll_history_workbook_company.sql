-- Approved feedback 11f50cd4: a historical workbook can identify its own payroll
-- company without supplying dated Personnel evidence. The existing company-scoped
-- record policy and the payslip subject policy still govern their respective writes.
CREATE OR REPLACE FUNCTION app.payroll_history_bind_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET row_security = on AS $$
DECLARE
  month_start date;
  month_end date;
BEGIN
  IF NEW.period IS NULL OR NEW.period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'Payroll import record identity mismatch';
  END IF;
  month_start := to_date(NEW.period || '-01', 'YYYY-MM-DD');
  month_end := (month_start + interval '1 month' - interval '1 day')::date;

  IF NOT EXISTS (
    SELECT 1
    FROM public.employment e
    JOIN public.payroll_cycle cycle ON cycle.id = NEW.cycle_id
    WHERE e.id = NEW.employment_id AND e.tenant_id = NEW.tenant_id
      AND cycle.tenant_id = NEW.tenant_id AND cycle.company_id = NEW.company_id
      AND (
        e.company_id = NEW.company_id
        OR EXISTS (
          SELECT 1 FROM public.assignment a
          WHERE a.employment_id = e.id AND a.tenant_id = e.tenant_id
            AND a.superseded_at IS NULL AND a.company_id = NEW.company_id
            AND a.valid_from <= month_end AND (a.valid_to IS NULL OR a.valid_to > month_start)
        )
        OR (
          NEW.tenant_id = app.current_tenant_id()
          AND e.voided_at IS NULL
          AND app.principal_snapshot_current()
          AND app.can_admin_payroll_for(e.company_id)
          AND app.payroll_history_maintenance_permission(NEW.company_id, 'payroll.history.import')
        )
      )
  ) THEN
    RAISE EXCEPTION 'Payroll import record identity mismatch';
  END IF;
  RETURN NEW;
END
$$;
