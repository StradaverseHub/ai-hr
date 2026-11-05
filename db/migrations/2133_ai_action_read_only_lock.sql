-- Keep both native read-only pause checks on the same shared ai-control barrier.
-- Prevent an action check upgrading a shared feature-policy lock into an exclusive lock.
-- Commands, admission and pause writers retain their existing exclusive lock and predicates.
CREATE OR REPLACE FUNCTION app.ai_agent_action_unpaused(wanted_action text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Fresh AI action controls require Read Committed';END IF;
 IF tid IS NULL OR wanted_action IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_action_kind k WHERE k.id=wanted_action) THEN RAISE EXCEPTION 'Unknown agent action';END IF;
 IF current_setting('transaction_read_only')='on' THEN
  PERFORM pg_advisory_xact_lock_shared(hashtext('ai-control'),hashtext(tid::text));
 ELSE PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text)); END IF;
 RETURN NOT EXISTS(SELECT 1 FROM app.ai_agent_action_pause p WHERE p.tenant_id=tid AND p.action_id=wanted_action AND p.paused);
END $$;
