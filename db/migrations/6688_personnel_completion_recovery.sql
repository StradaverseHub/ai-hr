-- Explicit HR recovery. Candidate pages hash saved metadata only; official Personnel is read
-- for ONE target by the bulk worker. No document/source values leave the public review RPC.
CREATE FUNCTION app.personnel_completion_recovery_hash(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex') $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.personnel_completion_recovery_hash(jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.personnel_completion_recovery_context(p_case uuid,p_document text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH cases AS (
  SELECT c.id,c.company_id,c.revision,false native,c.data state,'{}'::jsonb source,c.data->'facts' facts FROM public.lc_v9_case c WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_case AND c.module='off'
  UNION ALL
  SELECT c.id,c.company_id,c.revision,true,(p.data->'lifecycleV9')||jsonb_build_object('state',c.data->'state','sourceRevision',c.data->'sourceVersion'),jsonb_build_object('case',c.data,'privateSource',p.data->'source','subject',p.data->'lifecycleV9Subject'),jsonb_build_object('joinDate',coalesce(p.data->'source'->>'joinDate',c.data->'source'->>'joinDate',c.data->'local'->>'joinDate'),'lastDay','')
  FROM public.lc_onboarding_case c JOIN public.lc_onboarding_private p ON p.case_id=c.id AND p.tenant_id=c.tenant_id WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_case AND c.data->>'state'='submitted'
 ), receipts AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',j.id,'mailId',j.mail_id,'status',j.status,'startedAt',j.started_at,'payloadHash',app.personnel_completion_recovery_hash(j.payload)) ORDER BY j.id),'[]'::jsonb) items
  FROM public.lc_v9_email_delivery j WHERE j.tenant_id=app.current_tenant_id() AND coalesce(j.case_id,j.onboarding_case_id)=p_case
 ) SELECT jsonb_build_object('native',c.native,'state',c.state,'source',c.source,'facts',c.facts,'document',d,
  'candidate',jsonb_build_object('tenantId',app.current_tenant_id(),'caseId',c.id,'companyId',c.company_id,'revision',c.revision,'documentId',p_document,'documentHash',app.personnel_completion_recovery_hash(d),
   'contextHash',app.personnel_completion_recovery_hash(jsonb_build_object('case',c.state,'source',c.source,'facts',c.facts,'deliveries',r.items))), 'deliveries',r.items)
 FROM cases c CROSS JOIN receipts r CROSS JOIN LATERAL jsonb_array_elements(coalesce(c.state->'documents','[]'::jsonb)) d WHERE d->>'id'=p_document
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.personnel_completion_recovery_context(uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.personnel_completion_recovery_candidates(p_after_case uuid DEFAULT NULL,p_after_document text DEFAULT NULL,p_limit integer DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();grants jsonb;sections jsonb;off_allowed boolean;result jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR (p_after_case IS NULL)<>(p_after_document IS NULL) OR length(p_after_document)>200 THEN RAISE EXCEPTION 'Invalid completion recovery page' USING ERRCODE='22023';END IF;
 IF NOT app.v9_signing_current_actor() OR nullif(current_setting('app.agent_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'Current HR authority is required' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('role',g.role,'companyId',g.company_id)),'[]'::jsonb) INTO grants FROM app.current_grants() g;
 sections:=app.onboarding_v9_sections();SELECT coalesce(cfg.data->'access'->'offboarding'?uid::text,false) INTO off_allowed FROM public.lc_onboarding_config cfg WHERE cfg.tenant_id=tenant;
 WITH companies AS MATERIALIZED (SELECT co.id FROM public.company co WHERE co.tenant_id=tenant AND app.grants_admin_for(grants,co.id) AND EXISTS(SELECT 1 FROM public.tenant_module m JOIN public.tenant t ON t.id=m.tenant_id WHERE m.tenant_id=tenant AND m.module_code='lifecycle' AND (m.company_id IS NULL OR m.company_id=co.id) AND m.status IN('active','trial') AND m.activated_at<=now() AND (m.expires_at IS NULL OR m.expires_at>now()) AND t.status IN('active','trial'))),
 cases AS MATERIALIZED (
  SELECT c.id,c.company_id,c.revision,c.data state,'{}'::jsonb source,c.data->'facts' facts FROM public.lc_v9_case c JOIN companies co ON co.id=c.company_id
  WHERE c.tenant_id=tenant AND c.module='off' AND c.data->>'state'='submitted' AND coalesce(off_allowed,false)
  UNION ALL
  SELECT c.id,c.company_id,c.revision,(p.data->'lifecycleV9')||jsonb_build_object('state',c.data->'state','sourceRevision',c.data->'sourceVersion'),jsonb_build_object('case',c.data,'privateSource',p.data->'source','subject',p.data->'lifecycleV9Subject'),jsonb_build_object('joinDate',coalesce(p.data->'source'->>'joinDate',c.data->'source'->>'joinDate',c.data->'local'->>'joinDate'),'lastDay','')
  FROM public.lc_onboarding_case c JOIN companies co ON co.id=c.company_id JOIN public.lc_onboarding_private p ON p.case_id=c.id AND p.tenant_id=c.tenant_id
  WHERE c.tenant_id=tenant AND c.data->>'state'='submitted' AND sections->>'actions'='allowed' AND sections->>'hr'='view'
 ), receipts AS MATERIALIZED (
  SELECT coalesce(j.case_id,j.onboarding_case_id) case_id,jsonb_agg(jsonb_build_object('id',j.id,'mailId',j.mail_id,'status',j.status,'startedAt',j.started_at,'payloadHash',app.personnel_completion_recovery_hash(j.payload)) ORDER BY j.id) items
  FROM public.lc_v9_email_delivery j JOIN cases c ON c.id=coalesce(j.case_id,j.onboarding_case_id) WHERE j.tenant_id=tenant GROUP BY coalesce(j.case_id,j.onboarding_case_id)
 ), contexts AS MATERIALIZED (
  SELECT c.*,app.personnel_completion_recovery_hash(jsonb_build_object('case',c.state,'source',c.source,'facts',c.facts,'deliveries',coalesce(r.items,'[]'::jsonb))) context_hash
  FROM cases c LEFT JOIN receipts r ON r.case_id=c.id
 ), documents AS MATERIALIZED (
  SELECT c.id,c.company_id,c.revision,d,c.context_hash
  FROM contexts c CROSS JOIN LATERAL jsonb_array_elements(coalesce(c.state->'documents','[]'::jsonb)) d
  WHERE d->>'status'='draft' AND d->>'sentAt' IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(d->'fields','[]'::jsonb)) f WHERE f->>'owner'='pmLocked')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(c.state->'runs','[]'::jsonb)) run WHERE run->>'status'='waiting' AND jsonb_typeof(run->'definition')='object' AND run->'definition'->'steps'->(CASE WHEN run->>'cursor'~'^[0-9]{1,4}$' THEN (run->>'cursor')::integer ELSE -1 END)->>'type'='doc' AND run->'definition'->'steps'->(CASE WHEN run->>'cursor'~'^[0-9]{1,4}$' THEN (run->>'cursor')::integer ELSE -1 END)->>'release'='true' AND run->'definition'->'steps'->(CASE WHEN run->>'cursor'~'^[0-9]{1,4}$' THEN (run->>'cursor')::integer ELSE -1 END)->>'template'=d->>'templateId')
 ), page AS (
  SELECT * FROM documents WHERE p_after_case IS NULL OR (id,d->>'id')>(p_after_case,p_after_document) ORDER BY id,d->>'id' LIMIT p_limit
 ), items AS (SELECT coalesce(jsonb_agg(jsonb_build_object('tenantId',tenant,'caseId',id,'companyId',company_id,'revision',revision,'documentId',d->>'id','documentHash',app.personnel_completion_recovery_hash(d),'contextHash',context_hash) ORDER BY id,d->>'id'),'[]'::jsonb) value FROM page)
 SELECT jsonb_build_object('items',items.value,'total',(SELECT count(*) FROM documents),'after',CASE WHEN jsonb_array_length(items.value)>0 THEN jsonb_build_object('caseId',items.value->-1->'caseId','documentId',items.value->-1->'documentId') ELSE NULL END) INTO result FROM items;
 RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.personnel_completion_recovery_candidates(uuid,text,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.personnel_completion_recovery_candidates(uuid,text,integer) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.personnel_completion_recovery_result(outcome text,candidate jsonb,fingerprint text,run_ids jsonb,reason text,proof jsonb DEFAULT '[]'::jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_strip_nulls(jsonb_build_object('outcome',outcome,'candidate',candidate,'sourceFingerprint',fingerprint,'runIds',run_ids,'reason',reason,
 'runs',coalesce((SELECT jsonb_agg(jsonb_build_object('id',item->'run'->>'id','stepId',item->'run'->'definition'->'steps'->((item->'run'->>'cursor')::integer)->>'id','dueOn',item->>'dueOn')) FROM jsonb_array_elements(proof) item),'[]'::jsonb),
 'reviewHash',app.personnel_completion_recovery_hash(jsonb_build_object('outcome',outcome,'candidate',candidate,'sourceFingerprint',fingerprint,'runIds',run_ids,'reason',reason,'proof',proof,'actor',app.current_user_id(),'day',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,
 'grants',(SELECT jsonb_agg(jsonb_build_object('role',g.role,'companyId',g.company_id) ORDER BY g.role,g.company_id) FROM app.current_grants() g)))))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.personnel_completion_recovery_result(text,jsonb,text,jsonb,text,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.personnel_completion_recovery_due(anchor text,days integer,working boolean) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE day date;remaining integer;direction integer;
BEGIN
 IF anchor IS NULL OR anchor!~'^\d{4}-\d{2}-\d{2}$' OR days IS NULL OR abs(days)>3660 THEN RETURN NULL;END IF;
 BEGIN day:=anchor::date;EXCEPTION WHEN OTHERS THEN RETURN NULL;END;
 IF to_char(day,'YYYY-MM-DD')<>anchor THEN RETURN NULL;END IF;
 IF NOT coalesce(working,false) THEN RETURN to_char(day+days,'YYYY-MM-DD');END IF;
 remaining:=abs(days);direction:=CASE WHEN days<0 THEN -1 ELSE 1 END;
 WHILE remaining>0 LOOP day:=day+direction;IF extract(isodow FROM day)<=5 THEN remaining:=remaining-1;END IF;END LOOP;
 RETURN to_char(day,'YYYY-MM-DD');
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.personnel_completion_recovery_due(text,integer,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.personnel_completion_recovery_review(candidate jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ctx jsonb;d jsonb;state jsonb;source jsonb;official jsonb;values_now jsonb;field jsonb;run jsonb;step jsonb;v_trigger jsonb;hold jsonb;publication boolean;fingerprint text;run_ids jsonb:='[]';proof jsonb:='[]';due text;anchor text;old_facts jsonb;old_run jsonb;at_day text:=to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','YYYY-MM-DD');outcome text:='eligible';missing_personal boolean:=false;has_today boolean:=false;v_case_id uuid;v_company_id uuid;document_id text;
BEGIN
 IF jsonb_typeof(candidate) IS DISTINCT FROM 'object' OR NOT candidate?&ARRAY['tenantId','caseId','companyId','revision','documentId','documentHash','contextHash'] OR octet_length(candidate::text)>4096 OR candidate-ARRAY['tenantId','caseId','companyId','revision','documentId','documentHash','contextHash']<>'{}'::jsonb
 OR candidate->>'revision'!~'^[0-9]+$' OR candidate->>'documentHash'!~'^[a-f0-9]{64}$' OR candidate->>'contextHash'!~'^[a-f0-9]{64}$' OR length(coalesce(candidate->>'documentId','')) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Invalid completion recovery candidate' USING ERRCODE='22023';END IF;
 BEGIN v_case_id:=(candidate->>'caseId')::uuid;v_company_id:=(candidate->>'companyId')::uuid;EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid completion recovery identity' USING ERRCODE='22023';END;
 IF candidate->>'tenantId' IS DISTINCT FROM app.current_tenant_id()::text OR NOT app.v9_signing_current_actor() OR nullif(current_setting('app.agent_principal_id',true),'') IS NOT NULL OR NOT app.is_admin_for(v_company_id) OR NOT app.probation_company_entitled(v_company_id) THEN RAISE EXCEPTION 'Full current HR case authority is required' USING ERRCODE='42501';END IF;
 document_id:=candidate->>'documentId';ctx:=app.personnel_completion_recovery_context(v_case_id,document_id);
 IF ctx IS NULL OR ctx->'candidate'->>'companyId' IS DISTINCT FROM v_company_id::text THEN RETURN app.personnel_completion_recovery_result('changed',candidate,NULL,'[]','The saved case or document is no longer available.');END IF;
 IF CASE WHEN (ctx->>'native')::boolean THEN NOT (app.onboarding_page_access() OR app.onboarding_v9_case_actor() OR app.is_group_admin()) ELSE NOT app.lc_v9_off_access(v_company_id) END THEN RAISE EXCEPTION 'Full current lifecycle HR access is required' USING ERRCODE='42501';END IF;
 d:=ctx->'document';state:=ctx->'state';
 IF d?'personnelCompletion' THEN RETURN app.personnel_completion_recovery_result(CASE WHEN jsonb_typeof(d->'personnelCompletion')='object' AND d->'personnelCompletion'->>'version'='1' THEN 'alreadyAdopted' ELSE 'manualReview' END,candidate,NULL,'[]','This document already has saved completion ownership and is not a legacy adoption target.');END IF;
 IF ctx->'candidate' IS DISTINCT FROM candidate THEN RETURN app.personnel_completion_recovery_result('changed',candidate,NULL,'[]','The saved document, workflow or delivery references changed.');END IF;
 IF state->>'state' IS DISTINCT FROM 'submitted' OR d->>'status' IS DISTINCT FROM 'draft' OR d->>'sentAt' IS NOT NULL OR app.personnel_completion_locked(d)
 OR d->'employeeSignature' IS NOT NULL AND d->'employeeSignature'<>'null'::jsonb OR d->'hrSignature' IS NOT NULL AND d->'hrSignature'<>'null'::jsonb
 OR EXISTS(SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(d->'stepSignatures')='object' THEN d->'stepSignatures' ELSE '{}'::jsonb END)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(d->'signing'->'actions','[]'::jsonb)) a WHERE a->>'action'='signed') THEN RETURN app.personnel_completion_recovery_result('manualReview',candidate,NULL,'[]','Only an unsigned unreleased saved draft can adopt completion.');END IF;
 IF jsonb_typeof(d->'signing')='object' AND NOT app.document_signing_can_edit(d->'signing',app.current_user_id()) THEN RETURN app.personnel_completion_recovery_result('manualReview',candidate,NULL,'[]','The current routed content owner must review this document.');END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(state->'mails','[]'::jsonb)) m WHERE coalesce(m->>'test','false')<>'true' AND (m->'documentIds'?document_id OR m->'delivery'->'linkDocumentIds'?document_id OR m->'delivery'->'pdfDocumentIds'?document_id))
 OR EXISTS(SELECT 1 FROM public.lc_v9_email_delivery j WHERE j.tenant_id=app.current_tenant_id() AND coalesce(j.case_id,j.onboarding_case_id)=v_case_id AND coalesce(j.payload->'mail'->>'test','false')<>'true' AND (j.payload->'mail'->'documentIds'?document_id OR j.payload->'mail'->'delivery'->'linkDocumentIds'?document_id OR j.payload->'mail'->'delivery'->'pdfDocumentIds'?document_id)) THEN RETURN app.personnel_completion_recovery_result('manualReview',candidate,NULL,'[]','A captured email references this document. Review its delivery receipt.');END IF;
 SELECT EXISTS(SELECT 1 FROM (SELECT data FROM public.lc_v9_config WHERE tenant_id=app.current_tenant_id() UNION ALL SELECT data FROM public.lc_v9_config_revision WHERE tenant_id=app.current_tenant_id()) cfg
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(cfg.data->'templates','[]'::jsonb)) t CROSS JOIN LATERAL jsonb_array_elements(coalesce(t->'versions','[]'::jsonb)) v
 WHERE t->>'id'=d->>'templateId' AND t->>'module'=CASE WHEN (ctx->>'native')::boolean THEN 'onb' ELSE 'off' END AND v->'version'=d->'version' AND v->>'state'='published' AND v->'fields'=d->'fields' AND v->'blocks'=d->'blocks') INTO publication;
 IF NOT publication THEN RETURN app.personnel_completion_recovery_result('manualReview',candidate,NULL,'[]','The frozen fields and blocks cannot be proved against a saved published version.');END IF;
 source:=app.v9_document_personnel_values(v_case_id);
 IF source IS NULL OR coalesce(source->>'_country','')='' OR source->>'_identityFieldsWithheld'='true' AND EXISTS(SELECT 1 FROM jsonb_array_elements(d->'fields') f WHERE f->>'owner'='pmLocked' AND f->>'pmKey' IN('personalEmail','employee.icNo','employee.passportNo')) THEN RETURN app.personnel_completion_recovery_result('manualReview',candidate,NULL,'[]','The authorized current Personnel source or protected-field authority is unavailable.');END IF;
 official:=app.personnel_completion_official(d,source);fingerprint:=app.personnel_completion_fingerprint(official,source->>'_country');values_now:=coalesce(d->'values','{}'::jsonb)||official;
 FOR field IN SELECT f FROM jsonb_array_elements(d->'fields') f LOOP
  IF field->>'owner'='pmLocked' AND btrim(coalesce(official->>(field->>'id'),''))<>'' THEN BEGIN PERFORM app.personnel_completion_scalar(field,official->>(field->>'id'));EXCEPTION WHEN raise_exception OR invalid_text_representation THEN RETURN app.personnel_completion_recovery_result('manualReview',candidate,fingerprint,'[]','A current official value does not meet the saved field validation.');END;END IF;
  IF field->>'owner'='pmLocked' AND btrim(coalesce(official->>(field->>'id'),''))='' AND btrim(coalesce(d->'values'->>(field->>'id'),''))<>'' THEN RETURN app.personnel_completion_recovery_result('manualReview',candidate,fingerprint,'[]','A saved case answer has no matching official source. HR must resolve it first.');END IF;
  IF field->'when' IS NOT NULL AND field->'when'<>'null'::jsonb AND values_now->>(field->'when'->>'field') IS DISTINCT FROM field->'when'->>'value' THEN CONTINUE;END IF;
  IF field->>'owner'='pmLocked' AND btrim(coalesce(official->>(field->>'id'),''))='' THEN
   IF app.personnel_completion_group(field->>'pmKey') IS DISTINCT FROM 'personal' THEN RETURN app.personnel_completion_recovery_result('manualReview',candidate,fingerprint,'[]','Missing employment or unclassified Personnel values require HR review.');END IF;
   IF field->>'required'='true' THEN missing_personal:=true;END IF;
  ELSIF field->>'owner'='hr' AND field->>'required'='true' AND (btrim(coalesce(values_now->>(field->>'id'),''))='' OR field->>'type'='checkbox' AND values_now->>(field->>'id') IS DISTINCT FROM 'true' OR field->>'type'='table' AND values_now->>(field->>'id')='[]') THEN RETURN app.personnel_completion_recovery_result('manualReview',candidate,fingerprint,'[]','A separate required HR answer is still missing.');END IF;
 END LOOP;
 IF NOT missing_personal THEN RETURN app.personnel_completion_recovery_result('manualReview',candidate,fingerprint,'[]','No required missing personal field explains this wait.');END IF;
 FOR run IN SELECT r FROM jsonb_array_elements(coalesce(state->'runs','[]'::jsonb)) r WHERE r->>'status'='waiting' LOOP
  IF run->>'cursor'!~'^[0-9]{1,4}$' OR jsonb_typeof(run->'definition') IS DISTINCT FROM 'object' THEN CONTINUE;END IF;
  step:=run->'definition'->'steps'->((run->>'cursor')::integer);
  IF step->>'type' IS DISTINCT FROM 'doc' OR step->>'release' IS DISTINCT FROM 'true' OR step->>'template' IS DISTINCT FROM d->>'templateId' THEN CONTINUE;END IF;
  IF run->'hold' IS NOT NULL OR run->'lateEmail' IS NOT NULL OR run->'resumeOn' IS NOT NULL THEN RETURN app.personnel_completion_recovery_result('manualReview',candidate,fingerprint,run_ids,'This run also has another saved hold or resume instruction.');END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(state->'documents','[]'::jsonb)) other WHERE other->>'templateId'=d->>'templateId' AND other->>'id'<>document_id AND other->>'status' NOT IN('withdrawn','superseded')) THEN RETURN app.personnel_completion_recovery_result('manualReview',candidate,fingerprint,run_ids,'More than one active document matches the held step.');END IF;
  hold:=run->'completionHold';old_facts:=NULL;old_run:=NULL;v_trigger:=run->'definition'->'trigger';
  IF jsonb_typeof(hold)='object' THEN
   IF hold->>'documentId' IS DISTINCT FROM document_id OR hold->>'stepId' IS DISTINCT FROM step->>'id' THEN RETURN app.personnel_completion_recovery_result('manualReview',candidate,fingerprint,run_ids,'The saved completion hold belongs to another document step.');END IF;
   due:=hold->>'dueOn';
  ELSIF coalesce(v_trigger->>'repeat','false')='true' OR v_trigger->>'event' NOT IN('beforeJoin','afterJoin','beforeLWD','afterLWD') THEN due:=run->>'date';
  ELSE
   -- Legacy dates need the retained waiting snapshot, not today's corrected Personnel anchor.
   IF (ctx->>'native')::boolean THEN
    SELECT jsonb_build_object('joinDate',coalesce(r.data->'source'->>'joinDate',public_revision.data->'source'->>'joinDate',public_revision.data->'local'->>'joinDate'),'lastDay',''),prior INTO old_facts,old_run FROM public.lc_onboarding_private_revision r JOIN public.lc_onboarding_case_revision public_revision ON public_revision.case_id=r.case_id AND public_revision.tenant_id=r.tenant_id AND public_revision.revision=r.revision CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.data->'lifecycleV9'->'runs','[]'::jsonb)) prior
    WHERE r.tenant_id=app.current_tenant_id() AND r.case_id=v_case_id AND prior->>'id'=run->>'id' AND prior->>'status'='waiting' AND prior->'cursor'=run->'cursor' AND prior->'definition'=run->'definition' ORDER BY r.revision LIMIT 1;
   ELSE
    SELECT r.data->'facts',prior INTO old_facts,old_run FROM public.lc_v9_case_revision r CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.data->'runs','[]'::jsonb)) prior
    WHERE r.tenant_id=app.current_tenant_id() AND r.case_id=v_case_id AND prior->>'id'=run->>'id' AND prior->>'status'='waiting' AND prior->'cursor'=run->'cursor' AND prior->'definition'=run->'definition' ORDER BY r.revision LIMIT 1;
   END IF;
   anchor:=old_facts->>CASE WHEN v_trigger->>'event' IN('beforeLWD','afterLWD') THEN 'lastDay' ELSE 'joinDate' END;
   due:=app.personnel_completion_recovery_due(anchor,CASE WHEN v_trigger->>'days'~'^-?[0-9]{1,4}$' THEN (v_trigger->>'days')::integer*CASE WHEN v_trigger->>'event' IN('afterJoin','afterLWD') THEN 1 ELSE -1 END END,coalesce(v_trigger->>'workdays','false')='true');
  END IF;
  IF due IS NULL OR app.personnel_completion_recovery_due(due,0,false) IS NULL THEN RETURN app.personnel_completion_recovery_result('manualReview',candidate,fingerprint,run_ids,'The original due date cannot be proved from the saved waiting run.');END IF;
  run_ids:=run_ids||jsonb_build_array(run->>'id');proof:=proof||jsonb_build_array(jsonb_build_object('run',run,'dueOn',due,'legacyFacts',old_facts,'legacyRun',old_run));
  IF due<at_day THEN outcome:='late';ELSIF due=at_day THEN has_today:=true;END IF;
 END LOOP;
 IF jsonb_array_length(run_ids)=0 THEN RETURN app.personnel_completion_recovery_result('manualReview',candidate,fingerprint,run_ids,'No frozen waiting document-release step matches this document.');END IF;
 IF outcome<>'late' THEN outcome:=CASE WHEN has_today THEN 'eligible' ELSE 'future' END;END IF;
 RETURN app.personnel_completion_recovery_result(outcome,candidate,fingerprint,run_ids,CASE outcome WHEN 'eligible' THEN 'Only missing personal values hold this saved draft.' WHEN 'future' THEN 'The original workflow due date is still in the future.' ELSE 'The original workflow is overdue and needs a separate HR decision.' END,proof);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.personnel_completion_recovery_review(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.personnel_completion_recovery_review(jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.personnel_completion_recovery_adopt(review jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE fresh jsonb;candidate jsonb;v_case_id uuid;v_company_id uuid;v_employment_id uuid;v_person_id uuid;v_draft_id uuid;native boolean;v_revision integer;
BEGIN
 IF jsonb_typeof(review) IS DISTINCT FROM 'object' OR octet_length(review::text)>2097152 OR review->>'outcome' NOT IN('eligible','future','late') THEN RAISE EXCEPTION 'Choose an eligible reviewed completion target' USING ERRCODE='22023';END IF;
 candidate:=review->'candidate';fresh:=app.personnel_completion_recovery_review(candidate);
 IF fresh IS DISTINCT FROM review OR fresh->>'outcome' NOT IN('eligible','future','late') THEN RAISE EXCEPTION 'The recovery review changed. Preview again' USING ERRCODE='40001';END IF;
 v_case_id:=(candidate->>'caseId')::uuid;v_company_id:=(candidate->>'companyId')::uuid;
 -- Match the canonical command's lock order, then freeze the exact source rows before repeating
 -- its guarded one-target review. No source values are projected by this function.
 PERFORM app.access_workforce_write_lock();PERFORM pg_advisory_xact_lock(hashtext('audit-chain:'||app.current_tenant_id()::text));PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':onboarding',0));PERFORM pg_advisory_xact_lock(hashtextextended('lifecycle-v9:'||app.current_tenant_id()::text,0));
 SELECT c.employment_id,false INTO v_employment_id,native FROM public.lc_v9_case c WHERE c.id=v_case_id AND c.tenant_id=app.current_tenant_id() AND c.company_id=v_company_id FOR UPDATE;
 IF NOT FOUND THEN
  SELECT c.employment_id,c.source_draft_id,true INTO v_employment_id,v_draft_id,native FROM public.lc_onboarding_case c WHERE c.id=v_case_id AND c.tenant_id=app.current_tenant_id() AND c.company_id=v_company_id FOR UPDATE;
  PERFORM 1 FROM public.lc_onboarding_private p WHERE p.case_id=v_case_id AND p.tenant_id=app.current_tenant_id() FOR UPDATE;
 END IF;
 IF native IS NULL THEN RAISE EXCEPTION 'The recovery case is no longer available' USING ERRCODE='40001';END IF;
 PERFORM 1 FROM public.company co WHERE co.id=v_company_id AND co.tenant_id=app.current_tenant_id() FOR SHARE;
 PERFORM 1 FROM public.lc_v9_config cfg WHERE cfg.tenant_id=app.current_tenant_id() FOR SHARE;
 IF v_employment_id IS NOT NULL THEN
  SELECT e.person_id INTO v_person_id FROM public.employment e WHERE e.id=v_employment_id AND e.tenant_id=app.current_tenant_id() AND e.company_id=v_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'The current Personnel employer changed' USING ERRCODE='40001';END IF;
  PERFORM 1 FROM public.person p WHERE p.id=v_person_id AND p.tenant_id=app.current_tenant_id() FOR UPDATE;
  PERFORM 1 FROM public.employee_statutory_my st WHERE st.person_id=v_person_id AND st.tenant_id=app.current_tenant_id() FOR SHARE;
  PERFORM 1 FROM public.assignment a WHERE a.employment_id=v_employment_id AND a.tenant_id=app.current_tenant_id() FOR SHARE;
  PERFORM 1 FROM public.reporting_line r WHERE r.subordinate_employment_id=v_employment_id AND r.tenant_id=app.current_tenant_id() FOR SHARE;
  PERFORM 1 FROM public.department d JOIN public.assignment a ON a.department_id=d.id AND a.tenant_id=d.tenant_id WHERE a.employment_id=v_employment_id AND d.tenant_id=app.current_tenant_id() FOR SHARE OF d;
  PERFORM 1 FROM public.position p JOIN public.assignment a ON a.position_id=p.id AND a.tenant_id=p.tenant_id WHERE a.employment_id=v_employment_id AND p.tenant_id=app.current_tenant_id() FOR SHARE OF p;
  PERFORM 1 FROM public.person p JOIN public.employment manager ON manager.person_id=p.id AND manager.tenant_id=p.tenant_id JOIN public.reporting_line r ON r.manager_employment_id=manager.id AND r.tenant_id=manager.tenant_id WHERE r.subordinate_employment_id=v_employment_id AND p.tenant_id=app.current_tenant_id() ORDER BY p.id FOR SHARE OF p;
 ELSE
  PERFORM 1 FROM public.employee_draft d WHERE d.id=v_draft_id AND d.tenant_id=app.current_tenant_id() AND d.company_id=v_company_id FOR UPDATE;
 END IF;
 fresh:=app.personnel_completion_recovery_review(candidate);
 IF fresh IS DISTINCT FROM review OR fresh->>'outcome' NOT IN('eligible','future','late') THEN RAISE EXCEPTION 'The document, due-date proof, authority or current Personnel source changed. Preview again' USING ERRCODE='40001';END IF;
 v_revision:=app.v9_personnel_completion_update(v_case_id,(candidate->>'revision')::integer,candidate->>'documentId','{}'::jsonb,'adopt',NULL);
 RETURN v_revision;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.personnel_completion_recovery_adopt(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.personnel_completion_recovery_adopt(jsonb) TO ai_hr_app;
