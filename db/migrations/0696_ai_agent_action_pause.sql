-- 0696 — WP12 / R8 (ADR-0151 §4.7, ADR-0116): one pause key per Assistant agent action, `hr_assistant:<actionId>`,
-- UNDER the existing hr_assistant pause. Reserved 0696, journal when 1793330000022.
--
-- The module pause (app.ai_action_unpaused('hr_assistant'), 0621/0692) is unchanged and still stops every action.
-- This table adds a narrower stop: a group administrator can pause ONE registry action (app.assistant_action_kind,
-- 0693) for the tenant while the Assistant keeps running. A pause stops only the agent's part (prepare, reopen,
-- confirm, choices through the Assistant review routes); the native human page is unaffected.
--
-- Writes go only through app.ai_agent_action_pause_set (group administrator with a current principal snapshot, fresh
-- tenant/actor checks, under the same ai-control advisory lock the policy writers and the pause check use). A group
-- administrator can read the full rows; every other session of the tenant sees only (action_id, paused) through
-- app.ai_agent_action_pauses(). Nobody writes the table directly. The enforcement read,
-- app.ai_agent_action_unpaused, takes the same lock, so a confirm in flight and a pause serialize.
-- No HR, person or pay data is stored here: the tenant, the action kind, the flag and who changed it.
CREATE TABLE app.ai_agent_action_pause(
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 action_id text NOT NULL REFERENCES app.assistant_action_kind(id),
 paused boolean NOT NULL,
 updated_by_user_id uuid REFERENCES public.app_user(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,action_id)
);
--> statement-breakpoint
ALTER TABLE app.ai_agent_action_pause ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON app.ai_agent_action_pause FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT ON app.ai_agent_action_pause TO ai_hr_app;
--> statement-breakpoint
-- Full rows (who changed it, when) only for a group administrator of the same tenant; other tenants' rows are invisible.
CREATE POLICY ai_agent_action_pause_read ON app.ai_agent_action_pause FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.is_group_admin());
--> statement-breakpoint
-- The narrow view for every other session of the tenant (company HR's registry view, the Assistant): which actions are
-- paused, nothing about who or when.
CREATE FUNCTION app.ai_agent_action_pauses()
 RETURNS TABLE(action_id text,paused boolean) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT p.action_id,p.paused FROM app.ai_agent_action_pause p WHERE app.current_tenant_id() IS NOT NULL AND p.tenant_id=app.current_tenant_id() ORDER BY p.action_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_agent_action_pauses() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_agent_action_pauses() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_agent_action_pause_set(wanted_action text,wanted_paused boolean)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();
BEGIN
 IF tid IS NULL OR uid IS NULL OR wanted_action IS NULL OR wanted_paused IS NULL THEN RAISE EXCEPTION 'AI action pause unavailable';END IF;
 -- As 0674: the claimed session must match the principal's current grants (a stale or forged claim is refused).
 IF app.principal_snapshot_current() IS NOT TRUE THEN RAISE EXCEPTION 'Current principal could not be confirmed' USING ERRCODE='42501';END IF;
 IF app.is_group_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Only a group administrator may pause an agent action';END IF;
 IF NOT EXISTS(SELECT 1 FROM tenant WHERE id=tid AND status IN ('active','trial')) THEN RAISE EXCEPTION 'AI unavailable';END IF;
 IF NOT EXISTS(SELECT 1 FROM app_user WHERE id=uid AND tenant_id=tid) THEN RAISE EXCEPTION 'Unknown actor';END IF;
 IF NOT EXISTS(SELECT 1 FROM app.assistant_action_kind k WHERE k.id=wanted_action) THEN RAISE EXCEPTION 'Unknown agent action';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));
 INSERT INTO app.ai_agent_action_pause(tenant_id,action_id,paused,updated_by_user_id,updated_at)
 VALUES(tid,wanted_action,wanted_paused,uid,now())
 ON CONFLICT(tenant_id,action_id) DO UPDATE SET paused=excluded.paused,updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_agent_action_pause_set(text,boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_agent_action_pause_set(text,boolean) TO ai_hr_app;
--> statement-breakpoint
-- Answers only whether this one action is unpaused. It grants no authority and is called AFTER
-- app.ai_action_unpaused('hr_assistant') in the same Read Committed transaction as the effect.
CREATE FUNCTION app.ai_agent_action_unpaused(wanted_action text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Fresh AI action controls require Read Committed';END IF;
 IF tid IS NULL OR wanted_action IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_action_kind k WHERE k.id=wanted_action) THEN RAISE EXCEPTION 'Unknown agent action';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));
 RETURN NOT EXISTS(SELECT 1 FROM app.ai_agent_action_pause p WHERE p.tenant_id=tid AND p.action_id=wanted_action AND p.paused);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_agent_action_unpaused(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_agent_action_unpaused(text) TO ai_hr_app;
