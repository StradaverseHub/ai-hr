-- Employee Home consumes the existing resolved Notice audience. Viewing/dismissing a notice may
-- update markers, never the identity of the recipient snapshot. The existing self UPDATE policy
-- proves only employment ownership: without this guard an employee could redirect their own row
-- to another notice and thereby satisfy that notice's recipient SELECT policy.
-- No backfill or audience re-resolution: historical snapshot membership remains unchanged.
CREATE OR REPLACE FUNCTION app.guard_notice_recipient_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.notice_id, NEW.employment_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.notice_id, OLD.employment_id, OLD.created_at) THEN
    RAISE EXCEPTION 'Notice recipient identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'notice_recipient_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.guard_notice_recipient_identity() FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
DROP TRIGGER IF EXISTS notice_recipient_identity_guard ON public.notice_recipient;
--> statement-breakpoint
CREATE TRIGGER notice_recipient_identity_guard
BEFORE UPDATE ON public.notice_recipient
FOR EACH ROW EXECUTE FUNCTION app.guard_notice_recipient_identity();
