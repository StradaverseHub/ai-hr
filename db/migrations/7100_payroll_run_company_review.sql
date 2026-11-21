-- Project one authorized company at a time. Keep the raw group, bulk-job,
-- settlement and cancellation policies unchanged.
CREATE FUNCTION app.payroll_run_review(p_group uuid)
RETURNS TABLE (
  kind text, pay_period text, started_at timestamptz, settled_end_at timestamptz,
  outcome jsonb, job jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $review$
  WITH selected AS MATERIALIZED (
    SELECT g.*
    FROM public.payroll_run_group g
    WHERE g.id=p_group AND g.tenant_id=app.current_tenant_id()
      AND g.sealed_at IS NOT NULL AND app.principal_snapshot_current()
  ),
  outcomes AS MATERIALIZED (
    SELECT g.id, o.value, o.ordinal
    FROM selected g
    CROSS JOIN LATERAL jsonb_array_elements(g.outcomes) WITH ORDINALITY o(value,ordinal)
  ),
  visible AS MATERIALIZED (
    SELECT o.*, c.id AS company_id
    FROM outcomes o
    JOIN selected g ON g.id=o.id
    JOIN public.company c
      ON c.id=CASE WHEN o.value->>'companyId' ~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'
                  THEN (o.value->>'companyId')::uuid END
      AND c.tenant_id=g.tenant_id AND c.id=ANY(g.company_ids)
    WHERE app.can_admin_payroll_for(c.id)
  ),
  saved AS (
    SELECT g.id, item.value->>'companyId' AS company_id, item.value
    FROM selected g
    CROSS JOIN LATERAL jsonb_array_elements(g.result->'perCompany') item(value)
  )
  SELECT g.kind, g.pay_period, coalesce((g.result->>'startedAt')::timestamptz,g.started_at),
    CASE WHEN (SELECT count(*) FROM visible)=(SELECT count(*) FROM outcomes)
      THEN coalesce((g.result->>'endedAt')::timestamptz,g.ended_at) END,
    (SELECT jsonb_object_agg(f.key,f.value)
      FROM jsonb_each(coalesce(s.value,v.value)) f(key,value)
      WHERE f.key IN ('companyId','companyName','status','batchId','employeesSelected','employeesSucceeded',
        'employeesSkipped','reason','transactionFailure','historicalTaxPeriod','missingCycleRunType','failed')),
    CASE WHEN j.id IS NOT NULL THEN jsonb_build_object(
      'state',j.state,'stepsTotal',j.steps_total,'stepsDone',j.steps_done,'updatedAt',j.updated_at,'finished_at',j.finished_at,
      'result',jsonb_build_object('payslips',j.result->'payslips','skipped',j.result->'skipped'),
      'plan',jsonb_strip_nulls(jsonb_build_object('failureReason',j.plan->'failureReason','transactionFailure',j.plan->'transactionFailure')),
      'historicalTaxPeriod',substring(j.error FROM '^Imported wage inputs require review for ([0-9]{4}-(?:0[1-9]|1[0-2]))[.] Preview the historical tax inputs and resolve the named missing evidence[.]$')
    ) END
  FROM visible v
  JOIN selected g ON g.id=v.id
  LEFT JOIN saved s ON s.id=g.id AND s.company_id=v.company_id::text
  LEFT JOIN public.bulk_job j
    ON j.id=CASE WHEN v.value->>'jobId' ~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'
                THEN (v.value->>'jobId')::uuid END
    AND v.value->>'status'='processing' AND j.kind='payroll_process'
    AND j.tenant_id=g.tenant_id AND j.created_by=g.created_by
    AND j.company_ids=ARRAY[v.company_id]
  ORDER BY v.ordinal
$review$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_run_review(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_run_review(uuid) TO ai_hr_app;
