-- Board 4604dccc (ADR 2026-11-15 dated information corrections): payroll history imports under the company the
-- employee belonged to during the payroll month.
--
-- The 0602 binding trigger accepted a payroll history record only for the employment's company TODAY, so a month
-- imported under the company that actually paid it was refused at commit once the employee had transferred (the
-- import's check now places each month by the dated history, core/payroll-history-import.ts). The record is now bound
-- when the employment is in that company today OR a live dated assignment places it there during the record's month
-- (the 0631/2011 payroll-close rule, narrowed to the month). The payroll cycle must still belong to that company and
-- the tenant must still match; nothing else changes.
--
-- Applies as the restricted owner: app.payroll_history_bind_record is owner-owned (0602) and replaced in place, so
-- its trigger, owner and privileges are kept; no purpose-owned object, table, grant, policy or row is changed.
CREATE OR REPLACE FUNCTION app.payroll_history_bind_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE month_start date;month_end date;
BEGIN
 IF NEW.period IS NULL OR NEW.period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'Payroll import record identity mismatch'; END IF;
 month_start:=to_date(NEW.period||'-01','YYYY-MM-DD');month_end:=(month_start+interval '1 month'-interval '1 day')::date;
 IF NOT EXISTS(SELECT 1 FROM public.employment e JOIN public.payroll_cycle c ON c.id=NEW.cycle_id
  WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id AND c.tenant_id=NEW.tenant_id AND c.company_id=NEW.company_id
   AND (e.company_id=NEW.company_id OR EXISTS(SELECT 1 FROM public.assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id
    AND a.superseded_at IS NULL AND a.company_id=NEW.company_id AND a.valid_from<=month_end AND (a.valid_to IS NULL OR a.valid_to>month_start))))
 THEN RAISE EXCEPTION 'Payroll import record identity mismatch'; END IF;
 RETURN NEW;
END $$;
