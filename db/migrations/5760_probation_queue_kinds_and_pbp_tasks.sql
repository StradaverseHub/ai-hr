-- Probation queues by step kind, the PBP's low-result and Other-outcome tasks (lane I of the Probation Confirmation build;
-- handoff B4, B5, §6; ADR docs/adr/2026-11-15-probation-shared-automation.md). Tag 5760 / idx 5160 / when 1793330005460.
--
-- 1. app.probation_task_list (5756 body): a letter step reaches the queue its kind names (handoff B5; the same rule as
--    lib/document-signing-model.ts signingStepQueue): my pending Review or Approve step is an Approval Item
--    ('letter_review', 'letter_approve'), a Sign step a task ('letter_sign'); revising (owner) and releasing stay tasks.
--    The PBP also gets 'low_result_action' (Band at or below the case's pinned low band, until the action taken with
--    the Line Manager is recorded for the current content revision) and 'choose_outcome' (an Other outcome until the
--    PBP chooses Confirm, Extend or Non-confirmation). The PBP's KPI-gate exception is listed only once the gate holds a
--    review back (case started and the part's issue date reached), not for every case still at Part 1 or waiting for
--    its start date. Bounded and set-based as before.
--    app.probation_pending_signer_kinds(part): the 5752 pending signers with each step's kind, owner only.
-- 2. app.probation_record_low_result_action(part, note): the case's PBP or GBS records the action taken with the Line
--    Manager for a low result. One per part and content revision; a Probation follow-up row, audited.
-- 3. app.probation_decide_other(outcome, expected revision, choice, months, reason): the case's PBP or GBS chooses the
--    real outcome of an Other outcome before any letter. The outcome then proceeds as that outcome (the caller runs the
--    outcome workflows or drafts the letter in the same transaction). The choice and its reason are a follow-up row and
--    audited. An Extend choice keeps its length on the outcome (new nullable column probation_outcome.extension_months,
--    null on every existing row), read by app.probation_evaluation_decision and app.probation_letter_values (2111 body)
--    only while the Line Manager's own recorded outcome is Other.
-- 4. probation_followup.kind also allows 'low_result_action' and 'other_decided' (widened; every existing row passes).
-- No table, grant or purpose-owned object changes besides these; the new functions are owner-owned, two are granted to
-- ai_hr_app and the signer-kinds helper is owner only. Re-created functions keep their signatures, owners and grants.
ALTER TABLE public.probation_followup DROP CONSTRAINT probation_followup_kind_check
--> statement-breakpoint
ALTER TABLE public.probation_followup ADD CONSTRAINT probation_followup_kind_check CHECK(kind IN('followup','development','extension_recommendation','nonconfirmation_recommendation','refusal_request','refusal_confirmed','low_result_action','other_decided')) NOT VALID
--> statement-breakpoint
ALTER TABLE public.probation_followup VALIDATE CONSTRAINT probation_followup_kind_check
--> statement-breakpoint
ALTER TABLE public.probation_outcome ADD COLUMN extension_months integer CONSTRAINT probation_outcome_extension_months_check CHECK(extension_months IS NULL OR extension_months IN(3,6))
--> statement-breakpoint
CREATE FUNCTION app.probation_pending_signer_kinds(p_part uuid) RETURNS TABLE(role text,user_id uuid,kind text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d document_signing_document;current_stage integer;route jsonb;
BEGIN
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=app.current_tenant_id() AND subject_type='probation' AND subject_id=p_part;IF NOT FOUND OR app.document_signing_returned(d.data) THEN RETURN;END IF;
 route:=app.probation_signing_refresh_route(p_part);
 IF route IS NULL THEN RETURN;END IF;
 SELECT min((s->>'stage')::integer) INTO current_stage FROM jsonb_array_elements(route->'steps') s WHERE s->>'required'='true' AND NOT app.document_signing_step_fulfilled(d.data,s);
 RETURN QUERY SELECT s->>'role',(s->>'holderId')::uuid,coalesce(s->>'kind','sign') FROM jsonb_array_elements(route->'steps') s WHERE s->>'required'='true' AND (s->>'stage')::integer=current_stage AND s->>'holderId' IS NOT NULL AND s->>'coveredByStepId' IS NULL AND NOT app.document_signing_step_fulfilled(d.data,s);
END $$
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_task_list(p_category text,p_limit integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();me uuid:=app.current_user_id();day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
 my_person uuid;usable boolean:=false;ops boolean:=false;visible uuid[];lim integer:=least(greatest(coalesce(p_limit,20),1),200);result jsonb;
BEGIN
 IF p_category IS NOT NULL AND p_category NOT IN('approval','task') THEN RAISE EXCEPTION 'Unknown Probation task category';END IF;
 IF t IS NULL OR me IS NULL OR app.probation_active_user() IS NOT TRUE THEN RETURN jsonb_build_object('count',0,'capped',false,'items','[]'::jsonb);END IF;
 SELECT u.person_id,(u.archived_at IS NULL AND NOT app.login_blocked(u.id)) INTO my_person,usable FROM public.app_user u WHERE u.id=me AND u.tenant_id=t;
 IF EXISTS(SELECT 1 FROM public.probation_access m WHERE m.tenant_id=t AND m.user_id=me AND m.role='gbs') THEN
  ops:=coalesce(usable,false) AND coalesce(app.lifecycle_canonical_people_ops_member((SELECT co.id FROM public.company co WHERE co.tenant_id=t ORDER BY co.id LIMIT 1),me),false);
 END IF;
 visible:=ARRAY(SELECT app.probation_visible_among(NULL));
 WITH cs AS MATERIALIZED (
  SELECT c.id,c.employment_id,c.company_id,c.data FROM public.probation_case c
  WHERE c.tenant_id=t AND c.id=ANY(visible)
   AND EXISTS(SELECT 1 FROM public.probation_activation a WHERE a.tenant_id=c.tenant_id AND a.company_id=c.company_id AND a.enabled)
   AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=c.employment_id AND e.tenant_id=c.tenant_id AND e.company_id=c.company_id)
   AND c.data->>'sourceCompanyMoved' IS DISTINCT FROM 'true'),
 h AS MATERIALIZED (SELECT * FROM app.probation_holders_set(ARRAY(SELECT cs.employment_id FROM cs))),
 gbs AS MATERIALIZED (SELECT m.* FROM public.probation_access m WHERE ops AND m.tenant_id=t AND m.user_id=me AND m.role='gbs' AND m.valid_from<=day AND (m.valid_to IS NULL OR m.valid_to>=day)),
 anc AS MATERIALIZED (SELECT * FROM app.probation_company_ancestors(ARRAY(SELECT DISTINCT h.company_id FROM h WHERE EXISTS(SELECT 1 FROM gbs)))),
 gbs_cover AS MATERIALIZED (SELECT DISTINCT anc.company_id,m.department_id,m.business_unit_id FROM gbs m JOIN anc ON anc.ancestor_id=m.company_id),
 -- Holders whose Head of Department / PBP / GBS steps move to me under a general delegation with Probation ticked.
 general AS MATERIALIZED (
  SELECT DISTINCT hu.id AS holder_id FROM public.reporting_line d
  JOIN public.employment de ON de.id=d.manager_employment_id AND de.tenant_id=d.tenant_id AND de.person_id=my_person
  JOIN public.employment he ON he.id=d.subordinate_employment_id AND he.tenant_id=d.tenant_id
  JOIN public.app_user hu ON hu.person_id=he.person_id AND hu.tenant_id=d.tenant_id
  WHERE d.tenant_id=t AND d.line_type::text='delegate' AND d.superseded_at IS NULL AND d.valid_from<=current_date AND (d.valid_to IS NULL OR d.valid_to>current_date)
   AND EXISTS(SELECT 1 FROM public.reporting_line_scope s WHERE s.reporting_line_id=d.id AND s.tenant_id=d.tenant_id AND s.module='probation')),
 parts AS MATERIALIZED (
  SELECT p.id,p.case_id,p.data,p.updated_at,p.content_revision,cs.data AS case_data,h.employee,h.lm,h.hod,h.pbp,
   EXISTS(SELECT 1 FROM gbs_cover g WHERE g.company_id=h.company_id AND (g.department_id IS NULL OR g.department_id=h.department_id) AND (g.business_unit_id IS NULL OR g.business_unit_id=h.business_unit_id)) AS gbs,
   d.data AS doc
  FROM cs JOIN public.probation_part p ON p.case_id=cs.id AND p.tenant_id=t AND coalesce(p.data->>'documentKind','review')='review'
  LEFT JOIN h ON h.employment_id=cs.employment_id
  LEFT JOIN public.document_signing_document d ON d.tenant_id=t AND d.subject_type='probation' AND d.subject_id=p.id
  WHERE cs.data->>'state' NOT IN('withdrawn','confirmed','not_confirmed') AND p.data->>'state'<>'cancelled'),
 -- A superset of the parts on which app.probation_commands can offer me a queue command; cheap tests only.
 candidates AS MATERIALIZED (
  SELECT parts.id,parts.case_id,parts.updated_at,coalesce(nullif(parts.data->>'dueOn','')::date,nullif(parts.case_data->>'endOn','')::date) AS due_on FROM parts
  WHERE
   -- Employee, Line Manager and route steps (Head of Department, PBP, GBS, a delegate or escalated signer) on an open part.
   (parts.data->>'state' NOT IN('not_issued','locked','recorded','completed_offline') AND (
     me=parts.employee OR me=parts.lm OR me=parts.hod OR me=parts.pbp
     OR parts.hod IN(SELECT general.holder_id FROM general) OR parts.pbp IN(SELECT general.holder_id FROM general)
     OR EXISTS(SELECT 1 FROM public.probation_delegate x WHERE x.tenant_id=t AND x.part_id=parts.id AND x.holder_id=me AND x.valid_from<=day AND (x.valid_to IS NULL OR x.valid_to>=day))
     -- 5756: a step assigned on the Part to a person whose Probation work moves to me (general delegation).
     OR EXISTS(SELECT 1 FROM public.probation_delegate x WHERE x.tenant_id=t AND x.part_id=parts.id AND x.kind IN('missing_holder','holder_changed') AND x.holder_id IN(SELECT general.holder_id FROM general) AND x.valid_from<=day AND (x.valid_to IS NULL OR x.valid_to>=day))
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(parts.doc->'route'->'steps','[]'::jsonb)) s WHERE s->>'holderId'=me::text AND NOT app.document_signing_step_fulfilled(parts.doc,s))))
   -- PBP tasks that do not depend on an open route step: KPI exception, employee wait exception, extension and refusal confirmations.
   OR me=parts.pbp AND (
     parts.data->>'state'='not_issued' AND parts.data->>'type'<>'1' AND parts.data->>'kpiException' IS NULL AND parts.case_data->>'kpiAcknowledged' IS DISTINCT FROM 'true' AND parts.case_data->'config'->>'kpiGate'='block'
      -- 5760: only once the gate actually holds the review back (started case, issue date reached), not for every case
      -- still at Part 1 or waiting for its start date.
      AND nullif(parts.case_data->>'startOn','')::date<=day AND nullif(parts.data->>'issueOn','')::date<=day
     OR parts.data->>'state' IN('issued','returned') AND parts.data->>'type'<>'1' AND parts.data->>'staffSubmittedAt' IS NULL AND parts.data->>'employeeWaitException' IS NULL AND parts.data->>'managerSubmittedAt' IS NULL AND parts.case_data->'config'->>'lmWaitsForEmployee'='true'
     OR parts.data->>'managerSubmittedAt' IS NOT NULL AND (EXISTS(SELECT 1 FROM public.probation_rater_draft r WHERE r.part_id=parts.id AND r.rater='lm' AND r.data->>'outcome'='extend')
      OR EXISTS(SELECT 1 FROM public.probation_followup f WHERE f.tenant_id=t AND f.part_id=parts.id AND f.kind='refusal_request')))
   -- GBS People Ops: recording a completed signature set or an offline final.
   OR parts.gbs AND (parts.data->>'state'='pending_approval' OR parts.data->>'state'='completed_offline' AND parts.data->>'type'='3')),
 bounded AS MATERIALIZED (SELECT * FROM candidates ORDER BY due_on,case_id,id LIMIT 201),
 review AS MATERIALIZED (
  SELECT b.case_id,b.id AS part_id,b.due_on,b.updated_at,k.kind,CASE WHEN k.kind='approve' THEN 'approval' ELSE 'task' END AS category,
   '/lifecycle/probation/'||b.case_id::text||'/'||b.id::text AS href
  FROM (SELECT * FROM bounded ORDER BY due_on,case_id,id LIMIT 200) b
  CROSS JOIN LATERAL (SELECT value AS kind FROM unnest(app.probation_commands(b.id)) value
   WHERE value IN('submit_employee','submit_manager','acknowledge','approve','record','confirm_extension','confirm_refusal','kpi_exception','employee_wait_exception') LIMIT 1) k),
 -- Letter Sign / revise / release: only cases with a letter that is not yet released.
 letter_cases AS MATERIALIZED (
  SELECT DISTINCT cs.id FROM cs JOIN public.probation_part l ON l.case_id=cs.id AND l.tenant_id=t AND l.data->>'documentKind'='letter'
  WHERE NOT EXISTS(SELECT 1 FROM public.probation_outcome o WHERE o.tenant_id=t AND o.letter_part_id=l.id AND o.released_at IS NOT NULL)),
 letters AS MATERIALIZED (
  SELECT c.id AS case_id,lt."partId" AS part_id,(c.data->>'endOn')::date AS due_on,lp.updated_at,
   -- 5760 (handoff B5): my pending step's kind decides the queue. Review and Approve go to Approval Items, Sign to the
   -- tasks; revising (the owner) and releasing stay tasks.
   CASE WHEN lt.state='awaiting_revision' THEN 'letter_revise' WHEN lt.state='awaiting_release' THEN 'letter_release'
    WHEN mine.kind='review' THEN 'letter_review' WHEN mine.kind='approve' THEN 'letter_approve' ELSE 'letter_sign' END AS kind,
   CASE WHEN lt.state NOT IN('awaiting_revision','awaiting_release') AND mine.kind IN('review','approve') THEN 'approval' ELSE 'task' END AS category,
   '/lifecycle/probation/'||c.id::text||'/letters/'||lt."partId"::text AS href
  FROM letter_cases lc JOIN public.probation_case c ON c.id=lc.id AND c.tenant_id=t CROSS JOIN LATERAL app.probation_letter_tasks(c.id) lt
  JOIN public.probation_part lp ON lp.id=lt."partId" AND lp.tenant_id=t
  LEFT JOIN LATERAL (SELECT signer.kind FROM app.probation_pending_signer_kinds(lt."partId") signer WHERE signer.user_id=me
   ORDER BY (signer.kind IN('review','approve')) DESC LIMIT 1) mine ON true
  WHERE (mine.kind IS NOT NULL
   OR lt.state IN('awaiting_revision','awaiting_release') AND (app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')))),
 -- 5760 (handoff B5, §6): the PBP's own tasks that no route step carries. A low result (Band at or below the case's
 -- pinned low band) until the action taken with the Line Manager is recorded for this content revision, and an Other
 -- outcome until the PBP chooses the real one. Cheap tests on the visible parts, bounded.
 pbp_work AS MATERIALIZED (
  SELECT parts.case_id,parts.id AS part_id,coalesce(nullif(parts.data->>'dueOn','')::date,nullif(parts.case_data->>'endOn','')::date) AS due_on,parts.updated_at,w.kind,'task'::text AS category,w.href
  FROM parts CROSS JOIN LATERAL (
   SELECT 'low_result_action'::text AS kind,'/lifecycle/probation/'||parts.case_id::text AS href
   WHERE parts.data->>'managerSubmittedAt' IS NOT NULL AND parts.data->>'type'<>'1'
    AND CASE WHEN parts.data->>'scoreBand' ~ '^[1-5]$' THEN (parts.data->>'scoreBand')::integer END
     <=coalesce(CASE WHEN parts.case_data->'config'->>'lowBand' ~ '^[1-5]$' THEN (parts.case_data->'config'->>'lowBand')::integer END,2)
    AND NOT EXISTS(SELECT 1 FROM public.probation_followup f WHERE f.tenant_id=t AND f.part_id=parts.id AND f.kind='low_result_action' AND f.content_revision=parts.content_revision)
   UNION ALL
   SELECT 'choose_outcome'::text,'/lifecycle/probation/'||parts.case_id::text||'/outcomes/'||o.id::text FROM public.probation_outcome o
   WHERE o.tenant_id=t AND o.part_id=parts.id AND o.outcome='other' AND o.released_at IS NULL AND o.state<>'completed') w
  WHERE me=parts.pbp
  ORDER BY 3,1,2 LIMIT 200),
 tasks AS MATERIALIZED (
  SELECT * FROM review WHERE p_category IS NULL OR review.category=p_category
  UNION ALL SELECT * FROM letters WHERE p_category IS NULL OR letters.category=p_category
  UNION ALL SELECT * FROM pbp_work WHERE p_category IS NULL OR pbp_work.category=p_category),
 named AS (
  SELECT tasks.*,person.full_name AS employee_name,c.company_id,(SELECT p.data->>'type' FROM public.probation_part p WHERE p.id=tasks.part_id AND p.tenant_id=t) AS part_type FROM tasks JOIN public.probation_case c ON c.id=tasks.case_id AND c.tenant_id=t
  JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id JOIN public.person person ON person.id=e.person_id AND person.tenant_id=e.tenant_id)
 SELECT jsonb_build_object('count',(SELECT count(*) FROM tasks),'capped',(SELECT count(*) FROM bounded)>200,
  'items',coalesce((SELECT jsonb_agg(jsonb_build_object('caseId',x.case_id,'partId',x.part_id,'employeeName',x.employee_name,'kind',x.kind,'category',x.category,'href',x.href,'dueOn',x.due_on,'updatedAt',x.updated_at,'companyId',x.company_id,'partType',x.part_type) ORDER BY x.due_on,x.case_id,x.part_id)
   FROM (SELECT * FROM named ORDER BY due_on,case_id,part_id LIMIT lim) x),'[]'::jsonb)) INTO result;
 RETURN result;
END $$
--> statement-breakpoint
CREATE FUNCTION app.probation_record_low_result_action(p_part uuid,p_note text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;v_id uuid;band integer;low_band integer:=2;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Probation review unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF app.current_user_id() IS NULL OR NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) THEN RAISE EXCEPTION 'Only the case''s PBP or GBS People Ops may record the low-result action' USING ERRCODE='42501';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 IF length(btrim(coalesce(p_note,''))) NOT BETWEEN 3 AND 10000 THEN RAISE EXCEPTION 'Describe the action taken with the Line Manager' USING ERRCODE='22023';END IF;
 IF p.data->>'scoreBand' ~ '^[1-5]$' THEN band:=(p.data->>'scoreBand')::integer;END IF;
 IF c.data->'config'->>'lowBand' ~ '^[1-5]$' THEN low_band:=(c.data->'config'->>'lowBand')::integer;END IF;
 IF band IS NULL OR band>low_band OR p.data->>'managerSubmittedAt' IS NULL OR p.data->>'state'='cancelled' THEN RAISE EXCEPTION 'This review has no low result to act on' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM probation_followup f WHERE f.tenant_id=p.tenant_id AND f.part_id=p.id AND f.kind='low_result_action' AND f.content_revision=p.content_revision) THEN RAISE EXCEPTION 'The low-result action is already recorded' USING ERRCODE='40001';END IF;
 INSERT INTO probation_followup(tenant_id,case_id,part_id,actor_user_id,kind,note,content_revision) VALUES(p.tenant_id,c.id,p.id,app.current_user_id(),'low_result_action',btrim(p_note),p.content_revision) RETURNING id INTO v_id;
 PERFORM app.probation_audit(c.id,p.id,'low_result_action_recorded');
 RETURN v_id;
END $$
--> statement-breakpoint
CREATE FUNCTION app.probation_decide_other(p_outcome uuid,p_expected integer,p_choice text,p_months integer,p_reason text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;actor uuid:=app.current_user_id();
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Outcome unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id FOR UPDATE;
 IF actor IS NULL OR NOT(app.probation_role(c.employment_id,'pbp') OR app.probation_role(c.employment_id,'gbs')) THEN RAISE EXCEPTION 'Only the case''s PBP or GBS People Ops may decide an Other outcome' USING ERRCODE='42501';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 IF o.revision IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'The outcome changed. Reload the case and try again' USING ERRCODE='40001';END IF;
 IF o.outcome<>'other' OR o.released_at IS NOT NULL OR o.letter_part_id IS NOT NULL OR o.state='completed' OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') THEN RAISE EXCEPTION 'Only an undecided Other outcome can be decided here' USING ERRCODE='22023';END IF;
 IF coalesce(p_choice,'') NOT IN('confirm','extend','not_confirm') OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 3 AND 10000 THEN RAISE EXCEPTION 'Choose Confirm, Extend or Non-confirmation and give a reason' USING ERRCODE='22023';END IF;
 IF p_choice='extend' THEN
  IF coalesce(p_months,0) NOT IN(3,6) OR (c.data->>'extensionCount')::integer>=app.probation_max_extensions(c.data) THEN RAISE EXCEPTION 'Choose a 3 or 6 month extension within the extension limit' USING ERRCODE='22023';END IF;
 ELSIF p_months IS NOT NULL THEN RAISE EXCEPTION 'Only an extension has a length' USING ERRCODE='22023';END IF;
 UPDATE probation_outcome SET outcome=p_choice,extension_months=CASE WHEN p_choice='extend' THEN p_months END,revision=revision+1,state='pending',failure=NULL,updated_at=now() WHERE id=o.id;
 UPDATE probation_case SET data=data||jsonb_build_object('pendingOutcome',p_choice),revision=revision+1 WHERE id=c.id;
 INSERT INTO probation_followup(tenant_id,case_id,part_id,actor_user_id,kind,note) VALUES(o.tenant_id,c.id,o.part_id,actor,'other_decided',btrim(p_reason));
 PERFORM app.probation_audit(c.id,o.part_id,'other_outcome_decided',p_choice);
 RETURN o.revision+1;
END $$
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_evaluation_decision(p_part uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE decision jsonb;chosen probation_outcome;
BEGIN
 SELECT jsonb_build_object('outcome',f.outcome,'extensionMonths',f.extension_months,'justification',f.reason,'provenance','completed_offline') INTO decision FROM probation_offline_final_proposal f JOIN probation_part part ON part.id=f.part_id AND part.tenant_id=f.tenant_id AND part.data->>'offlineProposalId'=f.id::text AND part.data->>'state'='completed_offline' WHERE f.part_id=p_part AND f.tenant_id=app.current_tenant_id() AND f.accepted_at IS NOT NULL AND f.superseded_at IS NULL;
 IF decision IS NULL THEN SELECT data INTO decision FROM probation_rater_draft WHERE part_id=p_part AND tenant_id=app.current_tenant_id() AND rater='lm';END IF;
 -- 5760: an Other outcome the PBP decided (app.probation_decide_other) answers with that choice and its length.
 IF decision->>'outcome'='other' THEN
  SELECT * INTO chosen FROM probation_outcome WHERE part_id=p_part AND tenant_id=app.current_tenant_id();
  IF chosen.id IS NOT NULL AND chosen.outcome<>'other' THEN decision:=decision||jsonb_build_object('outcome',chosen.outcome,'extensionMonths',chosen.extension_months,'decidedFromOther',true);END IF;
 END IF;
 RETURN decision;
END $$
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_letter_values(p_outcome uuid,p_template uuid,p_subject uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;t probation_builder_definition;e employment;a assignment;h jsonb;d document_signing_document;letter document_signing_document;holder uuid;signer_name text;signer_title text;manager_name text;head_name text;partner_name text;months integer;new_end text;result jsonb;subject probation_part;has_signed boolean:=false;
BEGIN
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id();SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;SELECT * INTO t FROM probation_builder_definition WHERE id=p_template AND tenant_id=c.tenant_id;SELECT * INTO e FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id;IF e.id IS NULL OR t.id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO a FROM assignment WHERE employment_id=e.id AND tenant_id=e.tenant_id AND superseded_at IS NULL AND valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (valid_to IS NULL OR valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY valid_from DESC,id LIMIT 1;h:=app.probation_holders(e.id);
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=c.tenant_id AND subject_type='probation' AND subject_id=o.part_id;
 SELECT action->>'actorName' INTO manager_name FROM jsonb_array_elements(d.data->'actions') action WHERE action->>'role'='lm' AND action->>'action'='signed' AND action->>'contentRevision'=d.data->>'contentRevision' AND action->>'contentHash'=d.data->>'contentHash' LIMIT 1;
 SELECT action->>'actorName' INTO head_name FROM jsonb_array_elements(d.data->'actions') action WHERE action->>'role'='hod' AND action->>'action'='signed' AND action->>'contentRevision'=d.data->>'contentRevision' AND action->>'contentHash'=d.data->>'contentHash' LIMIT 1;
 SELECT action->>'actorName' INTO partner_name FROM jsonb_array_elements(d.data->'actions') action WHERE action->>'role'='pbp' AND action->>'action'='signed' AND action->>'contentRevision'=d.data->>'contentRevision' AND action->>'contentHash'=d.data->>'contentHash' LIMIT 1;
 SELECT (h->>(step->>'role'))::uuid INTO holder FROM jsonb_array_elements(t.data->'route'->'steps') step WHERE step->>'required'='true' AND step->>'role'<>'employee' ORDER BY (step->>'stage')::integer,step->>'id' LIMIT 1;
 IF p_subject IS NOT NULL THEN
  SELECT * INTO subject FROM probation_part WHERE id=p_subject AND tenant_id=c.tenant_id AND case_id=c.id;SELECT * INTO letter FROM document_signing_document WHERE subject_id=p_subject AND subject_type='probation' AND tenant_id=c.tenant_id;
  SELECT (action->>'actorId')::uuid,action->>'actorName' INTO holder,signer_name FROM jsonb_array_elements(letter.data->'actions') action JOIN jsonb_array_elements(letter.data->'route'->'steps') step ON step->>'id'=action->>'stepId' WHERE action->>'role'<>'employee' AND action->>'action'='signed' AND action->>'contentRevision'=letter.data->>'contentRevision' AND action->>'contentHash'=letter.data->>'contentHash' ORDER BY (step->>'stage')::integer,step->>'id' LIMIT 1;
  IF signer_name IS NOT NULL THEN has_signed:=true;signer_title:=subject.data->'letterMerge'->>'signatoryTitle';ELSE SELECT (h->>(step->>'role'))::uuid INTO holder FROM jsonb_array_elements(t.data->'route'->'steps') step WHERE step->>'required'='true' AND step->>'role'<>'employee' ORDER BY (step->>'stage')::integer,step->>'id' LIMIT 1;END IF;
 END IF;
 IF signer_name IS NULL THEN SELECT person.full_name INTO signer_name FROM app_user u JOIN person person ON person.id=u.person_id AND person.tenant_id=u.tenant_id WHERE u.id=holder AND u.tenant_id=c.tenant_id;END IF;
 IF NOT has_signed AND signer_title IS NULL THEN SELECT company->>'signatoryTitle' INTO signer_title FROM lc_v9_config configuration CROSS JOIN LATERAL jsonb_array_elements(coalesce(configuration.data->'companies','[]')) company WHERE configuration.tenant_id=c.tenant_id AND company->>'companyId'=c.company_id::text AND company->>'signatoryUserId'=holder::text LIMIT 1;END IF;
 IF NOT has_signed AND nullif(signer_title,'') IS NULL THEN SELECT position.title INTO signer_title FROM app_user u JOIN employment employment ON employment.person_id=u.person_id AND employment.tenant_id=u.tenant_id JOIN assignment assignment ON assignment.employment_id=employment.id AND assignment.tenant_id=employment.tenant_id AND assignment.superseded_at IS NULL AND assignment.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (assignment.valid_to IS NULL OR assignment.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) JOIN position position ON position.id=assignment.position_id AND position.tenant_id=assignment.tenant_id WHERE u.id=holder AND u.tenant_id=c.tenant_id AND (least(employment.terminated_on,employment.resignation_date,employment.last_working_date) IS NULL OR least(employment.terminated_on,employment.resignation_date,employment.last_working_date)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY (employment.company_id=c.company_id) DESC,employment.hired_on DESC,employment.id LIMIT 1;END IF;
 SELECT CASE WHEN data->>'outcome'='other' AND o.outcome<>'other' THEN o.extension_months ELSE (data->>'extensionMonths')::integer END INTO months FROM probation_rater_draft WHERE part_id=o.part_id AND tenant_id=c.tenant_id AND rater='lm';IF o.outcome='extend' AND months IN(3,6) THEN new_end:=((c.data->>'endOn')::date+interval '1 day'+(months::text||' months')::interval-interval '1 day')::date::text;END IF;
 result:=jsonb_build_object('employeeJobTitle',coalesce((SELECT title FROM position WHERE id=a.position_id AND tenant_id=c.tenant_id),''),'employeeGrade',coalesce((SELECT regexp_replace(upper(code),'^(JG|GRADE)[ -]*','','g') FROM job_grade WHERE id=e.grade_id AND tenant_id=e.tenant_id),c.data->>'gradeAtStart'),'businessGroup',coalesce((SELECT bg.legal_name FROM company co JOIN company bg ON bg.id=coalesce(co.parent_company_id,co.id) AND bg.tenant_id=co.tenant_id WHERE co.id=c.company_id AND co.tenant_id=c.tenant_id),''),'businessUnit',coalesce((SELECT name FROM business_unit WHERE id=a.business_unit_id AND tenant_id=c.tenant_id),''),'division',coalesce(e.org_division,''),'department',coalesce((SELECT name FROM department WHERE id=a.department_id AND tenant_id=c.tenant_id),''),'lineManagerName',coalesce(manager_name,(SELECT person.full_name FROM app_user u JOIN person person ON person.id=u.person_id AND person.tenant_id=u.tenant_id WHERE u.id=(h->>'lm')::uuid AND u.tenant_id=c.tenant_id),''),'hodName',coalesce(head_name,(SELECT person.full_name FROM app_user u JOIN person person ON person.id=u.person_id AND person.tenant_id=u.tenant_id WHERE u.id=(h->>'hod')::uuid AND u.tenant_id=c.tenant_id),''),'pbpName',coalesce(partner_name,(SELECT person.full_name FROM app_user u JOIN person person ON person.id=u.person_id AND person.tenant_id=u.tenant_id WHERE u.id=(h->>'pbp')::uuid AND u.tenant_id=c.tenant_id),''),'originalEndOn',coalesce(c.data->>'originalEndOn',c.data->>'endOn'),'reviewPlanMonths',coalesce(c.data->>'planMonths',''),'confirmationEffectiveOn',CASE WHEN o.outcome='confirm' THEN c.data->>'endOn' ELSE '' END,'extensionNewEndOn',coalesce(new_end,''),'extensionCount',coalesce(c.data->>'extensionCount','0'),'maxExtensions',coalesce(c.data->'config'->>'maxExtensions','2'),'signatoryName',coalesce(signer_name,''),'signatoryTitle',coalesce(signer_title,''),'acknowledgedBy','','acknowledgedOn','');IF has_signed OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(letter.data->'actions','[]')) action WHERE action->>'action' IN('signed','acknowledged') AND action->>'contentRevision'=letter.data->>'contentRevision' AND action->>'contentHash'=letter.data->>'contentHash') THEN
 result:=result||jsonb_build_object('businessGroup',coalesce(subject.data->'letterMerge'->'businessGroup',result->'businessGroup'),'businessUnit',coalesce(subject.data->'letterMerge'->'businessUnit',result->'businessUnit'));
 ELSIF t.data->>'organisationMapping'='personnel-v2' THEN
 result:=result||jsonb_build_object('businessGroup',coalesce((SELECT name FROM business_unit WHERE id=a.business_unit_id AND tenant_id=c.tenant_id),''),'businessUnit',coalesce((SELECT legal_name FROM company WHERE id=e.company_id AND tenant_id=c.tenant_id),''));
 END IF;
 RETURN result;
END $$
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_pending_signer_kinds(uuid),app.probation_record_low_result_action(uuid,text),app.probation_decide_other(uuid,integer,text,integer,text) FROM PUBLIC
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_pending_signer_kinds(uuid) FROM ai_hr_app
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_record_low_result_action(uuid,text),app.probation_decide_other(uuid,integer,text,integer,text) TO ai_hr_app
