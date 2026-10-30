-- Payroll reopening; assigned development identity added only after coordinator allocation.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES ('payroll.reopen','payroll','approve','payroll','payroll.reopen');
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD COLUMN payroll_reopen_batch_id uuid REFERENCES public.payroll_batch(id), ADD COLUMN payroll_reopen_period_id uuid REFERENCES public.pay_period(id), ADD COLUMN payroll_reopened_event_id uuid UNIQUE REFERENCES public.domain_event(id), ADD COLUMN payroll_reopen_person_ids uuid[];
--> statement-breakpoint
-- Preserve every predecessor CHECK verbatim for every predecessor action. New kind uses the
-- same truthful USER/company/run/period binding shape with its OWN named columns.
DO $$ DECLARE c record;newexpr text;
BEGIN
 FOR c IN SELECT conname,pg_get_expr(conbin,conrelid) expr FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' AND position('action_kind' in pg_get_expr(conbin,conrelid))>0 LOOP
  newexpr:=replace(c.expr,'action_kind','''payroll.close''::text');
  newexpr:=replace(replace(replace(replace(newexpr,'payroll_close_batch_id','payroll_reopen_batch_id'),'payroll_close_period_id','payroll_reopen_period_id'),'payroll_closed_event_id','payroll_reopened_event_id'),'payroll_review_person_ids','payroll_reopen_person_ids');
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',c.conname);
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK(CASE WHEN action_kind=''payroll.reopen'' THEN (%s) ELSE (%s) END)',c.conname,newexpr,c.expr);
 END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_payroll_reopen_columns CHECK(CASE WHEN action_kind='payroll.reopen' THEN payroll_close_batch_id IS NULL AND payroll_close_period_id IS NULL AND payroll_closed_event_id IS NULL AND payroll_review_person_ids IS NULL AND (payroll_reopen_person_ids IS NULL OR array_position(payroll_reopen_person_ids,NULL) IS NULL) ELSE payroll_reopen_batch_id IS NULL AND payroll_reopen_period_id IS NULL AND payroll_reopened_event_id IS NULL AND payroll_reopen_person_ids IS NULL END);
--> statement-breakpoint
CREATE FUNCTION app._assistant_payroll_reopen_review_identity(p_person uuid,p_bind boolean DEFAULT true,p_write boolean DEFAULT true) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL OR current_setting('transaction_isolation')<>'read committed' OR (p_write AND current_setting('transaction_read_only')<>'off') THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||app.current_tenant_id()::text,0));
 IF app.principal_snapshot_current() IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id() AND a.archived_at IS NULL AND NOT app.login_blocked(a.id) AND (p_bind IS NOT TRUE OR a.person_id IS NOT DISTINCT FROM p_person) AND (a.person_id IS NULL OR EXISTS(SELECT 1 FROM public.person actual WHERE actual.id=a.person_id AND actual.tenant_id=a.tenant_id))) THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_payroll_reopen_review_identity(uuid,boolean,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Narrow canonical snapshot: no money, individual source rows or raw witness leaves the function.
CREATE FUNCTION app.payroll_reopen_review_context(p_batch uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b public.payroll_batch%ROWTYPE;c public.company%ROWTYPE;parent public.pay_period%ROWTYPE;cycle public.payroll_cycle%ROWTYPE;witness jsonb;people uuid[];employees uuid[];
BEGIN
 PERFORM app._assistant_payroll_reopen_review_identity(NULL,false,false);
 SELECT * INTO b FROM public.payroll_batch WHERE id=p_batch AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR app.can_admin_payroll_for(b.company_id) IS NOT TRUE THEN RAISE EXCEPTION 'Payroll reopening unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM public.company WHERE id=b.company_id AND tenant_id=b.tenant_id;
 SELECT * INTO parent FROM public.pay_period WHERE id=b.pay_period_id AND tenant_id=b.tenant_id AND company_id=b.company_id AND period=b.pay_period;
 IF NOT FOUND THEN RAISE EXCEPTION 'Payroll parent unavailable';END IF;
 SELECT * INTO cycle FROM public.payroll_cycle WHERE id=b.payroll_cycle_id AND tenant_id=b.tenant_id;
 IF (SELECT count(*) FROM public.domain_event e WHERE e.tenant_id=b.tenant_id AND e.aggregate_id=b.id)>10000 OR (SELECT count(*) FROM public.statutory_report r WHERE r.tenant_id=b.tenant_id AND r.company_id=b.company_id AND r.period_key=b.pay_period)>10000 THEN RAISE EXCEPTION 'Payroll reopening requires native handoff' USING ERRCODE='54000';END IF;
 people:=app.payroll_close_source_people(b.id,NULL,ARRAY[]::uuid[]);
 employees:=app.native_outcome_payroll_target_employments(b.id,NULL,ARRAY[]::uuid[]);
 IF cardinality(people)>10000 OR cardinality(employees)>10000 THEN RAISE EXCEPTION 'Payroll reopening requires native handoff' USING ERRCODE='54000';END IF;
 SELECT jsonb_build_object('batch',to_jsonb(b),'batchVersion',(SELECT xmin::text FROM public.payroll_batch WHERE id=b.id),'parent',to_jsonb(parent),'parentVersion',(SELECT xmin::text FROM public.pay_period WHERE id=parent.id),'company',to_jsonb(c),'cycle',to_jsonb(cycle),'adopted',app.payroll_history_batch_adopted(b.id),
 'events',(SELECT coalesce(jsonb_agg(jsonb_build_array(e.id,e.xmin::text) ORDER BY e.id),'[]'::jsonb) FROM public.domain_event e WHERE e.tenant_id=b.tenant_id AND e.aggregate_id=b.id),
 'reports',(SELECT coalesce(jsonb_agg(jsonb_build_array(r.id,r.status,r.xmin::text) ORDER BY r.id),'[]'::jsonb) FROM public.statutory_report r WHERE r.tenant_id=b.tenant_id AND r.company_id=b.company_id AND r.period_key=b.pay_period),
 'people',people,'employees',employees) INTO witness;
 IF octet_length(witness::text)>1000000 THEN RAISE EXCEPTION 'Payroll reopening requires native handoff' USING ERRCODE='54000';END IF;
 RETURN jsonb_build_object('companyName',c.legal_name,'cycleName',cycle.name,'sourceDigest',encode(sha256(convert_to(witness::text,'UTF8')),'hex'),'people',people,'employees',employees);
END $$;
REVOKE ALL ON FUNCTION app.payroll_reopen_review_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_reopen_review_context(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.read_own_payroll_reopen_effect(p_batch uuid,p_event uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b public.payroll_batch%ROWTYPE;e public.domain_event%ROWTYPE;h public.payroll_status_history%ROWTYPE;parent public.pay_period%ROWTYPE;pe public.domain_event%ROWTYPE;parent_event uuid;
BEGIN
 PERFORM app._assistant_payroll_reopen_review_identity(NULL,false,false);
 SELECT * INTO b FROM public.payroll_batch WHERE id=p_batch AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR app.can_admin_payroll_for(b.company_id) IS NOT TRUE THEN RETURN NULL;END IF;
 SELECT * INTO e FROM public.domain_event WHERE id=p_event AND tenant_id=b.tenant_id AND aggregate_id=b.id AND aggregate_type='payroll-batch' AND event_type='payroll-batch.unlocked' AND actor_type='user' AND actor_id=app.current_user_id() AND subject_employment_id IS NULL;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO h FROM public.payroll_status_history WHERE id=(e.payload->>'statusHistoryId')::uuid AND tenant_id=b.tenant_id AND batch_id=b.id AND action='unlock' AND from_status='closed' AND to_status='processed' AND actor_type='user' AND actor_id=e.actor_id;
 IF NOT FOUND OR h.reason IS DISTINCT FROM e.payload->>'reason' OR h.reason IS NULL OR btrim(h.reason)='' OR h.before->>'status' IS DISTINCT FROM 'closed' OR h.after->>'status' IS DISTINCT FROM 'processed' OR h.after->'warnings' IS DISTINCT FROM e.payload->'warnings' OR h.before->'periodReopened' IS DISTINCT FROM e.payload->'reopenedPeriod' OR e.payload->>'companyId' IS DISTINCT FROM b.company_id::text OR e.payload->>'payPeriod' IS DISTINCT FROM b.pay_period THEN RETURN NULL;END IF;
 SELECT * INTO parent FROM public.pay_period WHERE id=b.pay_period_id AND tenant_id=b.tenant_id AND company_id=b.company_id AND period=b.pay_period;
 IF NOT FOUND THEN RETURN NULL;END IF;
 parent_event:=(e.payload->>'periodReopenedEventId')::uuid;
 IF (e.payload->>'reopenedPeriod')::boolean THEN
  SELECT * INTO pe FROM public.domain_event WHERE id=parent_event AND tenant_id=b.tenant_id AND aggregate_id=parent.id AND aggregate_type='pay-period' AND event_type='pay-period.reopened' AND actor_type='user' AND actor_id=e.actor_id AND subject_employment_id IS NULL;
  IF NOT FOUND OR pe.payload->>'batchId' IS DISTINCT FROM b.id::text OR pe.payload->>'reason' IS DISTINCT FROM h.reason OR pe.payload->>'unlockedEventId' IS DISTINCT FROM e.id::text OR pe.payload->>'statusHistoryId' IS DISTINCT FROM h.id::text THEN RETURN NULL;END IF;
 ELSIF (e.payload->>'reopenedPeriod')::boolean IS DISTINCT FROM false OR parent_event IS NOT NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('batchId',b.id,'payPeriodId',parent.id,'statusHistoryId',h.id,'unlockedEventId',e.id,'periodReopenedEventId',parent_event,'parentWasReopened',(e.payload->>'reopenedPeriod')::boolean,'currentStatus',b.status,'currentPeriodStatus',parent.status);
END $$;
REVOKE ALL ON FUNCTION app.read_own_payroll_reopen_effect(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_own_payroll_reopen_effect(uuid,uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app._assistant_payroll_reopen_review_source(p_person uuid,p_batch uuid,p_company uuid,p_period uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_payroll_reopen_review_identity(p_person);
 IF NOT EXISTS(SELECT 1 FROM public.payroll_batch b JOIN public.pay_period p ON p.id=b.pay_period_id AND p.tenant_id=b.tenant_id AND p.company_id=b.company_id AND p.period=b.pay_period
  WHERE b.id=p_batch AND b.tenant_id=app.current_tenant_id() AND b.company_id=p_company AND b.pay_period_id=p_period AND app.can_admin_payroll_for(b.company_id)) THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_payroll_reopen_review_source(uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_payroll_reopen_review_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object('actionId',r.id,'action',r.action_kind,'contractVersion',1,
 'binding',jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'employmentId',r.employment_id,'companyId',r.company_id,'batchId',r.payroll_reopen_batch_id,'payPeriodId',r.payroll_reopen_period_id),
 'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,'state',r.state,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object('formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,
 'eventId',r.payroll_reopened_event_id)
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id WHERE r.id=p_id AND r.action_kind='payroll.reopen';
$$;
REVOKE ALL ON FUNCTION app._assistant_payroll_reopen_review_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_payroll_reopen_review_prepare(p_id uuid,p_person uuid,p_batch uuid,p_company uuid,p_period uuid,p_people uuid[],p_prior uuid,p_coverage uuid[],p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();at_time timestamptz;people uuid[];
BEGIN
 PERFORM app._assistant_payroll_reopen_review_source(p_person,p_batch,p_company,p_period);
 IF NOT EXISTS(SELECT 1 FROM public.payroll_batch b JOIN public.pay_period p ON p.id=b.pay_period_id WHERE b.id=p_batch AND b.tenant_id=t AND b.status='closed' AND p.status IN('open','closed')) THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 people:=app.payroll_close_source_people(p_batch,p_prior,p_coverage);
 IF p_people IS NULL OR p_people IS DISTINCT FROM people THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND (i.person_id=p_person OR i.person_id=ANY(people))) OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND (i.person_id=p_person OR i.person_id=ANY(people))) THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 IF p_id IS NULL OR p_intent_digest IS NULL OR p_intent_digest !~ '^[a-f0-9]{64}$' OR p_reviewed_digest IS NULL OR p_reviewed_digest !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$' OR p_wrapped_dek IS NULL OR length(p_wrapped_dek) NOT BETWEEN 1 AND 512 OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='22023';END IF;
 at_time:=clock_timestamp();
 IF (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation' AND expires_at>at_time)>=5 OR (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND created_at>at_time-interval '10 minutes')>=20 THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='54000';END IF;
 INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,payroll_reopen_batch_id,payroll_reopen_period_id,payroll_reopen_person_ids,intent_digest,reviewed_digest,state,created_at,expires_at)
 VALUES('payroll.reopen',p_id,t,u,p_person,NULL,p_company,p_batch,p_period,people,p_intent_digest,p_reviewed_digest,'awaiting_confirmation',at_time,at_time+interval '10 minutes') ON CONFLICT(id) DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped_dek,p_ciphertext);
 RETURN app._assistant_payroll_reopen_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reopen_review_prepare(uuid,uuid,uuid,uuid,uuid,uuid[],uuid,uuid[],text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_payroll_reopen_review_prepare(uuid,uuid,uuid,uuid,uuid,uuid[],uuid,uuid[],text,text,text,text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_payroll_reopen_review_subject(p_id uuid) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_payroll_reopen_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='payroll.reopen';
 IF NOT FOUND THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_payroll_reopen_review_identity(r.person_id);RETURN r.payroll_reopen_batch_id;
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reopen_review_subject(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_payroll_reopen_review_subject(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_payroll_reopen_review_peek(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_payroll_reopen_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='payroll.reopen';
 IF NOT FOUND THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_payroll_reopen_review_source(r.person_id,r.payroll_reopen_batch_id,r.company_id,r.payroll_reopen_period_id);
 IF r.state='awaiting_confirmation' AND (r.payroll_reopen_person_ids IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c WHERE c.action_id=r.id)) THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('review',app._assistant_payroll_reopen_review_json(r.id),'pendingExpired',r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at);
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reopen_review_peek(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_payroll_reopen_review_peek(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_payroll_reopen_review_read(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_payroll_reopen_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='payroll.reopen' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_payroll_reopen_review_source(r.person_id,r.payroll_reopen_batch_id,r.company_id,r.payroll_reopen_period_id);
 IF r.state='awaiting_confirmation' AND (r.payroll_reopen_person_ids IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c WHERE c.action_id=r.id)) THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL,payroll_reopen_person_ids=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review a WHERE c.action_id=a.id AND a.id=r.id AND a.state<>'awaiting_confirmation';
 RETURN app._assistant_payroll_reopen_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reopen_review_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_payroll_reopen_review_read(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_payroll_reopen_review_complete(p_id uuid,p_reviewed_digest text,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 PERFORM app._assistant_payroll_reopen_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='payroll.reopen' FOR UPDATE NOWAIT;
 IF NOT FOUND OR p_event IS NULL THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_payroll_reopen_review_source(r.person_id,r.payroll_reopen_batch_id,r.company_id,r.payroll_reopen_period_id);
 IF r.state='completed' THEN
  IF r.payroll_reopened_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
  IF r.reviewed_digest IS DISTINCT FROM p_reviewed_digest OR r.payroll_reopen_person_ids IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c WHERE c.action_id=r.id) THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
  IF app.read_own_payroll_reopen_effect(r.payroll_reopen_batch_id,p_event) IS NULL OR NOT EXISTS(
   SELECT 1 FROM public.payroll_batch b JOIN public.domain_event d ON d.id=p_event AND d.tenant_id=b.tenant_id
   JOIN public.payroll_status_history h ON h.id=(d.payload->>'statusHistoryId')::uuid AND h.tenant_id=b.tenant_id
   JOIN public.pay_period parent ON parent.id=b.pay_period_id AND parent.tenant_id=b.tenant_id
   WHERE b.id=r.payroll_reopen_batch_id AND b.company_id=r.company_id AND b.pay_period_id=r.payroll_reopen_period_id
    AND b.tenant_id=t AND b.status='processed' AND parent.status='open'
    AND b.xmin=pg_current_xact_id()::xid AND h.xmin=pg_current_xact_id()::xid AND d.xmin=pg_current_xact_id()::xid
    AND (NOT (d.payload->>'reopenedPeriod')::boolean OR (parent.xmin=pg_current_xact_id()::xid AND EXISTS(
     SELECT 1 FROM public.domain_event pe WHERE pe.id=(d.payload->>'periodReopenedEventId')::uuid AND pe.tenant_id=t AND pe.xmin=pg_current_xact_id()::xid)))
  ) THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
  UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,payroll_reopened_event_id=p_event,payroll_reopen_person_ids=NULL WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 ELSE RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 RETURN app._assistant_payroll_reopen_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reopen_review_complete(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_payroll_reopen_review_complete(uuid,text,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Login-only, digestless retirement/index. Revoked Assistant/Payroll permission never executes.
CREATE FUNCTION app.assistant_payroll_reopen_review_discard(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_payroll_reopen_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='payroll.reopen' FOR UPDATE NOWAIT;
 IF NOT FOUND OR r.state='completed' THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' THEN UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL,payroll_reopen_person_ids=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=r.id;
 RETURN jsonb_build_object('action','payroll.reopen','contractVersion',1,'actionId',r.id,'state',r.state);
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reopen_review_discard(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_payroll_reopen_review_discard(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_payroll_reopen_reviews_index() RETURNS TABLE(action text,action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_payroll_reopen_review_identity(NULL,false,false);
 RETURN QUERY SELECT r.action_kind,r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.action_kind='payroll.reopen' ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reopen_reviews_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_payroll_reopen_reviews_index() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_payroll_reopen_body_retired() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 UPDATE app.assistant_own_leave_review SET payroll_reopen_person_ids=NULL WHERE id=OLD.action_id AND action_kind='payroll.reopen' AND payroll_reopen_person_ids IS NOT NULL;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reopen_body_retired() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_payroll_reopen_body_retired AFTER DELETE ON app.assistant_own_leave_review_content FOR EACH ROW EXECUTE FUNCTION app.assistant_payroll_reopen_body_retired();

--> statement-breakpoint
-- Extend canonical erasure admission/audit/deferred verification for the private reopening cohort.
DO $$ DECLARE f record;definition text;changed text;
BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.prokind='f' AND p.proname IN('assistant_own_leave_reviews_redact','audit_assistant_review_erasure','assistant_review_erasure_complete') LOOP
  definition:=pg_get_functiondef(f.signature);
  changed:=replace(definition,'i.person_id = ANY (r.payroll_review_person_ids)','(i.person_id = ANY (r.payroll_review_person_ids) OR i.person_id = ANY (r.payroll_reopen_person_ids))');
  -- pg_get_functiondef preserves PL/pgSQL body spelling from the source migrations.
  changed:=replace(changed,'i.person_id=ANY(r.payroll_review_person_ids)','(i.person_id=ANY(r.payroll_review_person_ids) OR i.person_id=ANY(r.payroll_reopen_person_ids))');
  changed:=replace(changed,'NEW.aggregate_id=ANY(r.payroll_review_person_ids)','(NEW.aggregate_id=ANY(r.payroll_review_person_ids) OR NEW.aggregate_id=ANY(r.payroll_reopen_person_ids))');
  changed:=replace(changed,'i.person_id=ANY(payroll_review_person_ids)','(i.person_id=ANY(payroll_review_person_ids) OR i.person_id=ANY(payroll_reopen_person_ids))');
  IF changed=definition THEN RAISE EXCEPTION 'Payroll reopening erasure owner drift: %',f.signature;END IF;
  EXECUTE changed;
 END LOOP;
END $$;
--> statement-breakpoint
DO $$ DECLARE target regprocedure;definition text;marker text;replacement text;
BEGIN
 FOR target IN SELECT signature::regprocedure FROM unnest(ARRAY['app.native_outcome_review_completed(text,uuid)','app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)','app.native_outcome_completed_review_choices(jsonb)']) signature LOOP
  definition:=pg_get_functiondef(target);
  IF target='app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure THEN
   marker:='WHEN ''payroll.close'' THEN r.payroll_closed_event_id';replacement:=marker||' WHEN ''payroll.reopen'' THEN r.payroll_reopened_event_id';
  ELSE
   marker:='''payroll.close''';replacement:=marker||',''payroll.reopen''';
  END IF;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'Payroll reopening outcome owner drift %',target;END IF;
  definition:=replace(definition,marker,replacement);
  -- Completion choices use the same columns via a new per-kind case, below if needed.
  EXECUTE definition;
 END LOOP;
END $$;
