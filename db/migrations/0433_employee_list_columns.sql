-- Per-user Personnel listing columns (feedback 579255c3, points 2, 3 and 10).
--
-- list_preferences stores each user's chosen employee-listing columns and their order as
--   {"employeeList": {"selected": ["code","name",...], "order": ["code","name",...]}}
-- NULL = the system default view (Emp ID | Full Name | Company | Department | Position | Status).
-- It is a NAMESPACED envelope rather than a bare array on purpose: this is the second per-user list
-- preference this product will want (dashboard_layout, migration 0207, was the first) and a second
-- bare column per screen does not scale.
--
-- WHY NOT reuse app_user.dashboard_layout: that column is the DASHBOARD's, normalised on every read and
-- write against the live dashboard card config (core/dashboard-prefs.ts). Sharing it would mean the
-- dashboard normaliser deciding what to do with a foreign key it does not recognise — which it drops.
--
-- WHY SECURITY DEFINER rather than an RLS UPDATE policy on app_user: exactly the reasoning migration 0207
-- wrote down for dashboard_layout. A broad UPDATE policy would let a user write ANY of their own columns
-- (person_id, archived_at); these three functions can only ever touch list_preferences, and only for
-- app.current_user_id(). RLS stays intact and one person's columns never reach another's screen.
--
-- No backfill: every existing user reads NULL and gets the default view, which is the view they have today.

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS list_preferences jsonb;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.list_preferences_get()
  RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT list_preferences FROM app_user WHERE id = app.current_user_id();
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.list_preferences_set(p_prefs jsonb)
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE app_user SET list_preferences = p_prefs WHERE id = app.current_user_id();
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.list_preferences_reset()
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE app_user SET list_preferences = NULL WHERE id = app.current_user_id();
$$;--> statement-breakpoint

-- The application role reaches app_user ONLY through these three functions for this column, so the
-- EXECUTE grants are the whole of its access. Without them the first render through ai_hr_app throws
-- `permission denied for function` — production's ALTER DEFAULT PRIVILEGES does not cover functions.
GRANT EXECUTE ON FUNCTION app.list_preferences_get() TO ai_hr_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.list_preferences_set(jsonb) TO ai_hr_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.list_preferences_reset() TO ai_hr_app;
