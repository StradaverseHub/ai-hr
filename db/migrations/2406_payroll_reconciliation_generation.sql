-- A durable receipt is created by successful Payroll processing, before anyone opens Reports.
-- Keep source identity and revision fingerprints only; Payroll remains the owner of the money.
CREATE TABLE public.payroll_reconciliation_generation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  company_id uuid NOT NULL,
  previous_period text NOT NULL,
  current_period text NOT NULL,
  source_event_id uuid NOT NULL,
  source_batches uuid[] NOT NULL,
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  generated_at timestamptz NOT NULL,
  FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
  UNIQUE (source_event_id, current_period)
);
CREATE INDEX payroll_reconciliation_generation_lookup ON public.payroll_reconciliation_generation
  (tenant_id, company_id, current_period, generated_at DESC);
ALTER TABLE public.payroll_reconciliation_generation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_reconciliation_generation FROM PUBLIC,ai_hr_app;
GRANT SELECT ON public.payroll_reconciliation_generation TO ai_hr_app;
CREATE POLICY payroll_reconciliation_generation_read ON public.payroll_reconciliation_generation FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.payroll_reconciliation_remark_access(company_id));
--> statement-breakpoint
CREATE FUNCTION app.capture_payroll_reconciliation_generation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source_company uuid; source_period text; current_month text; previous_month text;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() THEN RETURN NEW; END IF;
  SELECT b.company_id,b.pay_period INTO source_company,source_period
  FROM public.payroll_batch b
  WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.aggregate_id
    AND b.status IN ('processed','closed') AND b.needs_recalc_at IS NULL;
  IF NOT FOUND OR source_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN RETURN NEW; END IF;
  -- Reprocessing affects this month and, where already processed, the following month.
  FOR current_month IN SELECT unnest(ARRAY[source_period,to_char(to_date(source_period,'YYYY-MM')+interval '1 month','YYYY-MM')])
  LOOP
    previous_month:=to_char(to_date(current_month,'YYYY-MM')-interval '1 month','YYYY-MM');
    WITH batches AS MATERIALIZED (
      SELECT b.id,b.status,b.pay_period,b.employee_count,b.needs_recalc_at
      FROM public.payroll_history_effective_batch b
      WHERE b.tenant_id=NEW.tenant_id AND b.company_id=source_company
        AND b.pay_period IN (previous_month,current_month)
        AND (b.history_import_attempt_id IS NULL OR b.employee_count>0)
      LIMIT 10001
    ), valid AS (
      SELECT array_agg(b.id ORDER BY b.id) ids
      FROM batches b
      HAVING count(*) BETWEEN 2 AND 10000 AND sum(b.employee_count) BETWEEN 1 AND 20000
        AND count(*) FILTER (WHERE b.pay_period=previous_month)>0
        AND count(*) FILTER (WHERE b.pay_period=current_month)>0
        AND bool_and(b.needs_recalc_at IS NULL AND
          (b.status='closed' OR (b.pay_period=current_month AND b.status='processed')))
    ), per_batch AS (
      SELECT b.id, b.employee_count, count(p.id) n,
        string_agg(p.id::text||':'||p.version::text, ',' ORDER BY p.id) refs
      FROM valid v JOIN batches b ON b.id=ANY(v.ids)
      LEFT JOIN public.payslip p ON p.tenant_id=NEW.tenant_id AND p.batch_id=b.id
      GROUP BY b.id,b.employee_count
    ), fingerprint AS (
      SELECT encode(sha256(convert_to(string_agg(p.id::text||':'||coalesce(p.refs,''),';' ORDER BY p.id),'UTF8')),'hex') digest
      FROM per_batch p HAVING count(*)>0 AND bool_and(p.n=p.employee_count)
    )
    INSERT INTO public.payroll_reconciliation_generation
      (tenant_id,company_id,previous_period,current_period,source_event_id,source_batches,source_fingerprint,generated_at)
    SELECT NEW.tenant_id,source_company,previous_month,current_month,NEW.id,v.ids,f.digest,NEW.occurred_at
    FROM valid v CROSS JOIN fingerprint f
    ON CONFLICT (source_event_id,current_period) DO NOTHING;
  END LOOP;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.capture_payroll_reconciliation_generation() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER payroll_reconciliation_generation AFTER INSERT ON public.domain_event FOR EACH ROW
 WHEN (NEW.aggregate_type='payroll-batch' AND NEW.event_type IN ('payroll-batch.processed','payroll-batch.selective-reprocessed','payroll-batch.closed'))
 EXECUTE FUNCTION app.capture_payroll_reconciliation_generation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_reconciliation_company_in_use(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.principal_snapshot_current() AND app.is_admin() AND EXISTS (
   SELECT 1 FROM public.company c WHERE c.id=target AND c.tenant_id=app.current_tenant_id()
     AND app.is_admin_for(coalesce(app.company_org_current_parent(c.id),c.id))
 ) THEN (
   EXISTS (SELECT 1 FROM public.payroll_reconciliation_remark r WHERE r.company_id=target AND r.tenant_id=app.current_tenant_id())
   OR EXISTS (SELECT 1 FROM public.payroll_reconciliation_generation g WHERE g.company_id=target AND g.tenant_id=app.current_tenant_id())
 ) ELSE false END
$$;
