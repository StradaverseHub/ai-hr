-- PRIVATE SOURCE PROPOSAL, UNALLOCATED / UNRUN. Append only after coordinator allocation.
-- This is a write invariant, not a completion/native-proof/expiry or historical erasure proof.
-- No installed SQL is rewritten. No kind allowlist, role provisioning, object grant or RLS change.
CREATE FUNCTION app._assistant_review_body_pending_parent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent_id uuid; parent_state text;
BEGIN
 IF TG_RELID<>'app.assistant_own_leave_review_content'::regclass
  OR TG_OP NOT IN('INSERT','UPDATE') OR TG_LEVEL<>'ROW' OR TG_WHEN NOT IN('BEFORE','AFTER') THEN
  RAISE EXCEPTION 'Review body requires pending parent' USING ERRCODE='42501';
 END IF;
 -- Check OLD too: an UPDATE cannot move a terminal parent's body back into a pending review.
 -- UPDATE already holds its body tuple before BEFORE triggers. A retirement may hold the parent
 -- while awaiting that body: blocking here would invert the canonical parent->body lock order.
 -- NOWAIT aborts the entire body writer with truthful55P03; no inner catch or fabricated42501.
 FOR parent_id IN
  SELECT DISTINCT id FROM unnest(CASE WHEN TG_OP='UPDATE'
   THEN ARRAY[OLD.action_id,NEW.action_id] ELSE ARRAY[NEW.action_id] END) AS parents(id) ORDER BY id
 LOOP
  SELECT r.state INTO parent_state FROM app.assistant_own_leave_review r WHERE r.id=parent_id FOR SHARE NOWAIT;
  IF NOT FOUND OR parent_state IS DISTINCT FROM 'awaiting_confirmation' THEN
   RAISE EXCEPTION 'Review body requires pending parent' USING ERRCODE='42501';
  END IF;
 END LOOP;
 IF TG_WHEN='BEFORE' THEN RETURN NEW;END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app._assistant_review_body_pending_parent() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER aaa_assistant_review_body_pending_parent
BEFORE INSERT OR UPDATE ON app.assistant_own_leave_review_content
FOR EACH ROW EXECUTE FUNCTION app._assistant_review_body_pending_parent();
--> statement-breakpoint
-- Ordinary AFTER observes the final tuple even if a later-sorted BEFORE writer changes action_id.
CREATE TRIGGER aaa_assistant_review_body_pending_parent_after
AFTER INSERT OR UPDATE ON app.assistant_own_leave_review_content
FOR EACH ROW EXECUTE FUNCTION app._assistant_review_body_pending_parent();
