-- System-user onboarding seam (ADR-0018).
--
-- onboarded_at is per-user UI state. Rather than open a broad RLS UPDATE policy on app_user (which
-- would let a user write any of their own columns), we expose narrow SECURITY DEFINER functions that
-- only ever touch onboarded_at for the CURRENT user (app.current_user_id()). Same seam as app.principal.

CREATE OR REPLACE FUNCTION app.onboarding_status()
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT onboarded_at IS NOT NULL FROM app_user WHERE id = app.current_user_id()), false);
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.onboarding_complete()
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE app_user SET onboarded_at = now()
  WHERE id = app.current_user_id() AND onboarded_at IS NULL;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.onboarding_reset()
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE app_user SET onboarded_at = NULL WHERE id = app.current_user_id();
$$;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.onboarding_status() TO ai_hr_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onboarding_complete() TO ai_hr_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onboarding_reset() TO ai_hr_app;
