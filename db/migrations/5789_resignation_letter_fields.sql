-- UNALLOCATED DRAFT for reserved5789; team replacements retain5788 protections.
CREATE OR REPLACE FUNCTION app.resignation_command_allowed(p_id uuid,p_command jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j resignation_journey;u app_user;l jsonb;s jsonb;owner_id text;is_owner boolean;field_values jsonb;mine boolean;holding boolean;opened boolean;k text:=p_command->>'type';w jsonb;layer jsonb;
BEGIN
 SELECT * INTO j FROM resignation_journey WHERE tenant_id=app.current_tenant_id() AND id=p_id;
 IF NOT FOUND THEN RETURN false;END IF;
 IF k='sweep' THEN RETURN app.current_user_id() IS NULL AND app.acting_as_owner();END IF;
 IF k='postingOutcome' THEN RETURN EXISTS(SELECT 1 FROM personnel_posting p WHERE p.tenant_id=j.tenant_id AND p.id=(p_command->>'postingId')::uuid AND p.source IN('off','offboarding') AND p.source_ref=j.id AND p.employment_id=j.employment_id AND p.company_id=j.company_id AND p.status=p_command->>'outcome' AND p.status IN('approved','rejected') AND (p.status='approved' AND p.approved_by=app.current_user_id() OR p.status='rejected' AND to_jsonb(p)->>'rejected_by'=app.current_user_id()::text OR app.current_user_id() IS NULL AND app.acting_as_owner()));END IF;
 SELECT * INTO u FROM app_user WHERE id=app.current_user_id() AND tenant_id=j.tenant_id AND archived_at IS NULL AND NOT app.login_blocked(id);
 IF u.id IS NULL OR NOT app.resignation_journey_access(p_id) THEN RETURN false;END IF;
 IF k='withdraw' THEN RETURN u.person_id=j.person_id AND j.stage IN('decision','retention');
 ELSIF k IN('accept','offer') THEN RETURN j.stage='decision' AND u.person_id IS DISTINCT FROM j.person_id AND j.data->'decision'->'to' ? u.id::text AND (k='accept' OR j.data->'decision'->>'choices'='both' AND NOT coalesce((j.data->>'offerLocked')::boolean,false));
 ELSIF k='comment' THEN RETURN app.resignation_journey_can_act(p_id,'comment');
 ELSIF k='retry' THEN RETURN app.resignation_journey_can_act(p_id,'retry');
 ELSIF k='runWorkflowsAgain' THEN RETURN app.resignation_journey_can_act(p_id,'runAgain');
 ELSIF k='completeReplacement' THEN RETURN j.data->'replacementRequest'->>'status'='requested' AND j.data->'replacementRequest'->>'id'=p_command->>'taskId' AND j.data->'replacementRequest'->'to' ? u.id::text;
 ELSIF k='taskProgress' THEN RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'tasks','[]')) t WHERE t->>'id'=p_command->>'taskId' AND t->'userIds' ? u.id::text AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) task_letter WHERE split_part(t->>'id',':',1)=task_letter->>'id' AND NOT(task_letter->>'state'='owner' AND t->>'id'=(task_letter->>'id')||':update' AND app.resignation_letter_owner_mine(task_letter) OR task_letter->>'state'='review' AND EXISTS(SELECT 1 FROM app.resignation_pending_steps(task_letter) task_step WHERE t->>'id'=(task_letter->>'id')||':'||(task_step->>'id') AND app.resignation_letter_step_mine(task_letter,task_step)))));
 ELSIF k='uploadFile' THEN RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'waits','[]')) upload_wait WHERE upload_wait->>'id'=p_command->>'taskId' AND upload_wait->>'kind'='file' AND upload_wait->'to' ? u.id::text);
 ELSIF k='approvalTask' THEN
  FOR w IN SELECT x FROM jsonb_array_elements(coalesce(j.data->'waits','[]')) x WHERE x->>'kind'='approval' LOOP
   SELECT x INTO layer FROM jsonb_array_elements(coalesce(w->'layers','[]')) x WHERE NOT coalesce((x->>'done')::boolean,false) LIMIT 1;
   IF layer->>'id'=p_command->>'taskId' AND layer->'to' ? u.id::text AND (layer->>'action'=p_command->>'action' OR p_command->>'action'='reject' AND length(btrim(coalesce(p_command->>'comment',''))) BETWEEN 1 AND 4000) THEN RETURN true;END IF;
  END LOOP;RETURN false;
 END IF;
 IF k='updateEmail' THEN
  RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) letter_email WHERE app.resignation_letter_owner_mine(letter_email) AND letter_email->>'state' IN('review','owner') AND (letter_email->>'state'='owner' OR EXISTS(SELECT 1 FROM app.resignation_pending_steps(letter_email) pending_email WHERE app.resignation_letter_step_mine(letter_email,pending_email))) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(letter_email->'document'->'actions') email_receipt WHERE email_receipt->>'action'='signed' AND email_receipt->>'contentRevision'=letter_email->>'revision'));
 END IF;
 SELECT x INTO l FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) x WHERE x->>'id'=p_command->>'documentId';
 IF l IS NULL OR l->>'revision' IS DISTINCT FROM p_command->>'documentRevision' THEN RETURN false;END IF;
 is_owner:=app.resignation_letter_owner_mine(l);
 SELECT x INTO s FROM app.resignation_pending_steps(l) x WHERE app.resignation_letter_step_mine(l,x) LIMIT 1;mine:=s IS NOT NULL;holding:=coalesce(is_owner AND (l->>'state'='owner' OR mine),false);opened:=coalesce(l->'openedBy'->>u.id::text=l->>'revision',false);
 IF k='openLetter' THEN RETURN l->>'state' IN('review','owner','released') AND (is_owner OR mine OR l->>'state'='released' AND (l->>'employeeUserId'=u.id::text OR EXISTS(SELECT 1 FROM jsonb_array_elements(l->'document'->'route'->'steps') x WHERE app.resignation_letter_step_mine(l,x))) OR EXISTS(SELECT 1 FROM jsonb_array_elements(l->'history') a WHERE a->>'actorId'=u.id::text));END IF;
 IF (l->>'state' IN('review','owner')) IS NOT TRUE THEN RETURN false;END IF;
 IF k='saveLetterFields' THEN SELECT coalesce(jsonb_object_agg(field->>'id',coalesce(l->'mergeValues'->>coalesce(field->>'pmKey',field->>'id'),'')),'{}'::jsonb)||(p_command->'values') INTO field_values FROM jsonb_array_elements(coalesce(l->'fields','[]')) field; RETURN (mine OR l->>'state'='owner' AND is_owner) AND jsonb_typeof(p_command->'values')='object' AND (SELECT count(*) FROM jsonb_object_keys(p_command->'values')) BETWEEN 1 AND 200 AND NOT EXISTS(SELECT 1 FROM jsonb_each(p_command->'values') supplied(id,value) WHERE jsonb_typeof(value) IS DISTINCT FROM 'string' OR length(value #>> '{}')>100000 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(l->'fields','[]')) field WHERE field->>'id'=supplied.id AND supplied.id !~ '^(employee|retention|resignation|company|org|letter|signer)[.]' AND supplied.id NOT IN('today','companyName','acknowledgedBy','acknowledgedOn') AND field->>'owner'=CASE WHEN l->>'employeeUserId'=u.id::text THEN 'employee' ELSE 'hr' END AND (field->'pmKey' IS NULL OR field->'pmKey'='null'::jsonb) AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(l->'blocks','[]')) block WHERE block->>'type'='field' AND block->>'fieldId'=field->>'id' OR block->>'type'='fields' AND block->>'section'=field->>'section') AND (field->'when' IS NULL OR field->'when'='null'::jsonb OR field_values->>(field->'when'->>'field')=field->'when'->>'value')));
 ELSIF k='letterAction' THEN RETURN mine AND l->>'state'='review' AND s->>'kind'=p_command->>'action' AND (l->>'employeeUserId'<>u.id::text OR opened) AND (p_command->>'action'<>'sign' OR p_command->>'consent'='true' AND length(coalesce(p_command->>'signature','')) BETWEEN 1 AND 100000);
 ELSIF k='sendBack' THEN RETURN mine AND NOT is_owner AND (l->>'employeeUserId'<>u.id::text OR opened) AND length(btrim(coalesce(p_command->>'reason',''))) BETWEEN 1 AND 4000;
 ELSIF k='recall' THEN RETURN is_owner AND NOT holding AND EXISTS(SELECT 1 FROM app.resignation_pending_steps(l));
 ELSIF k='updateLetter' THEN RETURN (holding OR mine AND s->>'kind'='review') AND (NOT(p_command ?| ARRAY['lastWorkingDay','reason']) OR holding) AND (NOT(p_command ? 'blocks') OR (l->>'state'='owner' AND is_owner OR mine AND s->>'kind'='review') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(l->'document'->'actions') a WHERE a->>'action'='signed' AND a->>'contentRevision'=l->>'revision'));
 ELSIF k='regenerateLetter' THEN RETURN is_owner AND (l->>'state'='owner' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(l->'document'->'actions','[]')) WITH ORDINALITY a(receipt,n) WHERE receipt->>'action'='signed' AND receipt->>'contentRevision'=l->'document'->>'contentRevision' AND receipt->>'contentHash'=l->'document'->>'contentHash' AND n>coalesce((SELECT max(rn) FROM jsonb_array_elements(coalesce(l->'document'->'actions','[]')) WITH ORDINALITY r(ra,rn) WHERE ra->>'action'='resent' AND ra->>'contentRevision'=l->'document'->>'contentRevision' AND ra->>'contentHash'=l->'document'->>'contentHash'),0))) AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'waits','[]')) regenerate_wait JOIN automation_run generating_run ON generating_run.tenant_id=j.tenant_id AND generating_run.id::text=regenerate_wait->>'runId' AND generating_run.module='off' AND generating_run.subject_id=j.id AND generating_run.status='waiting' AND generating_run.waiting_for::text=l->>'id' WHERE regenerate_wait->>'kind'='letter' AND regenerate_wait->>'documentId'=l->>'id');
 ELSIF k='resendLetter' THEN RETURN l->>'state'='owner' AND is_owner;
 ELSIF k='withdrawOffer' THEN RETURN l->>'state'='owner' AND l->>'kind'='retention' AND is_owner AND length(btrim(coalesce(p_command->>'reason',''))) BETWEEN 1 AND 4000;
 ELSIF k='declineOffer' THEN RETURN l->>'kind'='retention' AND l->>'employeeUserId'=u.id::text AND mine AND opened;
 END IF;RETURN false;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.resignation_journey_save(p_id uuid,p_revision integer,p_action text,p_stage text,p_data jsonb,p_participants uuid[],p_offboarding uuid DEFAULT NULL) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j resignation_journey;proof jsonb;intent jsonb;k text;
BEGIN
 proof:=app.resignation_runtime_consume('save',p_id,jsonb_build_object('id',p_id,'revision',p_revision,'action',p_action,'stage',p_stage,'data',p_data,'participants',to_jsonb(p_participants),'offboarding',p_offboarding));
 SELECT payload INTO intent FROM app.resignation_runtime_state WHERE tenant_id=app.current_tenant_id() AND actor=coalesce(app.current_user_id()::text,'worker') AND kind='intent:'||p_id::text AND transaction_id=txid_current();k:=intent->'command'->>'type';
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO j FROM resignation_journey WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR intent IS NULL THEN RAISE EXCEPTION 'This resignation action is not assigned to you' USING ERRCODE='42501';END IF;
 IF j.revision<>p_revision THEN RAISE EXCEPTION 'This resignation changed; reload before acting' USING ERRCODE='40001';END IF;
 IF jsonb_typeof(p_data)<>'object' OR NOT (p_data->>'lastWorkingDay' ~ '^\d{4}-\d{2}-\d{2}$') OR length(coalesce(p_data->>'reason',''))>4000 OR cardinality(p_participants)>1000 THEN RAISE EXCEPTION 'Invalid resignation details' USING ERRCODE='22023';END IF;
 -- HMAC authenticates derivation; native invariants retain identity, scope, history and command authority.
 IF p_data->'facts' IS DISTINCT FROM j.data->'facts' THEN RAISE EXCEPTION 'Frozen subject facts cannot change' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM unnest(p_participants) uid WHERE NOT(uid=ANY(j.participant_ids)) AND NOT EXISTS(SELECT 1 FROM app_user u WHERE u.tenant_id=j.tenant_id AND u.id=uid AND u.archived_at IS NULL)) THEN RAISE EXCEPTION 'Invalid case participant' USING ERRCODE='42501';END IF;
 IF p_offboarding IS NOT NULL AND NOT EXISTS(SELECT 1 FROM lc_v9_case c WHERE c.tenant_id=j.tenant_id AND c.id=p_offboarding AND c.company_id=j.company_id AND c.employment_id=j.employment_id AND c.module='off' AND c.data->>'resignationSourceCaseId'=j.id::text) THEN RAISE EXCEPTION 'Invalid clearance case' USING ERRCODE='42501';END IF;
 IF j.offboarding_case_id IS NOT NULL AND p_offboarding IS DISTINCT FROM j.offboarding_case_id THEN RAISE EXCEPTION 'Clearance link cannot be replaced' USING ERRCODE='42501';END IF;
 IF k='withdraw' AND p_stage<>'withdrawn' OR k='accept' AND p_stage NOT IN('accepted','leaving') OR k='offer' AND p_stage NOT IN('retention','offer') OR k IN('comment','taskProgress','updateEmail','openLetter','completeReplacement','runWorkflowsAgain') AND p_stage<>j.stage THEN RAISE EXCEPTION 'Command cannot make this transition' USING ERRCODE='42501';END IF;
 IF k='accept' AND (p_data->>'lastWorkingDay' IS DISTINCT FROM intent->'command'->>'lastWorkingDay' OR p_data->'replacementNeeded' IS DISTINCT FROM intent->'command'->'replacementNeeded') THEN RAISE EXCEPTION 'Decision values differ from the admitted command' USING ERRCODE='42501';END IF;
 IF k='offer' AND p_data->'offer' IS DISTINCT FROM (intent->'command'->'offer'||jsonb_build_object('position',btrim(intent->'command'->'offer'->>'position'))) THEN RAISE EXCEPTION 'Offer differs from the admitted command' USING ERRCODE='42501';END IF;
 IF k NOT IN('accept','updateLetter') AND (p_data->>'lastWorkingDay' IS DISTINCT FROM j.data->>'lastWorkingDay' OR p_data->>'reason' IS DISTINCT FROM j.data->>'reason') THEN RAISE EXCEPTION 'Only the holding owner can correct case details' USING ERRCODE='42501';END IF;
 IF k='updateLetter' AND ((intent->'command' ? 'lastWorkingDay' AND p_data->>'lastWorkingDay' IS DISTINCT FROM intent->'command'->>'lastWorkingDay') OR (intent->'command' ? 'reason' AND p_data->>'reason' IS DISTINCT FROM intent->'command'->>'reason')) THEN RAISE EXCEPTION 'Corrections differ from the admitted command' USING ERRCODE='42501';END IF;
 IF jsonb_array_length(coalesce(p_data->'offerSnapshots','[]'))<jsonb_array_length(coalesce(j.data->'offerSnapshots','[]')) OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'offerSnapshots','[]')) WITH ORDINALITY old(snapshot,n) WHERE p_data->'offerSnapshots'->((old.n-1)::integer) IS DISTINCT FROM old.snapshot) OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_data->'offerSnapshots','[]')) WITH ORDINALITY new(snapshot,n) WHERE new.n>jsonb_array_length(coalesce(j.data->'offerSnapshots','[]')) AND (k<>'offer' OR snapshot->'offer' IS DISTINCT FROM (intent->'command'->'offer'||jsonb_build_object('position',btrim(intent->'command'->'offer'->>'position'))) OR snapshot->'by'->>'id' IS DISTINCT FROM app.current_user_id()::text)) THEN RAISE EXCEPTION 'Retention offer snapshots are immutable command evidence' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) old WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_data->'letters','[]')) new WHERE new->>'id'=old->>'id')) THEN RAISE EXCEPTION 'Letter evidence cannot be removed' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_data->'letters','[]')) l WHERE l->'document'->>'tenantId' IS DISTINCT FROM j.tenant_id::text OR l->'document'->>'companyId' IS DISTINCT FROM j.company_id::text OR l->'document'->>'subjectId' IS DISTINCT FROM j.id::text OR l->'document'->>'subjectType' IS DISTINCT FROM 'resignation' OR (NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) prior WHERE prior->>'id'=l->>'id') OR k='regenerateLetter' AND l->>'id'=intent->'command'->>'documentId') AND EXISTS(SELECT 1 FROM jsonb_array_elements(l->'document'->'route'->'steps') s WHERE NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id::text=s->>'holderId' AND u.tenant_id=j.tenant_id AND u.person_id IS NOT NULL AND (NOT(s ? 'holderPersonId') OR u.person_id::text=s->>'holderPersonId') AND u.archived_at IS NULL))) THEN RAISE EXCEPTION 'Letter scope or recipient identity mismatch' USING ERRCODE='42501';END IF;
 IF k='saveLetterFields' AND p_stage IS DISTINCT FROM j.stage AND NOT(j.stage='offer' AND p_stage='retention' AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) old JOIN LATERAL jsonb_array_elements(coalesce(p_data->'letters','[]')) new ON new->>'id'=old->>'id' WHERE old->>'id'=intent->'command'->>'documentId' AND (new->>'revision')::integer>(old->>'revision')::integer AND new->'mergeValues' IS DISTINCT FROM old->'mergeValues' AND EXISTS(SELECT 1 FROM app.resignation_pending_steps(old) pending WHERE pending->>'holderId'=old->>'employeeUserId') AND NOT EXISTS(SELECT 1 FROM app.resignation_pending_steps(new) pending WHERE pending->>'holderId'=new->>'employeeUserId') AND EXISTS(SELECT 1 FROM jsonb_array_elements(old->'document'->'actions') signed WHERE signed->>'action'='signed' AND signed->>'contentRevision'=old->'document'->>'contentRevision' AND signed->>'contentHash'=old->'document'->>'contentHash'))) THEN RAISE EXCEPTION 'Form fields cannot complete a resignation decision or signature' USING ERRCODE='42501';END IF;
 -- Local form values are distinct from immutable mapped Personnel source values and pinned definitions.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) old JOIN LATERAL jsonb_array_elements(coalesce(p_data->'letters','[]')) new ON new->>'id'=old->>'id' WHERE new->'fields' IS DISTINCT FROM old->'fields' AND NOT(k='regenerateLetter' AND old->>'id'=intent->'command'->>'documentId')) THEN RAISE EXCEPTION 'Pinned letter field definitions cannot change' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) old JOIN LATERAL jsonb_array_elements(coalesce(p_data->'letters','[]')) new ON new->>'id'=old->>'id' WHERE coalesce(new->'fieldValues','{}') IS DISTINCT FROM coalesce(old->'fieldValues','{}') AND NOT(k='regenerateLetter' AND old->>'id'=intent->'command'->>'documentId') AND (k<>'saveLetterFields' OR old->>'id' IS DISTINCT FROM intent->'command'->>'documentId' OR coalesce(new->'fieldValues','{}') IS DISTINCT FROM coalesce(old->'fieldValues','{}')||(intent->'command'->'values'))) OR k='saveLetterFields' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) old JOIN LATERAL jsonb_array_elements(coalesce(p_data->'letters','[]')) new ON new->>'id'=old->>'id' WHERE old->>'id'=intent->'command'->>'documentId' AND coalesce(new->'fieldValues','{}')=coalesce(old->'fieldValues','{}')||(intent->'command'->'values') AND new->'state'=old->'state' AND new->'blocks'=old->'blocks' AND ((new->'mergeValues')-ARRAY(SELECT jsonb_object_keys(intent->'command'->'values')))=((old->'mergeValues')-ARRAY(SELECT jsonb_object_keys(intent->'command'->'values'))) AND NOT EXISTS(SELECT 1 FROM jsonb_each(intent->'command'->'values') value(id,text_value) WHERE new->'mergeValues'->id IS DISTINCT FROM text_value)) THEN RAISE EXCEPTION 'Letter field values must match the admitted local edits' USING ERRCODE='42501';END IF;
 -- Start Offboarding is derived from the exact pinned run, never a caller-selected case type.
 IF p_data->'offboardingStart' IS DISTINCT FROM j.data->'offboardingStart' AND NOT EXISTS(SELECT 1 FROM automation_run run JOIN automation_workflow_version version ON version.tenant_id=run.tenant_id AND version.workflow_id=run.workflow_id AND version.revision=run.workflow_revision AND version.module='off' CROSS JOIN LATERAL jsonb_array_elements(coalesce(version.definition->'steps','[]')) step WHERE run.tenant_id=j.tenant_id AND run.subject_id=j.id AND run.module='off' AND run.id::text=p_data->'offboardingStart'->>'runId' AND step->>'id'=p_data->'offboardingStart'->>'stepId' AND step->>'type'='startOffboarding' AND coalesce(nullif(step->'params'->>'exitReason',''),'Resignation')=p_data->'offboardingStart'->>'exitReason' AND coalesce(nullif(step->'params'->>'exitReason',''),'Resignation') IN('Resignation','Termination','Contract end','Retirement','Non-confirmation') AND p_stage IN('accepted','leaving') AND j.offboarding_case_id IS NULL) THEN RAISE EXCEPTION 'Offboarding reason must match the pinned workflow step' USING ERRCODE='42501';END IF;
 -- An Open receipt never rewrites released employment or signature evidence.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) old JOIN LATERAL jsonb_array_elements(coalesce(p_data->'letters','[]')) new ON new->>'id'=old->>'id' WHERE old->>'state'='released' AND (jsonb_array_length(new->'receipts') NOT BETWEEN jsonb_array_length(old->'receipts') AND jsonb_array_length(old->'receipts')+1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(old->'receipts') WITH ORDINALITY receipt(value,n) WHERE new->'receipts'->((n-1)::integer) IS DISTINCT FROM value) OR new->'receipts' IS DISTINCT FROM old->'receipts' AND (k<>'openLetter' OR old->>'id' IS DISTINCT FROM intent->'command'->>'documentId') OR (new-'openedBy'-'receipts') IS DISTINCT FROM (old-'openedBy'-'receipts') OR ((new->'openedBy')-app.current_user_id()::text) IS DISTINCT FROM ((old->'openedBy')-app.current_user_id()::text) OR new->'openedBy'->>app.current_user_id()::text IS DISTINCT FROM old->'openedBy'->>app.current_user_id()::text AND (k<>'openLetter' OR old->>'id' IS DISTINCT FROM intent->'command'->>'documentId' OR new->'openedBy'->>app.current_user_id()::text IS DISTINCT FROM old->>'revision'))) THEN RAISE EXCEPTION 'Released letter evidence is immutable' USING ERRCODE='42501';END IF;
 -- The first opener is advisory assignment metadata, never a lock or a source of authority.
 IF EXISTS(SELECT 1 FROM jsonb_each(coalesce(p_data->'progress','{}')) progress(task_id,value) LEFT JOIN LATERAL(SELECT j.data->'progress'->task_id AS value) old ON true WHERE progress.value IS DISTINCT FROM old.value AND (NOT(k='taskProgress' AND task_id=intent->'command'->>'taskId' OR k='openLetter' AND task_id LIKE (intent->'command'->>'documentId')||':%' AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'tasks','[]')) current_task WHERE current_task->>'id'=task_id AND current_task->'userIds' ? app.current_user_id()::text AND current_task->>'team'='true')) OR (progress.value->>'status' IN('todo','progress')) IS NOT TRUE OR old.value->'onIt' IS NOT NULL AND old.value->'onIt'<>'null'::jsonb AND progress.value->'onIt' IS DISTINCT FROM old.value->'onIt' OR (old.value->'onIt' IS NULL OR old.value->'onIt'='null'::jsonb) AND progress.value->'onIt'<>'null'::jsonb AND progress.value->'onIt'->>'id' IS DISTINCT FROM app.current_user_id()::text)) OR EXISTS(SELECT 1 FROM jsonb_object_keys(coalesce(j.data->'progress','{}')) task_id WHERE NOT(coalesce(p_data->'progress','{}') ? task_id) AND NOT(k='regenerateLetter' AND task_id LIKE (intent->'command'->>'documentId')||':%')) THEN RAISE EXCEPTION 'Task progress cannot reassign the first team actor' USING ERRCODE='42501';END IF;
 -- Membership is generated once by the trusted module adapter; later commands cannot reassign it.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) old JOIN LATERAL jsonb_array_elements(coalesce(p_data->'letters','[]')) new ON new->>'id'=old->>'id' WHERE new->'teamSteps' IS DISTINCT FROM old->'teamSteps' AND NOT(k='regenerateLetter' AND old->>'id'=intent->'command'->>'documentId')) THEN RAISE EXCEPTION 'Frozen letter team assignments cannot change' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_data->'letters','[]')) l WHERE (NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) old WHERE old->>'id'=l->>'id') OR k='regenerateLetter' AND l->>'id'=intent->'command'->>'documentId') AND l ? 'teamSteps' AND (jsonb_typeof(l->'teamSteps') IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_each(l->'teamSteps') team(step_id,assignment) WHERE jsonb_typeof(assignment->'memberIds') IS DISTINCT FROM 'array' OR jsonb_typeof(assignment->'personIds') IS DISTINCT FROM 'object' OR jsonb_typeof(assignment->'team') IS DISTINCT FROM 'boolean' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(l->'document'->'route'->'steps') step WHERE step->>'id'=step_id AND assignment->'memberIds' ? (step->>'holderId') AND assignment->'personIds'->>(step->>'holderId')=step->>'holderPersonId') OR jsonb_array_length(assignment->'memberIds') NOT BETWEEN 1 AND 1000 OR (SELECT count(DISTINCT member) FROM jsonb_array_elements_text(assignment->'memberIds') member)<>jsonb_array_length(assignment->'memberIds') OR (SELECT count(*) FROM jsonb_object_keys(assignment->'personIds'))<>jsonb_array_length(assignment->'memberIds') OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(assignment->'memberIds') member WHERE NOT EXISTS(SELECT 1 FROM app_user u WHERE u.tenant_id=j.tenant_id AND u.id::text=member AND u.person_id IS NOT NULL AND u.person_id::text=assignment->'personIds'->>member AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)))))) THEN RAISE EXCEPTION 'Letter team members must retain verified active identities' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_data->'letters','[]')) l LEFT JOIN LATERAL (SELECT prior FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) prior WHERE prior->>'id'=l->>'id') old ON true CROSS JOIN LATERAL jsonb_array_elements(coalesce(l->'history','[]')) WITH ORDINALITY a(receipt,n) WHERE a.n>coalesce(jsonb_array_length(old.prior->'history'),0) AND (receipt->>'actorId' IS DISTINCT FROM app.current_user_id()::text OR NOT EXISTS(SELECT 1 FROM app_user u WHERE u.tenant_id=j.tenant_id AND u.id=app.current_user_id() AND u.person_id::text=receipt->>'actorPersonId' AND u.archived_at IS NULL))) THEN RAISE EXCEPTION 'New signing evidence must name the current verified actor' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_data->'letters','[]')) l CROSS JOIN LATERAL jsonb_array_elements(coalesce(l->'document'->'actions','[]')) a WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(l->'history','[]')) h WHERE (a-'contentRevision'-'contentHash')=(h-'contentRevision'-'contentHash'))) THEN RAISE EXCEPTION 'Effective signing receipts must retain immutable action evidence' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_data->'letters','[]')) l LEFT JOIN LATERAL(SELECT prior FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) prior WHERE prior->>'id'=l->>'id') old ON true CROSS JOIN LATERAL jsonb_array_elements(coalesce(l->'history','[]')) WITH ORDINALITY a(receipt,n) WHERE a.n>coalesce(jsonb_array_length(old.prior->'history'),0) AND receipt->>'action' IN('reviewed','approved') AND (k IS DISTINCT FROM 'letterAction' OR l->>'id' IS DISTINCT FROM intent->'command'->>'documentId' OR intent->'command'->>'action' IS DISTINCT FROM CASE receipt->>'action' WHEN 'reviewed' THEN 'review' ELSE 'approve' END OR NOT EXISTS(SELECT 1 FROM app.resignation_pending_steps(old.prior) step WHERE step->>'id'=receipt->>'stepId' AND step->>'kind'=intent->'command'->>'action' AND app.resignation_letter_step_mine(old.prior,step)))) THEN RAISE EXCEPTION 'Review and approval evidence must match the admitted current pending step' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_data->'letters','[]')) l LEFT JOIN LATERAL (SELECT prior FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) prior WHERE prior->>'id'=l->>'id') old ON true CROSS JOIN LATERAL jsonb_array_elements(coalesce(l->'history','[]')) WITH ORDINALITY a(receipt,n) WHERE a.n>coalesce(jsonb_array_length(old.prior->'history'),0) AND receipt->>'action'='signed' AND (k<>'letterAction' OR intent->'command'->>'action'<>'sign' OR l->>'id' IS DISTINCT FROM intent->'command'->>'documentId' OR receipt->'signature'->>'consent' IS DISTINCT FROM 'true' OR receipt->'signature'->>'value' IS DISTINCT FROM intent->'command'->>'signature' OR NOT EXISTS(SELECT 1 FROM app.resignation_pending_steps(old.prior) step WHERE step->>'id'=receipt->>'stepId' AND app.resignation_letter_step_mine(old.prior,step) AND step->>'kind'='sign'))) THEN RAISE EXCEPTION 'Signature evidence must match the admitted current pending signature' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) old JOIN LATERAL jsonb_array_elements(coalesce(p_data->'letters','[]')) new ON new->>'id'=old->>'id' WHERE ((new->'document'->'route' IS DISTINCT FROM old->'document'->'route' OR new->'templateVersion' IS DISTINCT FROM old->'templateVersion') AND NOT(k='regenerateLetter' AND old->>'id'=intent->'command'->>'documentId')) OR new->'templateId' IS DISTINCT FROM old->'templateId' OR new->'generatedOn' IS DISTINCT FROM old->'generatedOn' OR jsonb_array_length(new->'history')<jsonb_array_length(old->'history') OR EXISTS(SELECT 1 FROM jsonb_array_elements(old->'history') WITH ORDINALITY h(a,n) WHERE new->'history'->((h.n-1)::integer) IS DISTINCT FROM h.a)) THEN RAISE EXCEPTION 'Pinned letter identity and action history cannot change' USING ERRCODE='42501';END IF;
 IF k='regenerateLetter' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_data->'letters','[]')) l JOIN LATERAL jsonb_array_elements(coalesce(intent->'initialData'->'letters','[]')) old ON old->>'id'=l->>'id' JOIN lc_v9_config cfg ON cfg.tenant_id=j.tenant_id CROSS JOIN LATERAL jsonb_array_elements(cfg.data->'templates') tpl CROSS JOIN LATERAL jsonb_array_elements(tpl->'versions') v WHERE l->>'id'=intent->'command'->>'documentId' AND tpl->>'id'=l->>'templateId' AND tpl->>'module'='off' AND NOT coalesce((tpl->>'retired')::boolean,false) AND v->>'state'='published' AND (tpl->>'currentVersion' IS NOT NULL AND v->>'version'=tpl->>'currentVersion' OR tpl->>'currentVersion' IS NULL AND (v->>'version')::integer=(SELECT max((pv->>'version')::integer) FROM jsonb_array_elements(tpl->'versions') pv WHERE pv->>'state'='published')) AND l->>'templateVersion'=v->>'version' AND (l->>'revision')::integer=(old->>'revision')::integer+1 AND l->'document'->'actions'='[]'::jsonb AND l->'signedValues'='{}'::jsonb AND l->'openedBy'='{}'::jsonb AND l->'receipts'='[]'::jsonb AND l->>'state'='review' AND l->'history'=old->'history') THEN RAISE EXCEPTION 'Regeneration must restart from the current published template and preserve original evidence' USING ERRCODE='42501';END IF;
 UPDATE resignation_journey SET stage=p_stage,data=p_data,participant_ids=p_participants,offboarding_case_id=coalesce(p_offboarding,offboarding_case_id),revision=revision+1,closed_on=CASE WHEN p_stage IN('retained','withdrawn','leaving') THEN coalesce(closed_on,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ELSE NULL END,updated_at=now() WHERE id=p_id AND tenant_id=j.tenant_id;
 -- Managed accepted journeys retain the pending legacy request until clearance records termination atomically.
 UPDATE resignation_request SET last_working_day=(p_data->>'lastWorkingDay')::date,reason=p_data->>'reason',status=CASE WHEN p_stage IN('retained','withdrawn') THEN 'withdrawn'::resignation_status ELSE status END WHERE id=p_id AND tenant_id=j.tenant_id;
 RETURN p_revision+1;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.resignation_offboarding_intent(p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j resignation_journey;construction jsonb;exit_type text;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 SELECT * INTO j FROM resignation_journey WHERE id=p_id AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR j.stage NOT IN('accepted','leaving') OR NOT app.resignation_runtime_intent(p_id) THEN RAISE EXCEPTION 'Resignation handoff unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(nullif(step->'params'->>'exitReason',''),'Resignation') INTO exit_type FROM automation_run run JOIN automation_workflow_version version ON version.tenant_id=run.tenant_id AND version.workflow_id=run.workflow_id AND version.revision=run.workflow_revision AND version.module='off' CROSS JOIN LATERAL jsonb_array_elements(coalesce(version.definition->'steps','[]')) step WHERE run.tenant_id=j.tenant_id AND run.subject_id=j.id AND run.module='off' AND run.id::text=j.data->'offboardingStart'->>'runId' AND step->>'id'=j.data->'offboardingStart'->>'stepId' AND step->>'type'='startOffboarding' AND coalesce(nullif(step->'params'->>'exitReason',''),'Resignation')=j.data->'offboardingStart'->>'exitReason' AND coalesce(nullif(step->'params'->>'exitReason',''),'Resignation') IN('Resignation','Termination','Contract end','Retirement','Non-confirmation');
 IF exit_type IS NULL THEN RAISE EXCEPTION 'Offboarding reason must match the pinned workflow step' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('employee',jsonb_build_object('id',e.id,'company_id',e.company_id,'person_id',e.person_id,'name',p.full_name,'employee_no',coalesce(e.employee_code,''),'hired_on',coalesce(e.join_date,e.hired_on)::text,'grade_id',e.grade_id,'confirmation_date',e.confirmation_date::text,'final_confirmation_date',e.final_confirmation_date::text,'probation_end_date',e.probation_end_date::text,'provisional_end_on',e.provisional_end_on::text),
 'assignment',(SELECT jsonb_build_object('department_id',a.department_id,'business_unit_id',a.business_unit_id,'position_id',a.position_id,'employment_type',a.employment_type::text) FROM assignment a WHERE a.tenant_id=j.tenant_id AND a.employment_id=j.employment_id AND a.superseded_at IS NULL AND a.valid_from<=day AND (a.valid_to IS NULL OR a.valid_to>day) ORDER BY a.valid_from DESC,a.id LIMIT 1),
 'logins',coalesce((SELECT jsonb_agg(jsonb_build_object('id',u.id) ORDER BY u.id) FROM app_user u WHERE u.tenant_id=j.tenant_id AND u.person_id=j.person_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)),'[]'::jsonb),
 'managers',coalesce((SELECT jsonb_agg(jsonb_build_object('id',u.id) ORDER BY u.id) FROM app_user u WHERE u.tenant_id=j.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND EXISTS(SELECT 1 FROM reporting_line rl JOIN employment me ON me.tenant_id=rl.tenant_id AND me.id=rl.manager_employment_id WHERE rl.tenant_id=j.tenant_id AND rl.subordinate_employment_id=j.employment_id AND rl.line_type='administrative' AND rl.superseded_at IS NULL AND rl.valid_from<=day AND (rl.valid_to IS NULL OR rl.valid_to>day) AND me.person_id=u.person_id)),'[]'::jsonb),
 'openExit',EXISTS(SELECT 1 FROM lc_v9_case c WHERE c.tenant_id=j.tenant_id AND c.employment_id=j.employment_id AND c.module='off' AND c.data->>'state' IN('pending','submitted'))) INTO construction
 FROM employment e JOIN person p ON p.tenant_id=e.tenant_id AND p.id=e.person_id WHERE e.tenant_id=j.tenant_id AND e.id=j.employment_id AND e.company_id=j.company_id AND e.person_id=j.person_id;
 IF construction IS NULL THEN RAISE EXCEPTION 'The resignation employment subject or company changed; review the case before handoff' USING ERRCODE='40001';END IF;
 RETURN jsonb_build_object('employmentId',j.employment_id,'type',exit_type,'noticeDate',j.submitted_on::text,'lastDay',j.data->>'lastWorkingDay','manualHandoff',false,'offboardingCaseId',j.offboarding_case_id,'construction',construction);
END $$;

--> statement-breakpoint
-- Existing 5785 function identities/ACLs retained; only termination source-fact consistency changes.
CREATE OR REPLACE FUNCTION app.personnel_posting_create(p_source text,p_source_ref uuid,p_employment uuid,p_event text,p_proposed jsonb,p_approver_group text,p_key text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); j public.resignation_journey; old public.personnel_posting; v_id uuid; v_number integer; configured text; baseline jsonb; workflow_step jsonb; source_currency text; current_currency text;
BEGIN
 IF p_source<>'offboarding' THEN RETURN app.personnel_posting_create_probation_v1(p_source,p_source_ref,p_employment,p_event,p_proposed,p_approver_group,p_key); END IF;
 IF t IS NULL OR app.current_user_id() IS NULL OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Sign in to create a posting' USING ERRCODE='42501'; END IF;
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO j FROM public.resignation_journey WHERE tenant_id=t AND id=p_source_ref AND employment_id=p_employment;
 IF NOT FOUND OR NOT app.resignation_journey_access(j.id) THEN RAISE EXCEPTION 'Resignation source unavailable' USING ERRCODE='42501'; END IF;
 IF p_event='termination' AND p_key IS DISTINCT FROM 'clearance:'||j.offboarding_case_id::text THEN RAISE EXCEPTION 'Termination posting requires the canonical clearance idempotency key' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('personnel-posting:'||t::text,0));
 SELECT * INTO old FROM public.personnel_posting WHERE tenant_id=t AND source=p_source AND source_ref=p_source_ref AND event_type=p_event AND idempotency_key=p_key;
 IF FOUND THEN
  IF old.proposed<>p_proposed OR old.employment_id<>p_employment THEN RAISE EXCEPTION 'Posting retry changed its frozen source values' USING ERRCODE='22023'; END IF;
  RETURN old.id;
 END IF;
 IF app.offboarding_posting_values_ok(p_event,p_proposed) IS NOT TRUE OR length(btrim(coalesce(p_key,''))) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Posting values are incomplete or not allowed' USING ERRCODE='22023'; END IF;
 IF p_event='termination' THEN
  IF NOT app.lc_v9_off_access(j.company_id) OR j.offboarding_case_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.lc_v9_case c WHERE c.id=j.offboarding_case_id AND c.tenant_id=t AND c.employment_id=j.employment_id AND c.data->>'state'='cleared') THEN RAISE EXCEPTION 'Termination is raised only at completed clearance' USING ERRCODE='42501'; END IF;
  IF p_proposed->>'resignationDate' IS DISTINCT FROM j.submitted_on::text OR NOT EXISTS(
   SELECT 1 FROM public.lc_v9_case c WHERE c.tenant_id=j.tenant_id AND c.id=j.offboarding_case_id AND c.company_id=j.company_id AND c.employment_id=j.employment_id AND c.module='off'
    AND c.data->>'state'='cleared' AND c.data->>'resignationSourceCaseId'=j.id::text
    AND c.data->'facts'->>'caseType' IN('Resignation','Termination','Contract end','Retirement','Non-confirmation')
    AND p_proposed->>'exitReason'=c.data->'facts'->>'caseType' AND p_proposed->>'effectiveDate'=c.data->'facts'->>'lastDay'
  ) THEN RAISE EXCEPTION 'Termination must use the completed Offboarding case exit reason and source facts' USING ERRCODE='22023'; END IF;
  IF p_proposed->>'effectiveDate' IS DISTINCT FROM (SELECT r.last_working_day::text FROM public.resignation_request r WHERE r.id=j.id AND r.tenant_id=t) THEN RAISE EXCEPTION 'Clearance last working day changed' USING ERRCODE='40001'; END IF;
 ELSE
  IF j.stage<>'retained' OR NOT (app.resignation_journey_can_act(j.id,'own') OR app.resignation_journey_can_act(j.id,'retry')) THEN RAISE EXCEPTION 'An accepted retention offer is required' USING ERRCODE='42501'; END IF;
  SELECT step INTO workflow_step FROM public.automation_run r JOIN public.automation_workflow_version w ON w.tenant_id=r.tenant_id AND w.workflow_id=r.workflow_id AND w.revision=r.workflow_revision CROSS JOIN LATERAL jsonb_array_elements(w.definition->'steps') step
  WHERE r.tenant_id=t AND r.module='off' AND r.subject_id=j.id AND r.status IN ('running','failed') AND p_key=r.id::text||':'||(step->>'id')||':'||j.revision::text AND step->>'type'='createPosting' LIMIT 1;
  IF workflow_step IS NULL THEN RAISE EXCEPTION 'Only a pinned workflow posting step can propose this event' USING ERRCODE='42501'; END IF;
  IF p_event IS DISTINCT FROM (CASE workflow_step->'params'->>'eventType' WHEN 'Transfer' THEN 'transfer' WHEN 'Increment' THEN 'increment' WHEN 'Confirmation' THEN 'confirmation' WHEN 'Salary Adjustment' THEN 'salaryAdjustment' WHEN 'Employment Type Change' THEN 'employmentTypeChange' ELSE 'promotion' END) THEN RAISE EXCEPTION 'Posting event does not match its workflow step' USING ERRCODE='22023'; END IF;
  IF (p_proposed ? 'positionId') IS DISTINCT FROM (coalesce(workflow_step->'params'->'fields','["title","grade","salary"]'::jsonb) ? 'title') OR (p_proposed ? 'gradeId') IS DISTINCT FROM (coalesce(workflow_step->'params'->'fields','["title","grade","salary"]'::jsonb) ? 'grade') OR (p_proposed ? 'basicSalary') IS DISTINCT FROM (coalesce(workflow_step->'params'->'fields','["title","grade","salary"]'::jsonb) ? 'salary') THEN RAISE EXCEPTION 'Posting fields do not match its workflow step' USING ERRCODE='22023'; END IF;

  IF p_proposed->>'effectiveDate' IS DISTINCT FROM (CASE workflow_step->'params'->>'dateFrom' WHEN 'lwd' THEN j.data->>'lastWorkingDay' WHEN 'today' THEN (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text ELSE j.data->'offer'->>'effectiveDate' END) THEN RAISE EXCEPTION 'Posting must use its pinned workflow date' USING ERRCODE='22023'; END IF;
  IF p_proposed ? 'position' AND p_proposed->>'position' IS DISTINCT FROM j.data->'offer'->>'position' THEN RAISE EXCEPTION 'Posting must use accepted Position' USING ERRCODE='22023'; END IF;
  IF p_proposed ? 'jobGrade' AND p_proposed->>'jobGrade' IS DISTINCT FROM j.data->'offer'->>'jobGrade' THEN RAISE EXCEPTION 'Posting must use accepted Job Grade' USING ERRCODE='22023'; END IF;
  IF p_proposed ? 'basicSalary' THEN IF (p_proposed->>'basicSalary')::numeric IS DISTINCT FROM (j.data->'offer'->>'basicSalary')::numeric THEN RAISE EXCEPTION 'Posting must use accepted Basic salary' USING ERRCODE='22023'; END IF; END IF;
 END IF;
 IF p_proposed ? 'basicSalary' THEN
  source_currency:=nullif(btrim(j.data->'facts'->>'currency'),'');
  IF source_currency IS NOT NULL THEN
   IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('leave-dependency-configuration:'||t::text,0)) THEN RAISE EXCEPTION 'Salary source is busy; review this posting again' USING ERRCODE='40001'; END IF;
   IF NOT pg_try_advisory_xact_lock(hashtextextended('leave-dependency-employment:'||t::text||':'||p_employment::text,0)) THEN RAISE EXCEPTION 'Salary source is busy; review this posting again' USING ERRCODE='40001'; END IF;
   SELECT c.currency INTO current_currency FROM public.compensation c WHERE c.tenant_id=t AND c.employment_id=p_employment AND c.superseded_at IS NULL AND c.valid_from<=(p_proposed->>'effectiveDate')::date AND (c.valid_to IS NULL OR c.valid_to>(p_proposed->>'effectiveDate')::date) ORDER BY c.valid_from DESC,c.id LIMIT 1;
   IF current_currency IS DISTINCT FROM source_currency THEN RAISE EXCEPTION 'The salary currency changed since this resignation case; review the agreed offer before creating a posting' USING ERRCODE='40001'; END IF;
  END IF;
 END IF;
 IF app.offboarding_posting_references_ok(j.company_id,p_proposed) IS NOT TRUE THEN RAISE EXCEPTION 'Posting references do not match Personnel Management' USING ERRCODE='22023'; END IF;
 SELECT CASE WHEN c.data->'offboarding' ? 'postingApproverGroupId' THEN c.data->'offboarding'->>'postingApproverGroupId' ELSE c.data->>'peopleOpsGroup' END INTO configured FROM public.lc_v9_config c WHERE c.tenant_id=t;
 IF configured IS DISTINCT FROM p_approver_group OR cardinality(app.offboarding_posting_group_members(configured))=0 THEN RAISE EXCEPTION 'Configure a populated Offboarding posting approver group' USING ERRCODE='22023'; END IF;
 SELECT coalesce(max(number),1000)+1 INTO v_number FROM public.personnel_posting WHERE tenant_id=t;
 baseline:=jsonb_build_object('position',j.data->'facts'->'position','jobGrade',j.data->'facts'->'jobGrade','basicSalary',j.data->'facts'->'basicSalary','currency',j.data->'facts'->'currency');
 INSERT INTO public.personnel_posting(tenant_id,company_id,employment_id,number,source,source_ref,event_type,proposed,approver_group_id,created_by,idempotency_key,baseline_values)
 VALUES(t,j.company_id,p_employment,v_number,p_source,p_source_ref,p_event,p_proposed,configured,app.current_user_id(),p_key,baseline) RETURNING id INTO v_id;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(t,'personnel_posting',v_id,'personnel_posting.created','user',app.current_user_id(),p_employment,jsonb_build_object('number',v_number,'source',p_source,'sourceRef',p_source_ref,'eventType',p_event,'proposed',p_proposed,'approverGroupId',configured));
 RETURN v_id;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.personnel_posting_approve(p_id uuid,p_revision integer,p_values jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.personnel_posting; v jsonb; source_currency text; current_currency text;
BEGIN
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=app.current_tenant_id() AND id=p_id;
 IF NOT FOUND OR p.source<>'offboarding' THEN RETURN app.personnel_posting_approve_probation_v1(p_id,p_revision,p_values); END IF;
 PERFORM app.access_workforce_write_lock();SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=app.current_tenant_id() AND id=p_id FOR UPDATE;
 IF NOT app.personnel_posting_visible(p.approver_group_id,p.employment_id,'offboarding') OR NOT app.offboarding_posting_group(p.company_id,p.approver_group_id) OR NOT app.access_workforce_employment(p.employment_id,'workforce.maintain') THEN RAISE EXCEPTION 'Only the authorised posting group can approve this posting' USING ERRCODE='42501'; END IF;
 IF p.status='approved' AND p.movement_id IS NOT NULL AND p_revision IN (p.revision,p.revision-1) AND (p_values IS NULL OR p_values=p.applied) THEN
  RETURN jsonb_build_object('id',p.id,'number',p.number,'employmentId',p.employment_id,'eventType',p.event_type,'values',p.applied,'revision',p.revision,'movementId',p.movement_id,'alreadyApplied',true);
 END IF;
 IF p.status<>'pending' OR p.revision<>p_revision THEN RAISE EXCEPTION 'Posting changed; reload before approving' USING ERRCODE='40001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.resignation_journey j JOIN public.employment e ON e.id=j.employment_id AND e.tenant_id=j.tenant_id WHERE j.tenant_id=p.tenant_id AND j.id=p.source_ref AND j.employment_id=p.employment_id AND j.company_id=p.company_id AND e.company_id=p.company_id AND (p.event_type<>'termination' AND j.stage='retained' OR p.event_type='termination' AND EXISTS(SELECT 1 FROM public.lc_v9_case c WHERE c.tenant_id=j.tenant_id AND c.id=j.offboarding_case_id AND c.employment_id=j.employment_id AND c.data->>'state'='cleared'))) THEN RAISE EXCEPTION 'The posting source or company changed; review before approving' USING ERRCODE='40001'; END IF;

 v:=coalesce(p_values,p.edited,p.proposed);IF app.offboarding_posting_values_ok(p.event_type,v) IS NOT TRUE THEN RAISE EXCEPTION 'Posting values are incomplete or not allowed' USING ERRCODE='22023'; END IF;
 IF p.event_type='termination' AND NOT EXISTS(
  SELECT 1 FROM public.resignation_journey j JOIN public.lc_v9_case c ON c.tenant_id=j.tenant_id AND c.id=j.offboarding_case_id AND c.company_id=j.company_id AND c.employment_id=j.employment_id
  JOIN public.resignation_request r ON r.tenant_id=j.tenant_id AND r.id=j.id AND r.employment_id=j.employment_id
  WHERE j.tenant_id=p.tenant_id AND j.id=p.source_ref AND j.company_id=p.company_id AND j.employment_id=p.employment_id AND c.module='off'
   AND c.data->>'state'='cleared' AND c.data->>'resignationSourceCaseId'=j.id::text
   AND c.data->'facts'->>'caseType' IN('Resignation','Termination','Contract end','Retirement','Non-confirmation')
   AND v->>'exitReason'=c.data->'facts'->>'caseType' AND v->>'effectiveDate'=c.data->'facts'->>'lastDay' AND v->>'effectiveDate'=r.last_working_day::text
   AND v->>'resignationDate'=j.submitted_on::text
 ) THEN RAISE EXCEPTION 'Termination must use the completed Offboarding case exit reason and source facts' USING ERRCODE='22023'; END IF;
 IF v ? 'basicSalary' THEN
  SELECT nullif(btrim(j.data->'facts'->>'currency'),'') INTO source_currency FROM public.resignation_journey j WHERE j.tenant_id=p.tenant_id AND j.id=p.source_ref;
  IF source_currency IS NOT NULL THEN
   IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('leave-dependency-configuration:'||p.tenant_id::text,0)) THEN RAISE EXCEPTION 'Salary source is busy; review this posting again' USING ERRCODE='40001'; END IF;
   IF NOT pg_try_advisory_xact_lock(hashtextextended('leave-dependency-employment:'||p.tenant_id::text||':'||p.employment_id::text,0)) THEN RAISE EXCEPTION 'Salary source is busy; review this posting again' USING ERRCODE='40001'; END IF;
   SELECT c.currency INTO current_currency FROM public.compensation c WHERE c.tenant_id=p.tenant_id AND c.employment_id=p.employment_id AND c.superseded_at IS NULL AND c.valid_from<=(v->>'effectiveDate')::date AND (c.valid_to IS NULL OR c.valid_to>(v->>'effectiveDate')::date) ORDER BY c.valid_from DESC,c.id LIMIT 1;
   IF current_currency IS DISTINCT FROM source_currency THEN RAISE EXCEPTION 'The salary currency changed since this resignation case; review the agreed offer before approving this posting' USING ERRCODE='40001'; END IF;
  END IF;
 END IF;
 IF app.offboarding_posting_references_ok(p.company_id,v) IS NOT TRUE THEN RAISE EXCEPTION 'Posting references do not match Personnel Management' USING ERRCODE='22023'; END IF;
 UPDATE public.personnel_posting SET status='approved',approved_by=app.current_user_id(),approved_at=now(),applied=v,revision=p.revision+1 WHERE id=p.id AND tenant_id=p.tenant_id;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(p.tenant_id,'personnel_posting',p.id,'personnel_posting.approved','user',app.current_user_id(),p.employment_id,jsonb_build_object('source',p.source,'sourceRef',p.source_ref,'applied',v,'revision',p.revision+1));
 RETURN jsonb_build_object('id',p.id,'number',p.number,'employmentId',p.employment_id,'eventType',p.event_type,'values',v,'revision',p.revision+1);
END $$;

--> statement-breakpoint
-- Exact pre-correction custody was adjudicated by the existing native begin admission.
CREATE OR REPLACE FUNCTION app.resignation_journey_admit(p_payload text,p_signature text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k bytea;p jsonb;expected bytea;received bytea;difference integer:=0;i integer;n numeric:=extract(epoch FROM clock_timestamp())*1000;j resignation_journey;op text;
BEGIN
 IF p_payload IS NULL OR octet_length(p_payload)>4194304 OR p_signature IS NULL OR p_signature!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Runtime proof unavailable' USING ERRCODE='42501';END IF;
 SELECT secret INTO k FROM app.resignation_runtime_verifier WHERE singleton;
 IF k IS NULL THEN RAISE EXCEPTION 'Resignation runtime verifier is not provisioned' USING ERRCODE='42501';END IF;
 expected:=app._ai_spend_hmac_sha256(convert_to(p_payload,'UTF8'),k);received:=decode(p_signature,'hex');
 FOR i IN 0..31 LOOP difference:=difference | (get_byte(expected,i) # get_byte(received,i));END LOOP;
 IF difference<>0 THEN RAISE EXCEPTION 'Runtime proof unavailable' USING ERRCODE='42501';END IF;
 p:=p_payload::jsonb;op:=p->>'operation';
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT(p ?& ARRAY['v','purpose','runner','tenantId','userId','personId','transactionId','operation','issuedAt','expiresAt']) OR p->>'purpose' IS DISTINCT FROM 'aihr-resignation-runtime-v1' OR p->'v' IS DISTINCT FROM '1'::jsonb OR p->>'runner' IS DISTINCT FROM 'resignation-journey' OR p->>'tenantId' IS DISTINCT FROM app.current_tenant_id()::text OR p->>'userId' IS DISTINCT FROM app.current_user_id()::text OR p->>'transactionId' IS DISTINCT FROM txid_current()::text OR jsonb_typeof(p->'issuedAt') IS DISTINCT FROM 'number' OR jsonb_typeof(p->'expiresAt') IS DISTINCT FROM 'number' OR (p->>'issuedAt')!~'^[0-9]{1,16}$' OR (p->>'expiresAt')!~'^[0-9]{1,16}$' OR (p->>'issuedAt')::numeric>n OR (p->>'expiresAt')::numeric<=n OR (p->>'expiresAt')::numeric-(p->>'issuedAt')::numeric NOT BETWEEN 1 AND 60000 OR op NOT IN('begin','create','save','read','context','notify','retrySave','postingRejected','email') THEN RAISE EXCEPTION 'Runtime proof unavailable' USING ERRCODE='42501';END IF;
 IF app.current_user_id() IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id() AND u.person_id::text IS NOT DISTINCT FROM p->>'personId' AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) OR app.current_user_id() IS NULL AND NOT app.acting_as_owner() THEN RAISE EXCEPTION 'Runtime actor unavailable' USING ERRCODE='42501';END IF;
 IF p ? 'caseId' THEN
  SELECT * INTO j FROM resignation_journey WHERE tenant_id=app.current_tenant_id() AND id=(p->>'caseId')::uuid;
  IF j.id IS NOT NULL AND p ? 'companyId' AND p->>'companyId' IS DISTINCT FROM j.company_id::text THEN RAISE EXCEPTION 'Runtime company mismatch' USING ERRCODE='42501';END IF;
 END IF;
 IF op='begin' THEN
  PERFORM app.access_workforce_write_lock();
  SELECT * INTO j FROM resignation_journey WHERE tenant_id=app.current_tenant_id() AND id=(p->>'caseId')::uuid FOR UPDATE;
  IF j.id IS NULL OR app.resignation_command_allowed(j.id,p->'command') IS NOT TRUE THEN RAISE EXCEPTION 'This action is not currently assigned to you' USING ERRCODE='42501';END IF;
  IF j.revision IS DISTINCT FROM (p->>'revision')::integer THEN RAISE EXCEPTION 'This resignation changed; reload before acting' USING ERRCODE='40001';END IF;
  p:=p||jsonb_build_object('initialStage',j.stage,'companyId',j.company_id)||CASE WHEN p->'command'->>'type'='regenerateLetter' THEN jsonb_build_object('initialData',jsonb_build_object('letters',(SELECT coalesce(jsonb_agg(l),'[]'::jsonb) FROM jsonb_array_elements(coalesce(j.data->'letters','[]')) l WHERE l->>'id'=p->'command'->>'documentId'))) WHEN p->'command'->>'type'='updateLetter' AND p->'command' ? 'lastWorkingDay' THEN jsonb_build_object('initialData',jsonb_build_object('lastWorkingDay',j.data->>'lastWorkingDay')) ELSE '{}'::jsonb END;
  INSERT INTO app.resignation_runtime_state VALUES(app.current_tenant_id(),coalesce(app.current_user_id()::text,'worker'),'intent:'||j.id::text,txid_current(),p,now()) ON CONFLICT(tenant_id,actor,kind) DO UPDATE SET transaction_id=excluded.transaction_id,payload=excluded.payload,created_at=excluded.created_at;
 ELSIF op NOT IN('read','context','create') AND NOT app.resignation_runtime_intent((p->>'caseId')::uuid) THEN RAISE EXCEPTION 'A current authorized command is required' USING ERRCODE='42501';END IF;
 DELETE FROM app.resignation_runtime_state WHERE tenant_id=app.current_tenant_id() AND actor=coalesce(app.current_user_id()::text,'worker') AND transaction_id<>txid_current();
 IF op='begin' THEN RETURN;END IF;
 INSERT INTO app.resignation_runtime_state VALUES(app.current_tenant_id(),coalesce(app.current_user_id()::text,'worker'),'proof:'||op,txid_current(),p,now()) ON CONFLICT(tenant_id,actor,kind) DO UPDATE SET transaction_id=excluded.transaction_id,payload=excluded.payload,created_at=excluded.created_at;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.resignation_offboarding_date_intent(p_id uuid,p_old date,p_new date) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j resignation_journey;c lc_v9_case;intent jsonb;u app_user;cfg jsonb;source jsonb;cfg_revision integer;group_revision integer;
BEGIN
 PERFORM app.resignation_runtime_consume('context',p_id,jsonb_build_object('mode','offboardingDateCorrection','journeyId',p_id,'oldLastDay',p_old::text,'newLastDay',p_new::text));
 SELECT payload INTO intent FROM app.resignation_runtime_state WHERE tenant_id=app.current_tenant_id() AND actor=app.current_user_id()::text AND kind='intent:'||p_id::text AND transaction_id=txid_current();
 SELECT * INTO u FROM app_user WHERE tenant_id=app.current_tenant_id() AND id=app.current_user_id() AND person_id IS NOT NULL AND archived_at IS NULL AND NOT app.login_blocked(id);
 SELECT * INTO j FROM resignation_journey WHERE tenant_id=app.current_tenant_id() AND id=p_id;
 IF intent IS NULL OR u.id IS NULL OR intent->>'personId' IS DISTINCT FROM u.person_id::text OR intent->'command'->>'type' IS DISTINCT FROM 'updateLetter' OR intent->'command'->>'lastWorkingDay' IS DISTINCT FROM p_new::text OR intent->'initialData'->>'lastWorkingDay' IS DISTINCT FROM p_old::text OR j.id IS NULL OR j.data->>'lastWorkingDay' IS DISTINCT FROM p_new::text OR p_new IS NULL OR p_old IS NULL OR p_new=p_old THEN RAISE EXCEPTION 'A current holding-owner date correction is required' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM lc_v9_case WHERE tenant_id=j.tenant_id AND id=j.offboarding_case_id AND company_id=j.company_id AND employment_id=j.employment_id AND module='off' AND data->>'resignationSourceCaseId'=j.id::text AND data->'facts'->>'personId'=j.person_id::text FOR UPDATE;
 IF c.id IS NULL THEN RAISE EXCEPTION 'The linked clearance source changed' USING ERRCODE='42501';END IF;
 IF c.data->>'state' IN('cleared','cancelled') THEN RETURN jsonb_build_object('blocked','closed');END IF;
 IF (c.data->>'state' IN('pending','submitted')) IS NOT TRUE OR c.data->'facts'->>'lastDay' IS DISTINCT FROM p_old::text OR p_new<(c.data->'facts'->>'noticeDate')::date THEN RAISE EXCEPTION 'The linked clearance date changed' USING ERRCODE='40001';END IF;
 SELECT cfgrow.data||CASE WHEN shared.tenant_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('groups',coalesce(shared.data->'groups','[]'::jsonb),'groupsRevision',shared.revision) END,cfgrow.revision,shared.revision INTO cfg,cfg_revision,group_revision FROM lc_v9_config cfgrow LEFT JOIN lc_onboarding_config shared ON shared.tenant_id=cfgrow.tenant_id WHERE cfgrow.tenant_id=j.tenant_id;
 SELECT jsonb_build_object('notice_before_confirmation_value',e.notice_before_confirmation_value,'notice_before_confirmation_unit',e.notice_before_confirmation_unit,'notice_after_confirmation_value',e.notice_after_confirmation_value,'notice_after_confirmation_unit',e.notice_after_confirmation_unit,'final_confirmation_date',e.final_confirmation_date::text,'grade',g.code,'source_version',e.xmin::text) INTO source FROM employment e LEFT JOIN job_grade g ON g.tenant_id=e.tenant_id AND g.id=e.grade_id WHERE e.tenant_id=j.tenant_id AND e.id=j.employment_id AND e.company_id=j.company_id AND e.person_id=j.person_id;
 IF cfg IS NOT NULL AND source IS NOT NULL THEN INSERT INTO app.resignation_runtime_state VALUES(j.tenant_id,u.id::text,'dateCorrection:'||j.id::text,txid_current(),jsonb_build_object('caseId',c.id,'caseRevision',c.revision,'journeyRevision',j.revision,'oldLastDay',p_old::text,'newLastDay',p_new::text,'personId',u.person_id,'employmentVersion',source->>'source_version','configRevision',cfg_revision,'groupsRevision',group_revision),now()) ON CONFLICT(tenant_id,actor,kind) DO UPDATE SET transaction_id=excluded.transaction_id,payload=excluded.payload,created_at=excluded.created_at;END IF;
 RETURN jsonb_build_object('row',jsonb_build_object('id',c.id,'revision',c.revision,'company_id',c.company_id,'data',c.data||jsonb_build_object('review',NULL,'finalFigures',NULL)),'config',cfg,'employmentDateSource',source);
END $$;
--> statement-breakpoint
CREATE FUNCTION app.resignation_offboarding_date_store(p_id uuid,p_revision integer,p_old date,p_new date,p_data jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j resignation_journey;c lc_v9_case;intent jsonb;bound jsonb;u app_user;expected jsonb;tasks jsonb;items jsonb;entry jsonb;anchor date;actor_name text;source_version text;cfg_revision integer;group_revision integer;
BEGIN
 PERFORM app.resignation_runtime_consume('context',p_id,jsonb_build_object('mode','offboardingDateCorrectionSave','journeyId',p_id,'revision',p_revision,'oldLastDay',p_old::text,'newLastDay',p_new::text,'data',p_data));
 SELECT payload INTO intent FROM app.resignation_runtime_state WHERE tenant_id=app.current_tenant_id() AND actor=app.current_user_id()::text AND kind='intent:'||p_id::text AND transaction_id=txid_current();
 DELETE FROM app.resignation_runtime_state WHERE tenant_id=app.current_tenant_id() AND actor=app.current_user_id()::text AND kind='dateCorrection:'||p_id::text AND transaction_id=txid_current() RETURNING payload INTO bound;
 SELECT * INTO u FROM app_user WHERE tenant_id=app.current_tenant_id() AND id=app.current_user_id() AND person_id IS NOT NULL AND archived_at IS NULL AND NOT app.login_blocked(id);
 SELECT * INTO j FROM resignation_journey WHERE tenant_id=app.current_tenant_id() AND id=p_id;
 IF bound IS NULL OR intent IS NULL OR u.id IS NULL OR intent->>'personId' IS DISTINCT FROM u.person_id::text OR bound->>'personId' IS DISTINCT FROM u.person_id::text OR intent->'command'->>'type' IS DISTINCT FROM 'updateLetter' OR intent->'command'->>'lastWorkingDay' IS DISTINCT FROM p_new::text OR intent->'initialData'->>'lastWorkingDay' IS DISTINCT FROM p_old::text OR bound->>'oldLastDay' IS DISTINCT FROM p_old::text OR bound->>'newLastDay' IS DISTINCT FROM p_new::text OR j.id IS NULL OR j.data->>'lastWorkingDay' IS DISTINCT FROM p_new::text OR bound->>'journeyRevision' IS DISTINCT FROM j.revision::text OR bound->>'caseId' IS DISTINCT FROM j.offboarding_case_id::text THEN RAISE EXCEPTION 'A current verified clearance date projection is required' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM lc_v9_case WHERE tenant_id=j.tenant_id AND id=j.offboarding_case_id AND company_id=j.company_id AND employment_id=j.employment_id AND module='off' AND data->>'resignationSourceCaseId'=j.id::text AND data->'facts'->>'personId'=j.person_id::text FOR UPDATE;
 IF c.id IS NULL THEN RAISE EXCEPTION 'The linked clearance source changed' USING ERRCODE='42501';END IF;
 IF c.revision IS DISTINCT FROM p_revision OR bound->>'caseRevision' IS DISTINCT FROM c.revision::text OR (c.data->>'state' IN('pending','submitted')) IS NOT TRUE OR c.data->'facts'->>'lastDay' IS DISTINCT FROM p_old::text THEN RAISE EXCEPTION 'The linked clearance case changed; refresh before correcting it' USING ERRCODE='40001';END IF;
 SELECT e.xmin::text INTO source_version FROM employment e WHERE e.tenant_id=j.tenant_id AND e.id=j.employment_id AND e.company_id=j.company_id AND e.person_id=j.person_id;
 SELECT cfg.revision,shared.revision INTO cfg_revision,group_revision FROM lc_v9_config cfg LEFT JOIN lc_onboarding_config shared ON shared.tenant_id=cfg.tenant_id WHERE cfg.tenant_id=j.tenant_id;
 IF bound->>'employmentVersion' IS DISTINCT FROM source_version OR bound->>'configRevision' IS DISTINCT FROM cfg_revision::text OR bound->>'groupsRevision' IS DISTINCT FROM group_revision::text THEN RAISE EXCEPTION 'The clearance date policy or employment source changed' USING ERRCODE='40001';END IF;
 expected:=jsonb_set(c.data,'{facts,lastDay}',to_jsonb(p_new::text));
 IF coalesce(c.data->>'revokeMode','lastday')='lastday' THEN expected:=jsonb_set(expected,'{revokeDate}',to_jsonb(p_new::text));END IF;
 SELECT coalesce(jsonb_agg(CASE WHEN task->>'status' IN('done','notNeeded') THEN task ELSE task||jsonb_build_object('dueOn',(p_new+(task->>'due')::integer)::text,'opensOn',CASE WHEN task->'opens'='null'::jsonb THEN NULL ELSE (p_new+(task->>'opens')::integer)::text END) END ORDER BY n),'[]'::jsonb) INTO tasks FROM jsonb_array_elements(coalesce(c.data->'tasks','[]')) WITH ORDINALITY rows(task,n);
 expected:=jsonb_set(expected,'{tasks}',tasks);
 IF c.data->>'state'='submitted' THEN
  -- The canonical settlement date owner derives this anchor. Its exact result is HMAC-bound; SQL owns every permitted relative-date delta.
  IF (p_data->>'returnAnchor' ~ '^\d{4}-\d{2}-\d{2}$') IS NOT TRUE THEN RAISE EXCEPTION 'A verified effective return anchor is required' USING ERRCODE='42501';END IF;
  anchor:=(p_data->>'returnAnchor')::date;expected:=jsonb_set(expected,'{returnAnchor}',to_jsonb(anchor::text));
  SELECT coalesce(jsonb_agg(CASE WHEN item->>'status' IN('done','notNeeded','notReturned') THEN item WHEN jsonb_typeof(item->'dueDay')='number' THEN item||jsonb_build_object('dueOn',(anchor+(item->>'dueDay')::integer)::text) WHEN NOT(item ? 'method') AND NOT(item ? 'dueDay') AND item->'dueOn'=c.data->'revokeDate' THEN item||jsonb_build_object('dueOn',expected->'revokeDate') ELSE item END ORDER BY n),'[]'::jsonb) INTO items FROM jsonb_array_elements(coalesce(c.data->'items','[]')) WITH ORDINALITY rows(item,n);
  expected:=jsonb_set(expected,'{items}',items);
 END IF;
 SELECT coalesce(p.full_name,'User') INTO actor_name FROM person p WHERE p.tenant_id=j.tenant_id AND p.id=u.person_id;
 entry:=p_data->'log'->jsonb_array_length(coalesce(c.data->'log','[]'));
 IF jsonb_array_length(coalesce(p_data->'log','[]')) IS DISTINCT FROM jsonb_array_length(coalesce(c.data->'log','[]'))+1 OR entry->>'action' IS DISTINCT FROM 'case.resignationLastDaySynchronized' OR entry->'actor' IS DISTINCT FROM jsonb_build_object('id',u.id,'name',actor_name) OR entry->>'detail' IS DISTINCT FROM 'Agreed last working day corrected from '||p_old::text||' to '||p_new::text||'. Open checklist dates and relative return dates now follow the corrected source.' OR (entry->>'id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') IS NOT TRUE OR (entry->>'at' ~ '^\d{4}-\d{2}-\d{2}T') IS NOT TRUE OR (entry-ARRAY['id','at','actor','action','detail'])<>'{}'::jsonb THEN RAISE EXCEPTION 'Clearance date corrections require one verified owner audit entry' USING ERRCODE='42501';END IF;
 expected:=expected||jsonb_build_object('revision',p_revision+1,'review',NULL,'finalFigures',NULL,'log',coalesce(c.data->'log','[]')||jsonb_build_array(entry));
 IF p_data IS DISTINCT FROM expected THEN RAISE EXCEPTION 'A clearance date correction cannot rewrite other case facts or assignments' USING ERRCODE='42501';END IF;
 INSERT INTO lc_v9_case_revision(tenant_id,case_id,company_id,revision,data,actor_user_id) VALUES(j.tenant_id,c.id,c.company_id,c.revision,c.data,u.id);
 UPDATE lc_v9_case SET data=p_data,revision=p_revision+1,updated_at=now() WHERE tenant_id=j.tenant_id AND id=c.id AND revision=p_revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'The linked clearance case changed; refresh before correcting it' USING ERRCODE='40001';END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.resignation_offboarding_date_intent(uuid,date,date),app.resignation_offboarding_date_store(uuid,integer,date,date,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resignation_offboarding_date_intent(uuid,date,date),app.resignation_offboarding_date_store(uuid,integer,date,date,jsonb) TO ai_hr_app;

--> statement-breakpoint
-- Human queue presentation only: current configured waiting members for already-visible pending Offboarding postings.
-- The shared people RPC and model-facing posting DTO stay unchanged. No directory or group lookup by arbitrary id.
CREATE FUNCTION app.offboarding_posting_waiting_members(p_postings uuid[])
RETURNS TABLE(posting_id uuid,names text[],total_members integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE visible_postings AS MATERIALIZED (
  SELECT p.id,p.approver_group_id,e.id AS employment_id,e.tenant_id,e.person_id,e.company_id,e.voided_at,e.import_pending_attempt_id
  FROM public.personnel_posting p JOIN public.employment e ON e.tenant_id=p.tenant_id AND e.id=p.employment_id
  WHERE coalesce(cardinality(p_postings),0) BETWEEN 1 AND 100 AND app.principal_snapshot_current()
   AND p.tenant_id=app.current_tenant_id() AND p.id=ANY(p_postings) AND p.source='offboarding' AND p.status='pending'
   AND app.personnel_posting_visible(p.approver_group_id,p.employment_id,p.source)
 ), employment_sources AS MATERIALIZED (
  SELECT DISTINCT employment_id,tenant_id,company_id,voided_at,import_pending_attempt_id FROM visible_postings
 ), public_sources AS MATERIALIZED (
  SELECT e.employment_id FROM employment_sources e
  -- The canonical inline state predicate keeps the CURRENT READER's normal row visibility and void exclusion.
  WHERE app.access_workforce_employment_permitted(e.tenant_id,e.company_id,e.voided_at,e.import_pending_attempt_id,ARRAY[e.company_id])
   -- Reader-owned import custody does not establish custody for OTHER prospective approvers.
   -- Evaluate publication once per distinct source, before any candidate expansion.
   AND (e.import_pending_attempt_id IS NULL OR app.import_marker_released(e.import_pending_attempt_id))
 ), visible AS MATERIALIZED (
  SELECT v.id,v.approver_group_id,v.person_id,v.company_id FROM visible_postings v JOIN public_sources e ON e.employment_id=v.employment_id
 ), wanted_groups AS MATERIALIZED (SELECT DISTINCT approver_group_id AS id FROM visible),
 configuration AS MATERIALIZED (
  SELECT coalesce((SELECT data->'groups' FROM public.lc_onboarding_config WHERE tenant_id=app.current_tenant_id()),
   (SELECT data->'groups' FROM public.lc_v9_config WHERE tenant_id=app.current_tenant_id()),'[]'::jsonb) AS groups
 ), configured_members AS MATERIALIZED (
  SELECT DISTINCT wanted.id,CASE WHEN member.value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN member.value::uuid ELSE NULL END AS user_id
  FROM configuration cfg CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(cfg.groups)='array' THEN cfg.groups ELSE '[]'::jsonb END) g
  JOIN wanted_groups wanted ON wanted.id=g->>'id'
  CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(g->'members')='array' THEN g->'members' ELSE '[]'::jsonb END) member
 ), wanted_users AS MATERIALIZED (SELECT DISTINCT user_id FROM configured_members WHERE user_id IS NOT NULL),
 active_people AS MATERIALIZED (
  SELECT u.id,u.person_id,nullif(btrim(person.full_name),'') AS name
  FROM wanted_users wanted JOIN public.app_user u ON u.id=wanted.user_id AND u.tenant_id=app.current_tenant_id()
  LEFT JOIN public.person person ON person.tenant_id=u.tenant_id AND person.id=u.person_id
  WHERE u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 ), wanted_companies AS MATERIALIZED (SELECT DISTINCT company_id FROM visible),
 -- Derived reader of the canonical Access owners (0579/2510/5071/5076/2126/2302), pinned and compared by native regression tests.
 -- No permission is stored or granted here. Resolve the current published parent source once, never per member.
 published_parents AS MATERIALIZED (
  SELECT DISTINCT ON(m.company_id) m.company_id,m.parent_company_id
  FROM public.company_organisation_mapping m JOIN public.company_organisation_run r ON r.tenant_id=m.tenant_id AND r.id=m.run_id
  WHERE m.tenant_id=app.current_tenant_id() AND r.state='published' AND r.effective_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  ORDER BY m.company_id,r.effective_on DESC,r.published_at DESC,r.id DESC
 ), parents AS MATERIALIZED (
  SELECT c.id,CASE WHEN p.company_id IS NOT NULL THEN p.parent_company_id ELSE c.parent_company_id END AS parent_id
  FROM public.company c LEFT JOIN published_parents p ON p.company_id=c.id WHERE c.tenant_id=app.current_tenant_id()
 ), lineage(company_id,ancestor_id,path) AS (
  SELECT c.company_id,c.company_id,ARRAY[c.company_id] FROM wanted_companies c
  UNION ALL SELECT l.company_id,p.id,l.path||p.id FROM lineage l JOIN parents current_parent ON current_parent.id=l.ancestor_id
   JOIN parents p ON p.id=current_parent.parent_id WHERE NOT(p.id=ANY(l.path))
 ), candidate_pairs AS MATERIALIZED (
  SELECT DISTINCT u.id AS user_id,v.company_id FROM visible v JOIN configured_members m ON m.id=v.approver_group_id
  JOIN active_people u ON u.id=m.user_id AND u.person_id IS DISTINCT FROM v.person_id
 ), role_pairs AS MATERIALIZED (
  SELECT DISTINCT p.user_id,p.company_id FROM candidate_pairs p JOIN public.role_assignment r
   ON r.tenant_id=app.current_tenant_id() AND r.app_user_id=p.user_id AND r.role::text IN('hr_admin','super_admin')
   AND (r.company_id IS NULL OR EXISTS(SELECT 1 FROM lineage l WHERE l.company_id=p.company_id AND l.ancestor_id=r.company_id))
 ), capability AS MATERIALIZED (
  SELECT c.supported,c.scope,jsonb_array_length(c.bindings)>0 AS bound,coalesce(cfg.initialized,false) AS initialized
  -- The canonical inlined catalogue preserves this tenant's previous state during a partial publication.
  FROM app.access_capability_effective(app.current_tenant_id()) c LEFT JOIN public.access_configuration cfg ON cfg.tenant_id=app.current_tenant_id()
  WHERE c.id='workforce.maintain'
 ), overrides AS MATERIALIZED (
  SELECT DISTINCT p.user_id,p.company_id,o.effect FROM role_pairs p JOIN public.access_user_override o
   ON o.tenant_id=app.current_tenant_id() AND o.user_id=p.user_id AND o.capability_id='workforce.maintain' AND o.retired_at IS NULL
   AND (o.company_id IS NULL OR EXISTS(SELECT 1 FROM lineage l WHERE l.company_id=p.company_id AND l.ancestor_id=o.company_id))
 ), memberships AS MATERIALIZED (
  SELECT m.user_id,m.group_id,m.company_id FROM public.access_effective_membership m JOIN wanted_users w ON w.user_id=m.user_id
  WHERE m.tenant_id=app.current_tenant_id()
 ), group_rights AS MATERIALIZED (
  SELECT DISTINCT p.user_id,p.company_id FROM role_pairs p JOIN memberships m ON m.user_id=p.user_id
  JOIN public.access_group g ON g.tenant_id=app.current_tenant_id() AND g.id=m.group_id AND g.retired_at IS NULL
  JOIN public.access_group_grant a ON a.tenant_id=g.tenant_id AND a.group_id=g.id AND a.capability_id='workforce.maintain' AND a.retired_at IS NULL
  WHERE (m.company_id IS NULL OR EXISTS(SELECT 1 FROM lineage l WHERE l.company_id=p.company_id AND l.ancestor_id=m.company_id))
   AND (a.company_id IS NULL OR EXISTS(SELECT 1 FROM lineage l WHERE l.company_id=p.company_id AND l.ancestor_id=a.company_id))
 ), permitted AS MATERIALIZED (
  SELECT p.user_id,p.company_id FROM role_pairs p CROSS JOIN capability c
  WHERE NOT c.supported OR c.scope='company' AND c.bound AND c.initialized
   AND NOT EXISTS(SELECT 1 FROM overrides o WHERE o.user_id=p.user_id AND o.company_id=p.company_id AND o.effect='deny')
   AND (EXISTS(SELECT 1 FROM overrides o WHERE o.user_id=p.user_id AND o.company_id=p.company_id AND o.effect='allow')
    OR EXISTS(SELECT 1 FROM group_rights g WHERE g.user_id=p.user_id AND g.company_id=p.company_id))
 ), ranked AS (
  SELECT v.id,u.name,row_number() OVER(PARTITION BY v.id ORDER BY u.name NULLS LAST,u.id) AS rank,
   count(*) OVER(PARTITION BY v.id)::integer AS total
  FROM visible v JOIN configured_members m ON m.id=v.approver_group_id
  JOIN active_people u ON u.id=m.user_id AND u.person_id IS DISTINCT FROM v.person_id
  JOIN permitted p ON p.user_id=u.id AND p.company_id=v.company_id
 )
 SELECT v.id,coalesce(array_agg(r.name ORDER BY r.rank) FILTER(WHERE r.rank<=3 AND r.name IS NOT NULL),'{}'::text[]),coalesce(max(r.total),0)
 FROM visible v LEFT JOIN ranked r ON r.id=v.id GROUP BY v.id;
$$;
REVOKE ALL ON FUNCTION app.offboarding_posting_waiting_members(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.offboarding_posting_waiting_members(uuid[]) TO ai_hr_app;
