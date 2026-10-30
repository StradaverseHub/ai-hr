-- 0751 / idx730 / when1793330000088: UNAPPLIED PROVISIONAL DEVELOPMENT ONLY.
-- Unexposed source under exact coordinator review. Never materialize a read-time default policy row.
-- Native provenance only: no ciphertext, review content, person facts or second review ledger.
CREATE TABLE app.people_general_native_observation(
 call_id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
 user_id uuid,native_xid xid8 NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 desired_nric boolean NOT NULL,desired_email boolean NOT NULL,
 inserted_policy boolean NOT NULL DEFAULT false,insert_revision uuid,
 before_nric boolean,before_email boolean,before_revision uuid,
 revision uuid UNIQUE,event_id uuid UNIQUE REFERENCES public.domain_event(id) ON DELETE CASCADE,
 CHECK(inserted_policy=(insert_revision IS NOT NULL)),
 CHECK((event_id IS NULL)=(revision IS NULL) AND (event_id IS NULL)=(before_nric IS NULL) AND (event_id IS NULL)=(before_email IS NULL)),
 CHECK(event_id IS NULL OR ((before_revision IS NULL)=inserted_policy))
);
ALTER TABLE app.people_general_native_observation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.people_general_native_observation FROM PUBLIC,ai_hr_app;
CREATE UNIQUE INDEX people_general_native_entered ON app.people_general_native_observation(tenant_id,native_xid) WHERE event_id IS NULL;
--> statement-breakpoint
CREATE FUNCTION app._people_general_policy_insert_observation() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP<>'INSERT' OR TG_RELID<>'public.people_general_policy'::regclass THEN RAISE EXCEPTION 'Policy observation unavailable' USING ERRCODE='42501';END IF;
 -- This row exists only while the native setter is executing. Other admission transactions
 -- cannot mark it: actual relation, tenant, native top-XID and actor must all match.
 UPDATE app.people_general_native_observation SET inserted_policy=true,insert_revision=NEW.revision
 WHERE tenant_id=NEW.tenant_id AND native_xid=pg_current_xact_id() AND user_id IS NOT DISTINCT FROM app.current_user_id() AND event_id IS NULL;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app._people_general_policy_insert_observation() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER people_general_policy_native_insert_observation AFTER INSERT ON public.people_general_policy
 FOR EACH ROW EXECUTE FUNCTION app._people_general_policy_insert_observation();
--> statement-breakpoint
-- SAME native body, UUID return, checks, audit payload and default two-argument delegation.
-- The owner captures its actual INSERT event ID and new revision together; no latest-event lookup.
CREATE OR REPLACE FUNCTION app.people_general_set(p_allow boolean,p_allow_email boolean,p_expected uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();previous boolean;previous_email boolean;actual uuid;next_revision uuid:=gen_random_uuid();
 call_key uuid:=gen_random_uuid();created_policy boolean;created_revision uuid;created_event uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF app.people_general_can_configure() IS NOT TRUE OR p_allow IS NULL OR p_allow_email IS NULL THEN
  RAISE EXCEPTION 'Whole organisation configuration access required' USING ERRCODE='42501';
 END IF;
 INSERT INTO app.people_general_native_observation(call_id,tenant_id,user_id,native_xid,desired_nric,desired_email)
 VALUES(call_key,t,app.current_user_id(),pg_current_xact_id(),p_allow,p_allow_email);
 INSERT INTO public.people_general_policy(tenant_id) VALUES(t) ON CONFLICT(tenant_id)
 DO UPDATE SET admission_version=people_general_policy.admission_version+1
 RETURNING allow_duplicated_nric,allow_duplicated_email,revision INTO previous,previous_email,actual;
 IF p_expected IS DISTINCT FROM actual AND (p_expected IS NOT NULL OR EXISTS(
  SELECT 1 FROM public.people_general_policy WHERE tenant_id=t AND admission_version>0)) THEN
  RAISE EXCEPTION 'People General settings changed; reload before saving' USING ERRCODE='PN002';
 END IF;
 UPDATE public.people_general_policy SET allow_duplicated_nric=p_allow,allow_duplicated_email=p_allow_email,revision=next_revision WHERE tenant_id=t;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'people-general',t,'people-general.changed','user',app.current_user_id(),
  jsonb_build_object('before',jsonb_build_object('allowDuplicatedNric',previous,'allowDuplicatedEmail',previous_email),
   'after',jsonb_build_object('allowDuplicatedNric',p_allow,'allowDuplicatedEmail',p_allow_email))) RETURNING id INTO created_event;
 SELECT inserted_policy,insert_revision INTO created_policy,created_revision FROM app.people_general_native_observation WHERE call_id=call_key;
 IF created_policy AND created_revision IS DISTINCT FROM actual THEN RAISE EXCEPTION 'Policy insertion observation unavailable' USING ERRCODE='42501';END IF;
 UPDATE app.people_general_native_observation SET before_nric=previous,before_email=previous_email,
 before_revision=CASE WHEN created_policy THEN NULL ELSE actual END,revision=next_revision,event_id=created_event WHERE call_id=call_key;
 RETURN next_revision;
END $$;
REVOKE ALL ON FUNCTION app.people_general_set(boolean,boolean,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.people_general_set(boolean,boolean,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._people_general_policy_review_actor() RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_user_id() IS NULL OR app.principal_snapshot_current() IS NOT TRUE OR app.people_general_can_configure() IS NOT TRUE THEN RAISE EXCEPTION 'Policy review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._people_general_policy_review_actor() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.people_general_policy_review_source() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 PERFORM app._people_general_policy_review_actor();
 SELECT jsonb_build_object('tenantId',t.id,'tenantName',t.name,
 'policy',jsonb_build_object('allowDuplicatedNric',coalesce(p.allow_duplicated_nric,false),'allowDuplicatedEmail',coalesce(p.allow_duplicated_email,false)),
 'revision',p.revision,'actor',jsonb_build_object('userId',a.id,'personId',a.person_id),
 'authority',jsonb_build_object('configuration',(SELECT c.revision FROM public.access_configuration c WHERE c.tenant_id=t.id),'userRevision',a.xmin::text,
 'roleRows',(SELECT jsonb_agg(jsonb_build_object('id',r.id,'role',r.role,'companyId',r.company_id,'revision',r.xmin::text) ORDER BY r.id) FROM public.role_assignment r WHERE r.tenant_id=t.id AND r.app_user_id=a.id),
 'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.role,g.company_id) FROM app.current_grants() g))) INTO result
 FROM public.tenant t JOIN public.app_user a ON a.tenant_id=t.id AND a.id=app.current_user_id()
 LEFT JOIN public.people_general_policy p ON p.tenant_id=t.id WHERE t.id=app.current_tenant_id();
 IF result IS NULL THEN RAISE EXCEPTION 'Policy review unavailable' USING ERRCODE='42501';END IF;RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.people_general_policy_review_source() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.people_general_policy_review_source() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.people_general_policy_review_lock() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._people_general_policy_review_actor();PERFORM app.access_workforce_write_lock();
 -- Existing tuple is the NRIC admission barrier; absence remains absence, with no exclusive-range claim.
 PERFORM 1 FROM public.people_general_policy WHERE tenant_id=app.current_tenant_id() FOR UPDATE;
 RETURN app.people_general_policy_review_source();
END $$;
REVOKE ALL ON FUNCTION app.people_general_policy_review_lock() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.people_general_policy_review_lock() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.people_general_policy_native_effect(p_revision uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 PERFORM app._people_general_policy_review_actor();
 SELECT jsonb_build_object('tenantId',o.tenant_id,'userId',o.user_id,'beforeRevision',o.before_revision,'revision',o.revision,'eventId',o.event_id,'insertedPolicy',o.inserted_policy,
 'before',jsonb_build_object('allowDuplicatedNric',o.before_nric,'allowDuplicatedEmail',o.before_email),
 'after',jsonb_build_object('allowDuplicatedNric',o.desired_nric,'allowDuplicatedEmail',o.desired_email)) INTO result
 FROM app.people_general_native_observation o JOIN public.people_general_policy p ON p.tenant_id=o.tenant_id AND p.revision=o.revision
 JOIN public.domain_event d ON d.id=o.event_id AND d.tenant_id=o.tenant_id
 WHERE o.tenant_id=app.current_tenant_id() AND o.user_id=app.current_user_id() AND o.revision=p_revision AND o.native_xid=pg_current_xact_id()
 AND o.xmin=pg_current_xact_id()::xid AND p.xmin=pg_current_xact_id()::xid AND d.xmin=pg_current_xact_id()::xid
 AND p.allow_duplicated_nric=o.desired_nric AND p.allow_duplicated_email=o.desired_email
 AND d.aggregate_type='people-general' AND d.aggregate_id=o.tenant_id AND d.event_type='people-general.changed' AND d.actor_type='user' AND d.actor_id=o.user_id AND d.subject_employment_id IS NULL
 AND d.payload=jsonb_build_object('before',jsonb_build_object('allowDuplicatedNric',o.before_nric,'allowDuplicatedEmail',o.before_email),'after',jsonb_build_object('allowDuplicatedNric',o.desired_nric,'allowDuplicatedEmail',o.desired_email));
 IF result IS NULL THEN RAISE EXCEPTION 'Policy effect observation unavailable' USING ERRCODE='42501';END IF;RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.people_general_policy_native_effect(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.people_general_policy_native_effect(uuid) TO ai_hr_app;

--> statement-breakpoint
-- SAME review ledger. Policy values are closed non-personal booleans; genuine subject is tenant.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES('org.people_general.change','org','approve','personnel','org.people_general.change');
ALTER TABLE app.assistant_own_leave_review ADD COLUMN people_general_before_nric boolean,ADD COLUMN people_general_before_email boolean,
 ADD COLUMN people_general_after_nric boolean,ADD COLUMN people_general_after_email boolean,
 ADD COLUMN people_general_before_revision uuid,ADD COLUMN people_general_native_revision uuid,
 ADD CONSTRAINT assistant_people_general_columns CHECK(CASE WHEN action_kind='org.people_general.change' THEN
 people_general_before_nric IS NOT NULL AND people_general_before_email IS NOT NULL AND people_general_after_nric IS NOT NULL AND people_general_after_email IS NOT NULL
 AND (people_general_before_nric<>people_general_after_nric OR people_general_before_email<>people_general_after_email)
 AND (state<>'completed' OR people_general_native_revision IS NOT NULL) AND (state<>'awaiting_confirmation' OR people_general_native_revision IS NULL)
 ELSE people_general_before_nric IS NULL AND people_general_before_email IS NULL AND people_general_after_nric IS NULL AND people_general_after_email IS NULL AND people_general_before_revision IS NULL AND people_general_native_revision IS NULL END);
--> statement-breakpoint
DO $$ DECLARE item record;previous text;scope_name text;matches integer;
BEGIN
 SELECT count(*),min(conname) INTO matches,scope_name FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' AND pg_get_expr(conbin,conrelid) LIKE '%testing_execution_id IS NOT NULL%' AND pg_get_expr(conbin,conrelid) LIKE '%employment_id IS NULL%';
 IF matches<>1 THEN RAISE EXCEPTION '0751: actor scope drift';END IF;
 FOR item IN SELECT * FROM (VALUES
 (scope_name,'employment_id IS NULL AND company_id IS NULL AND testing_execution_id IS NULL AND testing_run_id IS NULL AND testing_event_id IS NULL'),
 ('assistant_review_kind_columns','performance_ack_event_id IS NULL AND leave_request_id IS NULL AND submission_event_id IS NULL AND notification_event_id IS NULL AND profile_request_id IS NULL AND profile_requested_event_id IS NULL AND claim_draft_id IS NULL AND claim_saved_event_id IS NULL'),
 ('assistant_review_decision_columns','decision_subject_person_id IS NULL AND decision_request_id IS NULL AND decision_step_id IS NULL AND decision_event_id IS NULL AND decision_applicant_person_id IS NULL'),
 ('assistant_review_generic_receipt','receipt_subject_kind IS NOT DISTINCT FROM ''people_general_policy'' AND receipt_subject_id IS NOT DISTINCT FROM tenant_id AND ((state=''completed'')=(receipt_event_id IS NOT NULL))')) requirements(name,expression) LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=item.name;
  IF previous IS NULL THEN RAISE EXCEPTION '0751: missing %',item.name;END IF;
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',item.name);
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK(CASE WHEN action_kind=''org.people_general.change'' THEN (%s) ELSE (%s) END)',item.name,item.expression,previous);
 END LOOP;
END $$;
--> statement-breakpoint
DO $$ DECLARE predicate text;
BEGIN
 SELECT pg_get_expr(indpred,indrelid) INTO predicate FROM pg_index WHERE indexrelid='app.assistant_review_generic_pending_subject'::regclass;
 IF predicate IS NULL THEN RAISE EXCEPTION '0751: pending index drift';END IF;
 DROP INDEX app.assistant_review_generic_pending_subject;
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_generic_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id) WHERE ('||predicate||') AND action_kind<>''org.people_general.change''';
END $$;
CREATE UNIQUE INDEX assistant_people_general_policy_pending ON app.assistant_own_leave_review(tenant_id,user_id) WHERE action_kind='org.people_general.change' AND state='awaiting_confirmation';
--> statement-breakpoint
-- Historical recovery is tied to LOGICAL policy revision, never admission_version or xmin.
CREATE FUNCTION app.people_general_policy_receipt(p_event uuid,p_revision uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 PERFORM app._people_general_policy_review_actor();
 SELECT jsonb_build_object('kind','recorded','tenantId',o.tenant_id,'policy',jsonb_build_object('allowDuplicatedNric',o.desired_nric,'allowDuplicatedEmail',o.desired_email),'eventId',o.event_id,'semantics','native_people_general_policy_current_record') INTO result
 FROM app.people_general_native_observation o JOIN public.people_general_policy p ON p.tenant_id=o.tenant_id AND p.revision=o.revision
 JOIN public.domain_event d ON d.tenant_id=o.tenant_id AND d.id=o.event_id
 WHERE o.tenant_id=app.current_tenant_id() AND o.user_id=app.current_user_id() AND o.revision=p_revision AND o.event_id=p_event
 AND p.allow_duplicated_nric=o.desired_nric AND p.allow_duplicated_email=o.desired_email
 AND d.aggregate_type='people-general' AND d.aggregate_id=o.tenant_id AND d.event_type='people-general.changed' AND d.actor_type='user' AND d.actor_id=o.user_id AND d.subject_employment_id IS NULL
 AND d.payload=jsonb_build_object('before',jsonb_build_object('allowDuplicatedNric',o.before_nric,'allowDuplicatedEmail',o.before_email),'after',jsonb_build_object('allowDuplicatedNric',o.desired_nric,'allowDuplicatedEmail',o.desired_email));
 IF result IS NULL THEN RAISE EXCEPTION 'Policy receipt unavailable' USING ERRCODE='42501';END IF;RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.people_general_policy_receipt(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.people_general_policy_receipt(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_people_general_policy_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object('actionId',r.id,'action',r.action_kind,'contractVersion',1,'binding',jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'companyId',NULL,'employmentId',NULL,
 'before',jsonb_build_object('allowDuplicatedNric',r.people_general_before_nric,'allowDuplicatedEmail',r.people_general_before_email),
 'after',jsonb_build_object('allowDuplicatedNric',r.people_general_after_nric,'allowDuplicatedEmail',r.people_general_after_email),'beforeRevision',r.people_general_before_revision),
 'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,'state',r.state,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object('formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,'eventId',r.receipt_event_id,'nativeRevision',r.people_general_native_revision)
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id WHERE r.id=p_id AND r.action_kind='org.people_general.change';
$$;
REVOKE ALL ON FUNCTION app._assistant_people_general_policy_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- p_revision is the reviewed baseline on prepare and exact native-produced revision on complete.
CREATE FUNCTION app.assistant_people_general_policy_command(p_operation text,p_id uuid DEFAULT NULL,p_person uuid DEFAULT NULL,p_before jsonb DEFAULT NULL,p_after jsonb DEFAULT NULL,p_revision uuid DEFAULT NULL,p_intent text DEFAULT NULL,p_reviewed text DEFAULT NULL,p_kid text DEFAULT NULL,p_wrapped text DEFAULT NULL,p_ciphertext text DEFAULT NULL,p_event uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();stamp timestamptz;source jsonb;effect jsonb;result jsonb;
BEGIN
 PERFORM app._assistant_pay_component_review_identity(NULL,false);
 IF p_operation IS NULL OR p_operation NOT IN('prepare','read','discard','index','complete') THEN RAISE EXCEPTION 'Policy review unavailable' USING ERRCODE='42501';END IF;
 IF p_operation='index' THEN
  PERFORM app._people_general_policy_review_actor();
  SELECT coalesce(jsonb_agg(jsonb_build_object('action',s.action_kind,'contractVersion',1,'actionId',s.id,'state',s.state,'createdAt',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(s.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY s.created_at DESC,s.id DESC),'[]'::jsonb) INTO result FROM
  (SELECT saved.* FROM app.assistant_own_leave_review saved WHERE saved.tenant_id=t AND saved.user_id=u AND saved.action_kind='org.people_general.change'
   AND saved.person_id IS NOT DISTINCT FROM(SELECT a.person_id FROM public.app_user a WHERE a.id=u AND a.tenant_id=t) ORDER BY saved.created_at DESC,saved.id DESC LIMIT 25) s;RETURN result;
 END IF;
 IF p_operation='prepare' THEN
  PERFORM app._assistant_pay_component_review_identity(p_person);
  source:=app.people_general_policy_review_lock();
  IF p_before IS DISTINCT FROM source->'policy' OR p_revision IS DISTINCT FROM(source->>'revision')::uuid OR p_after IS NULL
   OR jsonb_typeof(p_after->'allowDuplicatedNric') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_after->'allowDuplicatedEmail') IS DISTINCT FROM 'boolean'
   OR p_after IS DISTINCT FROM jsonb_build_object('allowDuplicatedNric',p_after->'allowDuplicatedNric','allowDuplicatedEmail',p_after->'allowDuplicatedEmail') OR p_after=p_before THEN RAISE EXCEPTION 'Policy review unavailable' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person) OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person) THEN RAISE EXCEPTION 'Policy review unavailable' USING ERRCODE='42501';END IF;
  IF p_id IS NULL OR p_intent IS NULL OR p_intent !~ '^[a-f0-9]{64}$' OR p_reviewed IS NULL OR p_reviewed !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$' OR p_wrapped IS NULL OR length(p_wrapped) NOT BETWEEN 1 AND 512 OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN RAISE EXCEPTION 'Policy review unavailable' USING ERRCODE='22023';END IF;
  stamp:=clock_timestamp();
  UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE tenant_id=t AND user_id=u AND action_kind='org.people_general.change' AND state='awaiting_confirmation' AND expires_at<=stamp;
  DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review expired WHERE c.action_id=expired.id AND expired.tenant_id=t AND expired.user_id=u AND expired.action_kind='org.people_general.change' AND expired.state='expired';
  IF(SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation' AND expires_at>stamp)>=5 OR(SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND created_at>stamp-interval '10 minutes')>=20 THEN RAISE EXCEPTION 'Policy review unavailable' USING ERRCODE='54000';END IF;
  INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,receipt_subject_kind,receipt_subject_id,people_general_before_nric,people_general_before_email,people_general_after_nric,people_general_after_email,people_general_before_revision,intent_digest,reviewed_digest,state,created_at,expires_at)
  VALUES('org.people_general.change',p_id,t,u,p_person,'people_general_policy',t,(p_before->>'allowDuplicatedNric')::boolean,(p_before->>'allowDuplicatedEmail')::boolean,(p_after->>'allowDuplicatedNric')::boolean,(p_after->>'allowDuplicatedEmail')::boolean,p_revision,p_intent,p_reviewed,'awaiting_confirmation',stamp,stamp+interval '10 minutes');
  INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped,p_ciphertext);RETURN app._assistant_people_general_policy_json(p_id);
 END IF;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='org.people_general.change' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Policy review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_pay_component_review_identity(r.person_id);
 IF p_operation<>'discard' THEN PERFORM app._people_general_policy_review_actor();END IF;
 IF p_operation='complete' THEN
  IF r.state='completed' THEN IF r.receipt_event_id IS DISTINCT FROM p_event OR r.people_general_native_revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'Policy review unavailable' USING ERRCODE='42501';END IF;
  ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
   effect:=app.people_general_policy_native_effect(p_revision);
   IF r.reviewed_digest IS DISTINCT FROM p_reviewed OR p_event IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id)
    OR(effect->>'eventId')::uuid IS DISTINCT FROM p_event OR(effect->>'beforeRevision')::uuid IS DISTINCT FROM r.people_general_before_revision
    OR effect->'before' IS DISTINCT FROM jsonb_build_object('allowDuplicatedNric',r.people_general_before_nric,'allowDuplicatedEmail',r.people_general_before_email)
    OR effect->'after' IS DISTINCT FROM jsonb_build_object('allowDuplicatedNric',r.people_general_after_nric,'allowDuplicatedEmail',r.people_general_after_email)
    OR(effect->>'insertedPolicy')::boolean IS DISTINCT FROM(r.people_general_before_revision IS NULL) THEN RAISE EXCEPTION 'Policy review unavailable' USING ERRCODE='42501';END IF;
   UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,receipt_event_id=p_event,people_general_native_revision=p_revision WHERE id=r.id;
  ELSE RAISE EXCEPTION 'Policy review unavailable' USING ERRCODE='42501';END IF;
 ELSIF p_operation='discard' THEN
  IF r.state='completed' THEN RAISE EXCEPTION 'Policy review unavailable' USING ERRCODE='42501';END IF;
  IF r.state='awaiting_confirmation' THEN UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 ELSIF p_operation='read' AND r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review ended WHERE c.action_id=ended.id AND ended.id=p_id AND ended.state<>'awaiting_confirmation';
 IF p_operation='discard' THEN SELECT jsonb_build_object('action',ended.action_kind,'contractVersion',1,'actionId',ended.id,'state',ended.state) INTO result FROM app.assistant_own_leave_review ended WHERE ended.id=p_id;RETURN result;END IF;
 RETURN app._assistant_people_general_policy_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_people_general_policy_command(text,uuid,uuid,jsonb,jsonb,uuid,text,text,text,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_people_general_policy_command(text,uuid,uuid,jsonb,jsonb,uuid,text,text,text,text,text,uuid) TO ai_hr_app;
--> statement-breakpoint
DO $$ DECLARE target regprocedure;definition text;marker text;replacement text;
BEGIN
 FOR target IN SELECT signature::regprocedure FROM unnest(ARRAY['app.native_outcome_review_completed(text,uuid)','app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)','app.native_outcome_completed_review_choices(jsonb)']) signature LOOP
  definition:=pg_get_functiondef(target);
  IF target='app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure THEN marker:='WHEN ''employees.qualification.maintain'' THEN r.receipt_event_id';replacement:=marker||' WHEN ''org.people_general.change'' THEN r.receipt_event_id';
  ELSE marker:='''employees.qualification.maintain''';replacement:=marker||',''org.people_general.change''';END IF;
  IF(length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION '0751: closed outcome drift %',target;END IF;
  EXECUTE replace(definition,marker,replacement);
 END LOOP;
END $$;
