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
--> statement-breakpoint
-- Same editable Dashboard Card Master for existing tenants; no second Home preference/config store.
-- Existing customer definitions retain their exact values. New tenant provisioning uses the same keys.
INSERT INTO public.dashboard_card_config
 (tenant_id,card_key,name,card_type,status,employee_selectable,default_display,mandatory,display_order,href,audience)
SELECT t.id,v.card_key,v.name,v.card_type,'active',v.card_key<>'summary',true,v.card_key='summary',v.display_order,NULL,'{employee}'::text[]
FROM public.tenant t CROSS JOIN (VALUES
 ('summary','My Day at a Glance','information',1),
 ('today','Your Day','information',2),
 ('calendar','My Calendar','information',3),
 ('notices','Notice Board','information',4),
 ('tasks','Waiting for You','action',5),
 ('timeOff','Time Off','information',6),
 ('team','Who’s Around','information',7),
 ('celebrations','Little Moments','information',8)
) v(card_key,name,card_type,display_order)
ON CONFLICT (tenant_id,card_key) DO NOTHING;
