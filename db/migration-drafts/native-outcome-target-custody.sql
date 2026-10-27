-- SOURCE ONLY / UNALLOCATED / UNJOURNALED / UNAPPLIED. Consolidate AFTER the base association
-- definition in ONE centrally allocated native-outcome migration before its first normal application.
-- Private source-owned COMPLETE privacy index. It does not establish canonical-engine provenance,
-- action quality, benefit, authority or causal attribution. Never expose these targets to a model.
CREATE TABLE app.native_outcome_source_capture(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.app_user(id) ON DELETE CASCADE,person_id uuid REFERENCES public.person(id) ON DELETE CASCADE,
 action text NOT NULL,source_id uuid NOT NULL,source_kind text NOT NULL CHECK(source_kind IN('review','employee_import')),
 review_id uuid REFERENCES app.assistant_own_leave_review(id) ON DELETE CASCADE,
 import_attempt_id uuid REFERENCES public.employee_import_evaluation_attempt(id) ON DELETE CASCADE,
 event_id uuid NOT NULL REFERENCES public.domain_event(id) ON DELETE CASCADE,
 target_count integer NOT NULL CHECK(target_count>=0),created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 days'),
 CHECK((source_kind='review' AND action<>'employees.import' AND review_id IS NOT NULL AND review_id=source_id AND import_attempt_id IS NULL)
 OR(source_kind='employee_import' AND action='employees.import' AND import_attempt_id IS NOT NULL AND import_attempt_id=source_id AND review_id IS NULL)),
 UNIQUE(tenant_id,user_id,action,source_id),UNIQUE(tenant_id,user_id,event_id)
);
CREATE TABLE app.native_outcome_source_target(
 capture_id uuid NOT NULL REFERENCES app.native_outcome_source_capture(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN('person','employment','lifecycle_case')),target_id uuid NOT NULL,
 PRIMARY KEY(capture_id,kind,target_id)
);
-- Deliberately no caller SELECT/INSERT/UPDATE/DELETE. Internal definer functions below check the
-- actual current principal and admission. The physical owner maintains only expired rows via code.
ALTER TABLE app.native_outcome_source_capture ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.native_outcome_source_target ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.native_outcome_source_capture,app.native_outcome_source_target FROM PUBLIC,ai_hr_app;
CREATE INDEX native_outcome_source_expiry ON app.native_outcome_source_capture(expires_at,id);
CREATE INDEX native_outcome_target_lookup ON app.native_outcome_source_target(kind,target_id,capture_id);
--> statement-breakpoint
-- Minimal exact native payroll cohort IDs; caller uses actual owner preflight, never client values.
-- Existing canonical source owns all prior-batch, coverage, role and tenant admission predicates.
CREATE FUNCTION app.native_outcome_payroll_target_employments(p_batch uuid,p_prior uuid,p_coverage uuid[]) RETURNS uuid[]
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ids uuid[];
BEGIN
 PERFORM app.payroll_close_source_people(p_batch,p_prior,p_coverage);
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}'::uuid[]) INTO ids FROM(
  SELECT slip.employment_id AS id FROM public.payslip slip WHERE slip.tenant_id=app.current_tenant_id() AND slip.batch_id IN(p_batch,p_prior)
  UNION ALL SELECT unnest(p_coverage)
 ) exact_source;
 RETURN ids;
END $$;
REVOKE ALL ON FUNCTION app.native_outcome_payroll_target_employments(uuid,uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.native_outcome_payroll_target_employments(uuid,uuid,uuid[]) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.native_outcome_targets_capture(p_tenant uuid,p_user uuid,p_person uuid,p_action text,p_source uuid,p_event uuid,p_targets jsonb) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;e public.employee_import_evaluation_attempt%ROWTYPE;
 t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();people uuid[];employees uuid[];cases uuid[];
 id uuid;total integer;expiry timestamptz;kind text;source_person uuid;
BEGIN
 IF p_tenant IS DISTINCT FROM t OR p_user IS DISTINCT FROM u OR t IS NULL OR u IS NULL
  OR app.principal_snapshot_current() IS NOT TRUE OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' OR p_action IS NULL OR p_source IS NULL OR p_event IS NULL
  OR jsonb_typeof(p_targets) IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_targets) x
    WHERE jsonb_typeof(x) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(x))<>2
     OR x->>'kind' NOT IN('person','employment','lifecycle_case') OR x->>'kind' IS NULL
     OR x->>'id' IS NULL OR x->>'id' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') THEN
  RAISE EXCEPTION 'Native outcome privacy custody unavailable' USING ERRCODE='42501';END IF;
 SELECT person_id INTO source_person FROM public.app_user WHERE id=u AND tenant_id=t AND archived_at IS NULL AND NOT app.login_blocked(id);
 IF NOT FOUND OR source_person IS DISTINCT FROM p_person THEN RAISE EXCEPTION 'Native outcome privacy custody unavailable' USING ERRCODE='42501';END IF;
 -- Actual effect source must be newly written in THIS top-level transaction, not a posted historical
 -- event or a child-savepoint artifact. This fence supplements, never replaces, canonical provenance.
 IF NOT EXISTS(SELECT 1 FROM public.domain_event d WHERE d.id=p_event AND d.tenant_id=t
   AND d.actor_type='user' AND d.actor_id=u AND d.xmin=pg_current_xact_id()::xid) THEN
  RAISE EXCEPTION 'Native outcome privacy custody unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(array_agg(DISTINCT (x->>'id')::uuid ORDER BY (x->>'id')::uuid) FILTER(WHERE x->>'kind'='person'),'{}'::uuid[]),
  coalesce(array_agg(DISTINCT (x->>'id')::uuid ORDER BY (x->>'id')::uuid) FILTER(WHERE x->>'kind'='employment'),'{}'::uuid[]),
  coalesce(array_agg(DISTINCT (x->>'id')::uuid ORDER BY (x->>'id')::uuid) FILTER(WHERE x->>'kind'='lifecycle_case'),'{}'::uuid[])
 INTO people,employees,cases FROM jsonb_array_elements(p_targets) x;
 IF p_person IS NOT NULL THEN people:=array_append(people,p_person);END IF;
 IF p_action='employees.import' THEN
  SELECT * INTO e FROM public.employee_import_evaluation_attempt WHERE id=p_source AND tenant_id=t AND user_id=u AND expires_at>now();
  IF NOT FOUND OR e.state NOT IN('prepared','committed') OR (e.event_id IS NOT NULL AND e.event_id<>p_event)
   OR NOT EXISTS(SELECT 1 FROM public.domain_event d WHERE d.id=p_event AND d.tenant_id=t
      AND d.event_type='employee-import.completed' AND d.aggregate_type='employee-import' AND d.aggregate_id=e.company_id) THEN
   RAISE EXCEPTION 'Native outcome privacy custody unavailable' USING ERRCODE='42501';END IF;
  expiry:=least(e.expires_at,now()+interval '30 days');kind:='employee_import';
 ELSE
  SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_source AND tenant_id=t AND user_id=u AND action_kind=p_action;
  IF NOT FOUND OR r.state<>'awaiting_confirmation' OR r.expires_at<=clock_timestamp() OR r.person_id IS DISTINCT FROM p_person THEN
   RAISE EXCEPTION 'Native outcome privacy custody unavailable' USING ERRCODE='42501';END IF;
  -- Original private snapshots are read before terminal completion clears them. No public reader is
  -- added, no client list is accepted as a replacement, and no complete cohort is silently truncated.
  people:=people||array_remove(ARRAY[r.person_id,r.country_statutory_person_id,r.lifecycle_case_person_id,r.org_subject_person_id,
   r.org_manager_person_id,r.org_previous_manager_person_id,r.decision_subject_person_id,r.decision_applicant_person_id],NULL)
   ||coalesce(r.rewards_review_person_ids,'{}'::uuid[])||coalesce(r.payroll_review_person_ids,'{}'::uuid[])||coalesce(r.multi_cycle_review_person_ids,'{}'::uuid[]);
  employees:=employees||array_remove(ARRAY[r.employment_id],NULL)||coalesce(r.multi_cycle_review_employment_ids,'{}'::uuid[]);
  cases:=cases||array_remove(ARRAY[r.lifecycle_case_id],NULL);
  IF r.action_kind='rewards.post' THEN
   people:=people||app._assistant_rewards_post_review_people(r.rewards_unit_id);
   SELECT employees||coalesce(array_agg(DISTINCT x.employment_id ORDER BY x.employment_id),'{}'::uuid[]) INTO employees
    FROM public.reward_entry x WHERE x.unit_id=r.rewards_unit_id AND x.tenant_id=t;
  END IF;
  expiry:=least(r.created_at+interval '30 days',now()+interval '30 days');kind:='review';
 END IF;
 IF EXISTS(SELECT 1 FROM unnest(cases) x WHERE NOT EXISTS(SELECT 1 FROM public.lc_case c WHERE c.id=x AND c.tenant_id=t))
  OR EXISTS(SELECT 1 FROM unnest(employees) x WHERE NOT EXISTS(SELECT 1 FROM public.employment actual WHERE actual.id=x AND actual.tenant_id=t)) THEN
  RAISE EXCEPTION 'Native outcome privacy custody unavailable' USING ERRCODE='42501';END IF;
 -- Preserve effect-time PERSON identity as well as EMPLOYMENT/case identity; future relinks cannot
 -- remove the original subject from privacy erasure. Unlinked cases and USER-only Testing are valid.
 SELECT people||coalesce(array_agg(c.person_id) FILTER(WHERE c.person_id IS NOT NULL),'{}'::uuid[]),
   employees||coalesce(array_agg(c.employment_id) FILTER(WHERE c.employment_id IS NOT NULL),'{}'::uuid[])
 INTO people,employees FROM public.lc_case c WHERE c.id=ANY(cases) AND c.tenant_id=t;
 SELECT people||coalesce(array_agg(actual.person_id),'{}'::uuid[]) INTO people FROM public.employment actual WHERE actual.id=ANY(employees) AND actual.tenant_id=t;
 IF array_position(people,NULL) IS NOT NULL OR EXISTS(SELECT 1 FROM unnest(people) x WHERE NOT EXISTS(SELECT 1 FROM public.person actual WHERE actual.id=x AND actual.tenant_id=t))
  OR expiry<=now() OR EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND (i.person_id=ANY(people) OR i.employment_id=ANY(employees))) THEN
  RAISE EXCEPTION 'Native outcome privacy custody unavailable' USING ERRCODE='42501';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('native-outcome:v1:'||t::text||':'||u::text,0)) THEN
  RAISE EXCEPTION 'Native outcome privacy custody is busy' USING ERRCODE='55P03';END IF;
 IF EXISTS(SELECT 1 FROM app.native_outcome_source_capture c WHERE c.tenant_id=t AND c.user_id=u AND (c.event_id=p_event OR(c.action=p_action AND c.source_id=p_source))) THEN
  RAISE EXCEPTION 'Native outcome privacy custody already captured' USING ERRCODE='42501';END IF;
 SELECT count(*)::integer INTO total FROM(SELECT DISTINCT 'person' AS k,x FROM unnest(people) x
  UNION SELECT DISTINCT 'employment',x FROM unnest(employees) x UNION SELECT DISTINCT 'lifecycle_case',x FROM unnest(cases) x) targets;
 INSERT INTO app.native_outcome_source_capture(tenant_id,user_id,person_id,action,source_id,source_kind,review_id,import_attempt_id,event_id,target_count,expires_at)
 VALUES(t,u,p_person,p_action,p_source,kind,CASE WHEN kind='review' THEN p_source END,CASE WHEN kind='employee_import' THEN p_source END,p_event,total,expiry) RETURNING native_outcome_source_capture.id INTO id;
 INSERT INTO app.native_outcome_source_target(capture_id,kind,target_id)
 SELECT id,'person',x FROM unnest(people) x UNION SELECT id,'employment',x FROM unnest(employees) x UNION SELECT id,'lifecycle_case',x FROM unnest(cases) x;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.native_outcome_targets_capture(uuid,uuid,uuid,text,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.native_outcome_targets_capture(uuid,uuid,uuid,text,uuid,uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.native_outcome_targets_require(p_tenant uuid,p_user uuid,p_person uuid,p_action text,p_source uuid,p_event uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_tenant=app.current_tenant_id() AND p_user=app.current_user_id() AND app.principal_snapshot_current()
 AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=p_user AND u.tenant_id=p_tenant AND u.person_id IS NOT DISTINCT FROM p_person AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 AND EXISTS(SELECT 1 FROM app.native_outcome_source_capture c WHERE c.tenant_id=p_tenant AND c.user_id=p_user
  AND c.person_id IS NOT DISTINCT FROM p_person AND c.action=p_action AND c.source_id=p_source AND c.event_id=p_event AND c.expires_at>now()
  AND c.target_count=(SELECT count(*) FROM app.native_outcome_source_target t WHERE t.capture_id=c.id))
 AND((p_action='employees.import' AND EXISTS(SELECT 1 FROM public.employee_import_evaluation_attempt e WHERE e.id=p_source AND e.tenant_id=p_tenant AND e.user_id=p_user AND e.state='committed' AND e.event_id=p_event AND e.expires_at>now()))
 OR(p_action<>'employees.import' AND EXISTS(SELECT 1 FROM app.assistant_own_leave_review r WHERE r.id=p_source AND r.tenant_id=p_tenant AND r.user_id=p_user
  AND r.action_kind=p_action AND r.state='completed' AND r.person_id IS NOT DISTINCT FROM p_person AND CASE p_action
   WHEN 'leave.apply' THEN r.submission_event_id WHEN 'org.reporting.change' THEN r.reporting_set_event_id
   WHEN 'ess.profile.request' THEN r.profile_requested_event_id WHEN 'approvals.leave.decide' THEN r.decision_event_id
   WHEN 'knowledge_base.article.create' THEN r.knowledge_created_event_id WHEN 'payroll.close' THEN r.payroll_closed_event_id
   WHEN 'attendance.correction.request' THEN r.attendance_requested_event_id WHEN 'claims.draft.save' THEN r.claim_saved_event_id
   WHEN 'claims.submit' THEN r.claim_submitted_event_id WHEN 'performance.review.acknowledge' THEN r.performance_ack_event_id
   WHEN 'performance.onehr.plan.acknowledge' THEN r.performance_ack_event_id WHEN 'rewards.post' THEN r.rewards_posted_event_id
   WHEN 'lifecycle.acknowledgement.submit' THEN r.lifecycle_submitted_event_id WHEN 'toil.replacement.request' THEN r.toil_submitted_event_id
   WHEN 'multi_cycle_payroll.create_run' THEN r.multi_cycle_created_event_id WHEN 'typed_pay_components.create' THEN r.pay_component_created_event_id
   WHEN 'country-my.statutory.update' THEN r.country_statutory_event_id WHEN 'notifications.email_preferences.save' THEN r.notification_event_id
   WHEN 'system_testing.execution.save' THEN r.testing_event_id END=p_event)))
$$;
REVOKE ALL ON FUNCTION app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Every association MUST have a complete source capture; legacy unindexed effects cannot become
-- new learning evidence. Deleting a capture erases linked learning metadata via the FK, not HR facts.
ALTER TABLE public.ai_native_outcome_association ADD COLUMN source_capture_id uuid NOT NULL REFERENCES app.native_outcome_source_capture(id) ON DELETE CASCADE;
CREATE FUNCTION app.native_outcome_association_capture() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c app.native_outcome_source_capture%ROWTYPE;source uuid;
BEGIN
 source:=CASE WHEN NEW.source_kind='review' THEN NEW.review_id ELSE NEW.import_attempt_id END;
 IF app.native_outcome_targets_require(NEW.tenant_id,NEW.user_id,NEW.person_id,NEW.action,source,NEW.event_id) IS NOT TRUE THEN
  RAISE EXCEPTION 'Native outcome privacy capture unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM app.native_outcome_source_capture WHERE tenant_id=NEW.tenant_id AND user_id=NEW.user_id AND action=NEW.action AND source_id=source AND event_id=NEW.event_id;
 IF NOT FOUND OR c.expires_at<NEW.expires_at THEN RAISE EXCEPTION 'Native outcome privacy capture unavailable' USING ERRCODE='42501';END IF;
 NEW.source_capture_id:=c.id;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.native_outcome_association_capture() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER native_outcome_association_capture BEFORE INSERT ON public.ai_native_outcome_association FOR EACH ROW EXECUTE FUNCTION app.native_outcome_association_capture();
--> statement-breakpoint
-- Source capture/target delete joins the same append/delete-only custody interval as associations.
CREATE FUNCTION app.native_outcome_source_mutation_lock() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid;u uuid;
BEGIN
 IF TG_TABLE_NAME='native_outcome_source_capture' THEN
  IF TG_OP='INSERT' THEN t:=NEW.tenant_id;u:=NEW.user_id;ELSE t:=OLD.tenant_id;u:=OLD.user_id;END IF;
 ELSE SELECT c.tenant_id,c.user_id INTO t,u FROM app.native_outcome_source_capture c WHERE c.id=OLD.capture_id;
  IF NOT FOUND THEN RETURN OLD;END IF;
 END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('native-outcome:v1:'||t::text||':'||u::text,0)) THEN
  RAISE EXCEPTION 'Native outcome privacy custody is busy' USING ERRCODE='55P03';END IF;
 IF TG_OP='INSERT' THEN RETURN NEW;END IF;RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION app.native_outcome_source_mutation_lock() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER native_outcome_source_mutation BEFORE INSERT OR DELETE ON app.native_outcome_source_capture FOR EACH ROW EXECUTE FUNCTION app.native_outcome_source_mutation_lock();
CREATE TRIGGER native_outcome_target_mutation BEFORE DELETE ON app.native_outcome_source_target FOR EACH ROW EXECUTE FUNCTION app.native_outcome_source_mutation_lock();
--> statement-breakpoint
-- Actual current login may erase its own learning privacy index after module/grant revocation.
-- This returns no source IDs/targets/counts, and association cascade preserves native receipts.
CREATE FUNCTION app.native_outcome_own_erase() RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF t IS NULL OR u IS NULL OR app.principal_snapshot_current() IS NOT TRUE OR NOT EXISTS(
  SELECT 1 FROM public.app_user actual WHERE actual.id=u AND actual.tenant_id=t AND actual.archived_at IS NULL AND NOT app.login_blocked(actual.id)) THEN
  RAISE EXCEPTION 'Native outcome erasure identity unavailable' USING ERRCODE='42501';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('native-outcome:v1:'||t::text||':'||u::text,0)) THEN
  RAISE EXCEPTION 'Native outcome privacy custody is busy' USING ERRCODE='55P03';END IF;
 DELETE FROM app.native_outcome_source_capture WHERE tenant_id=t AND user_id=u;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.native_outcome_own_erase() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.native_outcome_own_erase() TO ai_hr_app;
--> statement-breakpoint
-- Existing PII erasure admission/audit remains the authority. No app access to target rows is added.
CREATE TABLE app.native_outcome_erasure_intent(
 xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,person_id uuid NOT NULL,employment_id uuid NOT NULL,
 cleared integer NOT NULL CHECK(cleared>=0),event_id uuid,PRIMARY KEY(xact_id,tenant_id,user_id,person_id)
);
ALTER TABLE app.native_outcome_erasure_intent ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.native_outcome_erasure_intent FROM PUBLIC,ai_hr_app;
-- Original snapshots AND current canonical relinks are privacy subjects. An initially unlinked
-- Lifecycle case remains representable; a later PERSON link does not evade admitted erasure.
CREATE FUNCTION app._native_outcome_target_person(p_kind text,p_target uuid,p_person uuid,p_employment uuid,p_tenant uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT(p_kind='person' AND p_target=p_person)
 OR(p_kind='employment' AND(p_target=p_employment OR EXISTS(SELECT 1 FROM public.employment e WHERE e.id=p_target AND e.tenant_id=p_tenant AND e.person_id=p_person)))
 OR(p_kind='lifecycle_case' AND EXISTS(SELECT 1 FROM public.lc_case c WHERE c.id=p_target AND c.tenant_id=p_tenant AND(c.person_id=p_person OR c.employment_id=p_employment)))
$$;
REVOKE ALL ON FUNCTION app._native_outcome_target_person(text,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.native_outcome_targets_redact(p_employment uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i app.home_greeting_erasure_intent%ROWTYPE;total integer;subject_user uuid;
BEGIN
 SELECT * INTO i FROM app.home_greeting_erasure_intent WHERE xact_id=pg_current_xact_id() AND tenant_id=app.current_tenant_id()
  AND user_id=app.current_user_id() AND employment_id=p_employment;
 IF NOT FOUND OR app.principal_snapshot_current() IS NOT TRUE OR app.can_admin_employment(p_employment) IS NOT TRUE THEN
  RAISE EXCEPTION 'Native outcome erasure admission unavailable' USING ERRCODE='42501';END IF;
 DELETE FROM app.native_outcome_erasure_intent WHERE tenant_id=i.tenant_id AND xact_id<>pg_current_xact_id() AND event_id IS NOT NULL;
 IF EXISTS(SELECT 1 FROM app.native_outcome_erasure_intent old WHERE old.xact_id=i.xact_id AND old.tenant_id=i.tenant_id AND old.user_id=i.user_id AND old.person_id=i.person_id) THEN
  RAISE EXCEPTION 'Native outcome erasure already prepared' USING ERRCODE='40001';END IF;
 -- Original PERSON snapshots survive employment/case relinking; direct current employment binding
 -- also matches the exact admitted subject. Other users' unrelated learning and all HR facts remain.
 -- Nominate all matching owners before touching the first row; TRY refusal rolls the whole
 -- authorized erasure back. Never retain partial locks or retarget a newly discovered subject.
 FOR subject_user IN SELECT DISTINCT c.user_id FROM app.native_outcome_source_capture c WHERE c.tenant_id=i.tenant_id AND EXISTS(
   SELECT 1 FROM app.native_outcome_source_target t WHERE t.capture_id=c.id AND app._native_outcome_target_person(t.kind,t.target_id,i.person_id,i.employment_id,i.tenant_id)) ORDER BY c.user_id LOOP
  IF NOT pg_try_advisory_xact_lock(hashtextextended('native-outcome:v1:'||i.tenant_id::text||':'||subject_user::text,0)) THEN
   RAISE EXCEPTION 'Native outcome privacy custody is busy' USING ERRCODE='55P03';END IF;
 END LOOP;
 WITH erased AS(DELETE FROM app.native_outcome_source_capture c WHERE c.tenant_id=i.tenant_id AND EXISTS(
   SELECT 1 FROM app.native_outcome_source_target t WHERE t.capture_id=c.id AND app._native_outcome_target_person(t.kind,t.target_id,i.person_id,i.employment_id,i.tenant_id)) RETURNING c.id)
 SELECT count(*)::integer INTO total FROM erased;
 INSERT INTO app.native_outcome_erasure_intent VALUES(i.xact_id,i.tenant_id,i.user_id,i.person_id,i.employment_id,total,NULL);
 RETURN total;
END $$;
REVOKE ALL ON FUNCTION app.native_outcome_targets_redact(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.native_outcome_targets_redact(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.audit_native_outcome_erasure() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i app.native_outcome_erasure_intent%ROWTYPE;h app.home_greeting_erasure_intent%ROWTYPE;
BEGIN
 IF NEW.event_type<>'pii.erased' OR NEW.aggregate_type<>'person' THEN RETURN NULL;END IF;
 SELECT * INTO i FROM app.native_outcome_erasure_intent WHERE xact_id=pg_current_xact_id() AND tenant_id=NEW.tenant_id AND user_id=NEW.actor_id AND person_id=NEW.aggregate_id;
 IF NOT FOUND THEN
  IF EXISTS(SELECT 1 FROM app.native_outcome_source_capture c JOIN app.native_outcome_source_target t ON t.capture_id=c.id
    WHERE c.tenant_id=NEW.tenant_id AND app._native_outcome_target_person(t.kind,t.target_id,NEW.aggregate_id,NEW.subject_employment_id,NEW.tenant_id))
    OR coalesce(NEW.payload->'erasedFields' ? 'assistantOutcomeLearning',false) THEN
   RAISE EXCEPTION 'Native outcome erasure admission unavailable' USING ERRCODE='42501';END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO h FROM app.home_greeting_erasure_intent WHERE xact_id=i.xact_id AND tenant_id=i.tenant_id AND user_id=i.user_id AND person_id=i.person_id;
 IF NOT FOUND OR i.event_id IS NOT NULL OR NEW.actor_type<>'user' OR NEW.actor_id IS DISTINCT FROM app.current_user_id()
  OR i.tenant_id IS DISTINCT FROM app.current_tenant_id() OR app.principal_snapshot_current() IS NOT TRUE
  OR app.can_admin_employment(i.employment_id) IS NOT TRUE OR NEW.subject_employment_id IS DISTINCT FROM i.employment_id
  OR jsonb_typeof(NEW.payload->'erasedFields') IS DISTINCT FROM 'array' OR NEW.payload->>'scope' IS DISTINCT FROM h.scope
  OR encode(sha256(convert_to(NEW.payload->>'requestRef','UTF8')),'hex') IS DISTINCT FROM h.request_ref_hash
  OR encode(sha256(convert_to(NEW.payload->>'reason','UTF8')),'hex') IS DISTINCT FROM h.reason_hash
  OR coalesce(NEW.payload->'erasedFields' ? 'assistantOutcomeLearning',false) IS DISTINCT FROM(i.cleared>0) THEN
  RAISE EXCEPTION 'Native outcome erasure audit unavailable' USING ERRCODE='42501';END IF;
 UPDATE app.native_outcome_erasure_intent SET event_id=NEW.id WHERE xact_id=i.xact_id AND tenant_id=i.tenant_id AND user_id=i.user_id AND person_id=i.person_id;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.audit_native_outcome_erasure() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER native_outcome_erasure_audit AFTER INSERT ON public.domain_event FOR EACH ROW EXECUTE FUNCTION app.audit_native_outcome_erasure();
CREATE FUNCTION app.native_outcome_erasure_complete() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i app.native_outcome_erasure_intent%ROWTYPE;
BEGIN
 SELECT * INTO i FROM app.native_outcome_erasure_intent WHERE xact_id=NEW.xact_id AND tenant_id=NEW.tenant_id AND user_id=NEW.user_id AND person_id=NEW.person_id;
 IF NOT FOUND OR i.event_id IS NULL OR i.xact_id IS DISTINCT FROM pg_current_xact_id() OR i.tenant_id IS DISTINCT FROM app.current_tenant_id()
  OR i.user_id IS DISTINCT FROM app.current_user_id() OR app.principal_snapshot_current() IS NOT TRUE OR app.can_admin_employment(i.employment_id) IS NOT TRUE
  OR EXISTS(SELECT 1 FROM app.native_outcome_source_capture c JOIN app.native_outcome_source_target t ON t.capture_id=c.id WHERE c.tenant_id=i.tenant_id
   AND app._native_outcome_target_person(t.kind,t.target_id,i.person_id,i.employment_id,i.tenant_id)) THEN
  RAISE EXCEPTION 'Native outcome erasure incomplete' USING ERRCODE='42501';END IF;
 -- Do not retain a new person-indexed audit cache after successful erasure. The authoritative
 -- home_greeting_erasure_intent remains the current-xact barrier even after SET CONSTRAINTS
 -- IMMEDIATE; capture explicitly checks it, so retiring this derivative marker cannot reopen writes.
 DELETE FROM app.native_outcome_erasure_intent WHERE xact_id=i.xact_id AND tenant_id=i.tenant_id AND user_id=i.user_id AND person_id=i.person_id;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.native_outcome_erasure_complete() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER native_outcome_erasure_complete AFTER INSERT ON app.native_outcome_erasure_intent DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.native_outcome_erasure_complete();
--> statement-breakpoint
-- Physical canonical identity deletion removes only linked learning metadata. Relinking alone does
-- not delete the original snapshot; admitted field erasure above still finds the original PERSON.
CREATE FUNCTION app.native_outcome_identity_deleted() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k text;
BEGIN
 k:=CASE TG_TABLE_NAME WHEN 'person' THEN 'person' WHEN 'employment' THEN 'employment' WHEN 'lc_case' THEN 'lifecycle_case' END;
 DELETE FROM app.native_outcome_source_capture c WHERE c.tenant_id=OLD.tenant_id AND EXISTS(
  SELECT 1 FROM app.native_outcome_source_target t WHERE t.capture_id=c.id AND t.kind=k AND t.target_id=OLD.id);
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION app.native_outcome_identity_deleted() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER native_outcome_person_deleted BEFORE DELETE ON public.person FOR EACH ROW EXECUTE FUNCTION app.native_outcome_identity_deleted();
CREATE TRIGGER native_outcome_employment_deleted BEFORE DELETE ON public.employment FOR EACH ROW EXECUTE FUNCTION app.native_outcome_identity_deleted();
CREATE TRIGGER native_outcome_case_deleted BEFORE DELETE ON public.lc_case FOR EACH ROW EXECUTE FUNCTION app.native_outcome_identity_deleted();
