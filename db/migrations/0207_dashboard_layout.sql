-- Per-user employee dashboard layout (feedback 7d9d145d).
--
-- dashboard_layout stores the employee's preferred vertical order of dashboard blocks as a JSON array
-- of block ids (e.g. ["plannedAbsences","cards",...]); NULL = the system default order. It is per-user
-- UI state — exactly like app_user.onboarded_at (ADR-0018) — so rather than open a broad RLS UPDATE
-- policy on app_user (which would let a user write ANY of their own columns), we expose narrow
-- SECURITY DEFINER functions that only ever touch dashboard_layout for the CURRENT user
-- (app.current_user_id()). This keeps RLS intact: a user can read/write only their own row.

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS dashboard_layout jsonb;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.dashboard_layout_get()
  RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT dashboard_layout FROM app_user WHERE id = app.current_user_id();
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.dashboard_layout_set(p_layout jsonb)
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE app_user SET dashboard_layout = p_layout WHERE id = app.current_user_id();
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.dashboard_layout_reset()
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE app_user SET dashboard_layout = NULL WHERE id = app.current_user_id();
$$;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.dashboard_layout_get() TO ai_hr_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.dashboard_layout_set(jsonb) TO ai_hr_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.dashboard_layout_reset() TO ai_hr_app;
