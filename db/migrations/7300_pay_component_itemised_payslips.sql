-- ADR 0181 (write side): a Pay Item save marks the open runs whose payslips itemise the code (feedback 017d9c25).
-- The marker read payroll_history_native_payslip (6693), a security-barrier view whose row filter is the definer
-- app.payroll_history_native_artifact_allowed(batch, employment, payslip). The containment test on
-- statutory->'componentLines' is not leakproof, so PostgreSQL had to run the authority function for every payslip of
-- every processed or processing run in the tenant before it could discard the slips that do not name the code.
-- Production 24 November 2026: Pay Item saves up to 27.2 s.
--
-- This returns exactly the rows the view would return for that read: the tenant's payslips in the given runs whose
-- componentLines contain the given element, admitted by the SAME app.payroll_history_native_artifact_allowed call the
-- view makes. The only change is the order: the containment is applied first (materialised), so the authority
-- function runs for the matching slips only. The view, its function and every grant are unchanged.
CREATE FUNCTION app.pay_component_itemised_payslips(batch_ids uuid[],line jsonb)
RETURNS TABLE(batch_id uuid,employment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH candidate AS MATERIALIZED (
  SELECT p.id,p.batch_id,p.employment_id FROM public.payslip p
  WHERE p.tenant_id=app.current_tenant_id() AND p.batch_id=ANY(batch_ids)
   AND p.statutory->'componentLines' @> line)
 SELECT c.batch_id,c.employment_id FROM candidate c
 WHERE app.payroll_history_native_artifact_allowed(c.batch_id,c.employment_id,c.id)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.pay_component_itemised_payslips(uuid[],jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.pay_component_itemised_payslips(uuid[],jsonb) TO ai_hr_app;
