-- PRIVATE UNALLOCATED SOURCE PROPOSAL / UNRUN. Needs independent SQL and native-flow review.
-- Compose AFTER the currently frozen generic owners and shared body-write guard; never edit applied SQL.
ALTER TABLE app.assistant_own_leave_review
 ADD COLUMN bank_retained_version integer,
 ADD COLUMN bank_before_hash text,
 ADD COLUMN bank_after_hash text,
 ADD COLUMN bank_event_payload_hash text,
 ADD COLUMN bank_event_scope_hash text,
 ADD COLUMN bank_retained_prepare_hash text,
 ADD COLUMN bank_retained_root_xid xid8;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_bank_retained_columns CHECK(
 CASE WHEN action_kind='employees.bank.maintain' THEN
  (bank_retained_version IS NULL OR bank_retained_version=1)
  AND (bank_retained_prepare_hash IS NULL OR bank_retained_prepare_hash ~ '^[a-f0-9]{64}$')
  AND (bank_before_hash IS NULL OR bank_before_hash ~ '^[a-f0-9]{64}$')
  AND (bank_after_hash IS NULL OR bank_after_hash ~ '^[a-f0-9]{64}$')
  AND (bank_event_payload_hash IS NULL OR bank_event_payload_hash ~ '^[a-f0-9]{64}$')
  AND (bank_event_scope_hash IS NULL OR bank_event_scope_hash ~ '^[a-f0-9]{64}$')
  AND CASE WHEN bank_retained_version IS NOT DISTINCT FROM 1 THEN
   CASE state WHEN 'awaiting_confirmation' THEN bank_retained_prepare_hash IS NOT NULL
     AND bank_before_hash IS NOT NULL AND bank_after_hash IS NOT NULL AND bank_event_payload_hash IS NOT NULL AND bank_event_scope_hash IS NOT NULL
    WHEN 'completed' THEN (bank_retained_prepare_hash IS NULL AND bank_before_hash IS NULL
      AND bank_after_hash IS NULL AND bank_event_payload_hash IS NULL AND bank_event_scope_hash IS NULL AND bank_retained_root_xid IS NULL)
     OR (bank_retained_prepare_hash IS NOT NULL AND bank_before_hash IS NOT NULL
      AND bank_after_hash IS NOT NULL AND bank_event_payload_hash IS NOT NULL AND bank_event_scope_hash IS NOT NULL AND bank_retained_root_xid IS NOT NULL)
    ELSE bank_retained_prepare_hash IS NULL AND bank_before_hash IS NULL
      AND bank_after_hash IS NULL AND bank_event_payload_hash IS NULL AND bank_event_scope_hash IS NULL AND bank_retained_root_xid IS NULL END
   ELSE bank_retained_prepare_hash IS NULL AND bank_before_hash IS NULL
    AND bank_after_hash IS NULL AND bank_event_payload_hash IS NULL AND bank_event_scope_hash IS NULL AND bank_retained_root_xid IS NULL END
 ELSE bank_retained_version IS NULL AND bank_retained_prepare_hash IS NULL AND bank_before_hash IS NULL
  AND bank_after_hash IS NULL AND bank_event_payload_hash IS NULL AND bank_event_scope_hash IS NULL AND bank_retained_root_xid IS NULL END);
--> statement-breakpoint
-- Ordinary non-bank statutory writers should probe only this transaction's armed bank reviews.
CREATE INDEX assistant_bank_review_active_root ON app.assistant_own_leave_review
 (bank_retained_root_xid,tenant_id,decision_subject_person_id)
 WHERE action_kind='employees.bank.maintain' AND bank_retained_version=1 AND bank_retained_root_xid IS NOT NULL
  AND state IN('awaiting_confirmation','completed');
--> statement-breakpoint
CREATE FUNCTION app._bank_retained_hash(p_row public.employee_statutory_my) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
 SELECT encode(sha256(convert_to((to_jsonb(p_row)-ARRAY[
  'bank_name','bank_account_no','enable_custom_holder_name','custom_holder_name',
  'enable_custom_holder_id','custom_holder_id','updated_at'])::text,'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION app._bank_retained_hash(public.employee_statutory_my) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._bank_full_hash(p_row public.employee_statutory_my) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
 SELECT encode(sha256(convert_to(to_jsonb(p_row)::text,'UTF8')),'hex')
$$;
CREATE FUNCTION app._bank_json_hash(p_value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(p_value::text,'UTF8')),'hex')
$$;
CREATE FUNCTION app._bank_values(p_row public.employee_statutory_my) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('bankName',p_row.bank_name,'bankAccountNo',p_row.bank_account_no,
  'enableCustomHolderName',p_row.enable_custom_holder_name,'customHolderName',p_row.custom_holder_name,
  'enableCustomHolderId',p_row.enable_custom_holder_id,'customHolderId',p_row.custom_holder_id)
$$;
REVOKE ALL ON FUNCTION app._bank_full_hash(public.employee_statutory_my),app._bank_json_hash(jsonb),app._bank_values(public.employee_statutory_my) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Join existing native barriers in their established order, before parent/native data locks.
-- Try the SAME owner keys; then canonical owners revalidate while those keys/tuples are already held.
CREATE FUNCTION app._bank_review_interval() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();
BEGIN
 PERFORM app._assistant_leave_decision_login();
 IF t IS NULL THEN RAISE EXCEPTION 'Bank review unavailable' USING ERRCODE='42501';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0)) THEN
  RAISE EXCEPTION 'Bank review busy' USING ERRCODE='55P03';END IF;
 PERFORM 1 FROM app.access_profile_write_generation WHERE tenant_id=t FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Bank review policy unavailable' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.access_configuration WHERE tenant_id=t AND initialized FOR SHARE NOWAIT;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('profile-edit-policy:'||t::text,0)) THEN
  RAISE EXCEPTION 'Bank review busy' USING ERRCODE='55P03';END IF;
 PERFORM app.access_profile_policy_write_lock();
END $$;
REVOKE ALL ON FUNCTION app._bank_review_interval() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Exact existing db/events.ts subjectEmploymentForPerson ordering; generated event ID/sequence
-- remain native-owned slots. All other metadata and the whole payload are independently committed.
CREATE FUNCTION app._bank_event_scope(p_tenant uuid,p_person uuid,p_statutory uuid,p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('tenant_id',p_tenant,'aggregate_type','employee-statutory',
  'aggregate_id',p_statutory,'event_type','employee.bank.updated','actor_type','user','actor_id',p_user,
  'subject_employment_id',(SELECT e.id FROM public.employment e WHERE e.tenant_id=p_tenant AND e.person_id=p_person
   ORDER BY (e.terminated_on IS NOT NULL),e.hired_on,e.id LIMIT 1))
$$;
REVOKE ALL ON FUNCTION app._bank_event_scope(uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Native expected values, not a caller hash assertion. p_after is the closed local-human command
-- normalized by the existing country owner. SQL independently binds actual BEFORE and exact payload;
-- unnormalised/extra values cannot pass the native row/event equality checks later.
CREATE FUNCTION app.assistant_bank_review_expected(p_employment uuid,p_person uuid,p_after jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE scope jsonb;q public.employee_statutory_my%ROWTYPE;k text;
BEGIN
 PERFORM app._bank_review_interval();scope:=app.assistant_bank_maintenance_scope(p_employment);
 IF scope->>'personId' IS DISTINCT FROM p_person::text OR jsonb_typeof(p_after) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'Bank expected command unavailable' USING ERRCODE='42501';END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_after))<>6 OR NOT (p_after ?& ARRAY[
  'bankName','bankAccountNo','enableCustomHolderName','customHolderName','enableCustomHolderId','customHolderId'])
  OR jsonb_typeof(p_after->'enableCustomHolderName') IS DISTINCT FROM 'boolean'
  OR jsonb_typeof(p_after->'enableCustomHolderId') IS DISTINCT FROM 'boolean' THEN
  RAISE EXCEPTION 'Bank expected command unavailable' USING ERRCODE='42501';END IF;
 FOREACH k IN ARRAY ARRAY['bankName','bankAccountNo','customHolderName','customHolderId'] LOOP
  IF jsonb_typeof(p_after->k) NOT IN('string','null') THEN
   RAISE EXCEPTION 'Bank expected command unavailable' USING ERRCODE='42501';END IF;
 END LOOP;
 IF (p_after->'enableCustomHolderName'='false'::jsonb AND p_after->'customHolderName'<>'null'::jsonb)
  OR (p_after->'enableCustomHolderId'='false'::jsonb AND p_after->'customHolderId'<>'null'::jsonb) THEN
  RAISE EXCEPTION 'Bank expected command unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO q FROM public.employee_statutory_my WHERE tenant_id=app.current_tenant_id()
  AND person_id=p_person FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Bank expected source unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('version',1,'before',app._bank_full_hash(q),'retained',app._bank_retained_hash(q),
  'after',app._bank_json_hash(p_after),'scope',app._bank_json_hash(app._bank_event_scope(q.tenant_id,q.person_id,q.id,app.current_user_id())),'event',app._bank_json_hash(jsonb_build_object(
   'personId',q.person_id,'before',app._bank_values(q),'after',p_after)));
END $$;
REVOKE ALL ON FUNCTION app.assistant_bank_review_expected(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_bank_review_expected(uuid,uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
-- Only an actually executing, configured ON DELETE CASCADE whose referenced parent is already
-- absent can remove retained history. Canonical PII erasure scrubs via its existing intent hook;
-- it does not acquire a new blanket permission to delete historical metadata.
CREATE FUNCTION app._bank_review_cascade_admitted(p_row app.assistant_own_leave_review) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ref record;key_value uuid;parent_present boolean;body jsonb:=to_jsonb(p_row);
BEGIN
 FOR ref IN SELECT c.confrelid,child.attname child_name,parent.attname parent_name
  FROM pg_constraint c JOIN pg_attribute child ON child.attrelid=c.conrelid AND child.attnum=c.conkey[1]
   JOIN pg_attribute parent ON parent.attrelid=c.confrelid AND parent.attnum=c.confkey[1]
  WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.contype='f' AND c.confdeltype='c'
   AND cardinality(c.conkey)=1 AND cardinality(c.confkey)=1
 LOOP
  IF body->>ref.child_name IS NULL THEN CONTINUE;END IF;
  -- Never mistake an RLS-hidden parent for an actually absent FK parent.
  IF row_security_active(ref.confrelid) THEN
   RAISE EXCEPTION 'Bank cascade witness unavailable' USING ERRCODE='42501';END IF;
  key_value:=(body->>ref.child_name)::uuid;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s WHERE %I=$1)',ref.confrelid::regclass,ref.parent_name)
   INTO parent_present USING key_value;
  IF NOT parent_present THEN RETURN true;END IF;
 END LOOP;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION app._bank_review_cascade_admitted(app.assistant_own_leave_review) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Existing pending reviews do not contain this proof: retire, never fabricate a prepared preimage.
WITH retired AS (
 UPDATE app.assistant_own_leave_review SET state='refused',intent_digest=NULL,reviewed_digest=NULL
 WHERE action_kind='employees.bank.maintain' AND state='awaiting_confirmation' RETURNING id
) DELETE FROM app.assistant_own_leave_review_content WHERE action_id IN(SELECT id FROM retired);
--> statement-breakpoint
CREATE FUNCTION app._bank_review_parent_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actual_hash text;actual_before text;erasure boolean:=false;
BEGIN
 IF TG_RELID<>'app.assistant_own_leave_review'::regclass OR TG_LEVEL<>'ROW' THEN
  RAISE EXCEPTION 'Bank review fence unavailable' USING ERRCODE='42501';END IF;
 -- Once armed, deleting/recreating or retiring/rearming the pending receipt cannot launder its
 -- native-derived baseline. Only the exact initial completion delta may cross this boundary.
 IF OLD.action_kind='employees.bank.maintain' AND OLD.bank_retained_version=1
  AND OLD.state='awaiting_confirmation' AND OLD.bank_retained_root_xid=pg_current_xact_id() THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Bank armed review immutable' USING ERRCODE='42501';END IF;
  IF NEW.state IS DISTINCT FROM 'completed' OR NEW.receipt_event_id IS NULL
   OR to_jsonb(NEW) IS DISTINCT FROM (to_jsonb(OLD)||jsonb_build_object('state','completed',
    'intent_digest',NULL,'reviewed_digest',NULL,'receipt_event_id',NEW.receipt_event_id)) THEN
   RAISE EXCEPTION 'Bank armed review immutable' USING ERRCODE='42501';END IF;
 END IF;
 IF OLD.action_kind='employees.bank.maintain' AND OLD.bank_retained_version=1 AND OLD.state='completed' THEN
  IF TG_OP='DELETE' THEN
   IF NOT app._bank_review_cascade_admitted(OLD::app.assistant_own_leave_review) THEN RAISE EXCEPTION 'Bank completed identity immutable' USING ERRCODE='42501';END IF;
   IF TG_WHEN='BEFORE' THEN RETURN OLD;END IF;RETURN NULL;
  END IF;
  IF OLD.bank_retained_root_xid=pg_current_xact_id() THEN
   RAISE EXCEPTION 'Bank completed command closed until commit' USING ERRCODE='42501';END IF;
  IF TG_OP='UPDATE' THEN
   IF ROW(NEW.id,NEW.action_kind,NEW.tenant_id,NEW.user_id,NEW.person_id,NEW.employment_id,NEW.company_id,
     NEW.decision_subject_person_id,NEW.receipt_subject_kind,NEW.receipt_subject_id,NEW.receipt_event_id,
     NEW.state,NEW.created_at,NEW.expires_at,NEW.bank_retained_version)
    IS DISTINCT FROM ROW(OLD.id,OLD.action_kind,OLD.tenant_id,OLD.user_id,OLD.person_id,OLD.employment_id,OLD.company_id,
     OLD.decision_subject_person_id,OLD.receipt_subject_kind,OLD.receipt_subject_id,OLD.receipt_event_id,
     OLD.state,OLD.created_at,OLD.expires_at,OLD.bank_retained_version) THEN
    RAISE EXCEPTION 'Bank completed identity immutable' USING ERRCODE='42501';END IF;
   IF ROW(NEW.bank_retained_prepare_hash,NEW.bank_before_hash,NEW.bank_after_hash,NEW.bank_event_payload_hash,NEW.bank_event_scope_hash,NEW.bank_retained_root_xid)
    IS DISTINCT FROM ROW(OLD.bank_retained_prepare_hash,OLD.bank_before_hash,OLD.bank_after_hash,OLD.bank_event_payload_hash,OLD.bank_event_scope_hash,OLD.bank_retained_root_xid) THEN
    SELECT EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id()
     AND i.tenant_id=OLD.tenant_id AND i.user_id=app.current_user_id() AND OLD.id=ANY(i.review_ids)) INTO erasure;
    IF NOT erasure OR NEW.bank_retained_prepare_hash IS NOT NULL OR NEW.bank_before_hash IS NOT NULL OR NEW.bank_after_hash IS NOT NULL OR NEW.bank_event_payload_hash IS NOT NULL OR NEW.bank_event_scope_hash IS NOT NULL OR NEW.bank_retained_root_xid IS NOT NULL THEN
     RAISE EXCEPTION 'Bank private proof erasure unavailable' USING ERRCODE='42501';END IF;
   END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN IF TG_WHEN='BEFORE' THEN RETURN OLD;END IF;RETURN NULL;END IF;
 IF NEW.action_kind='employees.bank.maintain' AND NEW.bank_retained_version=1 THEN
  IF OLD.bank_retained_version=1 AND NEW.bank_retained_version IS DISTINCT FROM OLD.bank_retained_version THEN
   RAISE EXCEPTION 'Bank proof version immutable' USING ERRCODE='42501';END IF;
  IF NEW.state IN('discarded','expired','refused') THEN
   IF TG_WHEN='BEFORE' THEN NEW.bank_retained_prepare_hash:=NULL;NEW.bank_before_hash:=NULL;NEW.bank_after_hash:=NULL;NEW.bank_event_payload_hash:=NULL;NEW.bank_event_scope_hash:=NULL;NEW.bank_retained_root_xid:=NULL;
   ELSIF NEW.bank_retained_prepare_hash IS NOT NULL OR NEW.bank_before_hash IS NOT NULL OR NEW.bank_after_hash IS NOT NULL OR NEW.bank_event_payload_hash IS NOT NULL OR NEW.bank_event_scope_hash IS NOT NULL OR NEW.bank_retained_root_xid IS NOT NULL THEN
    RAISE EXCEPTION 'Bank terminal private proof unavailable' USING ERRCODE='42501';END IF;
  ELSIF NEW.state='awaiting_confirmation' THEN
   IF OLD.bank_retained_version=1 AND ROW(NEW.bank_retained_prepare_hash,NEW.bank_before_hash,NEW.bank_after_hash,NEW.bank_event_payload_hash,NEW.bank_event_scope_hash) IS DISTINCT FROM ROW(OLD.bank_retained_prepare_hash,OLD.bank_before_hash,OLD.bank_after_hash,OLD.bank_event_payload_hash,OLD.bank_event_scope_hash) THEN
    RAISE EXCEPTION 'Bank prepared source immutable' USING ERRCODE='42501';END IF;
   IF OLD.bank_retained_version IS DISTINCT FROM 1 OR NEW.bank_retained_root_xid IS DISTINCT FROM OLD.bank_retained_root_xid THEN
    SELECT app._bank_retained_hash(q),app._bank_full_hash(q) INTO actual_hash,actual_before FROM public.employee_statutory_my q
     WHERE q.tenant_id=NEW.tenant_id AND q.person_id=NEW.decision_subject_person_id;
    IF NEW.bank_retained_prepare_hash IS NULL OR NEW.bank_retained_prepare_hash IS DISTINCT FROM actual_hash OR NEW.bank_before_hash IS DISTINCT FROM actual_before
     OR (NEW.bank_retained_root_xid IS NOT NULL AND NEW.bank_retained_root_xid<>pg_current_xact_id()) THEN
     RAISE EXCEPTION 'Bank retained source changed' USING ERRCODE='42501';END IF;
   END IF;
  ELSIF NEW.state='completed' AND OLD.state='awaiting_confirmation' THEN
   IF NEW.bank_retained_root_xid IS DISTINCT FROM pg_current_xact_id()
    OR ROW(NEW.bank_retained_version,NEW.bank_retained_prepare_hash,NEW.bank_retained_root_xid)
     IS DISTINCT FROM ROW(OLD.bank_retained_version,OLD.bank_retained_prepare_hash,OLD.bank_retained_root_xid) THEN
    RAISE EXCEPTION 'Bank completion arm unavailable' USING ERRCODE='42501';END IF;
  END IF;
 END IF;
 IF OLD.bank_retained_version=1 AND (NEW.action_kind IS DISTINCT FROM OLD.action_kind
  OR NEW.bank_retained_version IS DISTINCT FROM 1) THEN
  RAISE EXCEPTION 'Bank proof binding immutable' USING ERRCODE='42501';END IF;
 IF TG_WHEN='BEFORE' THEN RETURN NEW;END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app._bank_review_parent_fence() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER bank_review_parent_fence BEFORE UPDATE OR DELETE ON app.assistant_own_leave_review
FOR EACH ROW EXECUTE FUNCTION app._bank_review_parent_fence();
CREATE TRIGGER bank_review_parent_fence_after AFTER UPDATE OR DELETE ON app.assistant_own_leave_review
FOR EACH ROW EXECUTE FUNCTION app._bank_review_parent_fence();
--> statement-breakpoint
CREATE FUNCTION app._bank_review_private_erasure() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID<>'app.assistant_review_erasure_intent'::regclass OR TG_OP<>'INSERT'
  OR NEW.xact_id<>pg_current_xact_id() OR NEW.tenant_id<>app.current_tenant_id()
  OR NEW.user_id<>app.current_user_id() THEN
  RAISE EXCEPTION 'Bank private proof erasure unavailable' USING ERRCODE='42501';END IF;
 UPDATE app.assistant_own_leave_review r SET bank_retained_prepare_hash=NULL,bank_before_hash=NULL,bank_after_hash=NULL,bank_event_payload_hash=NULL,bank_event_scope_hash=NULL,bank_retained_root_xid=NULL
 WHERE r.id=ANY(NEW.review_ids) AND r.tenant_id=NEW.tenant_id AND r.action_kind='employees.bank.maintain'
  AND r.bank_retained_version=1;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app._bank_review_private_erasure() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER bank_review_private_erasure AFTER INSERT ON app.assistant_review_erasure_intent
FOR EACH ROW EXECUTE FUNCTION app._bank_review_private_erasure();
--> statement-breakpoint
ALTER FUNCTION app.assistant_assigned_review_prepare(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text)
 RENAME TO _assistant_assigned_review_prepare_bank_previous;
CREATE FUNCTION app.assistant_assigned_review_prepare(p_kind text,p_id uuid,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,p_subject uuid,p_intent text,p_reviewed text,p_kid text,p_wrapped text,p_ciphertext text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_kind='employees.bank.maintain' THEN RAISE EXCEPTION 'Prepare protected bank expected command' USING ERRCODE='42501';END IF;
 RETURN app._assistant_assigned_review_prepare_bank_previous(p_kind,p_id,p_person,p_employment,p_company,p_subject_person,p_subject,p_intent,p_reviewed,p_kid,p_wrapped,p_ciphertext);
END $$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_prepare_bank_previous(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app.assistant_assigned_review_prepare(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_assigned_review_prepare(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) TO ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_json(uuid) RENAME TO _assistant_assigned_review_json_bank_previous;
CREATE FUNCTION app._assistant_assigned_review_json(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE base jsonb;r app.assistant_own_leave_review%ROWTYPE;proof jsonb;
BEGIN
 base:=app._assistant_assigned_review_json_bank_previous(p_id);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id;
 IF NOT FOUND OR r.action_kind<>'employees.bank.maintain' THEN RETURN base;END IF;
 IF r.bank_retained_version=1 AND r.bank_retained_prepare_hash IS NOT NULL THEN
  proof:=jsonb_build_object('version',1,'before',r.bank_before_hash,'retained',r.bank_retained_prepare_hash,
   'after',r.bank_after_hash,'event',r.bank_event_payload_hash,'scope',r.bank_event_scope_hash);
 END IF;
 RETURN jsonb_set(base,'{metadata,binding}',(base#>'{metadata,binding}')||jsonb_build_object('bankProof',proof));
END $$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_json(uuid),app._assistant_assigned_review_json_bank_previous(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_bank_review_prepare(p_id uuid,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,p_subject uuid,p_intent text,p_reviewed text,p_kid text,p_wrapped text,p_ciphertext text,p_after jsonb,p_proof jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;q public.employee_statutory_my%ROWTYPE;proof jsonb;actual jsonb;expected jsonb;
BEGIN
 proof:=app.assistant_bank_review_expected(p_employment,p_subject_person,p_after);
 IF proof IS DISTINCT FROM p_proof THEN RAISE EXCEPTION 'Bank expected source changed before custody' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_assigned_review_prepare_bank_previous('employees.bank.maintain',p_id,p_person,p_employment,p_company,p_subject_person,p_subject,p_intent,p_reviewed,p_kid,p_wrapped,p_ciphertext);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND action_kind='employees.bank.maintain'
  AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() FOR UPDATE NOWAIT;
 IF NOT FOUND OR r.state<>'awaiting_confirmation'
  OR ROW(r.person_id,r.employment_id,r.company_id,r.decision_subject_person_id,r.receipt_subject_id,r.intent_digest,r.reviewed_digest)
   IS DISTINCT FROM ROW(p_person,p_employment,p_company,p_subject_person,p_subject,p_intent,p_reviewed) THEN
  RAISE EXCEPTION 'Bank prepared custody changed' USING ERRCODE='42501';END IF;
 UPDATE app.assistant_own_leave_review SET bank_retained_version=1,bank_retained_prepare_hash=proof->>'retained',
  bank_before_hash=proof->>'before',bank_after_hash=proof->>'after',bank_event_payload_hash=proof->>'event',bank_event_scope_hash=proof->>'scope' WHERE id=r.id;
 expected:=to_jsonb(r)||jsonb_build_object('bank_retained_version',1,'bank_retained_prepare_hash',proof->>'retained',
  'bank_before_hash',proof->>'before','bank_after_hash',proof->>'after','bank_event_payload_hash',proof->>'event','bank_event_scope_hash',proof->>'scope');
 SELECT to_jsonb(a) INTO actual FROM app.assistant_own_leave_review a WHERE a.id=r.id;
 IF actual IS DISTINCT FROM expected OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id)
  OR proof IS DISTINCT FROM app.assistant_bank_review_expected(p_employment,p_subject_person,p_after)
  OR clock_timestamp()>=r.expires_at THEN RAISE EXCEPTION 'Bank prepared custody changed' USING ERRCODE='42501';END IF;
 RETURN app._assistant_assigned_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_bank_review_prepare(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_bank_review_prepare(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,jsonb,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_bank_review_arm(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;q public.employee_statutory_my%ROWTYPE;
 expected_parent jsonb;actual_parent jsonb;expected_body jsonb;actual_body jsonb;
BEGIN
 PERFORM app._bank_review_interval();
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id()
  AND user_id=app.current_user_id() AND action_kind='employees.bank.maintain' FOR UPDATE NOWAIT;
 IF NOT FOUND OR r.state<>'awaiting_confirmation' OR r.bank_retained_version IS DISTINCT FROM 1
  OR r.bank_retained_prepare_hash IS NULL OR clock_timestamp()>=r.expires_at THEN
  RAISE EXCEPTION 'Bank review arm unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_assigned_review_binding(r.action_kind,r.person_id,r.employment_id,r.company_id,r.decision_subject_person_id,r.receipt_subject_id);
 PERFORM app.assistant_bank_maintenance_scope(r.employment_id);
 SELECT * INTO q FROM public.employee_statutory_my WHERE tenant_id=r.tenant_id AND person_id=r.decision_subject_person_id FOR UPDATE NOWAIT;
 IF NOT FOUND OR app._bank_full_hash(q) IS DISTINCT FROM r.bank_before_hash
  OR app._bank_retained_hash(q) IS DISTINCT FROM r.bank_retained_prepare_hash
  OR app._bank_json_hash(app._bank_event_scope(q.tenant_id,q.person_id,q.id,r.user_id)) IS DISTINCT FROM r.bank_event_scope_hash THEN
  RAISE EXCEPTION 'Bank retained source changed' USING ERRCODE='42501';END IF;
 SELECT to_jsonb(c) INTO expected_body FROM app.assistant_own_leave_review_content c WHERE c.action_id=r.id;
 IF expected_body IS NULL THEN RAISE EXCEPTION 'Bank review arm unavailable' USING ERRCODE='42501';END IF;
 expected_parent:=to_jsonb(r)||jsonb_build_object('bank_retained_root_xid',pg_current_xact_id());
 IF r.bank_retained_root_xid IS DISTINCT FROM pg_current_xact_id() THEN
  UPDATE app.assistant_own_leave_review SET bank_retained_root_xid=pg_current_xact_id() WHERE id=r.id;
 END IF;
 -- Re-read after every arm callback. Do not let later completion bless a newly tainted baseline.
 SELECT to_jsonb(a) INTO actual_parent FROM app.assistant_own_leave_review a WHERE a.id=r.id;
 SELECT to_jsonb(c) INTO actual_body FROM app.assistant_own_leave_review_content c WHERE c.action_id=r.id;
 IF actual_parent IS DISTINCT FROM expected_parent OR actual_body IS DISTINCT FROM expected_body THEN
  RAISE EXCEPTION 'Bank armed custody changed' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_leave_decision_login();
 IF app.current_tenant_id() IS DISTINCT FROM r.tenant_id OR app.current_user_id() IS DISTINCT FROM r.user_id
  OR app.principal_snapshot_current() IS NOT TRUE THEN RAISE EXCEPTION 'Bank review arm unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_assigned_review_binding(r.action_kind,r.person_id,r.employment_id,r.company_id,r.decision_subject_person_id,r.receipt_subject_id);
 PERFORM app.assistant_bank_maintenance_scope(r.employment_id);
 SELECT * INTO q FROM public.employee_statutory_my WHERE tenant_id=r.tenant_id AND person_id=r.decision_subject_person_id FOR UPDATE NOWAIT;
 IF NOT FOUND OR app._bank_full_hash(q) IS DISTINCT FROM r.bank_before_hash
  OR app._bank_retained_hash(q) IS DISTINCT FROM r.bank_retained_prepare_hash
  OR app._bank_json_hash(app._bank_event_scope(q.tenant_id,q.person_id,q.id,r.user_id)) IS DISTINCT FROM r.bank_event_scope_hash THEN
  RAISE EXCEPTION 'Bank retained source changed' USING ERRCODE='42501';END IF;
 IF clock_timestamp()>=r.expires_at THEN RAISE EXCEPTION 'Bank completion deadline unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app.assistant_bank_review_arm(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_bank_review_arm(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._bank_retained_native_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;old_hash text;new_hash text;
 old_t uuid;old_p uuid;new_t uuid;new_p uuid;
BEGIN
 IF TG_RELID<>'public.employee_statutory_my'::regclass OR TG_LEVEL<>'ROW' THEN
  RAISE EXCEPTION 'Bank native fence unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP<>'INSERT' THEN old_t:=OLD.tenant_id;old_p:=OLD.person_id;END IF;
 IF TG_OP<>'DELETE' THEN new_t:=NEW.tenant_id;new_p:=NEW.person_id;END IF;
 FOR r IN SELECT a.* FROM app.assistant_own_leave_review a WHERE a.action_kind='employees.bank.maintain'
  AND a.bank_retained_version=1 AND a.bank_retained_root_xid=pg_current_xact_id()
  AND a.state IN('awaiting_confirmation','completed') AND (
   (a.tenant_id=old_t AND a.decision_subject_person_id=old_p)
   OR (a.tenant_id=new_t AND a.decision_subject_person_id=new_p))
 LOOP
  IF r.state='completed' THEN RAISE EXCEPTION 'Bank native command closed until commit' USING ERRCODE='42501';END IF;
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Bank retained source changed' USING ERRCODE='42501';END IF;
  old_hash:=app._bank_retained_hash(OLD::public.employee_statutory_my);new_hash:=app._bank_retained_hash(NEW::public.employee_statutory_my);
  IF old_hash IS DISTINCT FROM r.bank_retained_prepare_hash OR new_hash IS DISTINCT FROM r.bank_retained_prepare_hash THEN
   RAISE EXCEPTION 'Bank retained source changed' USING ERRCODE='42501';END IF;
  IF app._bank_json_hash(app._bank_values(NEW::public.employee_statutory_my)) IS DISTINCT FROM r.bank_after_hash THEN
   RAISE EXCEPTION 'Bank reviewed after-state changed' USING ERRCODE='42501';END IF;
  IF NEW.updated_at IS DISTINCT FROM transaction_timestamp() THEN
   RAISE EXCEPTION 'Bank native timestamp changed' USING ERRCODE='42501';END IF;
 END LOOP;
 IF TG_WHEN='AFTER' THEN RETURN NULL;END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app._bank_retained_native_fence() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER bank_retained_native_fence BEFORE INSERT OR UPDATE OR DELETE ON public.employee_statutory_my
FOR EACH ROW EXECUTE FUNCTION app._bank_retained_native_fence();
CREATE TRIGGER bank_retained_native_fence_after AFTER INSERT OR UPDATE OR DELETE ON public.employee_statutory_my
FOR EACH ROW EXECUTE FUNCTION app._bank_retained_native_fence();
--> statement-breakpoint
-- The selected native event is part of the completed effect, not mutable narration.
CREATE FUNCTION app._bank_completed_event_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old_id uuid;new_id uuid;
BEGIN
 IF TG_RELID<>'public.domain_event'::regclass OR TG_OP NOT IN('UPDATE','DELETE') THEN
  RAISE EXCEPTION 'Bank event fence unavailable' USING ERRCODE='42501';END IF;
 old_id:=OLD.id;IF TG_OP='UPDATE' THEN new_id:=NEW.id;END IF;
 IF EXISTS(SELECT 1 FROM app.assistant_own_leave_review r WHERE r.action_kind='employees.bank.maintain'
  AND r.bank_retained_version=1 AND r.state='completed' AND r.bank_retained_root_xid=pg_current_xact_id()
  AND (r.receipt_event_id=old_id OR r.receipt_event_id=new_id)) THEN
  RAISE EXCEPTION 'Bank native event closed until commit' USING ERRCODE='42501';END IF;
 IF TG_WHEN='AFTER' THEN RETURN NULL;END IF;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app._bank_completed_event_fence() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER bank_completed_event_fence BEFORE UPDATE OR DELETE ON public.domain_event
FOR EACH ROW EXECUTE FUNCTION app._bank_completed_event_fence();
CREATE TRIGGER bank_completed_event_fence_after AFTER UPDATE OR DELETE ON public.domain_event
FOR EACH ROW EXECUTE FUNCTION app._bank_completed_event_fence();
--> statement-breakpoint
CREATE FUNCTION app._bank_review_check_native(p_id uuid,p_event uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;q public.employee_statutory_my%ROWTYPE;d public.domain_event%ROWTYPE;
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id()
  AND user_id=app.current_user_id() AND action_kind='employees.bank.maintain';
 IF NOT FOUND OR r.bank_retained_version IS DISTINCT FROM 1 OR r.bank_retained_root_xid IS DISTINCT FROM pg_current_xact_id() THEN
  RAISE EXCEPTION 'Bank completion arm unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO q FROM public.employee_statutory_my WHERE tenant_id=r.tenant_id AND person_id=r.decision_subject_person_id;
 IF NOT FOUND OR app._bank_retained_hash(q) IS DISTINCT FROM r.bank_retained_prepare_hash THEN
  RAISE EXCEPTION 'Bank native postimage unavailable' USING ERRCODE='42501';END IF;
 IF app._bank_json_hash(app._bank_values(q)) IS DISTINCT FROM r.bank_after_hash THEN
  RAISE EXCEPTION 'Bank reviewed after-state changed' USING ERRCODE='42501';END IF;
 SELECT * INTO d FROM public.domain_event WHERE id=p_event AND tenant_id=r.tenant_id;
 IF NOT FOUND OR app._bank_json_hash(d.payload) IS DISTINCT FROM r.bank_event_payload_hash
  OR app._bank_json_hash(to_jsonb(d)-ARRAY['id','sequence','occurred_at','payload']) IS DISTINCT FROM r.bank_event_scope_hash
  OR d.occurred_at IS DISTINCT FROM transaction_timestamp() THEN
  RAISE EXCEPTION 'Bank reviewed event changed' USING ERRCODE='42501';END IF;
 IF q.updated_at IS DISTINCT FROM transaction_timestamp() OR app._assistant_generic_review_verify(r.id,p_event) IS NOT TRUE THEN
  RAISE EXCEPTION 'Bank native postimage unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._bank_review_check_native(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.assistant_assigned_review_complete(uuid,text,text,uuid) RENAME TO _assistant_assigned_review_complete_bank_previous;
CREATE FUNCTION app.assistant_assigned_review_complete(p_id uuid,p_kind text,p_digest text,p_event uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;q public.employee_statutory_my%ROWTYPE;actual jsonb;expected jsonb;result jsonb;
BEGIN
 IF p_kind IS DISTINCT FROM 'employees.bank.maintain' THEN RETURN app._assistant_assigned_review_complete_bank_previous(p_id,p_kind,p_digest,p_event);END IF;
 PERFORM app._bank_review_interval();
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id()
  AND user_id=app.current_user_id() AND action_kind=p_kind FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Bank completion unavailable' USING ERRCODE='42501';END IF;
 IF r.state='completed' THEN RETURN app._assistant_assigned_review_complete_bank_previous(p_id,p_kind,p_digest,p_event);END IF;
 IF r.state<>'awaiting_confirmation' OR r.bank_retained_version IS DISTINCT FROM 1
  OR r.bank_retained_root_xid IS DISTINCT FROM pg_current_xact_id() OR r.bank_retained_prepare_hash IS NULL
  OR p_event IS NULL OR p_digest IS DISTINCT FROM r.reviewed_digest THEN
  RAISE EXCEPTION 'Bank completion arm unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO q FROM public.employee_statutory_my WHERE tenant_id=r.tenant_id AND person_id=r.decision_subject_person_id FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Bank native postimage unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._bank_review_check_native(r.id,p_event);
 result:=app._assistant_assigned_review_complete_bank_previous(p_id,p_kind,p_digest,p_event);
 expected:=to_jsonb(r)||jsonb_build_object('state','completed','intent_digest',NULL,'reviewed_digest',NULL,'receipt_event_id',p_event);
 SELECT to_jsonb(a) INTO actual FROM app.assistant_own_leave_review a WHERE a.id=r.id;
 IF actual IS DISTINCT FROM expected OR EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) THEN
  RAISE EXCEPTION 'Bank completed custody changed' USING ERRCODE='42501';END IF;
 SELECT * INTO q FROM public.employee_statutory_my WHERE tenant_id=r.tenant_id AND person_id=r.decision_subject_person_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Bank native postimage unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._bank_review_check_native(r.id,p_event);
 IF clock_timestamp()>=r.expires_at THEN RAISE EXCEPTION 'Bank completion deadline unavailable' USING ERRCODE='42501';END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_complete_bank_previous(uuid,text,text,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app.assistant_assigned_review_complete(uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_assigned_review_complete(uuid,text,text,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_bank_review_receipt_valid(p_id uuid,p_event uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;d public.domain_event%ROWTYPE;
BEGIN
 PERFORM app._assistant_leave_decision_login();
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id()
  AND user_id=app.current_user_id() AND action_kind='employees.bank.maintain';
 IF NOT FOUND OR r.state<>'completed' OR p_event IS DISTINCT FROM r.receipt_event_id THEN RETURN false;END IF;
 PERFORM app._assistant_assigned_review_binding(r.action_kind,r.person_id,r.employment_id,r.company_id,r.decision_subject_person_id,r.receipt_subject_id);
 PERFORM app.assistant_bank_maintenance_scope(r.employment_id);
 -- Pre-adoption history is preserved under its existing contract, never upgraded to new proof.
 IF r.bank_retained_version IS NULL THEN RETURN true;END IF;
 IF r.bank_retained_version IS DISTINCT FROM 1 OR r.bank_event_payload_hash IS NULL OR r.bank_event_scope_hash IS NULL THEN RETURN false;END IF;
 SELECT * INTO d FROM public.domain_event WHERE id=p_event AND tenant_id=r.tenant_id;
 IF NOT FOUND THEN RETURN false;END IF;
 -- Historical receipt does not freeze a mutable current statutory row after this command committed.
 RETURN app._bank_json_hash(d.payload) IS NOT DISTINCT FROM r.bank_event_payload_hash
  AND app._bank_json_hash(to_jsonb(d)-ARRAY['id','sequence','occurred_at','payload']) IS NOT DISTINCT FROM r.bank_event_scope_hash;
END $$;
REVOKE ALL ON FUNCTION app.assistant_bank_review_receipt_valid(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_bank_review_receipt_valid(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._bank_review_completion_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;q public.employee_statutory_my%ROWTYPE;
BEGIN
 IF TG_RELID<>'app.assistant_own_leave_review'::regclass THEN
  RAISE EXCEPTION 'Bank completion check unavailable' USING ERRCODE='42501';END IF;
 IF NEW.action_kind<>'employees.bank.maintain' OR NEW.bank_retained_version IS DISTINCT FROM 1
  OR NEW.bank_retained_root_xid IS DISTINCT FROM pg_current_xact_id() THEN RETURN NULL;END IF;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=NEW.id;
 IF NOT FOUND THEN
  IF app._bank_review_cascade_admitted(NEW::app.assistant_own_leave_review) THEN RETURN NULL;END IF;
  RAISE EXCEPTION 'Bank completed custody changed' USING ERRCODE='42501';
 END IF;
 IF r.state<>'completed' OR r.bank_retained_root_xid IS DISTINCT FROM NEW.bank_retained_root_xid
  OR r.bank_retained_prepare_hash IS DISTINCT FROM NEW.bank_retained_prepare_hash
  OR EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) THEN
  RAISE EXCEPTION 'Bank completed custody changed' USING ERRCODE='42501';END IF;
 SELECT * INTO q FROM public.employee_statutory_my WHERE tenant_id=r.tenant_id AND person_id=r.decision_subject_person_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Bank native postimage unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._bank_review_check_native(r.id,r.receipt_event_id);
 IF clock_timestamp()>=r.expires_at THEN RAISE EXCEPTION 'Bank completion deadline unavailable' USING ERRCODE='42501';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app._bank_review_completion_check() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER bank_review_completion_check AFTER INSERT OR UPDATE ON app.assistant_own_leave_review
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN(NEW.action_kind='employees.bank.maintain' AND NEW.state='completed' AND NEW.bank_retained_version=1)
EXECUTE FUNCTION app._bank_review_completion_check();
