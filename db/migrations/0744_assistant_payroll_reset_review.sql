-- Payroll reset; assigned development identity added only after coordinator allocation.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES ('payroll.reset','payroll','approve','payroll','payroll.reset');
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD COLUMN payroll_reset_batch_id uuid REFERENCES public.payroll_batch(id), ADD COLUMN payroll_reset_period_id uuid REFERENCES public.pay_period(id), ADD COLUMN payroll_reset_event_id uuid UNIQUE REFERENCES public.domain_event(id), ADD COLUMN payroll_reset_person_ids uuid[], ADD COLUMN payroll_reset_proof jsonb;
--> statement-breakpoint
-- Preserve every predecessor CHECK verbatim for every predecessor action. New kind uses the
-- same truthful USER/company/run/period binding shape with its OWN named columns.
DO $$ DECLARE c record;strict_nulls text;scope_name text;matches integer;previous text;newexpr text;original jsonb;item record;after_hash text;changed text[];
BEGIN
 SELECT jsonb_object_agg(conname,encode(sha256(convert_to(conbin::text,'UTF8')),'hex')) INTO original FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c';
 -- Enumerate only the actual dependency candidates; use the predecessor owner's exact markers.
 matches:=0;
 FOR c IN SELECT conname,conbin,oid FROM pg_constraint q WHERE q.conrelid='app.assistant_own_leave_review'::regclass AND q.contype='c'
 AND q.conkey @> ARRAY(SELECT attnum FROM pg_attribute WHERE attrelid=q.conrelid AND attname IN('employment_id','testing_execution_id'))::smallint[] ORDER BY conname LOOP
  RAISE NOTICE '0744 scope candidate % rawConbinBytes %',c.conname,octet_length(c.conbin::text);
  SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint WHERE oid=c.oid;
  IF previous LIKE '%testing_execution_id IS NOT NULL%' AND previous LIKE '%employment_id IS NULL%' THEN matches:=matches+1;scope_name:=c.conname;END IF;
 END LOOP;
 IF matches<>1 THEN RAISE EXCEPTION '0744 actor scope drift: %',matches;END IF;
 changed:=ARRAY[scope_name,'assistant_review_kind_columns'];
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname='assistant_review_action_kind' AND contype='c') OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname='assistant_review_action_kind_registered' AND contype='f' AND confrelid='app.assistant_action_kind'::regclass) OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname='assistant_review_kind_columns' AND contype='c') THEN RAISE EXCEPTION '0744 ordered kind schema drift';END IF;
 FOR c IN SELECT conname,conbin FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' AND conname=ANY(changed) ORDER BY conname LOOP
  RAISE NOTICE '0744 target % rawConbinBytes % beforeSHA256 %',c.conname,octet_length(c.conbin::text),original->>c.conname;
  SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=c.conname;
  newexpr:=CASE WHEN c.conname=scope_name THEN 'employment_id IS NULL AND company_id IS NOT NULL AND testing_execution_id IS NULL AND testing_run_id IS NULL AND testing_event_id IS NULL'
   WHEN c.conname='assistant_review_kind_columns' THEN 'leave_request_id IS NULL AND submission_event_id IS NULL AND notification_event_id IS NULL AND profile_request_id IS NULL AND profile_requested_event_id IS NULL AND claim_draft_id IS NULL AND claim_saved_event_id IS NULL AND performance_ack_event_id IS NULL'
   ELSE 'true' END;
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',c.conname);
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK(CASE WHEN action_kind=''payroll.reset'' THEN (%s) ELSE (%s) END)',c.conname,newexpr,previous);
 END LOOP;
 IF (SELECT count(*) FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=ANY(changed) AND contype='c')<>2 THEN RAISE EXCEPTION '0744 admission constraint inventory drift';END IF;
 -- A finite, strict new-kind shape. Every predecessor dedicated column remains forbidden.
 SELECT string_agg(format('%I IS NULL',attname),' AND ' ORDER BY attnum) INTO strict_nulls
 FROM pg_attribute WHERE attrelid='app.assistant_own_leave_review'::regclass AND attnum>0 AND NOT attisdropped
 AND attname NOT IN('action_kind','id','tenant_id','user_id','person_id','employment_id','company_id','intent_digest','reviewed_digest','state','created_at','expires_at','payroll_reset_batch_id','payroll_reset_period_id','payroll_reset_event_id','payroll_reset_person_ids','payroll_reset_proof');
 IF strict_nulls IS NULL THEN RAISE EXCEPTION '0744 dedicated column inventory unavailable';END IF;
 newexpr:='employment_id IS NULL AND company_id IS NOT NULL AND payroll_reset_batch_id IS NOT NULL AND payroll_reset_period_id IS NOT NULL AND ((state=''completed'')=(payroll_reset_event_id IS NOT NULL)) AND (payroll_reset_person_ids IS NULL OR array_position(payroll_reset_person_ids,NULL) IS NULL) AND '||strict_nulls;
 EXECUTE 'ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_payroll_reset_columns CHECK(CASE WHEN action_kind=''payroll.reset'' THEN ('||newexpr||') ELSE payroll_reset_batch_id IS NULL AND payroll_reset_period_id IS NULL AND payroll_reset_event_id IS NULL AND payroll_reset_person_ids IS NULL AND payroll_reset_proof IS NULL END)';
 FOR item IN SELECT key,value FROM jsonb_each_text(original) WHERE NOT key=ANY(changed) LOOP
  SELECT encode(sha256(convert_to(conbin::text,'UTF8')),'hex') INTO after_hash FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=item.key AND contype='c';
  IF after_hash IS DISTINCT FROM item.value THEN RAISE EXCEPTION '0744 predecessor changed: %',item.key;END IF;
  RAISE NOTICE '0744 unchanged CHECK % SHA256 %',item.key,after_hash;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app._assistant_payroll_reset_review_identity(p_person uuid,p_bind boolean DEFAULT true,p_write boolean DEFAULT true) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL OR current_setting('transaction_isolation')<>'read committed' OR (p_write AND current_setting('transaction_read_only')<>'off') THEN RAISE EXCEPTION 'Payroll reset review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||app.current_tenant_id()::text,0));
 IF app.principal_snapshot_current() IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id() AND a.archived_at IS NULL AND NOT app.login_blocked(a.id) AND (p_bind IS NOT TRUE OR a.person_id IS NOT DISTINCT FROM p_person) AND (a.person_id IS NULL OR EXISTS(SELECT 1 FROM public.person actual WHERE actual.id=a.person_id AND actual.tenant_id=a.tenant_id))) THEN RAISE EXCEPTION 'Payroll reset review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_payroll_reset_review_identity(uuid,boolean,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Private source commitments only. Never returns loan/claim/payslip amounts or raw source JSON.
CREATE FUNCTION app._payroll_reset_hash(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$ SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex') $$;
REVOKE ALL ON FUNCTION app._payroll_reset_hash(jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._payroll_reset_source(p_batch uuid,p_loans uuid[] DEFAULT NULL,p_individuals uuid[] DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b public.payroll_batch%ROWTYPE;loan_ids uuid[];employees uuid[];people uuid[];rows jsonb;meta jsonb;size_total bigint;count_total bigint;
BEGIN
 PERFORM app._assistant_payroll_reset_review_identity(NULL,false,false);
 SELECT * INTO b FROM public.payroll_batch WHERE id=p_batch AND tenant_id=app.current_tenant_id() AND app.can_admin_payroll_for(company_id) AND app.is_admin();
 IF NOT FOUND THEN RAISE EXCEPTION 'Payroll reset unavailable' USING ERRCODE='42501';END IF;
 -- Explicitly preserve the native 0121 read predicate, including native-invisible loan skips.
 IF p_loans IS NULL THEN SELECT coalesce(array_agg(DISTINCT loan_id ORDER BY loan_id),'{}'::uuid[]) INTO loan_ids FROM public.loan_repayment WHERE tenant_id=b.tenant_id AND applied_batch_id=b.id AND status='applied' AND app.can_see_employment(employment_id);ELSE loan_ids:=p_loans;END IF;
 WITH source AS (
 SELECT 'payroll_batch' relation,id,to_jsonb(q) value FROM public.payroll_batch q WHERE q.tenant_id=b.tenant_id AND q.pay_period_id=b.pay_period_id
 UNION ALL SELECT 'company',id,to_jsonb(q) FROM public.company q WHERE q.id=b.company_id AND q.tenant_id=b.tenant_id
 UNION ALL SELECT 'payroll_cycle',id,to_jsonb(q) FROM public.payroll_cycle q WHERE q.id=b.payroll_cycle_id AND q.tenant_id=b.tenant_id
 UNION ALL SELECT 'pay_period',id,to_jsonb(q) FROM public.pay_period q WHERE q.tenant_id=b.tenant_id AND q.id=b.pay_period_id
 UNION ALL SELECT 'payslip',id,to_jsonb(q) FROM public.payslip q WHERE q.tenant_id=b.tenant_id AND q.batch_id=b.id AND (app.can_admin_payroll_employment(q.employment_id) OR EXISTS(SELECT 1 FROM public.employment emp WHERE emp.id=q.employment_id AND emp.tenant_id=q.tenant_id AND app.is_self_person(emp.person_id))) AND (app.payroll_history_effective(q.id) OR app.payroll_history_self_issued(q.id))
 UNION ALL SELECT 'employee_loan',id,to_jsonb(q) FROM public.employee_loan q WHERE q.tenant_id=b.tenant_id AND q.id=ANY(loan_ids) AND app.can_see_employment(q.employment_id)
 UNION ALL SELECT 'loan_repayment',id,to_jsonb(q) FROM public.loan_repayment q WHERE q.tenant_id=b.tenant_id AND q.loan_id=ANY(loan_ids) AND app.can_see_employment(q.employment_id)
 UNION ALL SELECT 'claim_request',id,to_jsonb(q) FROM public.claim_request q WHERE q.tenant_id=b.tenant_id AND q.payroll_batch_id=b.id AND (app.can_see_employment(q.employment_id) OR (q.status::text<>'draft' AND q.employment_id=ANY(app.delegated_subject_ids('claims','claims.claim'))))
 UNION ALL SELECT 'payroll_individual_txn',id,to_jsonb(q) FROM public.payroll_individual_txn q WHERE q.tenant_id=b.tenant_id AND (q.batch_id=b.id OR q.consumed_batch_id=b.id OR q.id=ANY(coalesce(p_individuals,ARRAY[]::uuid[]))) AND ((q.batch_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.payroll_batch pb WHERE pb.id=q.batch_id AND pb.tenant_id=b.tenant_id AND app.can_admin_payroll_for(pb.company_id))) OR (q.batch_id IS NULL AND q.company_id IS NOT NULL AND app.can_admin_payroll_for(q.company_id)))
 UNION ALL SELECT 'payroll_input',id,to_jsonb(q) FROM public.payroll_input q WHERE q.tenant_id=b.tenant_id AND q.batch_id=b.id
 UNION ALL SELECT 'payroll_batch_component',id,to_jsonb(q) FROM public.payroll_batch_component q WHERE q.tenant_id=b.tenant_id AND q.batch_id=b.id AND app.is_admin_for(b.company_id)
 UNION ALL SELECT 'payroll_statutory_adjustment',id,to_jsonb(q) FROM public.payroll_statutory_adjustment q WHERE q.tenant_id=b.tenant_id AND q.batch_id=b.id
 UNION ALL SELECT 'statutory_report',id,to_jsonb(q) FROM public.statutory_report q WHERE q.tenant_id=b.tenant_id AND q.company_id=b.company_id AND q.period_key=b.pay_period AND app.is_admin_for(q.company_id)
 ), grouped AS (SELECT relation,jsonb_object_agg(id::text,app._payroll_reset_hash(value)) hashes FROM source GROUP BY relation)
 SELECT coalesce(jsonb_object_agg(relation,hashes),'{}'::jsonb) INTO rows FROM grouped;
 -- Cohort is deliberately wider than the close/payslip cohort. Consumed rows may have moved batches.
 SELECT coalesce(array_agg(DISTINCT employment_id ORDER BY employment_id),'{}'::uuid[]) INTO employees FROM (
 SELECT employment_id FROM public.payslip WHERE tenant_id=b.tenant_id AND batch_id=b.id
 UNION SELECT employment_id FROM public.claim_request WHERE tenant_id=b.tenant_id AND payroll_batch_id=b.id AND status='paid'
 UNION SELECT employment_id FROM public.loan_repayment WHERE tenant_id=b.tenant_id AND loan_id=ANY(loan_ids)
 UNION SELECT employment_id FROM public.employee_loan WHERE tenant_id=b.tenant_id AND id=ANY(loan_ids)
 UNION SELECT employment_id FROM public.payroll_individual_txn WHERE tenant_id=b.tenant_id AND consumed_batch_id=b.id
 ) subjects WHERE employment_id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT person_id ORDER BY person_id),'{}'::uuid[]) INTO people FROM public.employment WHERE tenant_id=b.tenant_id AND id=ANY(employees);
 SELECT coalesce(sum((SELECT count(*) FROM jsonb_each(value))),0) INTO count_total FROM jsonb_each(rows);
 size_total:=octet_length(rows::text);
 IF count_total>10000 OR size_total>1000000 OR cardinality(employees)>10000 OR cardinality(people)>10000 THEN RAISE EXCEPTION 'Payroll reset requires native handoff' USING ERRCODE='54000';END IF;
 IF (SELECT count(*) FROM public.domain_event WHERE tenant_id=b.tenant_id AND aggregate_id=b.id AND event_type='payroll-batch.payment-summary.exported')>10000 THEN RAISE EXCEPTION 'Payroll reset requires native handoff' USING ERRCODE='54000';END IF;
 meta:=jsonb_build_object('exportHash',(SELECT app._payroll_reset_hash(coalesce(jsonb_agg(jsonb_build_array(id,xmin::text) ORDER BY id),'[]'::jsonb)) FROM public.domain_event WHERE tenant_id=b.tenant_id AND aggregate_id=b.id AND event_type='payroll-batch.payment-summary.exported'),'payPeriod',b.pay_period,'companyId',b.company_id,'periodId',b.pay_period_id,'runType',b.run_type,'runSeq',b.run_seq,'statutoryReports',(SELECT count(*) FROM public.statutory_report q WHERE q.tenant_id=b.tenant_id AND q.company_id=b.company_id AND q.period_key=b.pay_period AND app.is_admin_for(q.company_id)),'people',people,'employees',employees,'loanIds',loan_ids,
 'payslips',(SELECT count(*) FROM public.payslip slip WHERE tenant_id=b.tenant_id AND batch_id=b.id AND (app.can_admin_payroll_employment(slip.employment_id) OR EXISTS(SELECT 1 FROM public.employment emp WHERE emp.id=slip.employment_id AND emp.tenant_id=slip.tenant_id AND app.is_self_person(emp.person_id))) AND (app.payroll_history_effective(slip.id) OR app.payroll_history_self_issued(slip.id))),
 'applied',(SELECT count(*) FROM public.loan_repayment WHERE tenant_id=b.tenant_id AND applied_batch_id=b.id AND status='applied' AND app.can_see_employment(employment_id)),
 'claims',(SELECT count(*) FROM public.claim_request q WHERE q.tenant_id=b.tenant_id AND q.payroll_batch_id=b.id AND q.status='paid' AND (app.can_see_employment(q.employment_id) OR (q.status='pending' AND q.employment_id=ANY(app.delegated_subject_ids('claims','claims.claim'))))),
 'consumed',(SELECT count(*) FROM public.payroll_individual_txn q WHERE q.tenant_id=b.tenant_id AND q.consumed_batch_id=b.id AND ((q.batch_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.payroll_batch pb WHERE pb.id=q.batch_id AND app.can_admin_payroll_for(pb.company_id))) OR (q.batch_id IS NULL AND q.company_id IS NOT NULL AND app.can_admin_payroll_for(q.company_id)))),
 'recalcMarked',b.needs_recalc_at IS NOT NULL,'beforeBatchHash',app._payroll_reset_hash(to_jsonb(b)),
 'beforeTotalsHash',app._payroll_reset_hash(jsonb_build_object('status',b.status,'totals',b.totals,'employeeCount',b.employee_count)));
 RETURN jsonb_build_object('rows',rows,'meta',meta);
END $$;
REVOKE ALL ON FUNCTION app._payroll_reset_source(uuid,uuid[],uuid[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- An arm nominates an exact own pending review. It supplies no source hashes and proves no callstack.
CREATE FUNCTION app.assistant_payroll_reset_review_arm(p_id uuid,p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;source jsonb;physical xid;
BEGIN
 PERFORM app._assistant_payroll_reset_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='payroll.reset' FOR UPDATE NOWAIT;
 IF NOT FOUND OR r.state<>'awaiting_confirmation' OR clock_timestamp()>=r.expires_at OR r.payroll_reset_proof->>'phase' IS DISTINCT FROM 'prepared' OR p_reason IS NULL OR btrim(p_reason)='' OR octet_length(p_reason)>16000 THEN RAISE EXCEPTION 'Payroll reset unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_payroll_reset_review_identity(r.person_id);
 IF EXISTS(SELECT 1 FROM app.assistant_own_leave_review WHERE tenant_id=r.tenant_id AND user_id=r.user_id AND action_kind='payroll.reset' AND payroll_reset_proof->>'xid'=pg_current_xact_id()::text) THEN RAISE EXCEPTION 'Payroll reset already armed';END IF;
 source:=app._payroll_reset_source(r.payroll_reset_batch_id);
 IF app._payroll_reset_hash(source) IS DISTINCT FROM r.payroll_reset_proof->>'sourceDigest' THEN RAISE EXCEPTION 'Payroll reset reviewed source changed';END IF;
 IF source->'meta'->>'companyId' IS DISTINCT FROM r.company_id::text OR source->'meta'->>'periodId' IS DISTINCT FROM r.payroll_reset_period_id::text THEN RAISE EXCEPTION 'Payroll reset binding changed';END IF;
 UPDATE app.assistant_own_leave_review SET payroll_reset_proof=jsonb_build_object('phase','actual','xid',pg_current_xact_id()::text,'source',source,'progress',source->'rows','observed','[]'::jsonb,'shortfalls','{}'::jsonb,'pendingLoans','{}'::jsonb,'reasonHash',app._payroll_reset_hash(to_jsonb(btrim(p_reason)))) WHERE id=r.id RETURNING xmin INTO physical;
 IF physical<>pg_current_xact_id()::xid THEN RAISE EXCEPTION 'Payroll reset requires top-level transaction';END IF;
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reset_review_arm(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_payroll_reset_review_arm(uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- The trigger itself owns every observation. Arm/helper names and caller GUCs confer no authority.
CREATE FUNCTION app._payroll_reset_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;proof jsonb;progress jsonb;oldj jsonb;newj jsonb;oldhash text;newhash text;relation text:=TG_TABLE_NAME;rowid text;relevant boolean;entry jsonb;physical xid;rep public.loan_repayment%ROWTYPE;loan public.employee_loan%ROWTYPE;other_reserved boolean;shortfall jsonb;expected jsonb;pending jsonb;step uuid;reopened boolean;
BEGIN
 IF TG_TABLE_SCHEMA<>'public' OR TG_RELID NOT IN('public.payroll_batch'::regclass,'public.pay_period'::regclass,'public.payslip'::regclass,'public.loan_repayment'::regclass,'public.employee_loan'::regclass,'public.claim_request'::regclass,'public.payroll_individual_txn'::regclass,'public.payroll_input'::regclass,'public.payroll_batch_component'::regclass,'public.payroll_statutory_adjustment'::regclass,'public.statutory_report'::regclass,'public.domain_event'::regclass,'public.payroll_status_history'::regclass) OR TG_OP NOT IN('INSERT','UPDATE','DELETE') THEN RAISE EXCEPTION 'Invalid reset observation';END IF;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='payroll.reset' AND state='awaiting_confirmation' AND payroll_reset_proof->>'phase'='actual' AND payroll_reset_proof->>'xid'=pg_current_xact_id()::text FOR UPDATE NOWAIT;
 IF NOT FOUND THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 PERFORM app._assistant_payroll_reset_review_identity(r.person_id);
 proof:=r.payroll_reset_proof;progress:=proof->'progress';
 IF TG_OP<>'INSERT' THEN oldj:=to_jsonb(OLD);oldhash:=app._payroll_reset_hash(oldj);END IF;
 IF TG_OP<>'DELETE' THEN newj:=to_jsonb(NEW);newhash:=app._payroll_reset_hash(newj);END IF;
 rowid:=coalesce(oldj->>'id',newj->>'id');
 relevant:=(relation='payroll_status_history' AND (oldj->>'batch_id'=r.payroll_reset_batch_id::text OR newj->>'batch_id'=r.payroll_reset_batch_id::text)) OR (relation='domain_event' AND (coalesce(oldj->>'aggregate_id',newj->>'aggregate_id')=r.payroll_reset_batch_id::text OR (proof->'source'->'rows'->'loan_repayment')?coalesce(oldj->>'aggregate_id',newj->>'aggregate_id') OR (proof->'source'->'rows'->'employee_loan')?coalesce(oldj->>'aggregate_id',newj->>'aggregate_id') OR (proof->'source'->'rows'->'claim_request')?coalesce(oldj->>'aggregate_id',newj->>'aggregate_id'))) OR coalesce((progress->relation)?rowid,false) OR coalesce((proof->'source'->'rows'->relation)?rowid,false)
 OR (relation IN('payslip','payroll_input','payroll_batch_component','payroll_statutory_adjustment') AND (oldj->>'batch_id'=r.payroll_reset_batch_id::text OR newj->>'batch_id'=r.payroll_reset_batch_id::text))
 OR (relation='claim_request' AND (oldj->>'payroll_batch_id'=r.payroll_reset_batch_id::text OR newj->>'payroll_batch_id'=r.payroll_reset_batch_id::text))
 OR (relation='payroll_individual_txn' AND (oldj->>'batch_id'=r.payroll_reset_batch_id::text OR newj->>'batch_id'=r.payroll_reset_batch_id::text OR oldj->>'consumed_batch_id'=r.payroll_reset_batch_id::text OR newj->>'consumed_batch_id'=r.payroll_reset_batch_id::text))
 OR (relation='loan_repayment' AND ((proof->'source'->'meta'->'loanIds')?coalesce(oldj->>'loan_id','') OR (proof->'source'->'meta'->'loanIds')?coalesce(newj->>'loan_id','')))
 OR (relation='payroll_batch' AND (oldj->>'pay_period_id'=r.payroll_reset_period_id::text OR newj->>'pay_period_id'=r.payroll_reset_period_id::text))
 OR (relation='statutory_report' AND (oldj->>'company_id'=r.company_id::text OR newj->>'company_id'=r.company_id::text) AND (oldj->>'period_key'=proof->'source'->'meta'->>'payPeriod' OR newj->>'period_key'=proof->'source'->'meta'->>'payPeriod'));
 IF relevant IS NOT TRUE THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF (relation NOT IN('domain_event','payroll_status_history') AND (TG_OP='INSERT' OR oldhash IS DISTINCT FROM progress->relation->>rowid)) OR (TG_OP='UPDATE' AND (oldj->>'id' IS DISTINCT FROM newj->>'id' OR oldj->>'tenant_id' IS DISTINCT FROM newj->>'tenant_id')) THEN RAISE EXCEPTION 'Payroll reset source membership changed';END IF;
 entry:=jsonb_build_object('relation',relation,'id',rowid,'op',TG_OP,'old',oldhash,'new',newhash);
 IF relation IN('domain_event','payroll_status_history') THEN
  IF TG_OP<>'INSERT' OR newj->>'tenant_id' IS DISTINCT FROM r.tenant_id::text OR newj->>'actor_type' IS DISTINCT FROM 'user' OR newj->>'actor_id' IS DISTINCT FROM r.user_id::text THEN RAISE EXCEPTION 'Payroll reset audit mutation mismatch';END IF;
  IF relation='domain_event' THEN
   IF newj->>'event_type' NOT IN('payroll-batch.reset','payroll-batch.recalc-cleared','loan.instalment.reversed','loan.reopened','claim-request.payment-reversed') OR (newj->>'event_type'='payroll-batch.reset' AND newj->>'id' IS DISTINCT FROM nullif(current_setting('app.payroll_reset_event',true),'')) OR (newj->>'event_type'<>'payroll-batch.reset' AND newj->'payload'->>'resetEventId' IS DISTINCT FROM nullif(current_setting('app.payroll_reset_event',true),'')) THEN RAISE EXCEPTION 'Payroll reset extra or unlinked event';END IF;
   entry:=entry||jsonb_build_object('kind','event');
  ELSE
   IF newj->>'action' IS DISTINCT FROM 'rollback' OR newj->>'from_status' IS DISTINCT FROM 'processed' OR newj->>'to_status' IS DISTINCT FROM 'draft' OR app._payroll_reset_hash(newj->'reason') IS DISTINCT FROM proof->>'reasonHash' THEN RAISE EXCEPTION 'Payroll reset history transition mismatch';END IF;
   entry:=entry||jsonb_build_object('kind','history');
  END IF;
 ELSIF relation='payslip' AND TG_OP='DELETE' AND oldj->>'batch_id'=r.payroll_reset_batch_id::text THEN
  entry:=entry||jsonb_build_object('kind','payslip');
 ELSIF relation='loan_repayment' AND TG_OP='DELETE' AND oldj->>'status'='scheduled' THEN
  step:=nullif(current_setting('app.payroll_reset_current_rep',true),'')::uuid;
  SELECT * INTO rep FROM public.loan_repayment q WHERE q.id=step AND q.tenant_id=r.tenant_id AND q.applied_batch_id=r.payroll_reset_batch_id AND q.status='applied' AND app.can_see_employment(q.employment_id);
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.employee_loan l WHERE l.id=rep.loan_id AND l.tenant_id=r.tenant_id AND app.can_see_employment(l.employment_id)) OR progress->relation->>rep.id::text IS DISTINCT FROM app._payroll_reset_hash(to_jsonb(rep)) OR rep.loan_id::text IS DISTINCT FROM oldj->>'loan_id' OR rep.applied_amount>=rep.due_amount OR (rep.due_amount-rep.applied_amount)::numeric(12,2) IS DISTINCT FROM (oldj->>'due_amount')::numeric OR EXISTS(SELECT 1 FROM public.loan_repayment q WHERE q.tenant_id=r.tenant_id AND q.loan_id=rep.loan_id AND app.can_see_employment(q.employment_id) AND q.status='scheduled' AND q.due_amount=rep.due_amount-rep.applied_amount AND q.sequence_no>(oldj->>'sequence_no')::int) OR proof->'shortfalls'?rep.id::text THEN RAISE EXCEPTION 'Payroll reset shortfall mismatch';END IF;
  proof:=jsonb_set(proof,ARRAY['shortfalls',rep.id::text],jsonb_build_object('id',rowid,'hash',oldhash));
  entry:=entry||jsonb_build_object('kind','shortfall','repaymentId',rep.id);
 ELSIF relation='loan_repayment' AND TG_OP='UPDATE' AND oldj->>'status'='applied' AND oldj->>'applied_batch_id'=r.payroll_reset_batch_id::text THEN
  step:=nullif(current_setting('app.payroll_reset_current_rep',true),'')::uuid;
  IF step::text IS DISTINCT FROM rowid OR oldj-ARRAY['status','reserved_batch_id','due_amount','applied_batch_id','applied_amount','applied_at'] IS DISTINCT FROM newj-ARRAY['status','reserved_batch_id','due_amount','applied_batch_id','applied_amount','applied_at'] OR newj->>'applied_batch_id' IS NOT NULL OR (newj->>'applied_amount')::numeric<>0 OR newj->>'applied_at' IS NOT NULL THEN RAISE EXCEPTION 'Payroll reset repayment mismatch';END IF;
  SELECT * INTO loan FROM public.employee_loan q WHERE q.id=(oldj->>'loan_id')::uuid AND q.tenant_id=r.tenant_id AND app.can_see_employment(q.employment_id);
  IF NOT FOUND OR progress->'employee_loan'->>loan.id::text IS DISTINCT FROM app._payroll_reset_hash(to_jsonb(loan)) OR proof->'pendingLoans'?loan.id::text THEN RAISE EXCEPTION 'Payroll reset loan mismatch';END IF;
  SELECT EXISTS(SELECT 1 FROM public.loan_repayment q WHERE q.tenant_id=r.tenant_id AND q.loan_id=loan.id AND app.can_see_employment(q.employment_id) AND q.id<>(oldj->>'id')::uuid AND q.status='reserved') INTO other_reserved;
  IF (other_reserved AND (newj->>'status'<>'scheduled' OR newj->>'reserved_batch_id' IS NOT NULL)) OR (NOT other_reserved AND (newj->>'status'<>'reserved' OR newj->'reserved_batch_id' IS DISTINCT FROM oldj->'reserved_batch_id')) THEN RAISE EXCEPTION 'Payroll reset reservation mismatch';END IF;
  shortfall:=proof->'shortfalls'->rowid;
  IF (oldj->>'applied_amount')::numeric<(oldj->>'due_amount')::numeric THEN
   IF shortfall IS NULL AND EXISTS(SELECT 1 FROM public.loan_repayment q WHERE q.tenant_id=r.tenant_id AND q.loan_id=loan.id AND app.can_see_employment(q.employment_id) AND q.status='scheduled' AND q.due_amount=(oldj->>'due_amount')::numeric-(oldj->>'applied_amount')::numeric) THEN RAISE EXCEPTION 'Payroll reset shortfall omitted';END IF;
   IF (newj->>'due_amount')::numeric IS DISTINCT FROM CASE WHEN shortfall IS NULL THEN (oldj->>'applied_amount')::numeric ELSE (oldj->>'due_amount')::numeric END THEN RAISE EXCEPTION 'Payroll reset restored due mismatch';END IF;
  ELSIF newj->'due_amount' IS DISTINCT FROM oldj->'due_amount' OR shortfall IS NOT NULL THEN RAISE EXCEPTION 'Payroll reset unexpected shortfall';END IF;
  -- Input columns are decimal(12,2). Keep cents in the exact native safe-integer range; never
  -- reproduce an amortization algorithm or expose monetary values in the commitment.
  IF abs(loan.outstanding_balance*100)+abs((oldj->>'applied_amount')::numeric*100)>9007199254740991 THEN RAISE EXCEPTION 'Payroll reset requires native handoff' USING ERRCODE='54000';END IF;
  reopened:=loan.status='settled' AND (oldj->>'applied_amount')::numeric>0;
  expected:=to_jsonb(loan)||jsonb_build_object('outstanding_balance',(loan.outstanding_balance+(oldj->>'applied_amount')::numeric)::numeric(12,2),'instalments_paid',greatest(0,loan.instalments_paid-CASE WHEN (oldj->>'applied_amount')::numeric>0 THEN 1 ELSE 0 END),'status',CASE WHEN reopened THEN 'active' ELSE loan.status::text END,'updated_at',now());
  proof:=jsonb_set(proof,ARRAY['pendingLoans',loan.id::text],jsonb_build_object('old',app._payroll_reset_hash(to_jsonb(loan)),'new',app._payroll_reset_hash(expected),'repaymentId',rowid,'reopened',reopened,'employmentId',loan.employment_id));
  entry:=entry||jsonb_build_object('kind','repayment','loanId',loan.id,'employmentId',oldj->>'employment_id');
 ELSIF relation='employee_loan' AND TG_OP='UPDATE' THEN
  pending:=proof->'pendingLoans'->rowid;
  IF pending IS NULL OR pending->>'old' IS DISTINCT FROM oldhash OR pending->>'new' IS DISTINCT FROM newhash THEN RAISE EXCEPTION 'Payroll reset loan transition mismatch';END IF;
  proof:=jsonb_set(proof,'{pendingLoans}',(proof->'pendingLoans')-rowid);
  entry:=entry||pending||jsonb_build_object('kind','loan');
 ELSIF relation='claim_request' AND TG_OP='UPDATE' AND oldj->>'status'='paid' AND oldj->>'payroll_batch_id'=r.payroll_reset_batch_id::text AND newj->>'status'='approved' AND newj->>'paid_at' IS NULL AND newj->>'payout_ref' IS NULL AND oldj-ARRAY['status','paid_at','payout_ref']=newj-ARRAY['status','paid_at','payout_ref'] THEN
  entry:=entry||jsonb_build_object('kind','claim','employmentId',oldj->>'employment_id');
 ELSIF relation='payroll_individual_txn' AND TG_OP='UPDATE' AND oldj->>'consumed_batch_id'=r.payroll_reset_batch_id::text AND newj->>'consumed_batch_id' IS NULL AND newj->>'consumed_at' IS NULL AND oldj-ARRAY['consumed_batch_id','consumed_at']=newj-ARRAY['consumed_batch_id','consumed_at'] THEN
  entry:=entry||jsonb_build_object('kind','consumed');
 ELSIF relation='payroll_batch' AND TG_OP='UPDATE' AND rowid=r.payroll_reset_batch_id::text THEN
  IF oldj->>'needs_recalc_at' IS NOT NULL AND newj->>'needs_recalc_at' IS NULL AND newj->>'recalc_employment_ids' IS NULL AND oldj-ARRAY['needs_recalc_at','recalc_employment_ids']=newj-ARRAY['needs_recalc_at','recalc_employment_ids'] THEN entry:=entry||jsonb_build_object('kind','recalc');
  ELSIF oldj->>'status'='processed' AND newj->>'status'='draft' AND newj->>'totals' IS NULL AND (newj->>'employee_count')::int=0 AND oldj-ARRAY['status','totals','employee_count']=newj-ARRAY['status','totals','employee_count'] AND ((proof->'source'->'meta'->>'recalcMarked')::boolean IS NOT TRUE OR oldj->>'needs_recalc_at' IS NULL) THEN entry:=entry||jsonb_build_object('kind','batch');
  ELSE RAISE EXCEPTION 'Payroll reset batch transition mismatch';END IF;
 ELSE RAISE EXCEPTION 'Payroll reset unexpected protected mutation';END IF;
 IF relation IN('domain_event','payroll_status_history') THEN NULL;
 ELSIF TG_OP='DELETE' THEN progress:=jsonb_set(progress,ARRAY[relation],(progress->relation)-rowid);ELSE progress:=jsonb_set(progress,ARRAY[relation,rowid],to_jsonb(newhash));END IF;
 proof:=jsonb_set(jsonb_set(proof,'{progress}',progress),'{observed}',(proof->'observed')||jsonb_build_array(entry));
 -- This physical write must be observed NOW, before a later top-level update could launder xmin.
 UPDATE app.assistant_own_leave_review SET payroll_reset_proof=proof WHERE id=r.id RETURNING xmin INTO physical;
 IF physical<>pg_current_xact_id()::xid THEN RAISE EXCEPTION 'Payroll reset observation is not top-level';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app._payroll_reset_transition() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
DO $$ DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['payroll_batch','pay_period','payslip','loan_repayment','employee_loan','claim_request','payroll_individual_txn','payroll_input','payroll_batch_component','payroll_statutory_adjustment','statutory_report','domain_event','payroll_status_history'] LOOP
  EXECUTE format('CREATE TRIGGER payroll_reset_transition AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app._payroll_reset_transition()',name);
 END LOOP;
END $$;
--> statement-breakpoint
-- Strict end-of-transition proof. Current state must equal the complete protected progress map,
-- not just a count or caller-supplied preview hash. Historical reads retain a protected commitment.
CREATE FUNCTION app._payroll_reset_complete_effect(p_id uuid,p_event uuid,p_finalize boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;proof jsonb;progress jsonb;current_source jsonb;e public.domain_event%ROWTYPE;h public.payroll_status_history%ROWTYPE;x jsonb;kind text;seen jsonb:='{}'::jsonb;effect record;expected_type text;expected_subject uuid;expected_aggregate uuid;event_hashes jsonb:='{}'::jsonb;event_count integer:=0;counts jsonb;selected_count int;updated_count int;claim_count int;slip_count int;consumed_count int;reopened_count int;recalc_count int;physical xid;history_before jsonb;commitment text;
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='payroll.reset' AND state='awaiting_confirmation' FOR UPDATE NOWAIT;
 IF NOT FOUND OR clock_timestamp()>=r.expires_at OR r.payroll_reset_proof->>'phase' IS DISTINCT FROM 'actual' OR r.payroll_reset_proof->>'xid' IS DISTINCT FROM pg_current_xact_id()::text THEN RAISE EXCEPTION 'Payroll reset completion unavailable';END IF;
 PERFORM app._assistant_payroll_reset_review_identity(r.person_id);
 proof:=r.payroll_reset_proof;
 IF proof->'pendingLoans'<>'{}'::jsonb THEN RAISE EXCEPTION 'Payroll reset loan effects incomplete';END IF;
 -- Recompute every original scope and every current scope, including now-released retargeted
 -- individual rows and schedules whose applied marker has been cleared. Reject new relation keys too.
 current_source:=app._payroll_reset_source(r.payroll_reset_batch_id,
 ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(proof->'source'->'meta'->'loanIds')),
 ARRAY(SELECT key::uuid FROM jsonb_each(coalesce(proof->'source'->'rows'->'payroll_individual_txn','{}'::jsonb))));
 SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) INTO progress FROM jsonb_each(proof->'progress') WHERE value<>'{}'::jsonb;
 IF current_source->'rows' IS DISTINCT FROM progress OR current_source->'meta'->>'exportHash' IS DISTINCT FROM proof->'source'->'meta'->>'exportHash' THEN RAISE EXCEPTION 'Payroll reset full source/progress mismatch';END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(proof->'observed') LOOP
  kind:=((x->>'kind')||':'||(x->>'id')||':'||CASE WHEN x->>'kind'='loan' THEN coalesce(x->>'repaymentId','') ELSE '' END);
  IF seen?kind THEN RAISE EXCEPTION 'Payroll reset duplicate transition';END IF;
  seen:=seen||jsonb_build_object(kind,true);
  IF x->>'kind'='shortfall' AND ((SELECT count(*) FROM jsonb_array_elements(proof->'observed') step WHERE step->>'kind'='repayment' AND step->>'id'=x->>'repaymentId')<>1 OR (SELECT count(*) FROM jsonb_array_elements(proof->'observed') step WHERE step->>'kind'='loan' AND step->>'repaymentId'=x->>'repaymentId')<>1) THEN RAISE EXCEPTION 'Payroll reset orphan shortfall';END IF;
 END LOOP;
 SELECT count(*) FILTER(WHERE value->>'kind'='payslip'),count(*) FILTER(WHERE value->>'kind'='repayment'),count(*) FILTER(WHERE value->>'kind'='claim'),count(*) FILTER(WHERE value->>'kind'='consumed'),count(*) FILTER(WHERE value->>'kind'='loan' AND (value->>'reopened')::boolean),count(*) FILTER(WHERE value->>'kind'='recalc') INTO slip_count,updated_count,claim_count,consumed_count,reopened_count,recalc_count FROM jsonb_array_elements(proof->'observed');
 selected_count:=(proof->'source'->'meta'->>'applied')::int;
 IF slip_count<>(proof->'source'->'meta'->>'payslips')::int OR claim_count<>(proof->'source'->'meta'->>'claims')::int OR consumed_count<>(proof->'source'->'meta'->>'consumed')::int OR recalc_count<>CASE WHEN (proof->'source'->'meta'->>'recalcMarked')::boolean THEN 1 ELSE 0 END OR (SELECT count(*) FROM jsonb_array_elements(proof->'observed') WHERE value->>'kind'='batch')<>1 OR (SELECT count(*) FROM jsonb_array_elements(proof->'observed') WHERE value->>'kind'='loan')<>updated_count THEN RAISE EXCEPTION 'Payroll reset effect inventory mismatch';END IF;
 -- Every originally applied native-visible repayment with a native-visible loan must be restored.
 IF EXISTS(SELECT 1 FROM public.loan_repayment q WHERE q.tenant_id=r.tenant_id AND q.applied_batch_id=r.payroll_reset_batch_id AND q.status='applied' AND app.can_see_employment(q.employment_id) AND EXISTS(SELECT 1 FROM public.employee_loan l WHERE l.id=q.loan_id AND l.tenant_id=q.tenant_id AND app.can_see_employment(l.employment_id))) THEN RAISE EXCEPTION 'Payroll reset repayment omitted';END IF;
 SELECT * INTO e FROM public.domain_event WHERE id=p_event AND tenant_id=r.tenant_id AND aggregate_type='payroll-batch' AND aggregate_id=r.payroll_reset_batch_id AND event_type='payroll-batch.reset' AND actor_type='user' AND actor_id=r.user_id AND subject_employment_id IS NULL AND xmin=pg_current_xact_id()::xid;
 IF NOT FOUND OR app._payroll_reset_hash(to_jsonb(e.payload->>'reason')) IS DISTINCT FROM proof->>'reasonHash' THEN RAISE EXCEPTION 'Payroll reset event mismatch';END IF;
 SELECT * INTO h FROM public.payroll_status_history WHERE id=(e.payload->>'statusHistoryId')::uuid AND tenant_id=r.tenant_id AND batch_id=r.payroll_reset_batch_id AND action='rollback' AND from_status='processed' AND to_status='draft' AND actor_type='user' AND actor_id=r.user_id AND xmin=pg_current_xact_id()::xid;
 IF NOT FOUND OR h.reason IS DISTINCT FROM e.payload->>'reason' OR app._payroll_reset_hash(h.before) IS DISTINCT FROM proof->'source'->'meta'->>'beforeTotalsHash' OR e.payload->>'companyId' IS DISTINCT FROM r.company_id::text OR e.payload->>'payPeriodId' IS DISTINCT FROM r.payroll_reset_period_id::text OR e.payload->>'payPeriod' IS DISTINCT FROM proof->'source'->'meta'->>'payPeriod' OR e.payload->>'fromStatus' IS DISTINCT FROM 'processed' OR e.payload->>'toStatus' IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Payroll reset history mismatch';END IF;
 counts:=jsonb_build_object('payslipsCleared',slip_count,'loanInstalmentsReversed',selected_count,'loansReopened',reopened_count,'claimsReverted',claim_count);
 IF h.after IS DISTINCT FROM (jsonb_build_object('status','draft','totals',NULL,'employeeCount',0)||counts) THEN RAISE EXCEPTION 'Payroll reset native counts mismatch';END IF;
 IF e.payload IS DISTINCT FROM (jsonb_build_object('statusHistoryId',h.id,'fromStatus','processed','toStatus','draft','companyId',r.company_id,'payPeriod',proof->'source'->'meta'->>'payPeriod','payPeriodId',r.payroll_reset_period_id,'runType',proof->'source'->'meta'->>'runType','runSeq',(proof->'source'->'meta'->>'runSeq')::int,'reason',h.reason,'statutoryReportsForPeriod',(proof->'source'->'meta'->>'statutoryReports')::int)||counts) THEN RAISE EXCEPTION 'Payroll reset native payload mismatch';END IF;
 -- Exact event-per-effect multisets, all linked to this reset event by the unchanged native writer.
 FOR x IN SELECT value FROM jsonb_array_elements(proof->'observed') WHERE value->>'kind' IN('repayment','claim','recalc') OR (value->>'kind'='loan' AND (value->>'reopened')::boolean) LOOP
  kind:=x->>'kind';expected_type:=CASE kind WHEN 'repayment' THEN 'loan.instalment.reversed' WHEN 'loan' THEN 'loan.reopened' WHEN 'claim' THEN 'claim-request.payment-reversed' ELSE 'payroll-batch.recalc-cleared' END;
  expected_aggregate:=CASE WHEN kind='recalc' THEN r.payroll_reset_batch_id ELSE (x->>'id')::uuid END;
  expected_subject:=CASE WHEN kind='recalc' THEN NULL ELSE (x->>'employmentId')::uuid END;
  IF (SELECT count(*) FROM public.domain_event d WHERE d.tenant_id=r.tenant_id AND d.event_type=expected_type AND d.aggregate_id=expected_aggregate AND d.aggregate_type=CASE kind WHEN 'repayment' THEN 'loan-repayment' WHEN 'loan' THEN 'employee-loan' WHEN 'claim' THEN 'claim-request' ELSE 'payroll-batch' END AND (kind<>'repayment' OR d.payload->>'loanId'=x->>'loanId') AND d.actor_type='user' AND d.actor_id=r.user_id AND d.subject_employment_id IS NOT DISTINCT FROM expected_subject AND d.payload->>'resetEventId'=p_event::text AND d.xmin=pg_current_xact_id()::xid AND d.payload=CASE WHEN kind='recalc' THEN jsonb_build_object('resetEventId',p_event) WHEN kind='repayment' THEN jsonb_build_object('batchId',r.payroll_reset_batch_id,'loanId',x->>'loanId','reason','payroll-reset','resetEventId',p_event) ELSE jsonb_build_object('batchId',r.payroll_reset_batch_id,'reason','payroll-reset','resetEventId',p_event) END)<>1 THEN RAISE EXCEPTION 'Payroll reset exact native event missing';END IF;
  event_count:=event_count+1;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_array_elements(proof->'observed') WHERE value->>'kind'='history')<>1 OR (SELECT count(*) FROM jsonb_array_elements(proof->'observed') WHERE value->>'kind'='event')<>event_count+1 OR (SELECT count(*) FROM public.domain_event d WHERE d.tenant_id=r.tenant_id AND d.payload->>'resetEventId'=p_event::text)<>event_count THEN RAISE EXCEPTION 'Payroll reset extra native event';END IF;
 SELECT jsonb_object_agg(d.id::text,app._payroll_reset_hash(to_jsonb(d))) INTO event_hashes FROM public.domain_event d WHERE d.tenant_id=r.tenant_id AND (d.id=p_event OR d.payload->>'resetEventId'=p_event::text);
 commitment:=app._payroll_reset_hash(jsonb_build_object('source',proof->'source','observed',proof->'observed','progress',proof->'progress','history',app._payroll_reset_hash(to_jsonb(h)),'events',event_hashes));
 proof:=jsonb_build_object('phase','completed','commitment',commitment,'statusHistoryId',h.id,'resetEventId',p_event,'counts',counts,'historyHash',app._payroll_reset_hash(to_jsonb(h)),'eventHashes',event_hashes);
 UPDATE app.assistant_own_leave_review SET payroll_reset_proof=CASE WHEN p_finalize THEN proof ELSE payroll_reset_proof END WHERE id=r.id RETURNING xmin INTO physical;
 IF physical<>pg_current_xact_id()::xid THEN RAISE EXCEPTION 'Payroll reset completion is not top-level';END IF;
 RETURN proof;
END $$;
REVOKE ALL ON FUNCTION app._payroll_reset_complete_effect(uuid,uuid,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_payroll_reset_review_source(p_person uuid,p_batch uuid,p_company uuid,p_period uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_payroll_reset_review_identity(p_person);
 IF NOT EXISTS(SELECT 1 FROM public.payroll_batch b JOIN public.pay_period p ON p.id=b.pay_period_id AND p.tenant_id=b.tenant_id AND p.company_id=b.company_id AND p.period=b.pay_period
  WHERE b.id=p_batch AND b.tenant_id=app.current_tenant_id() AND b.company_id=p_company AND b.pay_period_id=p_period AND app.can_admin_payroll_for(b.company_id) AND app.is_admin()) THEN RAISE EXCEPTION 'Payroll reset review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_payroll_reset_review_source(uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_payroll_reset_review_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object('actionId',r.id,'action',r.action_kind,'contractVersion',1,
 'binding',jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'employmentId',r.employment_id,'companyId',r.company_id,'batchId',r.payroll_reset_batch_id,'payPeriodId',r.payroll_reset_period_id),
 'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,'state',r.state,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object('formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,
 'eventId',r.payroll_reset_event_id)
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id WHERE r.id=p_id AND r.action_kind='payroll.reset';
$$;
REVOKE ALL ON FUNCTION app._assistant_payroll_reset_review_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_payroll_reset_review_prepare(p_id uuid,p_person uuid,p_batch uuid,p_company uuid,p_period uuid,p_people uuid[],p_prior uuid,p_coverage uuid[],p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text,p_source_digest text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();at_time timestamptz;people uuid[];
BEGIN
 PERFORM app._assistant_payroll_reset_review_source(p_person,p_batch,p_company,p_period);
 IF NOT EXISTS(SELECT 1 FROM public.payroll_batch b JOIN public.pay_period p ON p.id=b.pay_period_id WHERE b.id=p_batch AND b.tenant_id=t AND b.status='processed' AND p.status IN('open','closed')) THEN RAISE EXCEPTION 'Payroll reset review unavailable' USING ERRCODE='42501';END IF;
 IF p_prior IS NOT NULL OR p_coverage IS DISTINCT FROM ARRAY[]::uuid[] THEN RAISE EXCEPTION 'Payroll reset source unavailable';END IF;
 SELECT coalesce(array_agg(value::uuid ORDER BY value::uuid),'{}'::uuid[]) INTO people FROM jsonb_array_elements_text(app._payroll_reset_source(p_batch)->'meta'->'people');
 IF p_source_digest IS DISTINCT FROM app._payroll_reset_hash(app._payroll_reset_source(p_batch)) THEN RAISE EXCEPTION 'Payroll reset source changed';END IF;
 IF p_people IS NULL OR p_people IS DISTINCT FROM people THEN RAISE EXCEPTION 'Payroll reset review unavailable' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND (i.person_id=p_person OR i.person_id=ANY(people))) OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND (i.person_id=p_person OR i.person_id=ANY(people))) THEN RAISE EXCEPTION 'Payroll reset review unavailable' USING ERRCODE='42501';END IF;
 IF p_id IS NULL OR p_intent_digest IS NULL OR p_intent_digest !~ '^[a-f0-9]{64}$' OR p_reviewed_digest IS NULL OR p_reviewed_digest !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$' OR p_wrapped_dek IS NULL OR length(p_wrapped_dek) NOT BETWEEN 1 AND 512 OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN RAISE EXCEPTION 'Payroll reset review unavailable' USING ERRCODE='22023';END IF;
 at_time:=clock_timestamp();
 IF (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation' AND expires_at>at_time)>=5 OR (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND created_at>at_time-interval '10 minutes')>=20 THEN RAISE EXCEPTION 'Payroll reset review unavailable' USING ERRCODE='54000';END IF;
 INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,payroll_reset_batch_id,payroll_reset_period_id,payroll_reset_person_ids,payroll_reset_proof,intent_digest,reviewed_digest,state,created_at,expires_at)
 VALUES('payroll.reset',p_id,t,u,p_person,NULL,p_company,p_batch,p_period,people,jsonb_build_object('phase','prepared','sourceDigest',p_source_digest),p_intent_digest,p_reviewed_digest,'awaiting_confirmation',at_time,at_time+interval '10 minutes') ON CONFLICT(id) DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'Payroll reset review unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped_dek,p_ciphertext);
 RETURN app._assistant_payroll_reset_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reset_review_prepare(uuid,uuid,uuid,uuid,uuid,uuid[],uuid,uuid[],text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_payroll_reset_review_prepare(uuid,uuid,uuid,uuid,uuid,uuid[],uuid,uuid[],text,text,text,text,text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_payroll_reset_review_subject(p_id uuid) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_payroll_reset_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='payroll.reset';
 IF NOT FOUND THEN RAISE EXCEPTION 'Payroll reset review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_payroll_reset_review_identity(r.person_id);RETURN r.payroll_reset_batch_id;
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reset_review_subject(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_payroll_reset_review_subject(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_payroll_reset_review_peek(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_payroll_reset_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='payroll.reset';
 IF NOT FOUND THEN RAISE EXCEPTION 'Payroll reset review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_payroll_reset_review_source(r.person_id,r.payroll_reset_batch_id,r.company_id,r.payroll_reset_period_id);
 IF r.state='awaiting_confirmation' AND (r.payroll_reset_person_ids IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c WHERE c.action_id=r.id)) THEN RAISE EXCEPTION 'Payroll reset review unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('review',app._assistant_payroll_reset_review_json(r.id),'pendingExpired',r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at);
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reset_review_peek(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_payroll_reset_review_peek(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_payroll_reset_review_read(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_payroll_reset_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='payroll.reset' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Payroll reset review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_payroll_reset_review_source(r.person_id,r.payroll_reset_batch_id,r.company_id,r.payroll_reset_period_id);
 IF r.state='awaiting_confirmation' AND (r.payroll_reset_person_ids IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c WHERE c.action_id=r.id)) THEN RAISE EXCEPTION 'Payroll reset review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL,payroll_reset_person_ids=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review a WHERE c.action_id=a.id AND a.id=r.id AND a.state<>'awaiting_confirmation';
 RETURN app._assistant_payroll_reset_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reset_review_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_payroll_reset_review_read(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_payroll_reset_review_complete(p_id uuid,p_reviewed_digest text,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_payroll_reset_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='payroll.reset' FOR UPDATE NOWAIT;
 IF NOT FOUND OR p_event IS NULL THEN RAISE EXCEPTION 'Payroll reset unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_payroll_reset_review_source(r.person_id,r.payroll_reset_batch_id,r.company_id,r.payroll_reset_period_id);
 IF r.state='completed' THEN
  IF r.payroll_reset_event_id IS DISTINCT FROM p_event OR app.read_own_payroll_reset_effect(r.payroll_reset_batch_id,p_event) IS NULL THEN RAISE EXCEPTION 'Payroll reset unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
  IF r.reviewed_digest IS DISTINCT FROM p_reviewed_digest OR r.payroll_reset_person_ids IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) THEN RAISE EXCEPTION 'Payroll reset unavailable' USING ERRCODE='42501';END IF;
  PERFORM app._payroll_reset_complete_effect(r.id,p_event,true);
  UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,payroll_reset_event_id=p_event,payroll_reset_person_ids=NULL WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 ELSE RAISE EXCEPTION 'Payroll reset unavailable' USING ERRCODE='42501';END IF;
 RETURN app._assistant_payroll_reset_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reset_review_complete(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_payroll_reset_review_complete(uuid,text,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Login-only, digestless retirement/index. Revoked Assistant/Payroll permission never executes.
CREATE FUNCTION app.assistant_payroll_reset_review_discard(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_payroll_reset_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='payroll.reset' FOR UPDATE NOWAIT;
 IF NOT FOUND OR r.state='completed' THEN RAISE EXCEPTION 'Payroll reset review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' THEN UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL,payroll_reset_person_ids=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=r.id;
 RETURN jsonb_build_object('action','payroll.reset','contractVersion',1,'actionId',r.id,'state',r.state);
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reset_review_discard(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_payroll_reset_review_discard(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_payroll_reset_reviews_index() RETURNS TABLE(action text,action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_payroll_reset_review_identity(NULL,false,false);
 RETURN QUERY SELECT r.action_kind,r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.action_kind='payroll.reset' ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reset_reviews_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_payroll_reset_reviews_index() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_payroll_reset_body_retired() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 UPDATE app.assistant_own_leave_review SET payroll_reset_person_ids=NULL,payroll_reset_proof=CASE WHEN state='completed' THEN payroll_reset_proof ELSE NULL END WHERE id=OLD.action_id AND action_kind='payroll.reset' AND (payroll_reset_person_ids IS NOT NULL OR payroll_reset_proof IS NOT NULL);
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reset_body_retired() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_payroll_reset_body_retired AFTER DELETE ON app.assistant_own_leave_review_content FOR EACH ROW EXECUTE FUNCTION app.assistant_payroll_reset_body_retired();

--> statement-breakpoint
-- Extend canonical erasure admission/audit/deferred verification for the private reset cohort.
DO $$ DECLARE f record;definition text;changed text;
BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.prokind='f' AND p.proname IN('assistant_own_leave_reviews_redact','audit_assistant_review_erasure','assistant_review_erasure_complete') LOOP
  definition:=pg_get_functiondef(f.signature);
  changed:=replace(definition,'i.person_id = ANY (r.payroll_review_person_ids)','(i.person_id = ANY (r.payroll_review_person_ids) OR i.person_id = ANY (r.payroll_reset_person_ids))');
  -- pg_get_functiondef preserves PL/pgSQL body spelling from the source migrations.
  changed:=replace(changed,'i.person_id=ANY(r.payroll_review_person_ids)','(i.person_id=ANY(r.payroll_review_person_ids) OR i.person_id=ANY(r.payroll_reset_person_ids))');
  changed:=replace(changed,'NEW.aggregate_id=ANY(r.payroll_review_person_ids)','(NEW.aggregate_id=ANY(r.payroll_review_person_ids) OR NEW.aggregate_id=ANY(r.payroll_reset_person_ids))');
  changed:=replace(changed,'i.person_id=ANY(payroll_review_person_ids)','(i.person_id=ANY(payroll_review_person_ids) OR i.person_id=ANY(payroll_reset_person_ids))');
  IF changed=definition THEN RAISE EXCEPTION 'Payroll reset erasure owner drift: %',f.signature;END IF;
  EXECUTE changed;
 END LOOP;
END $$;
--> statement-breakpoint
DO $$ DECLARE target regprocedure;definition text;marker text;replacement text;
BEGIN
 FOR target IN SELECT signature::regprocedure FROM unnest(ARRAY['app.native_outcome_review_completed(text,uuid)','app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)','app.native_outcome_completed_review_choices(jsonb)']) signature LOOP
  definition:=pg_get_functiondef(target);
  IF target='app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure THEN
   marker:='WHEN ''payroll.close'' THEN r.payroll_closed_event_id';replacement:=marker||' WHEN ''payroll.reset'' THEN r.payroll_reset_event_id';
  ELSE
   marker:='''payroll.close''';replacement:=marker||',''payroll.reset''';
  END IF;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'Payroll reset outcome owner drift %',target;END IF;
  definition:=replace(definition,marker,replacement);
  -- Completion choices use the same columns via a new per-kind case, below if needed.
  EXECUTE definition;
 END LOOP;
END $$;

--> statement-breakpoint
-- Add this kind's complete original private cohort before terminal custody clears the array.
DO $$ DECLARE definition text;marker text:='||coalesce(r.payroll_review_person_ids,''{}''::uuid[])';
BEGIN
 definition:=pg_get_functiondef('app.native_outcome_targets_capture(uuid,uuid,uuid,text,uuid,uuid,jsonb)'::regprocedure);
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION '0744 privacy capture owner drift';END IF;
 EXECUTE replace(definition,marker,marker||'||coalesce(r.payroll_reset_person_ids,''{}''::uuid[])');
END $$;
-- Fresh native verification is not completion. The full arm/progress guards remain live until
-- custody atomically completes, revalidates and retires every transient source/transition hash.
CREATE FUNCTION app.assistant_payroll_reset_review_verify(p_id uuid,p_event uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;proof jsonb;b public.payroll_batch%ROWTYPE;parent public.pay_period%ROWTYPE;
BEGIN
 proof:=app._payroll_reset_complete_effect(p_id,p_event,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='payroll.reset';
 SELECT * INTO b FROM public.payroll_batch WHERE id=r.payroll_reset_batch_id AND tenant_id=r.tenant_id;
 SELECT * INTO parent FROM public.pay_period WHERE id=b.pay_period_id AND tenant_id=b.tenant_id;
 RETURN jsonb_build_object('batchId',b.id,'payPeriodId',parent.id,'resetEventId',p_event,'statusHistoryId',proof->>'statusHistoryId','currentStatus',b.status,'currentPeriodStatus',parent.status,'counts',proof->'counts','commitment',proof->>'commitment');
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reset_review_verify(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_payroll_reset_review_verify(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.read_own_payroll_reset_effect(p_batch uuid,p_event uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;b public.payroll_batch%ROWTYPE;parent public.pay_period%ROWTYPE;h public.payroll_status_history%ROWTYPE;x record;actual text;
BEGIN
 PERFORM app._assistant_payroll_reset_review_identity(NULL,false,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='payroll.reset' AND state='completed' AND payroll_reset_batch_id=p_batch AND payroll_reset_event_id=p_event;
 IF NOT FOUND OR r.payroll_reset_proof->>'phase' IS DISTINCT FROM 'completed' OR r.payroll_reset_proof->>'resetEventId' IS DISTINCT FROM p_event::text THEN RETURN NULL;END IF;
 SELECT * INTO b FROM public.payroll_batch WHERE id=p_batch AND tenant_id=r.tenant_id AND app.can_admin_payroll_for(company_id) AND app.is_admin();
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO parent FROM public.pay_period WHERE id=b.pay_period_id AND tenant_id=b.tenant_id;
 SELECT * INTO h FROM public.payroll_status_history WHERE id=(r.payroll_reset_proof->>'statusHistoryId')::uuid AND tenant_id=r.tenant_id AND batch_id=b.id;
 IF NOT FOUND OR app._payroll_reset_hash(to_jsonb(h)) IS DISTINCT FROM r.payroll_reset_proof->>'historyHash' THEN RETURN NULL;END IF;
 FOR x IN SELECT key,value FROM jsonb_each_text(r.payroll_reset_proof->'eventHashes') LOOP
  SELECT app._payroll_reset_hash(to_jsonb(d)) INTO actual FROM public.domain_event d WHERE d.id=x.key::uuid AND d.tenant_id=r.tenant_id;
  IF actual IS DISTINCT FROM x.value THEN RETURN NULL;END IF;
 END LOOP;
 -- Do not require historical deletions to remain absent after an authorized regeneration.
 RETURN jsonb_build_object('batchId',b.id,'payPeriodId',parent.id,'resetEventId',p_event,'statusHistoryId',h.id,'currentStatus',b.status,'currentPeriodStatus',parent.status,'counts',r.payroll_reset_proof->'counts','commitment',r.payroll_reset_proof->>'commitment');
END $$;
REVOKE ALL ON FUNCTION app.read_own_payroll_reset_effect(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_own_payroll_reset_effect(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.payroll_reset_review_context(p_batch uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;b public.payroll_batch%ROWTYPE;company_name text;cycle_name text;
BEGIN
 source:=app._payroll_reset_source(p_batch);
 SELECT * INTO b FROM public.payroll_batch WHERE id=p_batch AND tenant_id=app.current_tenant_id();
 SELECT legal_name INTO company_name FROM public.company WHERE id=b.company_id AND tenant_id=b.tenant_id;
 SELECT name INTO cycle_name FROM public.payroll_cycle WHERE id=b.payroll_cycle_id AND tenant_id=b.tenant_id;
 RETURN jsonb_build_object('companyName',company_name,'cycleName',cycle_name,'sourceDigest',app._payroll_reset_hash(source),'people',source->'meta'->'people','employees',source->'meta'->'employees');
END $$;
REVOKE ALL ON FUNCTION app.payroll_reset_review_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_reset_review_context(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Native reset skips the WHOLE repayment branch when its loan is RLS-invisible. Enforce that
-- admission before an actual shortfall deletion; the AFTER witness still observes physical DELETE.
CREATE FUNCTION app._payroll_reset_shortfall_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 IF TG_RELID<>'public.loan_repayment'::regclass OR TG_OP<>'DELETE' THEN RAISE EXCEPTION 'Invalid reset shortfall admission';END IF;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='payroll.reset' AND state='awaiting_confirmation' AND payroll_reset_proof->>'phase'='actual' AND payroll_reset_proof->>'xid'=pg_current_xact_id()::text;
 IF FOUND AND (r.payroll_reset_proof->'source'->'meta'->'loanIds')?OLD.loan_id::text AND NOT EXISTS(SELECT 1 FROM public.employee_loan l WHERE l.id=OLD.loan_id AND l.tenant_id=OLD.tenant_id AND app.can_see_employment(l.employment_id)) THEN RAISE EXCEPTION 'Payroll reset shortfall loan unavailable';END IF;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION app._payroll_reset_shortfall_admission() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER payroll_reset_shortfall_admission BEFORE DELETE ON public.loan_repayment FOR EACH ROW EXECUTE FUNCTION app._payroll_reset_shortfall_admission();
--> statement-breakpoint
