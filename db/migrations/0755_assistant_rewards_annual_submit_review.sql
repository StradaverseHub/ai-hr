-- UNAPPLIED PROVISIONAL DEVELOPMENT ONLY. Allocated 0755 / idx734 / version7 / when1793330000092 / breakpoints:true. Private proof stage; Journal identity reserved; NOT applied/CI.
-- SAME encrypted ledger; legacy Rewards refs retain truthful unit/event/reviewed-revision meaning.
-- Private whole-effect hashes/IDs retire with encrypted content; completed refs have a protected commitment.
ALTER TABLE app.assistant_own_leave_review ADD COLUMN rewards_submit_decision_id uuid UNIQUE,
 ADD COLUMN rewards_submit_snapshot jsonb, ADD COLUMN rewards_submit_commitment text, ADD COLUMN rewards_submit_completed_xid xid8, ADD COLUMN rewards_submit_effect_xid xid8;
--> statement-breakpoint
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES('rewards.annual_review.submit','rewards','approve','pay','rewards.annual_review.submit');
--> statement-breakpoint
-- Preserve every predecessor CHECK byte-expression for all predecessor kinds. Only the new closed
-- kind uses the existing unit/company column family; no assigned employment/person is fabricated.
DO $$ DECLARE c record; old text; canonical text; null_columns text; scope_name text; rewards_name text; matches integer; before_hashes jsonb; after_hashes jsonb; raw_bytes integer;
BEGIN
 -- Closed metadata/receipt whitelist. Every other physical column is strictly NULL for annual submission,
 -- including all existing assigned subject and other action receipt columns. No predecessor tree copy.
 SELECT string_agg(format('%I IS NULL',attname),' AND ' ORDER BY attnum) INTO null_columns
 FROM pg_attribute WHERE attrelid='app.assistant_own_leave_review'::regclass AND attnum>0 AND NOT attisdropped
 AND attname NOT IN ('action_kind','id','tenant_id','user_id','person_id','employment_id','company_id','intent_digest','reviewed_digest','state','created_at','expires_at','rewards_unit_id','rewards_posted_event_id','rewards_posted_revision','rewards_posted_batch_id','rewards_review_person_ids','rewards_submit_decision_id','rewards_submit_snapshot','rewards_submit_commitment','rewards_submit_completed_xid','rewards_submit_effect_xid');
 IF null_columns IS NULL THEN RAISE EXCEPTION 'UNALLOCATED-SUBMIT missing canonical custody columns';END IF;
 canonical:=null_columns||' AND employment_id IS NULL AND company_id IS NOT NULL AND rewards_unit_id IS NOT NULL AND rewards_posted_batch_id IS NULL AND ((state=''awaiting_confirmation'')=(rewards_submit_snapshot IS NOT NULL)) AND (rewards_submit_snapshot IS NULL OR jsonb_typeof(rewards_submit_snapshot)=''object'') AND ((state=''completed'')=(rewards_posted_event_id IS NOT NULL AND rewards_posted_revision IS NOT NULL AND rewards_submit_decision_id IS NOT NULL AND rewards_submit_commitment IS NOT NULL AND rewards_submit_completed_xid IS NOT NULL AND rewards_submit_effect_xid IS NOT NULL AND rewards_submit_effect_xid=rewards_submit_completed_xid)) AND ((rewards_posted_event_id IS NULL)=(rewards_posted_revision IS NULL)) AND ((rewards_posted_event_id IS NULL)=(rewards_submit_decision_id IS NULL)) AND ((rewards_posted_event_id IS NULL)=(rewards_submit_commitment IS NULL)) AND ((rewards_posted_event_id IS NULL)=(rewards_submit_completed_xid IS NULL)) AND (rewards_submit_commitment IS NULL OR rewards_submit_commitment ~ ''^[a-f0-9]{64}$'') AND (state=''awaiting_confirmation'' OR rewards_review_person_ids IS NULL) AND (state IN (''awaiting_confirmation'',''completed'') OR rewards_submit_effect_xid IS NULL)';
 -- Only three existing checks reject this kind: actor scope, dedicated Rewards columns and
 -- legacy kind receipt columns. Other family checks already enforce their own columns NULL.
 -- Discover exact keys without deparsing every large predecessor tree into a held cursor.
 SELECT count(*),min(conname) INTO matches,scope_name FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' AND conname='assistant_own_leave_review_check'
 AND conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='app.assistant_own_leave_review'::regclass AND attname='testing_execution_id'),(SELECT attnum FROM pg_attribute WHERE attrelid='app.assistant_own_leave_review'::regclass AND attname='employment_id')]::smallint[];
 IF matches<>1 THEN RAISE EXCEPTION 'UNALLOCATED-SUBMIT actor scope shape drift';END IF;
 SELECT count(*),min(conname) INTO matches,rewards_name FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' AND conname='assistant_own_leave_review_check3';
 IF matches<>1 THEN RAISE EXCEPTION 'UNALLOCATED-SUBMIT Rewards shape drift';END IF;
 SELECT jsonb_object_agg(conname,encode(sha256(convert_to(conbin::text,'UTF8')),'hex') ORDER BY conname) INTO before_hashes FROM pg_constraint
 WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' AND conname NOT IN (scope_name,rewards_name,'assistant_review_kind_columns');
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' AND conname IN (scope_name,rewards_name,'assistant_review_kind_columns') LOOP
 SELECT octet_length(conbin::text) INTO raw_bytes FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=c.conname;
 RAISE NOTICE 'UNALLOCATED-SUBMIT target % raw conbin bytes before deparse %',c.conname,raw_bytes;
 SELECT pg_get_expr(conbin,conrelid) INTO old FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=c.conname;
 RAISE NOTICE 'UNALLOCATED-SUBMIT wrapping %, predecessor bytes %, finite new branch bytes %',c.conname,octet_length(old),octet_length(canonical);
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',c.conname);
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK (CASE WHEN action_kind=''rewards.annual_review.submit'' THEN (%s) ELSE (%s) END)',c.conname,canonical,old);
 END LOOP;
 SELECT jsonb_object_agg(conname,encode(sha256(convert_to(conbin::text,'UTF8')),'hex') ORDER BY conname) INTO after_hashes FROM pg_constraint
 WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' AND conname NOT IN (scope_name,rewards_name,'assistant_review_kind_columns');
 IF before_hashes IS NULL OR before_hashes IS DISTINCT FROM after_hashes THEN RAISE EXCEPTION 'UNALLOCATED-SUBMIT untouched predecessor CHECK changed';END IF;
 RAISE NOTICE 'UNALLOCATED-SUBMIT untouched CHECK hashes identical, digest %',encode(sha256(convert_to(before_hashes::text,'UTF8')),'hex');
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_rewards_submit_columns CHECK (CASE WHEN action_kind=''rewards.annual_review.submit'' THEN (%s) ELSE rewards_submit_decision_id IS NULL AND rewards_submit_snapshot IS NULL AND rewards_submit_commitment IS NULL AND rewards_submit_completed_xid IS NULL AND rewards_submit_effect_xid IS NULL END)',canonical);
END $$;
--> statement-breakpoint
CREATE FUNCTION app._assistant_rewards_submit_review_identity(p_person uuid,p_bind boolean DEFAULT true,p_write boolean DEFAULT true) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL OR current_setting('transaction_isolation')<>'read committed' OR (p_write AND current_setting('transaction_read_only')<>'off') THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('access-configuration:'||app.current_tenant_id()::text,0)) THEN RAISE EXCEPTION 'Rewards annual submission busy' USING ERRCODE='55P03';END IF;
 IF app.principal_snapshot_current() IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id() AND a.archived_at IS NULL AND NOT app.login_blocked(a.id) AND (p_bind IS NOT TRUE OR a.person_id IS NOT DISTINCT FROM p_person) AND (a.person_id IS NULL OR EXISTS(SELECT 1 FROM public.person actual WHERE actual.id=a.person_id AND actual.tenant_id=a.tenant_id))) THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_submit_review_identity(uuid,boolean,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_rewards_submit_review_source(p_person uuid,p_unit uuid,p_company uuid,p_stage text DEFAULT NULL,p_no_pending boolean DEFAULT true) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.reward_unit%ROWTYPE;roles text[];stage text;
BEGIN
 PERFORM app._assistant_rewards_submit_review_identity(p_person);
 SELECT * INTO q FROM public.reward_unit WHERE id=p_unit AND tenant_id=app.current_tenant_id() AND company_id=p_company AND kind='annual' AND deleted_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Annual submission unavailable' USING ERRCODE='42501';END IF;
 IF p_no_pending AND EXISTS(SELECT 1 FROM public.reward_access_request pending WHERE pending.tenant_id=q.tenant_id AND pending.status='pending' AND pending.unit_revisions ? q.id::text) THEN RAISE EXCEPTION 'Open the native annual review for this submission' USING ERRCODE='42501';END IF;
 roles:=ARRAY(SELECT app.reward_roles(p_unit));stage:=coalesce(p_stage,q.status);
 IF NOT (stage='draft' AND 'bu'=ANY(roles)) THEN RAISE EXCEPTION 'Annual submission authority unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_submit_review_source(uuid,uuid,uuid,text,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Private participant privacy links cover all actual entry employments and PERSONs; no subject employment is fabricated.
CREATE FUNCTION app._assistant_rewards_submit_review_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object('actionId',r.id,'action',r.action_kind,'contractVersion',1,
 'binding',jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'employmentId',r.employment_id,'companyId',r.company_id,'unitId',r.rewards_unit_id),
 'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,'state',r.state,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object('formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,
 'eventId',r.rewards_posted_event_id,'submittedRevision',r.rewards_posted_revision,'decisionId',r.rewards_submit_decision_id,'snapshot',r.rewards_submit_snapshot,'commitment',r.rewards_submit_commitment)
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id WHERE r.id=p_id AND r.action_kind='rewards.annual_review.submit';
$$;
REVOKE ALL ON FUNCTION app._assistant_rewards_submit_review_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Pure typed-row serializers only. Function-local UTC cannot change source/authority current_date.
-- No table read, guard, command or timestamp-looking JSON string is evaluated/reinterpreted here.
CREATE FUNCTION app._assistant_rewards_submit_unit_json(p_row public.reward_unit) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$ SELECT to_jsonb(p_row) $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_submit_unit_json(public.reward_unit) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_rewards_submit_entry_json(p_row public.reward_entry) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$ SELECT to_jsonb(p_row) $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_submit_entry_json(public.reward_entry) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_rewards_submit_decision_json(p_row public.reward_decision) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$ SELECT to_jsonb(p_row) $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_submit_decision_json(public.reward_decision) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_rewards_submit_event_json(p_row public.domain_event) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$ SELECT to_jsonb(p_row) $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_submit_event_json(public.domain_event) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_rewards_submit_dependency_json(p_row anyelement) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$ SELECT to_jsonb(p_row) $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_submit_dependency_json(anyelement) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Private whole-effect snapshot. Caller must first prove the live annual-submit purpose.
CREATE FUNCTION app._assistant_rewards_submit_snapshot(p_unit uuid,p_skip_decision uuid DEFAULT NULL,p_skip_event uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.reward_unit%ROWTYPE;unit_xmin text;unit_ctid text;entry_hash text;history_hash text;event_hash text;people_hash text;employments jsonb;people jsonb;dependencies jsonb;
BEGIN
 SELECT * INTO q FROM public.reward_unit WHERE id=p_unit AND tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN RAISE EXCEPTION 'Annual submission unavailable' USING ERRCODE='42501';END IF;
 SELECT xmin::text,ctid::text INTO unit_xmin,unit_ctid FROM public.reward_unit WHERE id=q.id AND tenant_id=q.tenant_id;
 SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('row',app._assistant_rewards_submit_entry_json(e),'xmin',e.xmin::text,'ctid',e.ctid::text) ORDER BY e.id),'[]'::jsonb)::text,'UTF8')),'hex'),coalesce(jsonb_agg(e.employment_id ORDER BY e.id),'[]'::jsonb) INTO entry_hash,employments FROM public.reward_entry e WHERE e.unit_id=q.id AND e.tenant_id=q.tenant_id;
 SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('row',app._assistant_rewards_submit_decision_json(d),'xmin',d.xmin::text,'ctid',d.ctid::text) ORDER BY d.id),'[]'::jsonb)::text,'UTF8')),'hex') INTO history_hash FROM public.reward_decision d WHERE d.unit_id=q.id AND d.tenant_id=q.tenant_id AND (p_skip_decision IS NULL OR d.id<>p_skip_decision);
 SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('row',app._assistant_rewards_submit_event_json(d),'xmin',d.xmin::text,'ctid',d.ctid::text) ORDER BY d.id),'[]'::jsonb)::text,'UTF8')),'hex') INTO event_hash FROM public.domain_event d WHERE d.aggregate_id=q.id AND d.aggregate_type='reward-unit' AND d.tenant_id=q.tenant_id AND (p_skip_event IS NULL OR d.id<>p_skip_event);
 SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('employmentId',e.id,'personId',e.person_id,'companyId',e.company_id,'xmin',e.xmin::text,'ctid',e.ctid::text) ORDER BY e.id),'[]'::jsonb)::text,'UTF8')),'hex'),coalesce(jsonb_agg(DISTINCT e.person_id ORDER BY e.person_id),'[]'::jsonb) INTO people_hash,people FROM public.employment e WHERE e.tenant_id=q.tenant_id AND EXISTS(SELECT 1 FROM public.reward_entry re WHERE re.unit_id=q.id AND re.tenant_id=q.tenant_id AND re.employment_id=e.id);
 -- Governance/history/award rows obey FORCE RLS: these are NATIVE-VISIBLE hashes, never a claim to hash hidden GR facts.
 dependencies:=jsonb_build_object('governance',(SELECT coalesce(jsonb_agg(encode(sha256(convert_to(app._assistant_rewards_submit_dependency_json(d)::text||d.xmin::text||d.ctid::text,'UTF8')),'hex') ORDER BY app._assistant_rewards_submit_dependency_json(d)::text),'[]'::jsonb) FROM public.reward_governance d WHERE d.tenant_id=q.tenant_id AND d.unit_id=q.id),
 'publicGovernance',(SELECT coalesce(jsonb_agg(encode(sha256(convert_to(app._assistant_rewards_submit_dependency_json(d)::text||d.xmin::text||d.ctid::text,'UTF8')),'hex') ORDER BY app._assistant_rewards_submit_dependency_json(d)::text),'[]'::jsonb) FROM public.reward_governance_public d WHERE d.tenant_id=q.tenant_id AND d.unit_id=q.id),
 'awards',(SELECT coalesce(jsonb_agg(encode(sha256(convert_to(app._assistant_rewards_submit_dependency_json(d)::text||d.xmin::text||d.ctid::text,'UTF8')),'hex') ORDER BY app._assistant_rewards_submit_dependency_json(d)::text),'[]'::jsonb) FROM public.reward_senior_award d WHERE d.tenant_id=q.tenant_id AND d.unit_id=q.id),
 'governanceHistory',(SELECT coalesce(jsonb_agg(encode(sha256(convert_to(app._assistant_rewards_submit_dependency_json(d)::text||d.xmin::text||d.ctid::text,'UTF8')),'hex') ORDER BY app._assistant_rewards_submit_dependency_json(d)::text),'[]'::jsonb) FROM public.reward_governance_history d WHERE d.tenant_id=q.tenant_id AND d.unit_id=q.id),
 'accessRequests',(SELECT coalesce(jsonb_agg(encode(sha256(convert_to(app._assistant_rewards_submit_dependency_json(a)::text||a.xmin::text||a.ctid::text,'UTF8')),'hex') ORDER BY a.id),'[]'::jsonb) FROM public.reward_access_request a WHERE a.tenant_id=q.tenant_id AND a.unit_revisions ? q.id::text),
 'accessEvents',(SELECT coalesce(jsonb_agg(encode(sha256(convert_to(app._assistant_rewards_submit_event_json(a)::text||a.xmin::text||a.ctid::text,'UTF8')),'hex') ORDER BY a.id),'[]'::jsonb) FROM public.domain_event a WHERE a.tenant_id=q.tenant_id AND a.aggregate_type='reward-access-request' AND EXISTS(SELECT 1 FROM public.reward_access_request request WHERE request.id=a.aggregate_id AND request.tenant_id=q.tenant_id AND request.unit_revisions ? q.id::text)),
 'members',(SELECT coalesce(jsonb_agg(jsonb_build_object('rowHash',encode(sha256(convert_to(app._assistant_rewards_submit_dependency_json(m)::text,'UTF8')),'hex'),'xmin',m.xmin::text,'ctid',m.ctid::text,'nativeEligibility',app.reward_member_state(m.id)) ORDER BY m.id),'[]'::jsonb) FROM public.reward_member m WHERE m.tenant_id=q.tenant_id AND m.unit_id=q.id),
 'memberUsers',(SELECT coalesce(jsonb_agg(encode(sha256(convert_to(app._assistant_rewards_submit_dependency_json(d)::text||d.xmin::text||d.ctid::text,'UTF8')),'hex') ORDER BY app._assistant_rewards_submit_dependency_json(d)::text),'[]'::jsonb) FROM public.app_user d WHERE d.tenant_id=q.tenant_id AND EXISTS(SELECT 1 FROM public.reward_member m WHERE m.tenant_id=q.tenant_id AND m.unit_id=q.id AND m.user_id=d.id)),
 'memberEmployment',(SELECT coalesce(jsonb_agg(encode(sha256(convert_to(app._assistant_rewards_submit_dependency_json(d)::text||d.xmin::text||d.ctid::text,'UTF8')),'hex') ORDER BY app._assistant_rewards_submit_dependency_json(d)::text),'[]'::jsonb) FROM public.employment d WHERE d.tenant_id=q.tenant_id AND EXISTS(SELECT 1 FROM public.reward_member m JOIN public.app_user u ON u.tenant_id=m.tenant_id AND u.id=m.user_id WHERE m.tenant_id=q.tenant_id AND m.unit_id=q.id AND u.person_id=d.person_id)),
 'memberAssignments',(SELECT coalesce(jsonb_agg(encode(sha256(convert_to(app._assistant_rewards_submit_dependency_json(d)::text||d.xmin::text||d.ctid::text,'UTF8')),'hex') ORDER BY app._assistant_rewards_submit_dependency_json(d)::text),'[]'::jsonb) FROM public.assignment d WHERE d.tenant_id=q.tenant_id AND EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id JOIN public.reward_member m ON m.user_id=u.id AND m.tenant_id=u.tenant_id WHERE m.tenant_id=q.tenant_id AND m.unit_id=q.id AND e.id=d.employment_id)),
 'memberProvenance',(SELECT coalesce(jsonb_agg(encode(sha256(convert_to(app._assistant_rewards_submit_dependency_json(d)::text||d.xmin::text||d.ctid::text,'UTF8')),'hex') ORDER BY app._assistant_rewards_submit_dependency_json(d)::text),'[]'::jsonb) FROM public.reward_access_source_epoch d WHERE d.tenant_id=q.tenant_id AND EXISTS(SELECT 1 FROM public.reward_member m JOIN public.app_user u ON u.tenant_id=m.tenant_id AND u.id=m.user_id WHERE m.tenant_id=q.tenant_id AND m.unit_id=q.id AND ((d.source_kind='person' AND d.source_id=u.person_id) OR (d.source_kind='user' AND d.source_id=u.id)))));
 RETURN jsonb_build_object('nativeVisibleDependenciesHash',encode(sha256(convert_to(dependencies::text,'UTF8')),'hex'),'unitStableHash',encode(sha256(convert_to((app._assistant_rewards_submit_unit_json(q)-'status'-'revision'-'approved_digest'-'updated_at')::text,'UTF8')),'hex'),'unitFullHash',encode(sha256(convert_to(app._assistant_rewards_submit_unit_json(q)::text,'UTF8')),'hex'),'unitXmin',unit_xmin,'unitCtid',unit_ctid,'revision',q.revision,'fromStage',q.status,'entriesHash',entry_hash,'historyHash',history_hash,'eventsHash',event_hash,'peopleHash',people_hash,'employmentIds',employments,'personIds',people);
END $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_submit_snapshot(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The native command's original audit stays unchanged. This reader nominates actual rows, never UUID guesses.
CREATE FUNCTION app._assistant_rewards_submit_effect_row(r app.assistant_own_leave_review,p_reason text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.reward_unit%ROWTYPE;unit_xmin text;unit_ctid text;d public.reward_decision%ROWTYPE;ev public.domain_event%ROWTYPE;ids uuid[];n integer;after_snapshot jsonb;targets jsonb;top_xid xid:=pg_current_xact_id()::xid;
BEGIN
 PERFORM app._assistant_rewards_submit_review_identity(NULL,false);
 IF r.id IS NULL OR r.tenant_id IS DISTINCT FROM app.current_tenant_id() OR r.user_id IS DISTINCT FROM app.current_user_id() OR r.person_id IS DISTINCT FROM (SELECT person_id FROM public.app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id()) OR r.action_kind IS DISTINCT FROM 'rewards.annual_review.submit' OR r.state IS DISTINCT FROM 'awaiting_confirmation' OR r.rewards_submit_snapshot IS NULL OR r.rewards_submit_effect_xid IS DISTINCT FROM pg_current_xact_id() OR p_reason IS NULL OR p_reason<>btrim(p_reason) OR length(p_reason) NOT BETWEEN 10 AND 4000 THEN RAISE EXCEPTION 'Annual submission proof unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_rewards_submit_review_source(r.person_id,r.rewards_unit_id,r.company_id,r.rewards_submit_snapshot->>'fromStage');
 SELECT * INTO q FROM public.reward_unit WHERE id=r.rewards_unit_id AND tenant_id=r.tenant_id;
 SELECT xmin::text,ctid::text INTO unit_xmin,unit_ctid FROM public.reward_unit WHERE id=q.id AND tenant_id=q.tenant_id;
 IF q.kind<>'annual' OR q.status<>'bg' OR q.revision<>(r.rewards_submit_snapshot->>'revision')::integer OR q.approved_digest IS DISTINCT FROM r.rewards_submit_snapshot->>'nativeDecisionDigest' OR unit_xmin IS DISTINCT FROM top_xid::text THEN RAISE EXCEPTION 'Annual submission proof unavailable' USING ERRCODE='42501';END IF;
 SELECT count(*),array_agg(x.id) INTO n,ids FROM public.reward_decision x WHERE x.unit_id=q.id AND x.tenant_id=q.tenant_id AND x.actor_id=r.user_id AND x.revision=(r.rewards_submit_snapshot->>'revision')::integer AND x.action='submit' AND x.from_stage=r.rewards_submit_snapshot->>'fromStage' AND x.to_stage='bg' AND x.reason=p_reason AND x.digest=r.rewards_submit_snapshot->>'nativeDecisionDigest' AND x.xmin=top_xid;
 IF n<>1 THEN RAISE EXCEPTION 'Annual submission decision is not unique' USING ERRCODE='42501';END IF;
 SELECT * INTO d FROM public.reward_decision WHERE id=ids[1] AND tenant_id=q.tenant_id;
 SELECT count(*),array_agg(x.id) INTO n,ids FROM public.domain_event x WHERE x.tenant_id=q.tenant_id AND x.aggregate_id=q.id AND x.aggregate_type='reward-unit' AND x.event_type='reward-unit.routed' AND x.actor_type='user' AND x.actor_id=r.user_id AND x.subject_employment_id IS NULL AND x.xmin=top_xid AND x.payload=jsonb_build_object('from',d.from_stage,'to','bg','revision',d.revision);
 IF n<>1 THEN RAISE EXCEPTION 'Annual submission event is not unique' USING ERRCODE='42501';END IF;
 SELECT * INTO ev FROM public.domain_event WHERE id=ids[1] AND tenant_id=q.tenant_id;
 after_snapshot:=app._assistant_rewards_submit_snapshot(q.id,d.id,ev.id);
 IF (after_snapshot-'unitFullHash'-'unitXmin'-'unitCtid'-'revision'-'fromStage') IS DISTINCT FROM (r.rewards_submit_snapshot-'unitFullHash'-'unitXmin'-'unitCtid'-'revision'-'fromStage'-'nativeDecisionDigest') THEN RAISE EXCEPTION 'Annual submission changed an unrelated effect' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(item ORDER BY item->>'kind',item->>'id'),'[]'::jsonb) INTO targets FROM (SELECT DISTINCT jsonb_build_object('kind','employment','id',e.id) item FROM public.reward_entry re JOIN public.employment e ON e.id=re.employment_id AND e.tenant_id=re.tenant_id WHERE re.unit_id=q.id AND re.tenant_id=q.tenant_id UNION SELECT DISTINCT jsonb_build_object('kind','person','id',e.person_id) FROM public.reward_entry re JOIN public.employment e ON e.id=re.employment_id AND e.tenant_id=re.tenant_id WHERE re.unit_id=q.id AND re.tenant_id=q.tenant_id) actual;
 RETURN jsonb_build_object('unitId',q.id,'decisionId',d.id,'eventId',ev.id,'submittedRevision',d.revision,'fromStage',d.from_stage,'unitXmin',unit_xmin,'unitCtid',unit_ctid,'decisionCtid',(SELECT ctid::text FROM public.reward_decision WHERE id=d.id AND tenant_id=d.tenant_id),'eventCtid',(SELECT ctid::text FROM public.domain_event WHERE id=ev.id AND tenant_id=ev.tenant_id),'decisionXmin',top_xid::text,'eventXmin',top_xid::text,'unitHash',encode(sha256(convert_to(app._assistant_rewards_submit_unit_json(q)::text,'UTF8')),'hex'),'decisionHash',encode(sha256(convert_to(app._assistant_rewards_submit_decision_json(d)::text,'UTF8')),'hex'),'eventHash',encode(sha256(convert_to(app._assistant_rewards_submit_event_json(ev)::text,'UTF8')),'hex'),'snapshotHash',encode(sha256(convert_to(r.rewards_submit_snapshot::text,'UTF8')),'hex'),'targets',targets);
END $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_submit_effect_row(app.assistant_own_leave_review,text) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app._assistant_rewards_submit_effect(p_review uuid,p_reason text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_review AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='rewards.annual_review.submit';
 RETURN app._assistant_rewards_submit_effect_row(r,p_reason);
END $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_submit_effect(uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_submit_native_effect(p_review uuid,p_reason text) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app._assistant_rewards_submit_effect(p_review,p_reason) $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_submit_native_effect(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_submit_native_effect(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_submit_clear_private() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.action_kind='rewards.annual_review.submit' AND NEW.state<>'awaiting_confirmation' THEN NEW.rewards_submit_snapshot:=NULL;NEW.rewards_review_person_ids:=NULL;IF NEW.state<>'completed' THEN NEW.rewards_submit_effect_xid:=NULL;END IF;END IF;
  RETURN NEW;
 END IF;
 -- Body erasure/discard before the parent transition clears private proof and state in one row write.
 UPDATE app.assistant_own_leave_review SET rewards_submit_snapshot=NULL,rewards_review_person_ids=NULL,intent_digest=NULL,reviewed_digest=NULL,state=CASE WHEN state='awaiting_confirmation' THEN 'refused' ELSE state END WHERE id=OLD.action_id AND action_kind='rewards.annual_review.submit';
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_submit_clear_private() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_rewards_submit_terminal BEFORE UPDATE ON app.assistant_own_leave_review FOR EACH ROW EXECUTE FUNCTION app.assistant_rewards_submit_clear_private();
CREATE TRIGGER assistant_rewards_submit_body_delete AFTER DELETE ON app.assistant_own_leave_review_content FOR EACH ROW EXECUTE FUNCTION app.assistant_rewards_submit_clear_private();
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_submit_review_prepare(p_id uuid,p_person uuid,p_unit uuid,p_company uuid,p_native_digest text,p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();at_time timestamptz;people uuid[];snapshot jsonb;
BEGIN
 PERFORM app._assistant_rewards_submit_review_source(p_person,p_unit,p_company);
 IF p_native_digest IS NULL OR p_native_digest !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Annual submission unavailable' USING ERRCODE='22023';END IF;
 snapshot:=app._assistant_rewards_submit_snapshot(p_unit)||jsonb_build_object('nativeDecisionDigest',p_native_digest);
 people:=ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(snapshot->'personIds') ORDER BY value);
 IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND (i.person_id=p_person OR i.person_id=ANY(people))) OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND (i.person_id=p_person OR i.person_id=ANY(people))) THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 IF p_id IS NULL OR p_intent_digest IS NULL OR p_intent_digest !~ '^[a-f0-9]{64}$' OR p_reviewed_digest IS NULL OR p_reviewed_digest !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$' OR p_wrapped_dek IS NULL OR length(p_wrapped_dek) NOT BETWEEN 1 AND 512 OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='22023';END IF;
 at_time:=clock_timestamp();
 IF (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation' AND expires_at>at_time)>=5 OR (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND created_at>at_time-interval '10 minutes')>=20 THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='54000';END IF;
 INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,rewards_unit_id,rewards_review_person_ids,rewards_submit_snapshot,intent_digest,reviewed_digest,state,created_at,expires_at)
 VALUES('rewards.annual_review.submit',p_id,t,u,p_person,NULL,p_company,p_unit,people,snapshot,p_intent_digest,p_reviewed_digest,'awaiting_confirmation',at_time,at_time+interval '10 minutes') ON CONFLICT(id) DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped_dek,p_ciphertext);
 RETURN app._assistant_rewards_submit_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_submit_review_prepare(uuid,uuid,uuid,uuid,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_submit_review_prepare(uuid,uuid,uuid,uuid,text,text,text,text,text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_submit_review_subject(p_id uuid) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_rewards_submit_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND action_kind='rewards.annual_review.submit';
 IF NOT FOUND THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.assistant_rewards_submit_scope(r.rewards_unit_id,r.id,false);RETURN r.rewards_unit_id;
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_submit_review_subject(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_submit_review_subject(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_submit_review_peek(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_rewards_submit_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND action_kind='rewards.annual_review.submit';
 IF NOT FOUND THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.assistant_rewards_submit_scope(r.rewards_unit_id,r.id,false);
 IF r.state='awaiting_confirmation' AND (r.rewards_review_person_ids IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c WHERE c.action_id=r.id)) THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('review',app._assistant_rewards_submit_review_json(r.id),'pendingExpired',r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at);
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_submit_review_peek(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_submit_review_peek(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_submit_review_read(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_rewards_submit_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND action_kind='rewards.annual_review.submit' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.assistant_rewards_submit_scope(r.rewards_unit_id,r.id,false);
 IF r.state='awaiting_confirmation' AND (r.rewards_review_person_ids IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c WHERE c.action_id=r.id)) THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review a WHERE c.action_id=a.id AND a.id=r.id AND a.state<>'awaiting_confirmation';
 RETURN app._assistant_rewards_submit_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_submit_review_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_submit_review_read(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_rewards_submit_completed_shape(p_before app.assistant_own_leave_review,p_proof jsonb) RETURNS app.assistant_own_leave_review
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE expected app.assistant_own_leave_review%ROWTYPE:=p_before;
BEGIN
 IF p_before.action_kind IS DISTINCT FROM 'rewards.annual_review.submit' OR p_before.state IS DISTINCT FROM 'awaiting_confirmation' OR p_before.rewards_submit_effect_xid IS DISTINCT FROM pg_current_xact_id() THEN RAISE EXCEPTION 'Annual submission completion shape unavailable' USING ERRCODE='42501';END IF;
 expected.state:='completed';expected.intent_digest:=NULL;expected.reviewed_digest:=NULL;
 expected.rewards_posted_event_id:=(p_proof->>'eventId')::uuid;expected.rewards_posted_revision:=(p_proof->>'submittedRevision')::integer;
 expected.rewards_submit_decision_id:=(p_proof->>'decisionId')::uuid;expected.rewards_submit_commitment:=encode(sha256(convert_to((p_proof-'targets')::text,'UTF8')),'hex');
 expected.rewards_submit_completed_xid:=pg_current_xact_id();expected.rewards_submit_snapshot:=NULL;expected.rewards_review_person_ids:=NULL;
 RETURN expected;
END $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_submit_completed_shape(app.assistant_own_leave_review,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_rewards_submit_assert_capture(p_before app.assistant_own_leave_review,p_proof jsonb) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE captured app.native_outcome_source_capture%ROWTYPE;actual_targets jsonb;expected_targets jsonb;
BEGIN
 SELECT * INTO captured FROM app.native_outcome_source_capture c WHERE c.tenant_id=p_before.tenant_id AND c.user_id=p_before.user_id AND c.person_id IS NOT DISTINCT FROM p_before.person_id AND c.action='rewards.annual_review.submit' AND c.source_kind='review' AND c.source_id=p_before.id AND c.review_id=p_before.id AND c.event_id=(p_proof->>'eventId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'Annual submission privacy capture unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(item ORDER BY item->>'kind',item->>'id'),'[]'::jsonb) INTO expected_targets FROM (SELECT DISTINCT value item FROM jsonb_array_elements(p_proof->'targets') UNION SELECT jsonb_build_object('kind','person','id',p_before.person_id) WHERE p_before.person_id IS NOT NULL) expected;
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',t.kind,'id',t.target_id) ORDER BY t.kind,t.target_id::text),'[]'::jsonb) INTO actual_targets FROM app.native_outcome_source_target t WHERE t.capture_id=captured.id;
 IF actual_targets IS DISTINCT FROM expected_targets OR captured.target_count<>jsonb_array_length(expected_targets) THEN RAISE EXCEPTION 'Annual submission privacy target set changed' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_submit_assert_capture(app.assistant_own_leave_review,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_submit_review_complete(p_id uuid,p_reviewed_digest text,p_reason text,p_proof jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;actual jsonb;commitment text;expected_row app.assistant_own_leave_review%ROWTYPE;saved_row app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_rewards_submit_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND action_kind='rewards.annual_review.submit' FOR UPDATE NOWAIT;
 IF NOT FOUND OR p_proof IS NULL OR jsonb_typeof(p_proof)<>'object' THEN RAISE EXCEPTION 'Annual submission unavailable' USING ERRCODE='42501';END IF;
 commitment:=encode(sha256(convert_to((p_proof-'targets')::text,'UTF8')),'hex');
 IF r.state='completed' THEN
  PERFORM app.assistant_rewards_submit_receipt(r.id);
  IF r.rewards_submit_commitment IS DISTINCT FROM commitment OR r.rewards_submit_decision_id IS DISTINCT FROM (p_proof->>'decisionId')::uuid OR r.rewards_posted_event_id IS DISTINCT FROM (p_proof->>'eventId')::uuid OR r.rewards_posted_revision IS DISTINCT FROM (p_proof->>'submittedRevision')::integer THEN RAISE EXCEPTION 'Annual submission unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
  IF r.reviewed_digest IS DISTINCT FROM p_reviewed_digest OR r.rewards_review_person_ids IS NULL OR r.rewards_submit_snapshot IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c WHERE c.action_id=r.id) THEN RAISE EXCEPTION 'Annual submission unavailable' USING ERRCODE='42501';END IF;
  actual:=app._assistant_rewards_submit_effect(r.id,p_reason);
  IF actual IS DISTINCT FROM p_proof THEN RAISE EXCEPTION 'Annual submission physical proof changed' USING ERRCODE='42501';END IF;
  PERFORM app._assistant_rewards_submit_assert_capture(r,actual);expected_row:=app._assistant_rewards_submit_completed_shape(r,actual);
  UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,rewards_posted_event_id=(actual->>'eventId')::uuid,rewards_posted_revision=(actual->>'submittedRevision')::integer,rewards_submit_decision_id=(actual->>'decisionId')::uuid,rewards_submit_commitment=commitment,rewards_submit_completed_xid=pg_current_xact_id() WHERE id=r.id;
  SELECT * INTO saved_row FROM app.assistant_own_leave_review WHERE id=r.id;
  IF NOT FOUND OR saved_row IS DISTINCT FROM expected_row THEN RAISE EXCEPTION 'Annual submission completion postimage changed' USING ERRCODE='42501';END IF;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
  SELECT * INTO saved_row FROM app.assistant_own_leave_review WHERE id=r.id;
  IF NOT FOUND OR saved_row IS DISTINCT FROM expected_row THEN RAISE EXCEPTION 'Annual submission cleanup postimage changed' USING ERRCODE='42501';END IF;
 ELSE RAISE EXCEPTION 'Annual submission unavailable' USING ERRCODE='42501';END IF;
 RETURN app._assistant_rewards_submit_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_submit_review_complete(uuid,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_submit_review_complete(uuid,text,text,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_submit_review_discard(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_rewards_submit_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND action_kind='rewards.annual_review.submit' FOR UPDATE NOWAIT;
 IF NOT FOUND OR r.state='completed' THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' THEN UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL,rewards_review_person_ids=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 -- Also clears a malformed already-retired association without touching native canonical history.
 UPDATE app.assistant_own_leave_review SET rewards_review_person_ids=NULL WHERE id=r.id AND rewards_review_person_ids IS NOT NULL;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=r.id;
 RETURN jsonb_build_object('action','rewards.annual_review.submit','contractVersion',1,'actionId',r.id,'state',r.state);
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_submit_review_discard(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_submit_review_discard(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_submit_reviews_index() RETURNS TABLE(action text,action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_rewards_submit_review_identity(NULL,false,false);
 RETURN QUERY SELECT r.action_kind,r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND r.action_kind='rewards.annual_review.submit' ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_submit_reviews_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_submit_reviews_index() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_submit_scope(p_unit uuid,p_review uuid DEFAULT NULL,p_lock boolean DEFAULT false) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.reward_unit%ROWTYPE;r app.assistant_own_leave_review%ROWTYPE;d public.reward_decision%ROWTYPE;actor_person uuid;permission_stage text;sn jsonb;
BEGIN
 PERFORM app._assistant_rewards_submit_review_identity(NULL,false);
 SELECT a.person_id INTO actor_person FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id();
 SELECT * INTO q FROM public.reward_unit WHERE id=p_unit AND tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN RAISE EXCEPTION 'Annual submission unavailable' USING ERRCODE='42501';END IF;
 permission_stage:=q.status;
 IF p_review IS NOT NULL THEN
  SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_review AND tenant_id=q.tenant_id AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=q.tenant_id) AND action_kind='rewards.annual_review.submit' AND rewards_unit_id=q.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Annual submission unavailable' USING ERRCODE='42501';END IF;
  IF r.state='completed' THEN
   SELECT * INTO d FROM public.reward_decision WHERE id=r.rewards_submit_decision_id AND tenant_id=r.tenant_id AND unit_id=q.id AND actor_id=r.user_id AND action='submit' AND to_stage='bg' AND revision=r.rewards_posted_revision;
   IF NOT FOUND OR r.rewards_submit_commitment IS NULL THEN RAISE EXCEPTION 'Annual submission unavailable' USING ERRCODE='42501';END IF;
   permission_stage:=d.from_stage;
  END IF;
 END IF;
 PERFORM app._assistant_rewards_submit_review_source(actor_person,q.id,q.company_id,permission_stage,p_review IS NULL OR r.state<>'completed');
 IF p_lock THEN
  PERFORM app.reward_funding(q.id,true);
  SELECT * INTO q FROM public.reward_unit WHERE id=q.id AND tenant_id=q.tenant_id FOR UPDATE NOWAIT;
 END IF;
 sn:=app._assistant_rewards_submit_snapshot(q.id);
 RETURN (SELECT jsonb_build_object('unitId',q.id,'companyId',q.company_id,'companyName',c.legal_name,'name',rc.name||' · '||coalesce(nullif(trim(b.label),''),b.code),'revision',q.revision,'status',q.status,'snapshot',sn)
 FROM public.company c JOIN public.reward_cycle rc ON rc.id=q.cycle_id AND rc.tenant_id=q.tenant_id JOIN public.business_unit b ON b.id=q.business_unit_id AND b.tenant_id=q.tenant_id WHERE c.id=q.company_id AND c.tenant_id=q.tenant_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_submit_scope(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_submit_scope(uuid,uuid,boolean) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_submit_receipt(p_review uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;q public.reward_unit%ROWTYPE;d public.reward_decision%ROWTYPE;ev public.domain_event%ROWTYPE;
BEGIN
 PERFORM app._assistant_rewards_submit_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_review AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND action_kind='rewards.annual_review.submit' AND state='completed';
 IF NOT FOUND OR r.rewards_submit_commitment IS NULL THEN RAISE EXCEPTION 'Annual submission unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.assistant_rewards_submit_scope(r.rewards_unit_id,r.id,false);
 SELECT * INTO q FROM public.reward_unit WHERE id=r.rewards_unit_id AND tenant_id=r.tenant_id;
 SELECT * INTO d FROM public.reward_decision WHERE id=r.rewards_submit_decision_id AND unit_id=q.id AND tenant_id=q.tenant_id AND actor_id=r.user_id AND revision=r.rewards_posted_revision AND action='submit' AND to_stage='bg';
 IF NOT FOUND OR q.revision<d.revision THEN RAISE EXCEPTION 'Annual submission unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO ev FROM public.domain_event WHERE id=r.rewards_posted_event_id AND tenant_id=q.tenant_id AND aggregate_id=q.id AND aggregate_type='reward-unit' AND event_type='reward-unit.routed' AND actor_type='user' AND actor_id=r.user_id AND subject_employment_id IS NULL AND payload=jsonb_build_object('from',d.from_stage,'to','bg','revision',d.revision);
 IF NOT FOUND THEN RAISE EXCEPTION 'Annual submission unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('kind','submitted_for_review','unitId',q.id,'decisionId',d.id,'eventId',ev.id,'submittedRevision',d.revision,'currentRevision',q.revision,'currentStatus',q.status,'proof','historical_annual_submission_current_unit');
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_submit_receipt(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_submit_receipt(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_submit_choices() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE items jsonb;
BEGIN
 PERFORM app._assistant_rewards_submit_review_identity(NULL,false);
 SELECT coalesce(jsonb_agg(jsonb_build_object('unitId',q.id,'companyName',q.company_name,'name',q.display_name,'revision',q.revision,'status',q.status) ORDER BY q.company_name,q.display_name,q.id),'[]'::jsonb) INTO items FROM (
 SELECT u.id,u.revision,u.status,c.legal_name company_name,rc.name||' · '||coalesce(nullif(trim(b.label),''),b.code) display_name FROM public.reward_unit u JOIN public.company c ON c.id=u.company_id AND c.tenant_id=u.tenant_id JOIN public.reward_cycle rc ON rc.id=u.cycle_id AND rc.tenant_id=u.tenant_id JOIN public.business_unit b ON b.id=u.business_unit_id AND b.tenant_id=u.tenant_id
 WHERE u.tenant_id=app.current_tenant_id() AND u.kind='annual' AND u.deleted_at IS NULL AND (u.status='draft' AND 'bu'=ANY(ARRAY(SELECT app.reward_roles(u.id)))) AND NOT EXISTS(SELECT 1 FROM public.reward_access_request pending WHERE pending.tenant_id=u.tenant_id AND pending.status='pending' AND pending.unit_revisions ? u.id::text) ORDER BY c.legal_name,display_name,u.id LIMIT 21) q;
 RETURN jsonb_build_object('kind','choices','truncated',jsonb_array_length(items)>20,'units',CASE WHEN jsonb_array_length(items)>20 THEN items-20 ELSE items END);
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_submit_choices() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_submit_choices() TO ai_hr_app;
--> statement-breakpoint
-- Extend only closed native-outcome predicates; retain all predecessor bodies and grants.
DO $$ DECLARE target regprocedure;definition text;marker text;replacement text;
BEGIN
 FOR target IN SELECT signature::regprocedure FROM unnest(ARRAY['app.native_outcome_review_completed(text,uuid)','app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)','app.native_outcome_completed_review_choices(jsonb)']) signature LOOP
 definition:=pg_get_functiondef(target);
 IF target='app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure THEN marker:='WHEN ''rewards.cancel_review'' THEN r.rewards_posted_event_id';replacement:=marker||' WHEN ''rewards.annual_review.submit'' THEN r.rewards_posted_event_id';
 ELSE marker:='''rewards.post''';replacement:=marker||',''rewards.annual_review.submit'''; END IF;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'UNALLOCATED-SUBMIT unexpected outcome owner %',target;END IF;
 EXECUTE replace(definition,marker,replacement);
 END LOOP;
END $$;

--> statement-breakpoint
-- Retain OLD pending proof only inside the deferred trigger queue. Sensitive snapshot/body are
-- already cleared in the same completion write, including erasure, discard and rollback paths.
CREATE FUNCTION app._assistant_rewards_submit_final_effect() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE current_row app.assistant_own_leave_review%ROWTYPE;expected_row app.assistant_own_leave_review%ROWTYPE;actual jsonb;human_reason text;
BEGIN
 IF TG_RELID<>'app.assistant_own_leave_review'::regclass OR TG_OP<>'UPDATE' OR OLD.action_kind<>'rewards.annual_review.submit' OR OLD.state<>'awaiting_confirmation' OR NEW.state<>'completed' THEN RAISE EXCEPTION 'Invalid annual submission final validator';END IF;
 SELECT * INTO current_row FROM app.assistant_own_leave_review WHERE id=NEW.id AND tenant_id=NEW.tenant_id;
 IF NOT FOUND OR current_row IS DISTINCT FROM NEW OR current_row.rewards_submit_completed_xid IS DISTINCT FROM pg_current_xact_id() THEN RAISE EXCEPTION 'Annual submission completion changed' USING ERRCODE='42501';END IF;
 SELECT reason INTO human_reason FROM public.reward_decision WHERE id=NEW.rewards_submit_decision_id AND tenant_id=NEW.tenant_id AND unit_id=NEW.rewards_unit_id;
 IF EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=NEW.id) OR NEW.rewards_submit_snapshot IS NOT NULL OR NEW.rewards_review_person_ids IS NOT NULL THEN RAISE EXCEPTION 'Annual submission private cleanup changed' USING ERRCODE='42501';END IF;
 actual:=app._assistant_rewards_submit_effect_row(OLD,human_reason);
 expected_row:=app._assistant_rewards_submit_completed_shape(OLD,actual);
 IF NEW IS DISTINCT FROM expected_row OR current_row IS DISTINCT FROM expected_row THEN RAISE EXCEPTION 'Annual submission protected binding changed' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_rewards_submit_assert_capture(OLD,actual);
 IF app.native_outcome_targets_require(NEW.tenant_id,NEW.user_id,NEW.person_id,'rewards.annual_review.submit',NEW.id,NEW.rewards_posted_event_id) IS NOT TRUE THEN RAISE EXCEPTION 'Annual submission privacy capture unavailable' USING ERRCODE='42501';END IF;
 IF NEW.rewards_submit_commitment IS DISTINCT FROM encode(sha256(convert_to((actual-'targets')::text,'UTF8')),'hex') OR NEW.rewards_submit_decision_id IS DISTINCT FROM (actual->>'decisionId')::uuid OR NEW.rewards_posted_event_id IS DISTINCT FROM (actual->>'eventId')::uuid OR NEW.rewards_posted_revision IS DISTINCT FROM (actual->>'submittedRevision')::integer THEN RAISE EXCEPTION 'Annual submission final proof changed' USING ERRCODE='42501';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_submit_final_effect() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER assistant_rewards_submit_final_effect AFTER UPDATE ON app.assistant_own_leave_review DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.action_kind='rewards.annual_review.submit' AND OLD.state='awaiting_confirmation' AND NEW.state='completed') EXECUTE FUNCTION app._assistant_rewards_submit_final_effect();
--> statement-breakpoint
CREATE INDEX assistant_rewards_submit_tx_seal ON app.assistant_own_leave_review(tenant_id,rewards_submit_completed_xid,rewards_unit_id) WHERE action_kind='rewards.annual_review.submit' AND state='completed';
-- SET CONSTRAINTS may flush a deferred validator early. These guards remain live for the rest
-- of the root transaction, including child savepoints. Later independent native transactions work.
CREATE FUNCTION app._assistant_rewards_submit_sealed_write() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous jsonb;following jsonb;root_xid xid8:=pg_current_xact_id_if_assigned();blocked boolean;
BEGIN
 IF TG_RELID NOT IN ('public.reward_unit'::regclass,'public.reward_entry'::regclass,'public.reward_decision'::regclass,'public.domain_event'::regclass,'public.employment'::regclass,'public.app_user'::regclass,'public.role_assignment'::regclass,'public.assignment'::regclass,'public.reward_member'::regclass,'public.reward_governance'::regclass,'public.reward_governance_public'::regclass,'public.reward_governance_history'::regclass,'public.reward_senior_award'::regclass,'public.reward_access_source_epoch'::regclass,'public.reward_access_request'::regclass,'app.assistant_own_leave_review'::regclass) OR TG_OP NOT IN ('INSERT','UPDATE','DELETE') THEN RAISE EXCEPTION 'Invalid annual submission writer guard';END IF;
 IF TG_OP<>'INSERT' THEN previous:=to_jsonb(OLD);END IF;
 IF TG_OP<>'DELETE' THEN following:=to_jsonb(NEW);END IF;
 IF root_xid IS NOT NULL THEN
  IF TG_RELID='app.assistant_own_leave_review'::regclass THEN
   IF previous->>'action_kind'='rewards.annual_review.submit' AND previous->>'state'='completed' AND (previous->>'rewards_submit_completed_xid')::xid8=root_xid AND (TG_OP='DELETE' OR previous IS DISTINCT FROM following) THEN RAISE EXCEPTION 'Annual submission transaction already sealed' USING ERRCODE='42501';END IF;
  ELSE
   SELECT EXISTS(SELECT 1 FROM app.assistant_own_leave_review r WHERE r.action_kind='rewards.annual_review.submit' AND r.state='completed' AND r.rewards_submit_completed_xid=root_xid AND (
    (TG_RELID='public.reward_unit'::regclass AND ((r.tenant_id=(previous->>'tenant_id')::uuid AND r.rewards_unit_id=(previous->>'id')::uuid) OR (r.tenant_id=(following->>'tenant_id')::uuid AND r.rewards_unit_id=(following->>'id')::uuid))) OR
    (TG_RELID IN ('public.reward_entry'::regclass,'public.reward_decision'::regclass,'public.reward_member'::regclass,'public.reward_governance'::regclass,'public.reward_governance_public'::regclass,'public.reward_governance_history'::regclass,'public.reward_senior_award'::regclass) AND ((r.tenant_id=(previous->>'tenant_id')::uuid AND r.rewards_unit_id=(previous->>'unit_id')::uuid) OR (r.tenant_id=(following->>'tenant_id')::uuid AND r.rewards_unit_id=(following->>'unit_id')::uuid))) OR
    (TG_RELID='public.domain_event'::regclass AND ((previous->>'aggregate_type'='reward-unit' AND r.tenant_id=(previous->>'tenant_id')::uuid AND r.rewards_unit_id=(previous->>'aggregate_id')::uuid) OR (following->>'aggregate_type'='reward-unit' AND r.tenant_id=(following->>'tenant_id')::uuid AND r.rewards_unit_id=(following->>'aggregate_id')::uuid))) OR
    (TG_RELID='public.app_user'::regclass AND ((r.tenant_id=(previous->>'tenant_id')::uuid AND r.user_id=(previous->>'id')::uuid) OR (r.tenant_id=(following->>'tenant_id')::uuid AND r.user_id=(following->>'id')::uuid))) OR
    (TG_RELID='public.role_assignment'::regclass AND ((r.tenant_id=(previous->>'tenant_id')::uuid AND r.user_id=(previous->>'app_user_id')::uuid) OR (r.tenant_id=(following->>'tenant_id')::uuid AND r.user_id=(following->>'app_user_id')::uuid))) OR
    (TG_RELID='public.employment'::regclass AND ((r.tenant_id=(previous->>'tenant_id')::uuid AND r.person_id=(previous->>'person_id')::uuid) OR (r.tenant_id=(following->>'tenant_id')::uuid AND r.person_id=(following->>'person_id')::uuid))) OR
    (TG_RELID='public.assignment'::regclass AND EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=r.tenant_id AND e.person_id=r.person_id AND ((e.tenant_id=(previous->>'tenant_id')::uuid AND e.id=(previous->>'employment_id')::uuid) OR (e.tenant_id=(following->>'tenant_id')::uuid AND e.id=(following->>'employment_id')::uuid)))) OR
    (TG_RELID='public.app_user'::regclass AND EXISTS(SELECT 1 FROM public.reward_member m WHERE m.tenant_id=r.tenant_id AND m.unit_id=r.rewards_unit_id AND (m.user_id=(previous->>'id')::uuid OR m.user_id=(following->>'id')::uuid))) OR
    (TG_RELID='public.employment'::regclass AND EXISTS(SELECT 1 FROM public.reward_member m JOIN public.app_user u ON u.id=m.user_id AND u.tenant_id=m.tenant_id WHERE m.tenant_id=r.tenant_id AND m.unit_id=r.rewards_unit_id AND (u.person_id=(previous->>'person_id')::uuid OR u.person_id=(following->>'person_id')::uuid))) OR
    (TG_RELID='public.assignment'::regclass AND EXISTS(SELECT 1 FROM public.reward_member m JOIN public.app_user u ON u.id=m.user_id AND u.tenant_id=m.tenant_id JOIN public.employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE m.tenant_id=r.tenant_id AND m.unit_id=r.rewards_unit_id AND (e.id=(previous->>'employment_id')::uuid OR e.id=(following->>'employment_id')::uuid))) OR
    (TG_RELID='public.reward_access_source_epoch'::regclass AND EXISTS(SELECT 1 FROM public.reward_member m JOIN public.app_user u ON u.id=m.user_id AND u.tenant_id=m.tenant_id WHERE m.tenant_id=r.tenant_id AND m.unit_id=r.rewards_unit_id AND ((previous->>'source_kind'='user' AND u.id=(previous->>'source_id')::uuid) OR (following->>'source_kind'='user' AND u.id=(following->>'source_id')::uuid) OR (previous->>'source_kind'='person' AND u.person_id=(previous->>'source_id')::uuid) OR (following->>'source_kind'='person' AND u.person_id=(following->>'source_id')::uuid)))) OR
    (TG_RELID='public.reward_access_request'::regclass AND ((r.tenant_id=(previous->>'tenant_id')::uuid AND previous->'unit_revisions' ? r.rewards_unit_id::text) OR (r.tenant_id=(following->>'tenant_id')::uuid AND following->'unit_revisions' ? r.rewards_unit_id::text))) OR
    (TG_RELID='public.domain_event'::regclass AND EXISTS(SELECT 1 FROM public.reward_access_request request WHERE request.tenant_id=r.tenant_id AND request.unit_revisions ? r.rewards_unit_id::text AND ((previous->>'aggregate_type'='reward-access-request' AND request.id=(previous->>'aggregate_id')::uuid AND request.tenant_id=(previous->>'tenant_id')::uuid) OR (following->>'aggregate_type'='reward-access-request' AND request.id=(following->>'aggregate_id')::uuid AND request.tenant_id=(following->>'tenant_id')::uuid)))) OR
    (TG_RELID='public.employment'::regclass AND EXISTS(SELECT 1 FROM public.reward_entry e WHERE e.tenant_id=r.tenant_id AND e.unit_id=r.rewards_unit_id AND ((e.tenant_id=(previous->>'tenant_id')::uuid AND e.employment_id=(previous->>'id')::uuid) OR (e.tenant_id=(following->>'tenant_id')::uuid AND e.employment_id=(following->>'id')::uuid))))
   )) INTO blocked;
   IF blocked THEN RAISE EXCEPTION 'Annual submission transaction already sealed' USING ERRCODE='42501';END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_submit_sealed_write() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_rewards_submit_sealed BEFORE INSERT OR UPDATE OR DELETE ON public.reward_unit FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed BEFORE INSERT OR UPDATE OR DELETE ON public.reward_entry FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed BEFORE INSERT OR UPDATE OR DELETE ON public.reward_decision FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed BEFORE INSERT OR UPDATE OR DELETE ON public.domain_event FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed BEFORE INSERT OR UPDATE OR DELETE ON public.employment FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed BEFORE UPDATE OR DELETE ON app.assistant_own_leave_review FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();

-- Exact completed actor/principal/eligibility sources are sealed only in this same root transaction.
-- Other users' maintenance and all later independent native transactions retain existing behavior.
CREATE TRIGGER assistant_rewards_submit_sealed BEFORE INSERT OR UPDATE OR DELETE ON public.app_user FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed BEFORE INSERT OR UPDATE OR DELETE ON public.role_assignment FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed BEFORE INSERT OR UPDATE OR DELETE ON public.assignment FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();

CREATE TRIGGER assistant_rewards_submit_sealed BEFORE INSERT OR UPDATE OR DELETE ON public.reward_member FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();

CREATE TRIGGER assistant_rewards_submit_sealed BEFORE INSERT OR UPDATE OR DELETE ON public.reward_governance FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();

CREATE TRIGGER assistant_rewards_submit_sealed BEFORE INSERT OR UPDATE OR DELETE ON public.reward_governance_public FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();

CREATE TRIGGER assistant_rewards_submit_sealed BEFORE INSERT OR UPDATE OR DELETE ON public.reward_governance_history FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();

CREATE TRIGGER assistant_rewards_submit_sealed BEFORE INSERT OR UPDATE OR DELETE ON public.reward_senior_award FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();

CREATE TRIGGER assistant_rewards_submit_sealed BEFORE INSERT OR UPDATE OR DELETE ON public.reward_access_source_epoch FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();

--> statement-breakpoint
-- Completion's existing cleanup DELETE is allowed; later insertion/update cannot resurrect a body.
CREATE FUNCTION app._assistant_rewards_submit_sealed_content() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID<>'app.assistant_own_leave_review_content'::regclass OR TG_OP NOT IN ('INSERT','UPDATE') THEN RAISE EXCEPTION 'Invalid annual submission content guard';END IF;
 IF EXISTS(SELECT 1 FROM app.assistant_own_leave_review r WHERE r.id=NEW.action_id AND r.action_kind='rewards.annual_review.submit' AND r.state='completed' AND r.rewards_submit_completed_xid=pg_current_xact_id_if_assigned()) THEN RAISE EXCEPTION 'Annual submission transaction already sealed' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_submit_sealed_content() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_rewards_submit_sealed_content BEFORE INSERT OR UPDATE ON app.assistant_own_leave_review_content FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_content();

--> statement-breakpoint
-- Capture is created before completion. Once sealed, same-root-TX late erasure/replacement must
-- roll back the outer command, including after a forced early final validation. Later independent
-- PDPA transactions retain their existing behavior and learning remains fail closed after erasure.
CREATE FUNCTION app._assistant_rewards_submit_sealed_capture() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE image jsonb;previous jsonb;following jsonb;blocked boolean;root_xid xid8:=pg_current_xact_id_if_assigned();
BEGIN
 IF TG_RELID NOT IN ('app.native_outcome_source_capture'::regclass,'app.native_outcome_source_target'::regclass) OR TG_OP NOT IN ('INSERT','UPDATE','DELETE') THEN RAISE EXCEPTION 'Invalid annual submission capture guard';END IF;
 IF TG_OP<>'INSERT' THEN previous:=to_jsonb(OLD);END IF;
 IF TG_OP<>'DELETE' THEN following:=to_jsonb(NEW);END IF;
 IF root_xid IS NOT NULL THEN
 FOR image IN SELECT value FROM (VALUES(previous),(following)) images(value) WHERE value IS NOT NULL LOOP
  IF TG_RELID='app.native_outcome_source_capture'::regclass THEN
   SELECT EXISTS(SELECT 1 FROM app.assistant_own_leave_review r WHERE r.id=(image->>'source_id')::uuid AND r.tenant_id=(image->>'tenant_id')::uuid AND r.action_kind='rewards.annual_review.submit' AND r.state='completed' AND r.rewards_submit_completed_xid=root_xid) INTO blocked;
  ELSE
   SELECT EXISTS(SELECT 1 FROM app.native_outcome_source_capture c JOIN app.assistant_own_leave_review r ON r.id=c.source_id AND r.tenant_id=c.tenant_id WHERE c.id=(image->>'capture_id')::uuid AND r.action_kind='rewards.annual_review.submit' AND r.state='completed' AND r.rewards_submit_completed_xid=root_xid) INTO blocked;
  END IF;
  IF blocked THEN RAISE EXCEPTION 'Annual submission transaction already sealed' USING ERRCODE='42501';END IF;
 END LOOP;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_submit_sealed_capture() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_rewards_submit_sealed_capture BEFORE INSERT OR UPDATE OR DELETE ON app.native_outcome_source_capture FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_capture();
CREATE TRIGGER assistant_rewards_submit_sealed_target BEFORE INSERT OR UPDATE OR DELETE ON app.native_outcome_source_target FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_capture();

CREATE TRIGGER assistant_rewards_submit_sealed BEFORE INSERT OR UPDATE OR DELETE ON public.reward_access_request FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();

--> statement-breakpoint
-- Protected pending review arm, not a user-settable GUC or a claimed function call stack.
CREATE FUNCTION app.assistant_rewards_submit_begin_effect(p_review uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row app.assistant_own_leave_review%ROWTYPE;expected_row app.assistant_own_leave_review%ROWTYPE;saved_row app.assistant_own_leave_review%ROWTYPE;current_snapshot jsonb;
BEGIN
 PERFORM app._assistant_rewards_submit_review_identity(NULL,false);
 SELECT * INTO before_row FROM app.assistant_own_leave_review WHERE id=p_review AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT u.person_id FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()) AND action_kind='rewards.annual_review.submit' FOR UPDATE NOWAIT;
 IF NOT FOUND OR before_row.state<>'awaiting_confirmation' OR clock_timestamp()>=before_row.expires_at OR before_row.rewards_submit_snapshot IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c WHERE c.action_id=before_row.id) THEN RAISE EXCEPTION 'Annual submission unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.assistant_rewards_submit_scope(before_row.rewards_unit_id,before_row.id,true);
 -- This transaction-level lock has no explicit unlock. It is a refusal-only fence, not authority.
 IF NOT pg_try_advisory_xact_lock(hashtextextended('assistant-rewards-submit-hidden-fence:'||before_row.tenant_id::text||':'||before_row.rewards_unit_id::text,0)) THEN RAISE EXCEPTION 'Annual submission hidden dependency busy' USING ERRCODE='55P03';END IF;
 current_snapshot:=app._assistant_rewards_submit_snapshot(before_row.rewards_unit_id);
 IF current_snapshot IS DISTINCT FROM before_row.rewards_submit_snapshot-'nativeDecisionDigest' THEN RAISE EXCEPTION 'Annual submission source changed' USING ERRCODE='42501';END IF;
 expected_row:=before_row;expected_row.rewards_submit_effect_xid:=pg_current_xact_id();
 UPDATE app.assistant_own_leave_review SET rewards_submit_effect_xid=pg_current_xact_id() WHERE id=before_row.id;
 SELECT * INTO saved_row FROM app.assistant_own_leave_review WHERE id=before_row.id;
 IF NOT FOUND OR saved_row IS DISTINCT FROM expected_row THEN RAISE EXCEPTION 'Annual submission arm binding changed' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_submit_begin_effect(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_submit_begin_effect(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Enforce every actual arm/armed-ledger transition AFTER the persisted row image. Even an
-- earlier/later BEFORE hook that retargets then restores must cross a forbidden OLD→NEW delta.
CREATE FUNCTION app._assistant_rewards_submit_arm_anchor() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE root_xid xid8:=pg_current_xact_id_if_assigned();expected_row app.assistant_own_leave_review%ROWTYPE;actual_proof jsonb;human_reason text;
BEGIN
 IF TG_RELID<>'app.assistant_own_leave_review'::regclass OR TG_OP NOT IN ('INSERT','UPDATE','DELETE') THEN RAISE EXCEPTION 'Invalid annual submission arm anchor';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.action_kind='rewards.annual_review.submit' AND NEW.rewards_submit_effect_xid IS NOT NULL THEN RAISE EXCEPTION 'Annual submission cannot insert an armed anchor' USING ERRCODE='42501';END IF;RETURN NULL;
 END IF;
 IF TG_OP='DELETE' THEN
  IF OLD.action_kind='rewards.annual_review.submit' AND root_xid IS NOT NULL AND OLD.rewards_submit_effect_xid=root_xid THEN RAISE EXCEPTION 'Annual submission armed anchor cannot be deleted' USING ERRCODE='42501';END IF;RETURN NULL;
 END IF;
 IF root_xid IS NULL THEN RETURN NULL;END IF;
 IF (OLD.action_kind='rewards.annual_review.submit' OR NEW.action_kind='rewards.annual_review.submit') AND NEW.rewards_submit_effect_xid=root_xid AND OLD.rewards_submit_effect_xid IS DISTINCT FROM root_xid THEN
  expected_row:=OLD;expected_row.rewards_submit_effect_xid:=root_xid;
  IF OLD.action_kind IS DISTINCT FROM 'rewards.annual_review.submit' OR OLD.state IS DISTINCT FROM 'awaiting_confirmation' OR NEW IS DISTINCT FROM expected_row THEN RAISE EXCEPTION 'Annual submission arm postimage changed' USING ERRCODE='42501';END IF;
 ELSIF OLD.action_kind='rewards.annual_review.submit' AND OLD.rewards_submit_effect_xid=root_xid THEN
  IF OLD.state='awaiting_confirmation' AND NEW.state='completed' THEN
   SELECT reason INTO human_reason FROM public.reward_decision WHERE id=NEW.rewards_submit_decision_id AND tenant_id=OLD.tenant_id AND unit_id=OLD.rewards_unit_id;
   actual_proof:=app._assistant_rewards_submit_effect_row(OLD,human_reason);expected_row:=app._assistant_rewards_submit_completed_shape(OLD,actual_proof);
   PERFORM app._assistant_rewards_submit_assert_capture(OLD,actual_proof);
  ELSE expected_row:=OLD;END IF;
  IF NEW IS DISTINCT FROM expected_row THEN RAISE EXCEPTION 'Annual submission armed binding changed' USING ERRCODE='42501';END IF;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_submit_arm_anchor() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_rewards_submit_arm_anchor AFTER INSERT OR UPDATE OR DELETE ON app.assistant_own_leave_review FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_arm_anchor();
--> statement-breakpoint
-- This TG guard never reads or returns hidden governance facts. It sees the actual row's unit only
-- and blocks every actual hidden/public governance mutation throughout the admitted native interval.
CREATE FUNCTION app._assistant_rewards_submit_refusal_fence_held(p_tenant uuid,p_unit uuid) RETURNS boolean
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM pg_locks held WHERE held.locktype='advisory' AND held.pid=pg_backend_pid() AND held.granted AND held.mode='ExclusiveLock' AND held.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND held.objsubid=1 AND ((held.classid::bigint << 32) | held.objid::bigint)=hashtextextended('assistant-rewards-submit-hidden-fence:'||p_tenant::text||':'||p_unit::text,0))
$$;
REVOKE ALL ON FUNCTION app._assistant_rewards_submit_refusal_fence_held(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_rewards_submit_hidden_interval() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE guard_key bigint;previous_tenant uuid;previous_unit uuid;following_tenant uuid;following_unit uuid;root_xid xid8:=pg_current_xact_id_if_assigned();
BEGIN
 IF TG_RELID NOT IN ('public.reward_governance'::regclass,'public.reward_governance_public'::regclass,'public.reward_governance_history'::regclass,'public.reward_senior_award'::regclass,'public.reward_senior_evidence'::regclass) OR TG_OP NOT IN ('INSERT','UPDATE','DELETE') THEN RAISE EXCEPTION 'Invalid annual submission hidden interval';END IF;
 IF TG_OP<>'INSERT' THEN previous_tenant:=OLD.tenant_id;previous_unit:=OLD.unit_id;END IF;IF TG_OP<>'DELETE' THEN following_tenant:=NEW.tenant_id;following_unit:=NEW.unit_id;END IF;
 IF app._assistant_rewards_submit_refusal_fence_held(previous_tenant,previous_unit) OR app._assistant_rewards_submit_refusal_fence_held(following_tenant,following_unit) OR (root_xid IS NOT NULL AND EXISTS(SELECT 1 FROM app.assistant_own_leave_review r WHERE r.action_kind='rewards.annual_review.submit' AND r.state IN ('awaiting_confirmation','completed') AND r.rewards_submit_effect_xid=root_xid AND ((r.tenant_id=previous_tenant AND r.rewards_unit_id=previous_unit) OR (r.tenant_id=following_tenant AND r.rewards_unit_id=following_unit)))) THEN RAISE EXCEPTION 'Annual submission hidden dependency write refused' USING ERRCODE='42501';END IF;
 -- All actual writers join the same key, even outside the normal native unit lock. Try-only
 -- shared admission is canonical and bounded; an owning exclusive fence was already refused above.
 FOR guard_key IN SELECT DISTINCT hashtextextended('assistant-rewards-submit-hidden-fence:'||image.tenant_id::text||':'||image.unit_id::text,0) FROM (VALUES(previous_tenant,previous_unit),(following_tenant,following_unit)) image(tenant_id,unit_id) WHERE image.tenant_id IS NOT NULL AND image.unit_id IS NOT NULL ORDER BY 1 LOOP
  IF NOT pg_try_advisory_xact_lock_shared(guard_key) THEN RAISE EXCEPTION 'Annual submission hidden dependency busy' USING ERRCODE='55P03';END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_submit_hidden_interval() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_rewards_submit_hidden_interval BEFORE INSERT OR UPDATE OR DELETE ON public.reward_governance FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_hidden_interval();
CREATE TRIGGER assistant_rewards_submit_hidden_interval BEFORE INSERT OR UPDATE OR DELETE ON public.reward_governance_public FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_hidden_interval();
CREATE TRIGGER assistant_rewards_submit_hidden_interval BEFORE INSERT OR UPDATE OR DELETE ON public.reward_governance_history FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_hidden_interval();
CREATE TRIGGER assistant_rewards_submit_hidden_interval BEFORE INSERT OR UPDATE OR DELETE ON public.reward_senior_award FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_hidden_interval();
CREATE TRIGGER assistant_rewards_submit_hidden_interval BEFORE INSERT OR UPDATE OR DELETE ON public.reward_senior_evidence FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_hidden_interval();

--> statement-breakpoint
-- AFTER companions inspect actual persisted OLD/NEW associations after every BEFORE hook.
CREATE TRIGGER assistant_rewards_submit_hidden_interval_after AFTER INSERT OR UPDATE OR DELETE ON public.reward_governance FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_hidden_interval();
CREATE TRIGGER assistant_rewards_submit_hidden_interval_after AFTER INSERT OR UPDATE OR DELETE ON public.reward_governance_public FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_hidden_interval();
CREATE TRIGGER assistant_rewards_submit_hidden_interval_after AFTER INSERT OR UPDATE OR DELETE ON public.reward_governance_history FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_hidden_interval();
CREATE TRIGGER assistant_rewards_submit_hidden_interval_after AFTER INSERT OR UPDATE OR DELETE ON public.reward_senior_award FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_hidden_interval();
CREATE TRIGGER assistant_rewards_submit_hidden_interval_after AFTER INSERT OR UPDATE OR DELETE ON public.reward_senior_evidence FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_hidden_interval();

--> statement-breakpoint
-- Actual-row companions close late BEFORE-hook association retargeting after forced IMMEDIATE.
CREATE TRIGGER assistant_rewards_submit_sealed_after AFTER INSERT OR UPDATE OR DELETE ON public.reward_unit FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed_after AFTER INSERT OR UPDATE OR DELETE ON public.reward_entry FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed_after AFTER INSERT OR UPDATE OR DELETE ON public.reward_decision FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed_after AFTER INSERT OR UPDATE OR DELETE ON public.domain_event FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed_after AFTER INSERT OR UPDATE OR DELETE ON public.employment FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed_after AFTER INSERT OR UPDATE OR DELETE ON public.app_user FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed_after AFTER INSERT OR UPDATE OR DELETE ON public.role_assignment FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed_after AFTER INSERT OR UPDATE OR DELETE ON public.assignment FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed_after AFTER INSERT OR UPDATE OR DELETE ON public.reward_member FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed_after AFTER INSERT OR UPDATE OR DELETE ON public.reward_governance FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed_after AFTER INSERT OR UPDATE OR DELETE ON public.reward_governance_public FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed_after AFTER INSERT OR UPDATE OR DELETE ON public.reward_governance_history FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed_after AFTER INSERT OR UPDATE OR DELETE ON public.reward_senior_award FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed_after AFTER INSERT OR UPDATE OR DELETE ON public.reward_access_source_epoch FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed_after AFTER INSERT OR UPDATE OR DELETE ON public.reward_access_request FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed_after AFTER UPDATE OR DELETE ON app.assistant_own_leave_review FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_write();
CREATE TRIGGER assistant_rewards_submit_sealed_content_after AFTER INSERT OR UPDATE ON app.assistant_own_leave_review_content FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_content();
CREATE TRIGGER assistant_rewards_submit_sealed_capture_after AFTER INSERT OR UPDATE OR DELETE ON app.native_outcome_source_capture FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_capture();
CREATE TRIGGER assistant_rewards_submit_sealed_target_after AFTER INSERT OR UPDATE OR DELETE ON app.native_outcome_source_target FOR EACH ROW EXECUTE FUNCTION app._assistant_rewards_submit_sealed_capture();
