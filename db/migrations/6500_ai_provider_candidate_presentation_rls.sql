-- Candidate metadata is displayed in a repeatable-read, read-only snapshot. The original
-- custody policy admits only read-committed evaluation/commands, silently hiding saved rows.
-- Add SELECT only for the existing presentation proof; keep all write policies and grants intact.
CREATE POLICY ai_provider_candidate_owner_presentation ON public.ai_provider_candidate
 FOR SELECT
 USING (
  current_user=pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.ai_provider_candidate'::regclass))
  AND tenant_id=app.current_tenant_id()
  AND app._ai_provider_presentation_actor_valid()
 );
