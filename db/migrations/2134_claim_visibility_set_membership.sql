-- Same native visibility owner and tenant clamp, with hashable membership instead of a
-- linear array scan per Claim. No result/permission cache, grants, delegation or WITH CHECK changes.
-- Refuse an unexpected installed policy rather than overwriting another owner's narrowing.
DO $claim_visibility_baseline$
DECLARE reviewed_qual text;
BEGIN
 SELECT regexp_replace(pg_get_expr(p.polqual,p.polrelid),'\s+','','g') INTO reviewed_qual
 FROM pg_policy p WHERE p.polrelid='public.claim_request'::regclass AND p.polname='claim_request_rls';
 IF reviewed_qual IS DISTINCT FROM '((tenant_id=app.current_tenant_id())AND(employment_id=ANY((SELECTapp.visible_employment_ids()ASvisible_employment_ids)::uuid[])))' THEN
  RAISE EXCEPTION 'Claim visibility policy differs from the reviewed baseline' USING ERRCODE='55000';
 END IF;
END;
$claim_visibility_baseline$;
--> statement-breakpoint
ALTER POLICY claim_request_rls ON public.claim_request
 USING (tenant_id=app.current_tenant_id() AND employment_id IN (SELECT unnest(app.visible_employment_ids())));
