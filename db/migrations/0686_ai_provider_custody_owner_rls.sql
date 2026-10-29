-- Provider custody functions must work with the installation's non-BYPASSRLS owner.
-- Keep FORCE RLS and ordinary app-role table revocations. Only the table owner executing
-- an existing SECURITY DEFINER issuer may use these rows, for a freshly authorised group admin
-- in the current tenant. Existing issuers still own candidate/receipt validation and promotion.
CREATE POLICY ai_provider_candidate_owner_custody ON public.ai_provider_candidate
 FOR ALL TO PUBLIC
 USING (
  current_user=pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.ai_provider_candidate'::regclass))
  AND tenant_id=app.current_tenant_id() AND app._ai_provider_evaluation_actor_valid()
 )
 WITH CHECK (
  current_user=pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.ai_provider_candidate'::regclass))
  AND tenant_id=app.current_tenant_id() AND app._ai_provider_evaluation_actor_valid()
 );
--> statement-breakpoint
CREATE POLICY ai_provider_protocol_evaluation_owner_custody ON public.ai_provider_protocol_evaluation
 FOR ALL TO PUBLIC
 USING (
  current_user=pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.ai_provider_protocol_evaluation'::regclass))
  AND tenant_id=app.current_tenant_id() AND app._ai_provider_evaluation_actor_valid()
 )
 WITH CHECK (
  current_user=pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.ai_provider_protocol_evaluation'::regclass))
  AND tenant_id=app.current_tenant_id() AND app._ai_provider_evaluation_actor_valid()
 );
