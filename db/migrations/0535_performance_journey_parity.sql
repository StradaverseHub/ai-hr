-- Native assessment journey: private working copies, persisted conversations and catalogue.
-- Apply strictly after 0531–0534. Historical assessment identifiers remain stable.
ALTER TABLE performance_onehr_review ADD COLUMN self_remark text NOT NULL DEFAULT '', ADD COLUMN competency_self_remark text NOT NULL DEFAULT '', ADD COLUMN competency_manager_remark text NOT NULL DEFAULT '';
ALTER TABLE performance_onehr_plan ADD COLUMN conversation_held_on date;
ALTER TABLE performance_onehr_calibration ADD COLUMN pip_locked_at timestamptz, ADD COLUMN promotion_locked_at timestamptz;
ALTER TABLE performance_onehr_calibration_entry ADD COLUMN pip_reason text NOT NULL DEFAULT '', ADD COLUMN promotion_reason text NOT NULL DEFAULT '', ADD COLUMN special_reward_reason text NOT NULL DEFAULT '';
CREATE TABLE performance_assessment_draft (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 review_id uuid NOT NULL REFERENCES performance_onehr_review(review_id), actor_user_id uuid NOT NULL REFERENCES app_user(id),
 kind text NOT NULL CHECK(kind IN ('results','moderation','competency_self','competency_manager','feedback')),
 context_id uuid NOT NULL, payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=100000),
 revision integer NOT NULL DEFAULT 1, review_revision integer NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(review_id,actor_user_id,kind,context_id)
);
CREATE TABLE performance_assessment_conversation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 review_id uuid NOT NULL REFERENCES performance_onehr_review(review_id), actor_user_id uuid NOT NULL REFERENCES app_user(id),
 stage text NOT NULL CHECK(stage IN ('setting','results','moderation','competency','career','evidence')),
 messages jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(messages)='array' AND octet_length(messages::text)<=1000000),
 revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(review_id,actor_user_id,stage)
);
CREATE TABLE performance_kpi_library (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid REFERENCES company(id),group_company_id uuid REFERENCES company(id),tier integer NOT NULL DEFAULT 0 CHECK(tier BETWEEN 0 AND 4),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 300),description text NOT NULL DEFAULT '',template jsonb NOT NULL,
 grades text[] NOT NULL DEFAULT '{}',department_ids uuid[] NOT NULL DEFAULT '{}',archived_at timestamptz,
 revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE performance_assessment_attachment_link (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 review_id uuid NOT NULL REFERENCES performance_onehr_review(review_id),attachment_id uuid NOT NULL REFERENCES performance_attachment(id),
 kpi_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(attachment_id,kpi_id)
);
--> statement-breakpoint
CREATE FUNCTION app.assessment_private_access(wanted_review uuid, wanted_kind text, wanted_context uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_review r WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id())
 AND CASE WHEN wanted_kind='feedback' THEN (app.onehr_feedback_card(wanted_context)->>'reviewId')::uuid=wanted_review
 ELSE wanted_context=wanted_review AND app.onehr_review_header(wanted_review) IS NOT NULL END
$$;
CREATE FUNCTION app.assessment_journey_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n jsonb:=to_jsonb(NEW); o jsonb; tid uuid:=NEW.tenant_id;
BEGIN
 IF TG_TABLE_NAME='performance_kpi_library' THEN
  IF NEW.group_company_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM company WHERE id=NEW.group_company_id AND tenant_id=tid) THEN RAISE EXCEPTION 'Invalid library group scope'; END IF;
  IF NEW.group_company_id IS NOT NULL AND NEW.company_id IS NOT NULL AND NOT app.is_company_descendant(NEW.company_id,NEW.group_company_id) THEN RAISE EXCEPTION 'Library company is outside its group'; END IF;
  IF NEW.company_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM company WHERE id=NEW.company_id AND tenant_id=tid) OR EXISTS(SELECT 1 FROM unnest(NEW.department_ids) d WHERE NOT EXISTS(SELECT 1 FROM department WHERE id=d AND tenant_id=tid AND (NEW.company_id IS NULL OR company_id=NEW.company_id) AND (NEW.group_company_id IS NULL OR app.is_company_descendant(company_id,NEW.group_company_id)))) THEN RAISE EXCEPTION 'Invalid KPI library scope'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM performance_onehr_review WHERE review_id=NEW.review_id AND tenant_id=tid) THEN RAISE EXCEPTION 'Invalid assessment reference'; END IF;
  IF TG_TABLE_NAME='performance_assessment_attachment_link' THEN
   IF NOT EXISTS(SELECT 1 FROM performance_attachment WHERE id=NEW.attachment_id AND review_id=NEW.review_id AND tenant_id=tid) OR NOT EXISTS(SELECT 1 FROM performance_onehr_review r, jsonb_array_elements(r.kpis) k WHERE r.review_id=NEW.review_id AND k->>'id'=NEW.kpi_id::text) THEN RAISE EXCEPTION 'Attachment must belong to this assessment and KPI'; END IF;
   IF EXISTS(SELECT 1 FROM performance_onehr_result WHERE review_id=NEW.review_id) THEN RAISE EXCEPTION 'Finalized assessment evidence is immutable'; END IF;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM app_user WHERE id=NEW.actor_user_id AND tenant_id=tid) THEN RAISE EXCEPTION 'Invalid assessment actor'; END IF;
   IF TG_TABLE_NAME='performance_assessment_draft' AND (NEW.kind='feedback' AND NOT EXISTS(SELECT 1 FROM performance_onehr_panel WHERE request_id=NEW.context_id AND review_id=NEW.review_id AND tenant_id=tid) OR NEW.kind<>'feedback' AND NEW.context_id<>NEW.review_id) THEN RAISE EXCEPTION 'Invalid draft context'; END IF;
  END IF;
 END IF;
 IF TG_OP='UPDATE' THEN
  o:=to_jsonb(OLD);
  IF n->'tenant_id' IS DISTINCT FROM o->'tenant_id' OR n->'review_id' IS DISTINCT FROM o->'review_id' OR n->'actor_user_id' IS DISTINCT FROM o->'actor_user_id' OR n->'kind' IS DISTINCT FROM o->'kind' OR n->'context_id' IS DISTINCT FROM o->'context_id' OR n->'stage' IS DISTINCT FROM o->'stage' THEN RAISE EXCEPTION 'Assessment workspace identity is immutable'; END IF;
  IF TG_TABLE_NAME='performance_assessment_conversation' AND (jsonb_array_length(NEW.messages)<jsonb_array_length(OLD.messages) OR EXISTS(SELECT 1 FROM jsonb_array_elements(OLD.messages) WITH ORDINALITY p(v,i) WHERE NEW.messages->((p.i-1)::integer) IS DISTINCT FROM p.v)) THEN RAISE EXCEPTION 'Assessment conversation is append-only'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.assessment_private_access(uuid,text,uuid),app.assessment_journey_validate() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_private_access(uuid,text,uuid) TO ai_hr_app;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['performance_assessment_draft','performance_assessment_conversation','performance_kpi_library','performance_assessment_attachment_link'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO ai_hr_app',t);
 EXECUTE format('CREATE TRIGGER assessment_journey_links BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.assessment_journey_validate()',t);
END LOOP; END $$;
CREATE POLICY assessment_draft_private ON performance_assessment_draft FOR ALL USING(tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id() AND app.assessment_private_access(review_id,kind,context_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id() AND app.assessment_private_access(review_id,kind,context_id));
CREATE POLICY assessment_conversation_private ON performance_assessment_conversation FOR ALL USING(tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id() AND app.assessment_private_access(review_id,'conversation',review_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id() AND app.assessment_private_access(review_id,'conversation',review_id));
CREATE POLICY kpi_library_read ON performance_kpi_library FOR SELECT USING(tenant_id=app.current_tenant_id() AND (company_id IS NULL AND group_company_id IS NULL OR app.onehr_admin(coalesce(company_id,group_company_id)) OR EXISTS(SELECT 1 FROM employment e WHERE (performance_kpi_library.company_id IS NULL OR e.company_id=performance_kpi_library.company_id) AND (performance_kpi_library.group_company_id IS NULL OR app.is_company_descendant(e.company_id,performance_kpi_library.group_company_id)) AND app.can_see_employment(e.id))));
CREATE POLICY kpi_library_write ON performance_kpi_library FOR ALL USING(tenant_id=app.current_tenant_id() AND app.onehr_admin(coalesce(company_id,group_company_id))) WITH CHECK(tenant_id=app.current_tenant_id() AND app.onehr_admin(coalesce(company_id,group_company_id)));
CREATE POLICY assessment_attachment_link_access ON performance_assessment_attachment_link FOR ALL USING(tenant_id=app.current_tenant_id() AND app.onehr_attachment_access(review_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.onehr_attachment_access(review_id));
CREATE FUNCTION app.performance_kpi_library_company_in_use(wanted_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM performance_kpi_library WHERE company_id=wanted_company AND tenant_id=app.current_tenant_id()) $$;
REVOKE ALL ON FUNCTION app.performance_kpi_library_company_in_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.performance_kpi_library_company_in_use(uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onehr_validate_links() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r performance_review; s performance_onehr_calibration; n jsonb:=to_jsonb(NEW); o jsonb; rid uuid:=(n->>'review_id')::uuid; eid uuid:=(n->>'employment_id')::uuid; tid uuid:=(n->>'tenant_id')::uuid;
BEGIN
 IF TG_TABLE_NAME='performance_onehr_cycle' THEN
  IF NOT EXISTS(SELECT 1 FROM review_cycle c WHERE c.id=(n->>'cycle_id')::uuid AND c.tenant_id=tid) THEN RAISE EXCEPTION 'Invalid assessment cycle'; END IF;
 ELSIF TG_TABLE_NAME='performance_onehr_calibration' THEN
  IF NOT EXISTS(SELECT 1 FROM performance_onehr_cycle c WHERE c.cycle_id=(n->>'cycle_id')::uuid AND c.tenant_id=tid) OR (n->>'company_id') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM company c WHERE c.id=(n->>'company_id')::uuid AND c.tenant_id=tid) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(n->'reviewer_user_ids') uid WHERE NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=uid::uuid AND u.tenant_id=tid AND u.archived_at IS NULL)) THEN RAISE EXCEPTION 'Invalid assessment calibration scope or reviewer'; END IF;
 ELSE
  SELECT * INTO r FROM performance_review WHERE id=rid AND tenant_id=tid;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Invalid assessment review'; END IF;
  IF TG_TABLE_NAME='performance_onehr_panel' THEN
   IF NOT EXISTS(SELECT 1 FROM peer_feedback_request f JOIN employment e ON e.id=f.peer_employment_id AND e.tenant_id=f.tenant_id JOIN employment sub ON sub.id=f.subject_employment_id AND sub.tenant_id=f.tenant_id WHERE f.id=(n->>'request_id')::uuid AND f.tenant_id=tid AND f.review_id=r.id AND f.subject_employment_id=(n->>'subject_employment_id')::uuid AND f.peer_employment_id=(n->>'peer_employment_id')::uuid AND e.person_id<>sub.person_id) OR (n->>'subject_employment_id')::uuid<>r.employment_id THEN RAISE EXCEPTION 'Invalid assessment panel'; END IF;
  ELSE
   IF eid<>r.employment_id THEN RAISE EXCEPTION 'Invalid assessment subject'; END IF;
   IF TG_TABLE_NAME IN ('performance_onehr_review','performance_onehr_result') AND (n->>'cycle_id')::uuid<>r.cycle_id THEN RAISE EXCEPTION 'Invalid assessment cycle reference'; END IF;
   IF TG_TABLE_NAME='performance_onehr_review' AND TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=eid AND e.tenant_id=tid AND e.company_id=(n->>'company_id')::uuid) THEN RAISE EXCEPTION 'Invalid assessment company'; END IF;
   IF TG_TABLE_NAME='performance_onehr_calibration_entry' THEN
    SELECT * INTO s FROM performance_onehr_calibration WHERE id=(n->>'session_id')::uuid AND tenant_id=tid;
    IF s.id IS NULL OR s.cycle_id<>r.cycle_id OR s.company_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM performance_onehr_review e WHERE e.review_id=r.id AND e.tenant_id=tid AND (e.company_id=s.company_id OR app.is_company_descendant(e.company_id,s.company_id))) THEN RAISE EXCEPTION 'Invalid assessment calibration cohort'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(r.id::text,0));
    IF EXISTS(SELECT 1 FROM performance_onehr_calibration_entry e JOIN performance_onehr_calibration c ON c.id=e.session_id WHERE e.review_id=rid AND c.tier=s.tier AND e.session_id<>s.id) THEN RAISE EXCEPTION 'A person may belong to one calibration scope at each tier'; END IF;
   END IF;
   IF TG_TABLE_NAME='performance_onehr_evidence' AND (n->>'supersedes_id') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM performance_onehr_evidence e WHERE e.id=(n->>'supersedes_id')::uuid AND e.tenant_id=tid AND e.employment_id=eid) THEN RAISE EXCEPTION 'Invalid assessment evidence correction'; END IF;
  END IF;
 END IF;
 IF TG_TABLE_NAME IN ('performance_onehr_panel','performance_onehr_calibration_entry') AND TG_OP='INSERT' AND EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=rid) THEN RAISE EXCEPTION 'Finalized assessment inputs are immutable'; END IF;
 IF TG_OP='UPDATE' THEN
  o:=to_jsonb(OLD);
  IF n->>'tenant_id' IS DISTINCT FROM o->>'tenant_id' OR n->>'review_id' IS DISTINCT FROM o->>'review_id' OR n->>'employment_id' IS DISTINCT FROM o->>'employment_id' OR n->>'cycle_id' IS DISTINCT FROM o->>'cycle_id' THEN RAISE EXCEPTION 'assessment record identity is immutable'; END IF;
  IF TG_TABLE_NAME='performance_onehr_review' AND n->'kpis' IS DISTINCT FROM o->'kpis' THEN
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(n->'kpis') k WHERE k->>'moderatorEmploymentId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM employment m JOIN employment sub ON sub.id=eid WHERE m.id=(k->>'moderatorEmploymentId')::uuid AND m.tenant_id=tid AND m.person_id<>sub.person_id)) THEN RAISE EXCEPTION 'Invalid KPI moderator'; END IF;
   IF NOT app.onehr_cycle_admin(r.cycle_id) AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(n->'kpis') k LEFT JOIN LATERAL (SELECT prior FROM jsonb_array_elements(o->'kpis') prior WHERE prior->>'id'=k->>'id') old_k ON true
    WHERE (k->>'moderatorSource'='matrix' AND (k->>'moderatorSource' IS DISTINCT FROM old_k.prior->>'moderatorSource' OR k->>'moderatorEmploymentId' IS DISTINCT FROM old_k.prior->>'moderatorEmploymentId'))
     OR coalesce((k->>'hrOwned')::boolean,false) IS DISTINCT FROM coalesce((old_k.prior->>'hrOwned')::boolean,false)
   ) THEN RAISE EXCEPTION 'HR assigns matrix moderators and company-owned KPI results'; END IF;
   IF NOT app.onehr_cycle_admin(r.cycle_id) AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(o->'kpis') old_k WHERE coalesce((old_k->>'hrOwned')::boolean,false)
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(n->'kpis') k WHERE k->>'id'=old_k->>'id' AND k=old_k)
   ) THEN RAISE EXCEPTION 'Company-owned KPI results are read-only'; END IF;
  END IF;
  IF TG_TABLE_NAME='performance_onehr_review' AND (n->'company_id' IS DISTINCT FROM o->'company_id' OR n->'grade' IS DISTINCT FROM o->'grade' OR n->'statements' IS DISTINCT FROM o->'statements') THEN RAISE EXCEPTION 'assessment opening snapshot is immutable'; END IF;
  IF TG_TABLE_NAME='performance_onehr_cycle' AND EXISTS(SELECT 1 FROM review_cycle c WHERE c.id=(n->>'cycle_id')::uuid AND c.status<>'draft') AND ((n->'policy')-'windows' IS DISTINCT FROM (o->'policy')-'windows' OR EXISTS(SELECT 1 FROM review_cycle c WHERE c.id=(n->>'cycle_id')::uuid AND c.status='closed')) THEN RAISE EXCEPTION 'An opened assessment assessment policy is immutable; only active deadlines can change'; END IF;
  IF TG_TABLE_NAME='performance_onehr_plan' AND o->>'status'<>'draft' THEN
   IF (SELECT coalesce(jsonb_agg(g->'id' ORDER BY idx),'[]'::jsonb) FROM jsonb_array_elements(n->'goals') WITH ORDINALITY q(g,idx)) IS DISTINCT FROM (SELECT coalesce(jsonb_agg(g->'id' ORDER BY idx),'[]'::jsonb) FROM jsonb_array_elements(o->'goals') WITH ORDINALITY q(g,idx)) THEN RAISE EXCEPTION 'Shared goal identities are immutable'; END IF;
   IF o->>'status'='closed' AND ((SELECT coalesce(jsonb_agg(g-'status' ORDER BY idx),'[]'::jsonb) FROM jsonb_array_elements(n->'goals') WITH ORDINALITY q(g,idx)) IS DISTINCT FROM (SELECT coalesce(jsonb_agg(g-'status' ORDER BY idx),'[]'::jsonb) FROM jsonb_array_elements(o->'goals') WITH ORDINALITY q(g,idx)) OR n->'manager_comment' IS DISTINCT FROM o->'manager_comment') THEN RAISE EXCEPTION 'Closed plan definitions and remarks are immutable'; END IF;
  END IF;
  IF TG_TABLE_NAME='performance_onehr_plan' AND n->'plan_year' IS DISTINCT FROM o->'plan_year' THEN RAISE EXCEPTION 'The development plan year is immutable'; END IF;
  IF TG_TABLE_NAME='performance_onehr_plan' AND o->>'status'<>'draft' AND (n->'career' IS DISTINCT FROM o->'career' OR n->>'status'='draft' OR o->>'status'='closed' AND n->>'status'<>'closed' OR ((SELECT coalesce(jsonb_agg(g-ARRAY['status','managerComment'] ORDER BY idx),'[]'::jsonb) FROM jsonb_array_elements(n->'goals') WITH ORDINALITY q(g,idx)) IS DISTINCT FROM (SELECT coalesce(jsonb_agg(g-ARRAY['status','managerComment'] ORDER BY idx),'[]'::jsonb) FROM jsonb_array_elements(o->'goals') WITH ORDINALITY q(g,idx)) AND NOT (o->>'status'='shared' AND app.assessment_plan_reviewer((n->>'id')::uuid)))) THEN RAISE EXCEPTION 'Shared development plan definitions are immutable'; END IF;
  IF TG_TABLE_NAME='performance_onehr_calibration_entry' THEN
   IF n->'pip' IS DISTINCT FROM o->'pip' OR n->'pip_reason' IS DISTINCT FROM o->'pip_reason' THEN
    IF s.locked_at IS NULL OR s.pip_locked_at IS NOT NULL OR s.tier NOT IN ('bg','group','final') THEN RAISE EXCEPTION 'PIP decisions require a locked calibration and an open PIP list'; END IF;
   END IF;
   IF n->'promotion' IS DISTINCT FROM o->'promotion' OR n->'promotion_reason' IS DISTINCT FROM o->'promotion_reason' THEN
    IF s.locked_at IS NULL OR s.pip_locked_at IS NULL OR s.promotion_locked_at IS NOT NULL OR s.tier NOT IN ('bg','group','final') THEN RAISE EXCEPTION 'Promotion decisions require a confirmed PIP list and an open promotion list'; END IF;
   END IF;
  END IF;
  IF TG_TABLE_NAME='performance_onehr_result' AND n-ARRAY['performance_released_at','potential_released_at','talent_released_at','feedback_released_at'] IS DISTINCT FROM o-ARRAY['performance_released_at','potential_released_at','talent_released_at','feedback_released_at'] THEN RAISE EXCEPTION 'A frozen assessment result is immutable'; END IF;
  IF TG_TABLE_NAME IN ('performance_onehr_panel','performance_onehr_calibration_entry') AND EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=rid) AND n IS DISTINCT FROM o THEN RAISE EXCEPTION 'Finalized assessment inputs are immutable'; END IF;
  IF TG_TABLE_NAME='performance_onehr_panel' AND (o->>'submitted_at') IS NOT NULL AND n IS DISTINCT FROM o THEN RAISE EXCEPTION 'Submitted feedback is immutable'; END IF;
  IF TG_TABLE_NAME='performance_onehr_review' AND EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=rid) THEN RAISE EXCEPTION 'A finalized assessment review is immutable'; END IF;
  IF TG_TABLE_NAME='performance_onehr_evidence' AND n->'responses' IS DISTINCT FROM o->'responses' AND (o->>'state'<>'shared' OR jsonb_array_length(n->'responses')<>jsonb_array_length(o->'responses')+1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(o->'responses') WITH ORDINALITY prev(v,idx) WHERE n->'responses'->((prev.idx-1)::integer) IS DISTINCT FROM prev.v) OR n->'responses'->(jsonb_array_length(o->'responses'))->>'userId' IS DISTINCT FROM app.current_user_id()::text) THEN RAISE EXCEPTION 'Evidence responses are append-only'; END IF;
  IF TG_TABLE_NAME='performance_onehr_evidence' AND o->>'state'<>'draft' AND n-ARRAY['state','responses'] IS DISTINCT FROM o-ARRAY['state','responses'] THEN RAISE EXCEPTION 'Correct shared evidence with a new entry'; END IF;
 END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onehr_decisions(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('tier',s.tier,'mode',s.mode,'performance',e.performance,'potential',e.potential,'performanceLocked',e.performance_locked_at IS NOT NULL OR s.performance_locked_at IS NOT NULL,'potentialLocked',e.potential_locked_at IS NOT NULL OR s.potential_locked_at IS NOT NULL,'locked',e.locked_at IS NOT NULL OR s.locked_at IS NOT NULL,'pipConfirmed',s.pip_locked_at IS NOT NULL,'promotionConfirmed',s.promotion_locked_at IS NOT NULL,'pip',e.pip,'promotion',e.promotion,'specialReward',e.special_reward) ORDER BY CASE s.tier WHEN 'hod' THEN 1 WHEN 'bu' THEN 2 WHEN 'bg' THEN 3 WHEN 'group' THEN 4 ELSE 5 END),'[]'::jsonb)
 FROM performance_onehr_calibration_entry e JOIN performance_onehr_calibration s ON s.id=e.session_id AND s.tenant_id=e.tenant_id JOIN performance_review r ON r.id=e.review_id AND r.tenant_id=e.tenant_id JOIN employment emp ON emp.id=e.employment_id AND emp.tenant_id=e.tenant_id
 WHERE e.review_id=wanted_review AND e.tenant_id=app.current_tenant_id() AND NOT app.is_self_person(emp.person_id) AND (app.onehr_cycle_admin(r.cycle_id) OR app.onehr_manager(r.id) OR EXISTS(SELECT 1 FROM performance_onehr_calibration_entry ce WHERE ce.review_id=r.id AND app.onehr_calibration_access(ce.session_id)))
$$;
REVOKE ALL ON FUNCTION app.onehr_decisions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_decisions(uuid) TO ai_hr_app;


CREATE FUNCTION app.performance_kpi_library_group_in_use(wanted_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM performance_kpi_library WHERE group_company_id=wanted_company AND tenant_id=app.current_tenant_id()) $$;
REVOKE ALL ON FUNCTION app.performance_kpi_library_group_in_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.performance_kpi_library_group_in_use(uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onehr_moderator(wanted_review uuid,wanted_kpi uuid DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_review r JOIN performance_review pr ON pr.id=r.review_id JOIN employment sub ON sub.id=r.employment_id JOIN app_user u ON u.id=app.current_user_id() AND u.tenant_id=r.tenant_id CROSS JOIN LATERAL jsonb_array_elements(r.kpis) k CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_array_length(coalesce(k->'approvalChain','[]'::jsonb))>0 THEN k->'approvalChain' ELSE jsonb_build_array(jsonb_build_object('employmentId',k->>'moderatorEmploymentId','at',NULL)) END) WITH ORDINALITY step(v,idx) JOIN employment m ON m.id=(step.v->>'employmentId')::uuid AND m.tenant_id=r.tenant_id AND m.person_id=u.person_id
 WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND (wanted_kpi IS NULL OR k->>'id'=wanted_kpi::text AND coalesce((k->>'locked')::boolean,false)=false AND step.v->>'at' IS NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(k->'approvalChain','[]'::jsonb)) WITH ORDINALITY earlier(v,idx) WHERE earlier.idx<step.idx AND earlier.v->>'at' IS NULL)) AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND sub.person_id<>m.person_id AND (m.terminated_on IS NULL OR m.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND (k->>'moderatorSource'='matrix' OR m.id=pr.reviewer_employment_id OR EXISTS(SELECT 1 FROM reporting_line l WHERE l.subordinate_employment_id=sub.id AND l.manager_employment_id=m.id AND l.line_type IN ('functional','project','dotted') AND l.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (l.valid_to IS NULL OR l.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND l.superseded_at IS NULL)))
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onehr_moderator_choices(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'name',p.full_name,'personId',m.person_id)),'[]'::jsonb) FROM performance_review r JOIN employment sub ON sub.id=r.employment_id AND sub.tenant_id=r.tenant_id JOIN employment m ON m.tenant_id=r.tenant_id JOIN person p ON p.id=m.person_id WHERE r.id=wanted_review AND r.tenant_id=app.current_tenant_id() AND app.onehr_review_header(r.id) IS NOT NULL AND sub.person_id<>m.person_id AND (m.terminated_on IS NULL OR m.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND (EXISTS(SELECT 1 FROM performance_onehr_review rr, jsonb_array_elements(rr.kpis) k WHERE rr.review_id=r.id AND k->>'moderatorSource'='matrix' AND k->>'moderatorEmploymentId'=m.id::text) OR m.id=r.reviewer_employment_id OR EXISTS(SELECT 1 FROM reporting_line l WHERE l.subordinate_employment_id=sub.id AND l.manager_employment_id=m.id AND l.line_type IN ('functional','project','dotted') AND l.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (l.valid_to IS NULL OR l.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND l.superseded_at IS NULL))
$$;
--> statement-breakpoint
CREATE FUNCTION app.assessment_plan_reviewer(wanted_plan uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_plan p JOIN performance_onehr_review r ON r.employment_id=p.employment_id AND r.tenant_id=p.tenant_id JOIN review_cycle c ON c.id=r.cycle_id JOIN performance_onehr_cycle cfg ON cfg.cycle_id=c.id WHERE p.id=wanted_plan AND p.tenant_id=app.current_tenant_id() AND p.plan_year=extract(year from c.period_end)::integer+CASE WHEN cfg.policy->>'kind'='year_end' THEN 1 ELSE 0 END AND (app.onehr_manager(r.review_id) OR app.onehr_moderator(r.review_id)))
$$;
REVOKE ALL ON FUNCTION app.assessment_plan_reviewer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_plan_reviewer(uuid) TO ai_hr_app;
ALTER POLICY onehr_plan_access ON performance_onehr_plan USING(tenant_id=app.current_tenant_id() AND (employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]) OR app.assessment_plan_reviewer(id)) AND (status<>'draft' OR EXISTS(SELECT 1 FROM employment e WHERE e.id=performance_onehr_plan.employment_id AND app.is_self_person(e.person_id)))) WITH CHECK(tenant_id=app.current_tenant_id() AND (app.can_see_employment(employment_id) OR app.assessment_plan_reviewer(id)));
