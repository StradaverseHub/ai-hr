-- The draft tax check reads payroll history and writes only its ordinary bulk-job progress.
INSERT INTO public.bulk_job_kind(kind,scope_kind,exclusive,input_shape,input_max_bytes,finalize_owner)
VALUES('payroll_draft_tax_readiness',NULL,'none','{"batchId":"string"}'::jsonb,128,false);
--> statement-breakpoint
-- Expose worker ownership as a boolean to authorized batch viewers, including a different payroll operator.
CREATE FUNCTION app.payroll_tax_basis_worker_managed(p_batch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $checked$
 SELECT EXISTS (
  SELECT 1
  FROM public.payroll_tax_basis_batch b
  JOIN public.bulk_job j ON j.tenant_id=b.tenant_id AND j.created_by=b.created_by
    AND b.company_id=ANY(j.company_ids)
  JOIN public.bulk_job_step s ON s.job_id=j.id AND s.tenant_id=b.tenant_id
    AND s.kind='confirm' AND s.payload->>'previewId'=b.preview_id::text
    AND s.payload->>'companyId'=b.company_id::text
  WHERE b.id=p_batch AND b.tenant_id=app.current_tenant_id()
    AND app.principal_snapshot_current() AND app.can_admin_payroll_for(b.company_id)
    AND app.payroll_tax_basis_permission(b.company_id,'payroll.tax-basis.view')
    AND j.kind='payroll_tax_basis_group' AND j.state IN ('running','finalizing')
 )
$checked$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_tax_basis_worker_managed(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_tax_basis_worker_managed(uuid) TO ai_hr_app;
