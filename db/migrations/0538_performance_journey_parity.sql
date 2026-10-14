-- Native assessment journey: private working copies, persisted conversations and catalogue.
-- Unapplied Performance increment: when 1791900000018, after board migrations 0536/0537.
-- Apply strictly after 0531–0535. Historical assessment identifiers remain stable.
ALTER TABLE performance_onehr_review ADD COLUMN profile_id uuid, ADD COLUMN profile_match text, ADD COLUMN self_remark text NOT NULL DEFAULT '', ADD COLUMN competency_self_remark text NOT NULL DEFAULT '', ADD COLUMN competency_manager_remark text NOT NULL DEFAULT '';
ALTER TABLE performance_onehr_panel ADD COLUMN reset_at timestamptz, ADD COLUMN archive_reason text;
ALTER TABLE performance_onehr_panel ADD COLUMN principle_comments jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(principle_comments)='object');
ALTER TABLE performance_onehr_plan ADD COLUMN conversation_held_on date;
ALTER TABLE performance_onehr_evidence ADD COLUMN details jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(details)='object' AND octet_length(details::text)<=5000), ADD COLUMN citations jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(citations)='array'), ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE performance_onehr_calibration ADD COLUMN pip_locked_at timestamptz, ADD COLUMN promotion_locked_at timestamptz;
ALTER TABLE performance_onehr_calibration ADD COLUMN bg_weight integer NOT NULL DEFAULT 50 CHECK(bg_weight BETWEEN 1 AND 99);
ALTER TABLE performance_onehr_calibration_entry ADD COLUMN performance_pinned boolean NOT NULL DEFAULT false, ADD COLUMN potential_pinned boolean NOT NULL DEFAULT false, ADD COLUMN pip_reason text NOT NULL DEFAULT '', ADD COLUMN promotion_reason text NOT NULL DEFAULT '', ADD COLUMN special_reward_reason text NOT NULL DEFAULT '';
ALTER TABLE performance_onehr_cycle ADD COLUMN participation_opened_on date;
CREATE TABLE performance_assessment_participation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 cycle_id uuid NOT NULL REFERENCES review_cycle(id),employment_id uuid NOT NULL REFERENCES employment(id),
 eligible_at_open boolean NOT NULL,reason text NOT NULL CHECK(reason IN ('confirmed','not_confirmed','confirmed_after_open','left','native_rule','existing_review')),
 override text CHECK(override IN ('add','remove')),revision integer NOT NULL DEFAULT 1,
 updated_by uuid REFERENCES app_user(id),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(cycle_id,employment_id)
);
-- Applied reviews predate the confirmation snapshot. Preserve them, rather than silently withdrawing tasks.
INSERT INTO performance_assessment_participation(tenant_id,cycle_id,employment_id,eligible_at_open,reason)
 SELECT tenant_id,cycle_id,employment_id,true,'existing_review' FROM performance_onehr_review;
ALTER TABLE performance_assessment_participation ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_assessment_participation FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON performance_assessment_participation TO ai_hr_app;
CREATE POLICY assessment_participation_admin ON performance_assessment_participation FOR ALL
 USING(tenant_id=app.current_tenant_id() AND app.onehr_cycle_admin(cycle_id) AND EXISTS(SELECT 1 FROM employment e WHERE e.id=employment_id AND e.tenant_id=performance_assessment_participation.tenant_id AND app.onehr_admin(e.company_id)))
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.onehr_cycle_admin(cycle_id) AND EXISTS(SELECT 1 FROM employment e JOIN review_cycle c ON c.id=cycle_id WHERE e.id=employment_id AND e.tenant_id=performance_assessment_participation.tenant_id AND app.onehr_admin(e.company_id) AND (c.company_id IS NULL OR c.company_id=e.company_id)));
CREATE FUNCTION app.assessment_review_participates(wanted_review uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_review r JOIN review_cycle c ON c.id=r.cycle_id AND c.tenant_id=r.tenant_id
  JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
  JOIN performance_assessment_participation p ON p.cycle_id=r.cycle_id AND p.employment_id=r.employment_id AND p.tenant_id=r.tenant_id
  WHERE r.id=wanted_review AND r.tenant_id=app.current_tenant_id()
   AND (c.status='closed' OR e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   AND CASE WHEN p.override='add' THEN true WHEN p.override='remove' THEN false ELSE p.eligible_at_open END
   AND (app.can_see_employment(e.id) OR app.onehr_cycle_admin(r.cycle_id) OR app.onehr_manager(r.id) OR app.onehr_moderator(r.id) OR EXISTS(SELECT 1 FROM performance_onehr_calibration_entry ce WHERE ce.review_id=r.id AND ce.tenant_id=r.tenant_id AND app.onehr_calibration_access(ce.session_id))))
$$;
CREATE FUNCTION app.assessment_participation_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c review_cycle;
BEGIN
 SELECT * INTO c FROM review_cycle WHERE id=NEW.cycle_id AND tenant_id=NEW.tenant_id;
 IF c.id IS NULL OR NOT EXISTS(SELECT 1 FROM performance_onehr_cycle WHERE cycle_id=c.id AND tenant_id=NEW.tenant_id)
  OR NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id AND (c.company_id IS NULL OR e.company_id=c.company_id))
  OR NEW.updated_by IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_user WHERE id=NEW.updated_by AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Invalid participation scope'; END IF;
 IF TG_OP='UPDATE' AND (NEW.tenant_id<>OLD.tenant_id OR NEW.cycle_id<>OLD.cycle_id OR NEW.employment_id<>OLD.employment_id OR NEW.eligible_at_open<>OLD.eligible_at_open OR NEW.reason<>OLD.reason) THEN RAISE EXCEPTION 'Participation opening snapshot is immutable'; END IF;
 IF c.status='closed' OR EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.cycle_id=NEW.cycle_id AND f.employment_id=NEW.employment_id AND f.tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Finalized participation is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assessment_participation_links BEFORE INSERT OR UPDATE ON performance_assessment_participation FOR EACH ROW EXECUTE FUNCTION app.assessment_participation_validate();
REVOKE ALL ON FUNCTION app.assessment_review_participates(uuid),app.assessment_participation_validate() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_review_participates(uuid) TO ai_hr_app;
-- Excluded staff retain their inputs. They disappear from active calibration cohorts, including direct SQL.
-- 0529 finished with separate read/insert/update policies; retain their distinct authorities.
ALTER POLICY onehr_calibration_entry_read ON performance_onehr_calibration_entry USING(
 tenant_id=app.current_tenant_id() AND app.onehr_calibration_access(session_id) AND app.assessment_review_participates(review_id)
 AND NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=employment_id AND e.tenant_id=performance_onehr_calibration_entry.tenant_id AND app.is_self_person(e.person_id)));
ALTER POLICY onehr_calibration_entry_insert ON performance_onehr_calibration_entry WITH CHECK(
 tenant_id=app.current_tenant_id() AND app.assessment_review_participates(review_id) AND EXISTS(SELECT 1 FROM performance_onehr_calibration s JOIN review_cycle c ON c.id=s.cycle_id AND c.tenant_id=s.tenant_id WHERE s.id=session_id AND s.tenant_id=performance_onehr_calibration_entry.tenant_id AND app.onehr_cycle_admin(s.cycle_id) AND c.status IN ('open','calibration')));
ALTER POLICY onehr_calibration_entry_update ON performance_onehr_calibration_entry USING(
 tenant_id=app.current_tenant_id() AND app.onehr_calibration_access(session_id) AND app.assessment_review_participates(review_id)
 AND NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=employment_id AND e.tenant_id=performance_onehr_calibration_entry.tenant_id AND app.is_self_person(e.person_id))
 AND EXISTS(SELECT 1 FROM performance_onehr_calibration s JOIN review_cycle c ON c.id=s.cycle_id AND c.tenant_id=s.tenant_id WHERE s.id=session_id AND s.tenant_id=performance_onehr_calibration_entry.tenant_id AND c.status IN ('open','calibration')));
--> statement-breakpoint
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
 stage text NOT NULL CHECK(stage IN ('setting','results','moderation','competency','career','evidence','journey','feedback')),
 context_id uuid NOT NULL,
 messages jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(messages)='array' AND octet_length(messages::text)<=1000000),
 revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(review_id,actor_user_id,stage,context_id)
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
 AND (wanted_kind NOT IN ('conversation','feedback_conversation') OR EXISTS(SELECT 1 FROM performance_onehr_review r JOIN performance_onehr_cycle c ON c.cycle_id=r.cycle_id AND c.tenant_id=r.tenant_id WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND coalesce((c.policy->'modules'->>'review')::boolean,true)))
 AND CASE WHEN wanted_kind IN ('feedback','feedback_conversation') THEN (app.onehr_feedback_card(wanted_context)->>'reviewId')::uuid=wanted_review
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
  IF TG_TABLE_NAME='performance_assessment_conversation' THEN
   IF (NEW.stage='feedback' AND NOT EXISTS(SELECT 1 FROM performance_onehr_panel p WHERE p.request_id=NEW.context_id AND p.review_id=NEW.review_id AND p.tenant_id=tid) OR NEW.stage<>'feedback' AND NEW.context_id<>NEW.review_id) THEN RAISE EXCEPTION 'Invalid conversation context'; END IF;
   IF EXISTS(SELECT 1 FROM performance_onehr_review r JOIN performance_onehr_cycle c ON c.cycle_id=r.cycle_id AND c.tenant_id=r.tenant_id WHERE r.review_id=NEW.review_id AND r.tenant_id=tid AND c.policy->'modules'->>'review'='false') THEN RAISE EXCEPTION 'Guided review is disabled'; END IF;
  END IF;
  IF TG_TABLE_NAME='performance_assessment_attachment_link' THEN
   IF NOT EXISTS(SELECT 1 FROM performance_attachment WHERE id=NEW.attachment_id AND review_id=NEW.review_id AND tenant_id=tid) OR NOT EXISTS(SELECT 1 FROM performance_onehr_review r, jsonb_array_elements(r.kpis) k WHERE r.review_id=NEW.review_id AND k->>'id'=NEW.kpi_id::text) THEN RAISE EXCEPTION 'Attachment must belong to this assessment and KPI'; END IF;
   IF EXISTS(SELECT 1 FROM performance_onehr_result WHERE review_id=NEW.review_id) THEN RAISE EXCEPTION 'Finalized assessment evidence is immutable'; END IF;
   IF EXISTS(SELECT 1 FROM performance_attachment a WHERE a.id=NEW.attachment_id AND a.tenant_id=tid AND a.evidence_id IS NOT NULL) THEN RAISE EXCEPTION 'Evidence files inherit their KPI links from their entry'; END IF;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM app_user WHERE id=NEW.actor_user_id AND tenant_id=tid) THEN RAISE EXCEPTION 'Invalid assessment actor'; END IF;
   IF TG_TABLE_NAME='performance_assessment_draft' THEN
    IF (NEW.kind='feedback' AND NOT EXISTS(SELECT 1 FROM performance_onehr_panel WHERE request_id=NEW.context_id AND review_id=NEW.review_id AND tenant_id=tid) OR NEW.kind<>'feedback' AND NEW.context_id<>NEW.review_id) THEN RAISE EXCEPTION 'Invalid draft context'; END IF;
   END IF;
  END IF;
 END IF;
 IF TG_OP='UPDATE' THEN
  o:=to_jsonb(OLD);
  IF n->'tenant_id' IS DISTINCT FROM o->'tenant_id' OR n->'review_id' IS DISTINCT FROM o->'review_id' OR n->'actor_user_id' IS DISTINCT FROM o->'actor_user_id' OR n->'kind' IS DISTINCT FROM o->'kind' OR n->'context_id' IS DISTINCT FROM o->'context_id' OR n->'stage' IS DISTINCT FROM o->'stage' THEN RAISE EXCEPTION 'Assessment workspace identity is immutable'; END IF;
  IF TG_TABLE_NAME='performance_assessment_conversation' THEN
   IF (jsonb_array_length(NEW.messages)<jsonb_array_length(OLD.messages) OR EXISTS(SELECT 1 FROM jsonb_array_elements(OLD.messages) WITH ORDINALITY p(v,i) WHERE NEW.messages->((p.i-1)::integer) IS DISTINCT FROM p.v)) THEN RAISE EXCEPTION 'Assessment conversation is append-only'; END IF;
  END IF;
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
CREATE POLICY assessment_conversation_private ON performance_assessment_conversation FOR ALL USING(tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id() AND app.assessment_private_access(review_id,CASE WHEN stage='feedback' THEN 'feedback_conversation' ELSE 'conversation' END,context_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id() AND app.assessment_private_access(review_id,CASE WHEN stage='feedback' THEN 'feedback_conversation' ELSE 'conversation' END,context_id));
CREATE POLICY kpi_library_read ON performance_kpi_library FOR SELECT USING(tenant_id=app.current_tenant_id() AND (company_id IS NULL AND group_company_id IS NULL OR app.onehr_admin(coalesce(company_id,group_company_id)) OR EXISTS(SELECT 1 FROM employment e WHERE (performance_kpi_library.company_id IS NULL OR e.company_id=performance_kpi_library.company_id) AND (performance_kpi_library.group_company_id IS NULL OR app.is_company_descendant(e.company_id,performance_kpi_library.group_company_id)) AND app.can_see_employment(e.id))));
CREATE POLICY kpi_library_write ON performance_kpi_library FOR ALL USING(tenant_id=app.current_tenant_id() AND app.onehr_admin(coalesce(company_id,group_company_id))) WITH CHECK(tenant_id=app.current_tenant_id() AND app.onehr_admin(coalesce(company_id,group_company_id)));
CREATE POLICY assessment_attachment_link_access ON performance_assessment_attachment_link FOR ALL USING(tenant_id=app.current_tenant_id() AND app.onehr_attachment_access(review_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.onehr_attachment_access(review_id));
CREATE FUNCTION app.performance_kpi_library_company_in_use(wanted_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM performance_kpi_library WHERE company_id=wanted_company AND tenant_id=app.current_tenant_id()) $$;
REVOKE ALL ON FUNCTION app.performance_kpi_library_company_in_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.performance_kpi_library_company_in_use(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Missing numbers are valid only while a scorecard is being built. Promotion into an agreed state is guarded here too.
CREATE FUNCTION app.assessment_scoring_number(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(v)='number' THEN abs((v#>>'{}')::numeric)<=1.7976931348623157e308::numeric ELSE false END
$$;
REVOKE ALL ON FUNCTION app.assessment_scoring_number(jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assessment_scoring_ready(s jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE previous numeric; value numeric; item jsonb; n integer:=0;
BEGIN
 IF coalesce(s->>'method','') NOT IN ('more','less') THEN RETURN false; END IF;
 IF s->>'mechanism'='A' THEN
  IF jsonb_typeof(s->'rates')<>'array' OR jsonb_array_length(s->'rates')<>5 THEN RETURN false; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(s->'rates') LOOP
   IF NOT app.assessment_scoring_number(item) THEN RETURN false; END IF;
   value:=(item#>>'{}')::numeric;
   IF n>0 AND (s->>'method'='more' AND value<previous OR s->>'method'='less' AND value>previous) THEN RETURN false; END IF;
   previous:=value;n:=n+1;
  END LOOP;
  RETURN n=5;
 ELSIF s->>'mechanism'='B' THEN
  RETURN coalesce(app.assessment_scoring_number(s->'threshold') AND app.assessment_scoring_number(s->'target') AND (s->>'target')::numeric<>0
   AND s->>'variant' IN ('base','excellence') AND (s->>'variant'<>'excellence' OR app.assessment_scoring_number(s->'excellence'))
   AND (s->'multiple' IS NULL OR s->'multiple'='null'::jsonb OR app.assessment_scoring_number(s->'multiple') AND (s->>'multiple')::numeric BETWEEN 0 AND 10000),false);
 END IF;
 RETURN false;
EXCEPTION WHEN others THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION app.assessment_scoring_ready(jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onehr_validate_links() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r performance_review; s performance_onehr_calibration; n jsonb:=to_jsonb(NEW); o jsonb; rid uuid:=(n->>'review_id')::uuid; eid uuid:=(n->>'employment_id')::uuid; tid uuid:=(n->>'tenant_id')::uuid;
BEGIN
 IF TG_TABLE_NAME='performance_onehr_cycle' THEN
  IF NOT EXISTS(SELECT 1 FROM review_cycle c WHERE c.id=(n->>'cycle_id')::uuid AND c.tenant_id=tid) THEN RAISE EXCEPTION 'Invalid assessment cycle'; END IF;
 ELSIF TG_TABLE_NAME='performance_onehr_calibration' THEN
  IF EXISTS(SELECT 1 FROM performance_onehr_cycle c WHERE c.cycle_id=(n->>'cycle_id')::uuid AND c.tenant_id=tid AND c.policy->'modules'->>'calibration'='false') THEN RAISE EXCEPTION 'Calibration is disabled'; END IF;
  IF NOT EXISTS(SELECT 1 FROM performance_onehr_cycle c WHERE c.cycle_id=(n->>'cycle_id')::uuid AND c.tenant_id=tid) OR (n->>'company_id') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM company c WHERE c.id=(n->>'company_id')::uuid AND c.tenant_id=tid) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(n->'reviewer_user_ids') uid WHERE NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=uid::uuid AND u.tenant_id=tid AND u.archived_at IS NULL)) THEN RAISE EXCEPTION 'Invalid assessment calibration scope or reviewer'; END IF;
 ELSE
  SELECT * INTO r FROM performance_review WHERE id=rid AND tenant_id=tid;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Invalid assessment review'; END IF;
  IF TG_TABLE_NAME='performance_onehr_calibration_entry' AND EXISTS(SELECT 1 FROM performance_onehr_cycle c WHERE c.cycle_id=r.cycle_id AND c.tenant_id=tid AND c.policy->'modules'->>'calibration'='false') THEN RAISE EXCEPTION 'Calibration is disabled'; END IF;
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
  IF TG_TABLE_NAME='performance_onehr_plan' AND n->>'status'='draft' AND o->>'status'<>'draft' THEN
   IF NOT app.onehr_cycle_admin(r.cycle_id) OR NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=r.employment_id AND e.tenant_id=tid AND app.onehr_admin(e.company_id) AND NOT app.is_self_person(e.person_id))
    OR n-ARRAY['status','revision','acknowledged_at'] IS DISTINCT FROM o-ARRAY['status','revision','acknowledged_at'] OR n->>'acknowledged_at' IS NOT NULL THEN RAISE EXCEPTION 'Only scoped HR may reopen an unchanged development plan'; END IF;
   RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='performance_onehr_review' AND (n->'profile_id' IS DISTINCT FROM o->'profile_id' OR n->'profile_match' IS DISTINCT FROM o->'profile_match' OR
   (SELECT coalesce(jsonb_agg(c-ARRAY['self','selfRemark','manager','managerRemark'] ORDER BY i),'[]'::jsonb) FROM jsonb_array_elements(n->'competencies') WITH ORDINALITY q(c,i)) IS DISTINCT FROM
   (SELECT coalesce(jsonb_agg(c-ARRAY['self','selfRemark','manager','managerRemark'] ORDER BY i),'[]'::jsonb) FROM jsonb_array_elements(o->'competencies') WITH ORDINALITY q(c,i))) THEN
   IF NOT app.onehr_cycle_admin(r.cycle_id) OR app.assessment_competency_started(r.id) THEN RAISE EXCEPTION 'Only HR can replace an unstarted competency assignment'; END IF;
  END IF;
  IF TG_TABLE_NAME='performance_onehr_review' AND n->'kpis' IS DISTINCT FROM o->'kpis' THEN
   IF (SELECT count(DISTINCT k->>'title') FROM jsonb_array_elements(n->'kpis') k)<>jsonb_array_length(n->'kpis') THEN RAISE EXCEPTION 'A KPI title can appear only once on a scorecard'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(n->'kpis') k WHERE k->>'setting' IN ('proposed','approved') AND NOT app.assessment_scoring_ready(k->'scoring')) THEN RAISE EXCEPTION 'Complete the target numbers and threshold order before proposing or approving a KPI'; END IF;
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
  IF TG_TABLE_NAME='performance_onehr_review' AND n->'submitted_proof' IS DISTINCT FROM o->'submitted_proof' THEN
   IF o->>'results_submitted_at' IS NOT NULL THEN RAISE EXCEPTION 'Submitted KPI proof is immutable'; END IF;
   IF jsonb_typeof(n->'submitted_proof') IS DISTINCT FROM 'array' OR n->>'results_submitted_at' IS NULL THEN RAISE EXCEPTION 'Proof belongs to a confirmed result'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(n->'submitted_proof') proof WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(app.assessment_kpi_file_links((n->>'review_id')::uuid)) available WHERE available->>'attachmentId'=proof->>'attachmentId' AND available->>'kpiId'=proof->>'kpiId')) THEN RAISE EXCEPTION 'Only available KPI proof can be confirmed'; END IF;
  END IF;
  IF TG_TABLE_NAME='performance_onehr_review' AND (n->'company_id' IS DISTINCT FROM o->'company_id' OR n->'grade' IS DISTINCT FROM o->'grade' OR n->'statements' IS DISTINCT FROM o->'statements') THEN RAISE EXCEPTION 'assessment opening snapshot is immutable'; END IF;
  IF TG_TABLE_NAME='performance_onehr_cycle' AND n->'participation_opened_on' IS DISTINCT FROM o->'participation_opened_on' AND EXISTS(SELECT 1 FROM review_cycle c WHERE c.id=(n->>'cycle_id')::uuid AND c.status<>'draft') THEN RAISE EXCEPTION 'Participation opening date is immutable'; END IF;
  IF TG_TABLE_NAME='performance_onehr_cycle' AND EXISTS(SELECT 1 FROM review_cycle c WHERE c.id=(n->>'cycle_id')::uuid AND c.status<>'draft') AND ((n->'policy')-ARRAY['windows','modules','profiles','skills','careerRoutes'] IS DISTINCT FROM (o->'policy')-ARRAY['windows','modules','profiles','skills','careerRoutes'] OR EXISTS(SELECT 1 FROM review_cycle c WHERE c.id=(n->>'cycle_id')::uuid AND c.status='closed')) THEN RAISE EXCEPTION 'An opened assessment policy is immutable; only active deadlines, module switches and job catalogues can change'; END IF;
  IF TG_TABLE_NAME='performance_onehr_plan' AND o->>'status'<>'draft' THEN
   IF (SELECT coalesce(jsonb_agg(g->'id' ORDER BY idx),'[]'::jsonb) FROM jsonb_array_elements(n->'goals') WITH ORDINALITY q(g,idx)) IS DISTINCT FROM (SELECT coalesce(jsonb_agg(g->'id' ORDER BY idx),'[]'::jsonb) FROM jsonb_array_elements(o->'goals') WITH ORDINALITY q(g,idx)) THEN RAISE EXCEPTION 'Shared goal identities are immutable'; END IF;
   IF o->>'status'='closed' AND ((SELECT coalesce(jsonb_agg(g-ARRAY['status','progressNote','progressAt','checkins'] ORDER BY idx),'[]'::jsonb) FROM jsonb_array_elements(n->'goals') WITH ORDINALITY q(g,idx)) IS DISTINCT FROM (SELECT coalesce(jsonb_agg(g-ARRAY['status','progressNote','progressAt','checkins'] ORDER BY idx),'[]'::jsonb) FROM jsonb_array_elements(o->'goals') WITH ORDINALITY q(g,idx)) OR n->'manager_comment' IS DISTINCT FROM o->'manager_comment') THEN RAISE EXCEPTION 'Closed plan definitions and remarks are immutable'; END IF;
  END IF;
  IF TG_TABLE_NAME='performance_onehr_plan' AND n->'plan_year' IS DISTINCT FROM o->'plan_year' THEN RAISE EXCEPTION 'The development plan year is immutable'; END IF;
  IF TG_TABLE_NAME='performance_onehr_plan' AND o->>'status'<>'draft' AND (n->'career' IS DISTINCT FROM o->'career' OR n->>'status'='draft' OR o->>'status'='closed' AND n->>'status'<>'closed' OR ((SELECT coalesce(jsonb_agg(g-ARRAY['status','managerComment','progressNote','progressAt','checkins'] ORDER BY idx),'[]'::jsonb) FROM jsonb_array_elements(n->'goals') WITH ORDINALITY q(g,idx)) IS DISTINCT FROM (SELECT coalesce(jsonb_agg(g-ARRAY['status','managerComment','progressNote','progressAt','checkins'] ORDER BY idx),'[]'::jsonb) FROM jsonb_array_elements(o->'goals') WITH ORDINALITY q(g,idx)) AND NOT (o->>'status'='shared' AND app.assessment_plan_reviewer((n->>'id')::uuid)))) THEN RAISE EXCEPTION 'Shared development plan definitions are immutable'; END IF;
  IF TG_TABLE_NAME='performance_onehr_calibration_entry' THEN
   IF n->'pip' IS DISTINCT FROM o->'pip' OR n->'pip_reason' IS DISTINCT FROM o->'pip_reason' THEN
    IF s.locked_at IS NULL OR s.pip_locked_at IS NOT NULL OR s.tier NOT IN ('bg','group','final') THEN RAISE EXCEPTION 'PIP decisions require a locked calibration and an open PIP list'; END IF;
   END IF;
   IF n->'promotion' IS DISTINCT FROM o->'promotion' OR n->'promotion_reason' IS DISTINCT FROM o->'promotion_reason' THEN
    IF s.locked_at IS NULL OR s.promotion_locked_at IS NOT NULL OR s.tier NOT IN ('bg','group','final') THEN RAISE EXCEPTION 'Promotion decisions require a locked calibration and an open promotion list'; END IF;
   END IF;
  END IF;
  IF TG_TABLE_NAME='performance_onehr_result' AND n-ARRAY['performance_released_at','potential_released_at','talent_released_at','feedback_released_at'] IS DISTINCT FROM o-ARRAY['performance_released_at','potential_released_at','talent_released_at','feedback_released_at'] THEN RAISE EXCEPTION 'A frozen assessment result is immutable'; END IF;
  IF TG_TABLE_NAME IN ('performance_onehr_panel','performance_onehr_calibration_entry') AND EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=rid) AND n IS DISTINCT FROM o THEN RAISE EXCEPTION 'Finalized assessment inputs are immutable'; END IF;
  IF TG_TABLE_NAME='performance_onehr_panel' THEN
   IF (o->>'submitted_at') IS NOT NULL AND n IS DISTINCT FROM o AND (
    NOT app.onehr_cycle_admin(r.cycle_id) OR EXISTS(SELECT 1 FROM employment e WHERE e.id=r.employment_id AND app.is_self_person(e.person_id))
    OR n-ARRAY['submitted_at','reset_at','archived_at','archive_reason','relationship'] IS DISTINCT FROM o-ARRAY['submitted_at','reset_at','archived_at','archive_reason','relationship']
    OR n->'submitted_at' IS DISTINCT FROM o->'submitted_at' AND (n->>'submitted_at' IS NOT NULL OR n->>'reset_at' IS NULL OR o->>'archived_at' IS NOT NULL)
   ) THEN RAISE EXCEPTION 'Submitted feedback is immutable except scoped HR relationship, archive, restore or reset-to-draft'; END IF;
   IF (n->'reset_at' IS DISTINCT FROM o->'reset_at' OR n->'archive_reason' IS DISTINCT FROM o->'archive_reason') AND (NOT app.onehr_cycle_admin(r.cycle_id) OR EXISTS(SELECT 1 FROM employment e WHERE e.id=r.employment_id AND app.is_self_person(e.person_id))) THEN RAISE EXCEPTION 'Only scoped HR may reset or archive feedback'; END IF;
  END IF;
  IF TG_TABLE_NAME='performance_onehr_review' AND EXISTS(SELECT 1 FROM review_cycle c WHERE c.id=r.cycle_id AND c.tenant_id=tid AND c.status='closed') THEN RAISE EXCEPTION 'An archived assessment is read-only'; END IF;
  IF TG_TABLE_NAME='performance_onehr_review' AND EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=rid) THEN RAISE EXCEPTION 'A finalized assessment review is immutable'; END IF;
  IF TG_TABLE_NAME='performance_onehr_evidence' THEN
   IF n->'author_user_id' IS DISTINCT FROM o->'author_user_id' THEN RAISE EXCEPTION 'Evidence authorship is immutable'; END IF;
   IF n->'responses' IS DISTINCT FROM o->'responses' AND (o->>'state'<>'shared' OR
    (SELECT count(*) FROM jsonb_array_elements(n->'responses') v WHERE v->>'userId'=app.current_user_id()::text)<>1 OR
    (SELECT coalesce(jsonb_agg(v ORDER BY i),'[]'::jsonb) FROM jsonb_array_elements(n->'responses') WITH ORDINALITY q(v,i) WHERE v->>'userId' IS DISTINCT FROM app.current_user_id()::text) IS DISTINCT FROM
    (SELECT coalesce(jsonb_agg(v ORDER BY i),'[]'::jsonb) FROM jsonb_array_elements(o->'responses') WITH ORDINALITY q(v,i) WHERE v->>'userId' IS DISTINCT FROM app.current_user_id()::text)) THEN RAISE EXCEPTION 'Change only your own standing evidence response'; END IF;
   IF n->'citations' IS DISTINCT FROM o->'citations' AND (o->>'state'<>'shared' OR
    EXISTS(SELECT 1 FROM jsonb_array_elements(n->'citations') v WHERE v->>'userId'=app.current_user_id()::text AND v->>'decisionKind' NOT IN ('kpi_result','moderation','band_change')) OR
    (SELECT count(*) FROM jsonb_array_elements(n->'citations') v WHERE v->>'userId'=app.current_user_id()::text)<>(SELECT count(DISTINCT v->>'decisionKind') FROM jsonb_array_elements(n->'citations') v WHERE v->>'userId'=app.current_user_id()::text) OR
    (SELECT coalesce(jsonb_agg(v ORDER BY i),'[]'::jsonb) FROM jsonb_array_elements(n->'citations') WITH ORDINALITY q(v,i) WHERE v->>'userId' IS DISTINCT FROM app.current_user_id()::text) IS DISTINCT FROM
    (SELECT coalesce(jsonb_agg(v ORDER BY i),'[]'::jsonb) FROM jsonb_array_elements(o->'citations') WITH ORDINALITY q(v,i) WHERE v->>'userId' IS DISTINCT FROM app.current_user_id()::text)) THEN RAISE EXCEPTION 'Change only your own evidence citation'; END IF;
   IF n->'links' IS DISTINCT FROM o->'links' AND NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=eid AND e.tenant_id=tid AND app.is_self_person(e.person_id)) THEN RAISE EXCEPTION 'Only the subject may change evidence links'; END IF;
   IF n->'state' IS DISTINCT FROM o->'state' AND n->>'author_user_id' IS DISTINCT FROM app.current_user_id()::text THEN RAISE EXCEPTION 'Only the author may share or retract evidence'; END IF;
   IF n-ARRAY['state','responses','links','citations','revision'] IS DISTINCT FROM o-ARRAY['state','responses','links','citations','revision'] AND n->>'author_user_id' IS DISTINCT FROM app.current_user_id()::text THEN RAISE EXCEPTION 'Only the author may edit evidence words'; END IF;
  END IF;
  IF TG_TABLE_NAME='performance_onehr_evidence' AND o->>'state'<>'draft' AND n-ARRAY['state','responses','links','citations','revision'] IS DISTINCT FROM o-ARRAY['state','responses','links','citations','revision'] THEN RAISE EXCEPTION 'Correct shared evidence with a new entry'; END IF;
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
ALTER POLICY onehr_plan_access ON performance_onehr_plan USING(tenant_id=app.current_tenant_id() AND (employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]) OR app.assessment_plan_reviewer(id)) AND (status<>'draft' OR EXISTS(SELECT 1 FROM employment e WHERE e.id=performance_onehr_plan.employment_id AND e.tenant_id=performance_onehr_plan.tenant_id AND (app.is_self_person(e.person_id) OR app.onehr_admin(e.company_id) AND EXISTS(SELECT 1 FROM performance_onehr_review r WHERE r.review_id=performance_onehr_plan.review_id AND r.tenant_id=e.tenant_id AND app.onehr_cycle_admin(r.cycle_id)))))) WITH CHECK(tenant_id=app.current_tenant_id() AND (app.can_see_employment(employment_id) OR app.assessment_plan_reviewer(id)));

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onehr_result_card(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('id',f.id,'digest',f.digest,'performanceReleasedAt',f.performance_released_at,'potentialReleasedAt',f.potential_released_at,'talentReleasedAt',f.talent_released_at,'feedbackReleasedAt',f.feedback_released_at,'result',jsonb_build_object('performance',CASE WHEN f.performance_released_at IS NOT NULL THEN f.result->'performance' ELSE 'null'::jsonb END,'potential',CASE WHEN f.potential_released_at IS NOT NULL THEN f.result->'potential' ELSE 'null'::jsonb END,'talent',CASE WHEN f.talent_released_at IS NOT NULL THEN f.result->'talent' ELSE 'null'::jsonb END,'anonymousFeedback',CASE WHEN f.feedback_released_at IS NOT NULL THEN f.result->'anonymousFeedback' ELSE 'null'::jsonb END,'feedback',CASE WHEN f.feedback_released_at IS NOT NULL THEN f.result->'feedback' ELSE '[]'::jsonb END))
 FROM performance_onehr_result f JOIN employment e ON e.id=f.employment_id AND e.tenant_id=f.tenant_id JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
 WHERE f.review_id=wanted_review AND f.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onehr_assessment_inputs(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('reviewId',r.review_id,'employmentId',r.employment_id,'companyId',r.company_id,'department',coalesce((SELECT d.name FROM assignment a JOIN department d ON d.id=a.department_id AND d.tenant_id=a.tenant_id WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1),''),'businessGroupId',coalesce((SELECT c.parent_company_id::text FROM company c WHERE c.id=r.company_id AND c.tenant_id=r.tenant_id),''),'businessGroup',coalesce((SELECT g.legal_name FROM company c JOIN company g ON g.id=c.parent_company_id AND g.tenant_id=c.tenant_id WHERE c.id=r.company_id AND c.tenant_id=r.tenant_id),''),'grade',r.grade,'name',p.full_name,'performance',r.manager_performance,'managerScore',r.manager_score,'finalized',EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=r.review_id),'competencyStatus',r.competency_status,'competencyAssigned',jsonb_array_length(r.competencies)>0,'selfCompetencies',CASE WHEN r.competency_status IN ('submitted','reviewed') THEN r.competencies ELSE '[]'::jsonb END,'submittedKpis',CASE WHEN r.results_submitted_at IS NOT NULL THEN r.kpis ELSE '[]'::jsonb END,'competencies',CASE WHEN r.competency_status='reviewed' THEN r.competencies ELSE '[]'::jsonb END,'principles',coalesce((SELECT jsonb_agg(jsonb_build_object('principle',q.principle,'pct',q.pct)) FROM (SELECT st->>'principle' principle,100*sum(CASE WHEN a.answers->>(st->>'id')='yes' THEN CASE WHEN (st->>'future')::boolean THEN 1.5 ELSE 1 END ELSE 0 END)/nullif(sum(CASE WHEN (st->>'future')::boolean THEN 1.5 ELSE 1 END),0) pct FROM performance_onehr_panel a CROSS JOIN LATERAL jsonb_array_elements(r.statements) st WHERE a.review_id=r.review_id AND a.submitted_at IS NOT NULL AND a.archived_at IS NULL GROUP BY st->>'principle') q),'[]'::jsonb),'leadership',coalesce((SELECT jsonb_agg(jsonb_build_object('score',app.onehr_adjusted_score(a.request_id,(SELECT sum(CASE WHEN a.answers->>(st->>'id')='yes' THEN CASE WHEN (st->>'future')::boolean THEN 1.5 ELSE 1 END ELSE 0 END) FROM jsonb_array_elements(r.statements) st),(SELECT sum(CASE WHEN (st->>'future')::boolean THEN 1.5 ELSE 1 END) FROM jsonb_array_elements(r.statements) st)),'max',(SELECT sum(CASE WHEN (st->>'future')::boolean THEN 1.5 ELSE 1 END) FROM jsonb_array_elements(r.statements) st))) FROM performance_onehr_panel a WHERE a.review_id=r.review_id AND a.submitted_at IS NOT NULL AND a.archived_at IS NULL),'[]'::jsonb))
 FROM performance_onehr_review r JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND NOT app.is_self_person(p.id) AND (app.onehr_cycle_admin(r.cycle_id) OR app.onehr_manager(r.review_id) OR EXISTS(SELECT 1 FROM performance_onehr_calibration_entry ce JOIN performance_onehr_calibration cs ON cs.id=ce.session_id WHERE ce.review_id=r.review_id AND app.onehr_calibration_access(cs.id) AND NOT app.is_self_person(p.id)))
$$;

--> statement-breakpoint
-- A narrow career-planning projection: skill evidence only, never peer identities or unreleased bands.
CREATE FUNCTION app.assessment_skill_history(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('status',h.competency_status,'competencies',h.competencies) ORDER BY h.cycle_id,h.review_id)
  FROM performance_onehr_review h WHERE h.tenant_id=r.tenant_id AND h.employment_id=r.employment_id
   AND (h.competency_status='reviewed' OR app.is_self_person(e.person_id) AND h.competency_status='submitted')),'[]'::jsonb)
 FROM performance_onehr_review r JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
 WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id()
  AND (app.is_self_person(e.person_id) OR app.onehr_manager(r.review_id) OR app.onehr_cycle_admin(r.cycle_id))
$$;
REVOKE ALL ON FUNCTION app.assessment_skill_history(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_skill_history(uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onehr_feedback_card(wanted_request uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('requestId',f.id,'reviewId',r.review_id,'cycleId',r.cycle_id,'guidedReview',coalesce((cfg.policy->'modules'->>'review')::boolean,true),'closed',cyc.status='closed','subject',f.subject_name,'statements',r.statements,'answers',a.answers,'remark',a.remark,'comments',a.principle_comments,'resetAt',a.reset_at,'submitted',a.submitted_at IS NOT NULL,'frozen',EXISTS(SELECT 1 FROM performance_onehr_result x WHERE x.review_id=r.review_id))
 FROM performance_onehr_panel a JOIN peer_feedback_request f ON f.id=a.request_id AND f.tenant_id=a.tenant_id JOIN performance_onehr_review r ON r.review_id=a.review_id AND r.tenant_id=a.tenant_id JOIN performance_onehr_cycle cfg ON cfg.cycle_id=r.cycle_id AND cfg.tenant_id=r.tenant_id JOIN review_cycle cyc ON cyc.id=r.cycle_id AND cyc.tenant_id=r.tenant_id JOIN employment e ON e.id=a.peer_employment_id AND e.tenant_id=a.tenant_id JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
 WHERE f.id=wanted_request AND a.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND a.archived_at IS NULL AND (cfg.policy->'modules'->>'tm')::boolean=true
$$;

--> statement-breakpoint
-- A yes/no predicate lets HR protect private work without reading another person's draft.
CREATE FUNCTION app.assessment_competency_started(wanted_review uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_review r WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND app.onehr_cycle_admin(r.cycle_id)
  AND (r.competency_status<>'pending' OR EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=r.review_id)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.competencies) c WHERE c->>'self' IS NOT NULL OR c->>'manager' IS NOT NULL)
   OR EXISTS(SELECT 1 FROM performance_assessment_draft d WHERE d.review_id=r.review_id AND d.kind IN ('competency_self','competency_manager') AND (coalesce(d.payload->>'remark','')<>'' OR EXISTS(SELECT 1 FROM jsonb_each(coalesce(d.payload->'answers','{}'::jsonb)) a WHERE a.value->>'answer' IS NOT NULL OR coalesce(a.value->>'remark','')<>'')))))
$$;
REVOKE ALL ON FUNCTION app.assessment_competency_started(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_competency_started(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Working talent consequences belong to the assessment, not to a reviewer's grid.
CREATE TABLE performance_assessment_talent (
 review_id uuid PRIMARY KEY REFERENCES performance_onehr_review(review_id),
 tenant_id uuid NOT NULL REFERENCES tenant(id),actions jsonb NOT NULL CHECK(jsonb_typeof(actions)='object'),revision integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE performance_assessment_talent_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 employment_id uuid NOT NULL REFERENCES employment(id),year integer NOT NULL,
 category text NOT NULL CHECK(category IN ('PIP/Improvement','Solid Core','Star','Super Star')),
 performance text NOT NULL CHECK(performance IN ('UA','BE','ME','AE','OU')),
 potential text NOT NULL CHECK(potential IN ('Low','Mid','High')),
 review_id uuid NOT NULL REFERENCES performance_onehr_review(review_id),session_id uuid NOT NULL REFERENCES performance_onehr_calibration(id),
 recorded_at timestamptz NOT NULL DEFAULT now(),UNIQUE(employment_id,year)
);
ALTER TABLE performance_assessment_talent ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_assessment_talent FORCE ROW LEVEL SECURITY;
ALTER TABLE performance_assessment_talent_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_assessment_talent_history FORCE ROW LEVEL SECURITY;
GRANT SELECT ON performance_assessment_talent,performance_assessment_talent_history TO ai_hr_app;
-- Read and write projections are the only app access. No direct DML privileges or permissive policies.
CREATE FUNCTION app.assessment_talent_context(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('actions',coalesce(a.actions,'{}'::jsonb),'revision',coalesce(a.revision,0),'history',coalesce((SELECT jsonb_agg(jsonb_build_object('year',h.year,'category',h.category) ORDER BY h.year DESC) FROM performance_assessment_talent_history h WHERE h.tenant_id=r.tenant_id AND h.employment_id=r.employment_id),'[]'::jsonb))
 FROM performance_onehr_review r JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
 LEFT JOIN performance_assessment_talent a ON a.review_id=r.review_id AND a.tenant_id=r.tenant_id
 WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND NOT app.is_self_person(e.person_id)
 AND (app.onehr_cycle_admin(r.cycle_id) OR EXISTS(SELECT 1 FROM performance_onehr_calibration_entry ce WHERE ce.review_id=r.review_id AND ce.tenant_id=r.tenant_id AND app.onehr_calibration_access(ce.session_id)))
$$;
CREATE FUNCTION app.assessment_talent_write(wanted_session uuid,wanted_review uuid,kind text,selected boolean,reason text,grade text,title text,expected_revision integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s performance_onehr_calibration; e performance_onehr_calibration_entry; a jsonb; noms jsonb; c review_cycle; rev integer;
BEGIN
 SELECT * INTO s FROM performance_onehr_calibration WHERE id=wanted_session AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF s.id IS NULL OR NOT app.onehr_calibration_access(s.id) THEN RAISE EXCEPTION 'Talent decisions are outside your calibration scope'; END IF;
 IF NOT app.assessment_review_participates(wanted_review) THEN RAISE EXCEPTION 'Employee is not participating in this cycle'; END IF;
 SELECT * INTO e FROM performance_onehr_calibration_entry WHERE session_id=s.id AND review_id=wanted_review AND tenant_id=s.tenant_id;
 IF e.id IS NULL OR EXISTS(SELECT 1 FROM employment emp WHERE emp.id=e.employment_id AND app.is_self_person(emp.person_id)) THEN RAISE EXCEPTION 'You cannot decide this assessment'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(wanted_review::text,0));
 SELECT * INTO c FROM review_cycle WHERE id=s.cycle_id AND tenant_id=s.tenant_id;
 IF c.status NOT IN ('open','calibration') OR EXISTS(SELECT 1 FROM performance_onehr_result WHERE review_id=wanted_review) THEN RAISE EXCEPTION 'Closed or finalized decisions are immutable'; END IF;
 IF kind NOT IN ('pip','promotion','specialReward','nomination') OR selected IS NULL OR reason IS NULL OR length(reason)>4000 OR grade IS NULL OR length(grade)>20 OR title IS NULL OR length(title)>120 THEN RAISE EXCEPTION 'Invalid talent decision'; END IF;
 IF kind IN ('specialReward','nomination') THEN
  IF s.tier NOT IN ('bu','bg','group','final') OR s.locked_at IS NOT NULL OR e.locked_at IS NOT NULL OR kind='nomination' AND s.tier<>'bg' THEN RAISE EXCEPTION 'Pins require an open authorized Talent Box'; END IF;
  IF s.tier='bu' AND EXISTS(SELECT 1 FROM performance_onehr_calibration_entry be JOIN performance_onehr_calibration bs ON bs.id=be.session_id WHERE be.review_id=wanted_review AND bs.tier='bg' AND (be.locked_at IS NOT NULL OR bs.locked_at IS NOT NULL)) THEN RAISE EXCEPTION 'BU calibration is closed after BG locks'; END IF;
 ELSE
  IF s.tier NOT IN ('bg','group','final') OR s.locked_at IS NULL OR kind='pip' AND s.pip_locked_at IS NOT NULL OR kind='promotion' AND s.promotion_locked_at IS NOT NULL THEN RAISE EXCEPTION 'Decisions require a locked box and an open decision list'; END IF;
 END IF;
 -- A list confirmed anywhere protects the same shared consequence everywhere.
 IF kind IN ('pip','promotion') AND EXISTS(SELECT 1 FROM performance_onehr_calibration_entry ce JOIN performance_onehr_calibration cs ON cs.id=ce.session_id WHERE ce.review_id=wanted_review AND (kind='pip' AND cs.pip_locked_at IS NOT NULL OR kind='promotion' AND cs.promotion_locked_at IS NOT NULL)) THEN RAISE EXCEPTION 'Reopen the confirmed decision list before changing this decision'; END IF;
 SELECT actions,revision INTO a,rev FROM performance_assessment_talent WHERE review_id=wanted_review FOR UPDATE;
 IF expected_revision IS DISTINCT FROM coalesce(rev,0) THEN RAISE EXCEPTION 'Talent decisions changed. Reload before saving'; END IF;
 a:=coalesce(a,'{}'::jsonb);
 IF kind='nomination' THEN
  SELECT coalesce(jsonb_agg(n),'[]'::jsonb) INTO noms FROM jsonb_array_elements(coalesce(a->'nominations','[]'::jsonb)) n WHERE n->>'userId'<>app.current_user_id()::text;
  IF selected THEN noms:=noms||jsonb_build_array(jsonb_build_object('userId',app.current_user_id(),'grade',grade,'title',title,'reason',reason,'at',now())); END IF;
  a:=a||jsonb_build_object('nominations',noms);
 ELSE
  a:=a||jsonb_build_object(kind,selected,kind||'Reason',CASE WHEN kind='specialReward' AND NOT selected THEN '' ELSE reason END);
  IF kind='promotion' THEN a:=a||jsonb_build_object('confirmedGrade',CASE WHEN selected THEN grade ELSE '' END,'confirmedTitle',CASE WHEN selected THEN title ELSE '' END); END IF;
 END IF;
 INSERT INTO performance_assessment_talent(review_id,tenant_id,actions) VALUES(wanted_review,s.tenant_id,a)
 ON CONFLICT(review_id) DO UPDATE SET actions=excluded.actions,revision=performance_assessment_talent.revision+1,updated_at=now();
END $$;
CREATE FUNCTION app.assessment_talent_snapshot() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s performance_onehr_calibration; yr integer; cat text;
BEGIN
 IF NEW.locked_at IS NULL OR NEW.performance IS NULL OR NEW.potential IS NULL OR (TG_OP='UPDATE' AND NEW.locked_at IS NOT DISTINCT FROM OLD.locked_at) THEN RETURN NEW; END IF;
 SELECT * INTO s FROM performance_onehr_calibration WHERE id=NEW.session_id;
 IF s.tier NOT IN ('bu','bg','group','final') THEN RETURN NEW; END IF;
 SELECT extract(year from period_end)::integer INTO yr FROM review_cycle WHERE id=s.cycle_id;
 cat:=CASE WHEN NEW.performance='UA' OR NEW.performance='BE' AND NEW.potential<>'High' THEN 'PIP/Improvement'
 WHEN NEW.potential='High' AND NEW.performance IN ('AE','OU') THEN 'Super Star'
 WHEN NEW.potential='High' AND NEW.performance='ME' OR NEW.potential='Mid' AND NEW.performance IN ('AE','OU') THEN 'Star' ELSE 'Solid Core' END;
 INSERT INTO performance_assessment_talent_history(tenant_id,employment_id,year,category,performance,potential,review_id,session_id)
 VALUES(NEW.tenant_id,NEW.employment_id,yr,cat,NEW.performance,NEW.potential,NEW.review_id,NEW.session_id)
 ON CONFLICT(employment_id,year) DO UPDATE SET category=excluded.category,performance=excluded.performance,potential=excluded.potential,review_id=excluded.review_id,session_id=excluded.session_id,recorded_at=now();
 RETURN NEW;
END $$;
CREATE TRIGGER assessment_talent_snapshot AFTER INSERT OR UPDATE ON performance_onehr_calibration_entry FOR EACH ROW EXECUTE FUNCTION app.assessment_talent_snapshot();
REVOKE ALL ON FUNCTION app.assessment_talent_context(uuid),app.assessment_talent_write(uuid,uuid,text,boolean,text,text,text,integer),app.assessment_talent_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_talent_context(uuid),app.assessment_talent_write(uuid,uuid,text,boolean,text,text,text,integer) TO ai_hr_app;
-- Preserve existing confirmed outcomes during the transition; new writes use only the shared record.
INSERT INTO performance_assessment_talent(review_id,tenant_id,actions)
 SELECT DISTINCT ON(e.review_id) e.review_id,e.tenant_id,jsonb_build_object('pip',e.pip,'promotion',e.promotion,'specialReward',e.special_reward)
 FROM performance_onehr_calibration_entry e JOIN performance_onehr_calibration s ON s.id=e.session_id
 ORDER BY e.review_id,CASE s.tier WHEN 'final' THEN 5 WHEN 'group' THEN 4 WHEN 'bg' THEN 3 WHEN 'bu' THEN 2 ELSE 1 END DESC;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onehr_decisions(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('tier',s.tier,'mode',s.mode,'performance',e.performance,'potential',e.potential,'performanceLocked',e.performance_locked_at IS NOT NULL OR s.performance_locked_at IS NOT NULL,'potentialLocked',e.potential_locked_at IS NOT NULL OR s.potential_locked_at IS NOT NULL,'locked',e.locked_at IS NOT NULL OR s.locked_at IS NOT NULL,'pipConfirmed',s.pip_locked_at IS NOT NULL,'promotionConfirmed',s.promotion_locked_at IS NOT NULL,'pip',coalesce((a.actions->>'pip')::boolean,false),'promotion',coalesce((a.actions->>'promotion')::boolean,false),'specialReward',coalesce((a.actions->>'specialReward')::boolean,false)) ORDER BY CASE s.tier WHEN 'hod' THEN 1 WHEN 'bu' THEN 2 WHEN 'bg' THEN 3 WHEN 'group' THEN 4 ELSE 5 END),'[]'::jsonb)
 FROM performance_onehr_calibration_entry e JOIN performance_onehr_calibration s ON s.id=e.session_id AND s.tenant_id=e.tenant_id JOIN performance_review r ON r.id=e.review_id AND r.tenant_id=e.tenant_id JOIN employment emp ON emp.id=e.employment_id AND emp.tenant_id=e.tenant_id
 LEFT JOIN performance_assessment_talent a ON a.review_id=e.review_id AND a.tenant_id=e.tenant_id
 WHERE e.review_id=wanted_review AND e.tenant_id=app.current_tenant_id() AND NOT app.is_self_person(emp.person_id) AND (app.onehr_cycle_admin(r.cycle_id) OR app.onehr_manager(r.id) OR EXISTS(SELECT 1 FROM performance_onehr_calibration_entry ce WHERE ce.review_id=r.id AND app.onehr_calibration_access(ce.session_id)))
$$;
REVOKE ALL ON FUNCTION app.onehr_decisions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_decisions(uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reward_onehr_source(wanted_unit uuid,wanted_employment uuid,wanted_year integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('id',f.id,'reviewId',f.review_id,'cycleId',f.cycle_id,'digest',f.digest,'frozenAt',f.frozen_at,'performance',f.result->'performance','potential',f.result->'potential','talent',f.result->'talent','pip',f.result->'pip','promotion',f.result->'promotion','specialReward',f.result->'specialReward','policyDigest',f.result->'policyDigest','confirmedGrade',f.result->'confirmedGrade','confirmedTitle',f.result->'confirmedTitle','pipReason',f.result->'pipReason','promotionReason',f.result->'promotionReason','specialRewardReason',f.result->'specialRewardReason')
 FROM performance_onehr_result f JOIN review_cycle c ON c.id=f.cycle_id AND c.tenant_id=f.tenant_id JOIN employment e ON e.id=f.employment_id AND e.tenant_id=f.tenant_id JOIN reward_unit u ON u.id=wanted_unit AND u.tenant_id=e.tenant_id AND u.company_id=e.company_id JOIN app_user a ON a.id=app.current_user_id() AND a.tenant_id=u.tenant_id
 WHERE f.tenant_id=app.current_tenant_id() AND f.employment_id=wanted_employment AND (f.result->>'performance' IS NOT NULL OR f.result->>'potential' IS NOT NULL OR f.result->>'pip'='true' OR f.result->>'promotion'='true' OR f.result->>'specialReward'='true') AND extract(year from c.period_end)::integer=wanted_year AND (u.policy->>'year')::integer=wanted_year AND a.archived_at IS NULL AND NOT app.login_blocked(a.id) AND NOT app.is_self_person(e.person_id) AND (app.reward_admin(u.company_id) OR 'gr' IN (SELECT app.reward_roles(u.id))) AND (app.reward_admin(u.company_id) OR EXISTS(SELECT 1 FROM reward_entry re WHERE re.unit_id=u.id AND re.employment_id=e.id))
 ORDER BY c.period_end DESC,CASE WHEN (SELECT policy->>'kind' FROM performance_onehr_cycle oc WHERE oc.cycle_id=f.cycle_id)='year_end' THEN 0 ELSE 1 END,f.frozen_at DESC,f.id DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.reward_onehr_source(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_onehr_source(uuid,uuid,integer) TO ai_hr_app;

--> statement-breakpoint
CREATE TABLE performance_assessment_career_profile (
 employment_id uuid PRIMARY KEY REFERENCES employment(id),tenant_id uuid NOT NULL REFERENCES tenant(id),
 review_id uuid NOT NULL REFERENCES performance_onehr_review(review_id),career jsonb NOT NULL CHECK(jsonb_typeof(career)='object'),
 manager_comment text NOT NULL DEFAULT '',manager_user_id uuid REFERENCES app_user(id),manager_comment_at timestamptz,
 revision integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO performance_assessment_career_profile(employment_id,tenant_id,review_id,career)
 SELECT DISTINCT ON(employment_id) employment_id,tenant_id,review_id,career FROM performance_onehr_plan WHERE career IS NOT NULL ORDER BY employment_id,plan_year DESC,created_at DESC;
CREATE FUNCTION app.assessment_career_access(wanted_employment uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM employment e WHERE e.id=wanted_employment AND e.tenant_id=app.current_tenant_id() AND
 (app.is_self_person(e.person_id) OR app.onehr_admin(e.company_id) OR EXISTS(SELECT 1 FROM performance_onehr_review r JOIN review_cycle c ON c.id=r.cycle_id WHERE r.employment_id=e.id AND r.tenant_id=e.tenant_id AND c.status IN ('open','calibration') AND (app.onehr_manager(r.review_id) OR app.onehr_moderator(r.review_id)))))
$$;
CREATE FUNCTION app.assessment_career_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r performance_onehr_review; c review_cycle; yr integer; own boolean; administrator boolean; manager_placeholder boolean;
BEGIN
 SELECT * INTO r FROM performance_onehr_review WHERE review_id=NEW.review_id AND tenant_id=NEW.tenant_id AND employment_id=NEW.employment_id;
 IF r.review_id IS NULL THEN RAISE EXCEPTION 'Invalid career profile reference'; END IF;
 IF TG_OP='UPDATE' AND (NEW.employment_id<>OLD.employment_id OR NEW.tenant_id<>OLD.tenant_id) THEN RAISE EXCEPTION 'Career profile identity is immutable'; END IF;
 SELECT * INTO c FROM review_cycle WHERE id=r.cycle_id;
 own:=EXISTS(SELECT 1 FROM employment e WHERE e.id=NEW.employment_id AND app.is_self_person(e.person_id));
 administrator:=NOT own AND app.onehr_cycle_admin(r.cycle_id) AND EXISTS(SELECT 1 FROM employment e WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id AND app.onehr_admin(e.company_id));
 manager_placeholder:=TG_OP='INSERT' AND NOT own AND (app.onehr_manager(r.review_id) OR app.onehr_moderator(r.review_id)) AND NEW.career=jsonb_build_object('aspiration','','mobility',NULL,'mobilityNote','','targetProfileId',NULL,'selfProfileId',NULL);
 IF c.status NOT IN ('open','calibration') AND NOT administrator THEN RAISE EXCEPTION 'This career period is read-only'; END IF;
 IF (TG_OP='INSERT' OR NEW.career IS DISTINCT FROM OLD.career) AND NOT manager_placeholder AND NOT administrator THEN
  IF NOT own THEN RAISE EXCEPTION 'Only the employee may change their career aspirations'; END IF;
  SELECT extract(year from c.period_end)::integer+CASE WHEN policy->>'kind'='year_end' THEN 1 ELSE 0 END INTO yr FROM performance_onehr_cycle WHERE cycle_id=c.id;
  IF TG_OP='UPDATE' AND nullif(btrim(OLD.career->>'mobility'),'') IS NOT NULL AND
   (nullif(btrim(OLD.career->>'aspiration'),'') IS NOT NULL OR nullif(btrim(OLD.career->>'aspirationNow'),'') IS NOT NULL OR nullif(btrim(OLD.career->>'aspirationLong'),'') IS NOT NULL)
   AND EXISTS(SELECT 1 FROM performance_onehr_plan p WHERE p.employment_id=NEW.employment_id AND p.plan_year=yr AND p.status<>'draft') THEN RAISE EXCEPTION 'The shared career plan is locked'; END IF;
 END IF;
 IF TG_OP='UPDATE' AND (NEW.manager_comment IS DISTINCT FROM OLD.manager_comment OR NEW.manager_user_id IS DISTINCT FROM OLD.manager_user_id OR NEW.manager_comment_at IS DISTINCT FROM OLD.manager_comment_at) OR TG_OP='INSERT' AND (NEW.manager_comment<>'' OR NEW.manager_user_id IS NOT NULL OR NEW.manager_comment_at IS NOT NULL) THEN
  IF own OR NOT (app.onehr_manager(r.review_id) OR app.onehr_moderator(r.review_id)) OR NEW.manager_user_id IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'Only the assigned manager may comment on a career profile'; END IF;
 END IF;
 RETURN NEW;
END $$;
ALTER TABLE performance_assessment_career_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_assessment_career_profile FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON performance_assessment_career_profile TO ai_hr_app;
CREATE POLICY assessment_career_profile_access ON performance_assessment_career_profile FOR ALL USING(tenant_id=app.current_tenant_id() AND app.assessment_career_access(employment_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.assessment_career_access(employment_id));
CREATE TRIGGER assessment_career_validate BEFORE INSERT OR UPDATE ON performance_assessment_career_profile FOR EACH ROW EXECUTE FUNCTION app.assessment_career_validate();
REVOKE ALL ON FUNCTION app.assessment_career_access(uuid),app.assessment_career_validate() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_career_access(uuid) TO ai_hr_app;


--> statement-breakpoint
-- Release grants are visibility decisions, independent of immutable final results.
CREATE TABLE performance_assessment_release (
 review_id uuid PRIMARY KEY REFERENCES performance_onehr_review(review_id),tenant_id uuid NOT NULL REFERENCES tenant(id),
 performance_released_at timestamptz,potential_released_at timestamptz,talent_released_at timestamptz,feedback_released_at timestamptz,
 updated_by uuid REFERENCES app_user(id),updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO performance_assessment_release(review_id,tenant_id,performance_released_at,potential_released_at,talent_released_at,feedback_released_at)
 SELECT review_id,tenant_id,performance_released_at,potential_released_at,talent_released_at,feedback_released_at FROM performance_onehr_result;
ALTER TABLE performance_assessment_release ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_assessment_release FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON performance_assessment_release TO ai_hr_app;
CREATE POLICY assessment_release_admin ON performance_assessment_release FOR ALL
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM performance_onehr_review r JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id WHERE r.review_id=performance_assessment_release.review_id AND r.tenant_id=performance_assessment_release.tenant_id AND app.onehr_cycle_admin(r.cycle_id) AND app.onehr_admin(e.company_id) AND NOT app.is_self_person(e.person_id)))
 WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM performance_onehr_review r JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id WHERE r.review_id=performance_assessment_release.review_id AND r.tenant_id=performance_assessment_release.tenant_id AND app.onehr_cycle_admin(r.cycle_id) AND app.onehr_admin(e.company_id) AND NOT app.is_self_person(e.person_id)));
CREATE FUNCTION app.assessment_release_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM performance_onehr_review r WHERE r.review_id=NEW.review_id AND r.tenant_id=NEW.tenant_id)
  OR NEW.updated_by IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=NEW.updated_by AND u.tenant_id=NEW.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
  THEN RAISE EXCEPTION 'Invalid assessment release scope'; END IF;
 IF TG_OP='UPDATE' AND (NEW.tenant_id<>OLD.tenant_id OR NEW.review_id<>OLD.review_id) THEN RAISE EXCEPTION 'Assessment release identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assessment_release_validate BEFORE INSERT OR UPDATE ON performance_assessment_release FOR EACH ROW EXECUTE FUNCTION app.assessment_release_validate();
REVOKE ALL ON FUNCTION app.assessment_release_validate() FROM PUBLIC;

--> statement-breakpoint
CREATE FUNCTION app.assessment_source_round(value numeric) RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN value-floor(value)=0.5 THEN CASE WHEN mod(floor(value),2)=0 THEN floor(value) ELSE floor(value)+1 END ELSE floor(value+0.5) END
$$;
REVOKE ALL ON FUNCTION app.assessment_source_round(numeric) FROM PUBLIC,ai_hr_app;

-- Internal projection, deliberately NOT executable by ai_hr_app. It has no rater identities,
-- relationships, raw scores, counts, evidence or justifications. The outer card enforces release.
CREATE FUNCTION app.assessment_working_result(wanted_review uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r performance_onehr_review; cfg jsonb; pm text; pot text; pm_source text:='manager'; pot_source text:='manager';
 leadership_pct numeric; n integer; minimum integer; tech_score numeric; tech_max numeric; pct numeric; w numeric;
 d record; found_pm boolean:=false; found_pot boolean:=false; report jsonb; legacy_feedback jsonb;
BEGIN
 SELECT * INTO r FROM performance_onehr_review WHERE review_id=wanted_review AND tenant_id=app.current_tenant_id();
 IF r.review_id IS NULL THEN RETURN NULL; END IF;
 SELECT policy INTO cfg FROM performance_onehr_cycle WHERE cycle_id=r.cycle_id AND tenant_id=r.tenant_id;
 pm:=CASE WHEN coalesce((cfg->'modules'->>'pm')::boolean,false) AND cfg->>'kind'<>'quarterly' THEN r.manager_performance END;
 minimum:=CASE WHEN regexp_replace(r.grade,'^JG\s*','','i') ~ '^\d+$' THEN (cfg->>'minValid')::integer ELSE 1 END;
 SELECT count(*),avg(app.onehr_adjusted_score(a.request_id,v.score,v.maximum)/nullif(v.maximum,0)*100) INTO n,leadership_pct
 FROM performance_onehr_panel a CROSS JOIN LATERAL (
  SELECT sum(CASE WHEN a.answers->>(s->>'id')='yes' THEN CASE WHEN (s->>'future')::boolean THEN 1.5 ELSE 1 END ELSE 0 END) score,
   sum(CASE WHEN (s->>'future')::boolean THEN 1.5 ELSE 1 END) maximum FROM jsonb_array_elements(r.statements) s
 ) v WHERE a.review_id=r.review_id AND a.tenant_id=r.tenant_id AND a.submitted_at IS NOT NULL AND a.archived_at IS NULL;
 IF coalesce((cfg->'modules'->>'tm')::boolean,false) AND n>=minimum THEN
  SELECT sum(CASE WHEN coalesce(s->>'manager',s->>'self')='yes' THEN CASE WHEN (s->>'future')::boolean THEN 1.5 ELSE 1 END ELSE 0 END),
   sum(CASE WHEN (s->>'future')::boolean THEN 1.5 ELSE 1 END) INTO tech_score,tech_max FROM jsonb_array_elements(CASE WHEN r.competency_status='reviewed' THEN r.competencies ELSE '[]'::jsonb END) s;
  w:=coalesce((cfg->'weights'->>regexp_replace(r.grade,'^JG\s*','','i'))::numeric,10000);
  pct:=CASE WHEN tech_max>0 AND w<10000 THEN (leadership_pct*w+100*tech_score/tech_max*(10000-w))/10000 ELSE leadership_pct END;
  pot:=CASE WHEN pct IS NULL THEN NULL WHEN pct<=(cfg->>'lowMaxPct')::numeric THEN 'Low' WHEN pct<=(cfg->>'midMaxPct')::numeric THEN 'Mid' ELSE 'High' END;
 END IF;
 FOR d IN SELECT ce.*,cs.tier,cs.mode,cs.performance_locked_at session_pm_lock,cs.potential_locked_at session_pot_lock
  FROM performance_onehr_calibration_entry ce JOIN performance_onehr_calibration cs ON cs.id=ce.session_id AND cs.tenant_id=ce.tenant_id
  WHERE ce.review_id=r.review_id AND ce.tenant_id=r.tenant_id
  ORDER BY CASE cs.tier WHEN 'final' THEN 5 WHEN 'group' THEN 4 WHEN 'bg' THEN 3 WHEN 'bu' THEN 2 ELSE 1 END DESC
 LOOP
  IF d.tier='group' AND d.mode='blend' THEN CONTINUE; END IF;
  IF NOT found_pm AND d.performance IS NOT NULL AND (d.performance_locked_at IS NOT NULL OR d.session_pm_lock IS NOT NULL OR d.tier='final') THEN pm:=d.performance;pm_source:=d.tier;found_pm:=true; END IF;
  IF NOT found_pot AND d.potential IS NOT NULL AND (d.potential_locked_at IS NOT NULL OR d.session_pot_lock IS NOT NULL OR d.tier='final') THEN pot:=d.potential;pot_source:=d.tier;found_pot:=true; END IF;
 END LOOP;
 -- Agreement percentages are unweighted. Weighting belongs only to the potential calculation.
 SELECT jsonb_build_object('principles',coalesce((SELECT jsonb_agg(jsonb_build_object('principle',q.principle,'agreementPct',q.pct) ORDER BY q.ord) FROM (
  SELECT s->>'principle' principle,min(ord) ord,app.assessment_source_round(100.0*count(*) FILTER(WHERE a.answers->>(s->>'id')='yes')/nullif(count(*) FILTER(WHERE a.answers->>(s->>'id') IN ('yes','no')),0)) pct
  FROM jsonb_array_elements(r.statements) WITH ORDINALITY st(s,ord) LEFT JOIN performance_onehr_panel a ON a.review_id=r.review_id AND a.tenant_id=r.tenant_id AND a.submitted_at IS NOT NULL AND a.archived_at IS NULL GROUP BY s->>'principle'
 ) q),'[]'::jsonb),'statements',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s->>'id','principle',s->>'principle','text',s->>'text','future',(s->>'future')::boolean,'agreementPct',(
  SELECT app.assessment_source_round(100.0*count(*) FILTER(WHERE a.answers->>(s->>'id')='yes')/nullif(count(*) FILTER(WHERE a.answers->>(s->>'id') IN ('yes','no')),0)) FROM performance_onehr_panel a WHERE a.review_id=r.review_id AND a.tenant_id=r.tenant_id AND a.submitted_at IS NOT NULL AND a.archived_at IS NULL)) ORDER BY ord) FROM jsonb_array_elements(r.statements) WITH ORDINALITY q(s,ord)),'[]'::jsonb),
  'remarks',coalesce((SELECT jsonb_agg(btrim(a.remark) ORDER BY btrim(a.remark) COLLATE "C") FROM performance_onehr_panel a WHERE a.review_id=r.review_id AND a.tenant_id=r.tenant_id AND a.submitted_at IS NOT NULL AND a.archived_at IS NULL AND btrim(a.remark)<>''),'[]'::jsonb),
  'comments',coalesce((SELECT jsonb_agg(jsonb_build_object('principle',c.key,'text',btrim(c.value)) ORDER BY c.key COLLATE "C",btrim(c.value) COLLATE "C") FROM performance_onehr_panel a CROSS JOIN LATERAL jsonb_each_text(a.principle_comments) c WHERE a.review_id=r.review_id AND a.tenant_id=r.tenant_id AND a.submitted_at IS NOT NULL AND a.archived_at IS NULL AND btrim(c.value)<>'' AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.statements) s WHERE s->>'principle'=c.key)),'[]'::jsonb)) INTO report;
 SELECT coalesce(jsonb_agg(jsonb_build_object('principle',v.principle,'band',CASE WHEN v.pct<=(cfg->>'lowMaxPct')::numeric THEN 'Low' WHEN v.pct<=(cfg->>'midMaxPct')::numeric THEN 'Mid' ELSE 'High' END) ORDER BY v.principle),'[]'::jsonb) INTO legacy_feedback
 FROM (SELECT s->>'principle' principle,100*sum(CASE WHEN a.answers->>(s->>'id')='yes' THEN CASE WHEN (s->>'future')::boolean THEN 1.5 ELSE 1 END ELSE 0 END)/nullif(sum(CASE WHEN (s->>'future')::boolean THEN 1.5 ELSE 1 END),0) pct FROM performance_onehr_panel a CROSS JOIN LATERAL jsonb_array_elements(r.statements) s WHERE a.review_id=r.review_id AND a.tenant_id=r.tenant_id AND a.submitted_at IS NOT NULL AND a.archived_at IS NULL GROUP BY s->>'principle') v;
 RETURN jsonb_build_object('performance',pm,'potential',pot,'performanceSource',pm_source,'potentialSource',pot_source,
  'talent',CASE WHEN pm IS NULL OR pot IS NULL THEN NULL WHEN pm IN ('UA','BE') THEN 'PIP/Improvement' WHEN pot='High' AND pm IN ('AE','OU') THEN 'Super Star' WHEN pot='High' AND pm='ME' OR pot='Mid' AND pm IN ('AE','OU') THEN 'Star' ELSE 'Solid Core' END,
  'anonymousFeedback',report,'feedback',legacy_feedback);
END $$;
REVOKE ALL ON FUNCTION app.assessment_working_result(uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- The overall IDP remark has one owner; goal remarks and conversation recording retain approver access.
CREATE FUNCTION app.assessment_plan_remark_writer(wanted_review uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_review r JOIN performance_review pr ON pr.id=r.review_id AND pr.tenant_id=r.tenant_id
 LEFT JOIN employment m ON m.id=pr.reviewer_employment_id AND m.tenant_id=r.tenant_id
 WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND (app.onehr_moderator(r.review_id) OR app.onehr_manager(r.review_id) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.kpis) k WHERE NOT coalesce((k->>'hrOwned')::boolean,false)))
 AND (app.onehr_manager(r.review_id) OR m.id IS NULL OR m.terminated_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR NOT EXISTS(SELECT 1 FROM app_user u WHERE u.person_id=m.person_id AND u.tenant_id=r.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) OR NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(r.kpis) k WHERE NOT coalesce((k->>'hrOwned')::boolean,false) AND (k->>'moderatorEmploymentId'=m.id::text OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(k->'approvalChain','[]'::jsonb)) step WHERE step->>'employmentId'=m.id::text))
 )))
$$;
REVOKE ALL ON FUNCTION app.assessment_plan_remark_writer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_plan_remark_writer(uuid) TO ai_hr_app;
CREATE FUNCTION app.assessment_plan_remark_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.manager_comment<>'' THEN RAISE EXCEPTION 'Overall feedback belongs to an employee-shared plan'; END IF;
 ELSIF NEW.manager_comment IS DISTINCT FROM OLD.manager_comment THEN
  IF OLD.status<>'shared' OR NOT EXISTS(
   SELECT 1 FROM performance_onehr_review r JOIN review_cycle c ON c.id=r.cycle_id AND c.tenant_id=r.tenant_id JOIN performance_onehr_cycle cfg ON cfg.cycle_id=c.id AND cfg.tenant_id=r.tenant_id
   WHERE r.employment_id=NEW.employment_id AND r.tenant_id=NEW.tenant_id AND r.tenant_id=app.current_tenant_id() AND c.status IN ('open','calibration') AND coalesce((cfg.policy->'modules'->>'idp')::boolean,false)
    AND NEW.plan_year=extract(year from c.period_end)::integer+CASE WHEN cfg.policy->>'kind'='year_end' THEN 1 ELSE 0 END
    AND app.assessment_review_participates(r.review_id) AND app.assessment_plan_remark_writer(r.review_id)
    AND (cfg.policy->'windows'->'idp_review'->>'opensAt' IS NULL OR now()>=(cfg.policy->'windows'->'idp_review'->>'opensAt')::timestamptz)
    AND (cfg.policy->'windows'->'idp_review'->>'closesAt' IS NULL OR now()<(cfg.policy->'windows'->'idp_review'->>'closesAt')::timestamptz)
  ) THEN RAISE EXCEPTION 'Only the eligible overall plan reviewer may change this remark'; END IF;
  IF cardinality(regexp_split_to_array(trim(NEW.manager_comment),'\s+'))>220 THEN RAISE EXCEPTION 'Overall plan feedback is limited to 220 words'; END IF;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.assessment_plan_remark_validate() FROM PUBLIC;
CREATE TRIGGER assessment_plan_remark_guard BEFORE INSERT OR UPDATE ON performance_onehr_plan FOR EACH ROW EXECUTE FUNCTION app.assessment_plan_remark_validate();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onehr_result_card(wanted_review uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r performance_onehr_review; f performance_onehr_result; rel performance_assessment_release; value jsonb; own boolean; administrator boolean;
BEGIN
 SELECT * INTO r FROM performance_onehr_review WHERE review_id=wanted_review AND tenant_id=app.current_tenant_id();
 IF r.review_id IS NULL OR NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=r.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RETURN NULL; END IF;
 SELECT app.is_self_person(e.person_id) INTO own FROM employment e WHERE e.id=r.employment_id AND e.tenant_id=r.tenant_id;
 administrator:=NOT own AND app.onehr_cycle_admin(r.cycle_id) AND app.onehr_admin(r.company_id);
 IF NOT own AND NOT administrator THEN RETURN NULL; END IF;
 SELECT * INTO f FROM performance_onehr_result WHERE review_id=r.review_id AND tenant_id=r.tenant_id;
 SELECT * INTO rel FROM performance_assessment_release WHERE review_id=r.review_id AND tenant_id=r.tenant_id;
 IF f.id IS NULL AND NOT app.assessment_review_participates(r.review_id) THEN RETURN NULL; END IF;
 value:=CASE WHEN f.id IS NOT NULL THEN f.result ELSE app.assessment_working_result(r.review_id) END;
 RETURN jsonb_build_object('id',coalesce(f.id,r.review_id),'digest',f.digest,'frozen',f.id IS NOT NULL,
  'performanceReleasedAt',rel.performance_released_at,'potentialReleasedAt',rel.potential_released_at,'talentReleasedAt',rel.talent_released_at,'feedbackReleasedAt',rel.feedback_released_at,
  'result',jsonb_build_object('performance',CASE WHEN administrator OR rel.performance_released_at IS NOT NULL THEN value->'performance' ELSE 'null'::jsonb END,
   'potential',CASE WHEN administrator OR rel.potential_released_at IS NOT NULL THEN value->'potential' ELSE 'null'::jsonb END,
   'talent',CASE WHEN administrator OR rel.talent_released_at IS NOT NULL THEN value->'talent' ELSE 'null'::jsonb END,
   'performanceSource',CASE WHEN administrator OR rel.performance_released_at IS NOT NULL THEN value->'performanceSource' ELSE 'null'::jsonb END,
   'potentialSource',CASE WHEN administrator OR rel.potential_released_at IS NOT NULL THEN value->'potentialSource' ELSE 'null'::jsonb END,
   'anonymousFeedback',CASE WHEN administrator OR rel.feedback_released_at IS NOT NULL THEN value->'anonymousFeedback' ELSE 'null'::jsonb END,
   'feedback',CASE WHEN administrator OR rel.feedback_released_at IS NOT NULL THEN value->'feedback' ELSE '[]'::jsonb END));
END $$;
REVOKE ALL ON FUNCTION app.onehr_result_card(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_result_card(uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE TABLE performance_assessment_rating_record (
 review_id uuid PRIMARY KEY REFERENCES performance_onehr_review(review_id),tenant_id uuid NOT NULL REFERENCES tenant(id),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),last_event text NOT NULL,
 recorded_by uuid REFERENCES app_user(id),recorded_at timestamptz NOT NULL DEFAULT now(),frozen_at timestamptz
);
ALTER TABLE performance_assessment_rating_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_assessment_rating_record FORCE ROW LEVEL SECURITY;
-- Snapshots may only be written by the internal capture; a scoped HR reader cannot forge a record.
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON performance_assessment_rating_record FROM ai_hr_app;
GRANT SELECT ON performance_assessment_rating_record TO ai_hr_app;
CREATE POLICY assessment_rating_record_read ON performance_assessment_rating_record FOR SELECT USING(
 tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM performance_onehr_review r JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
 WHERE r.review_id=performance_assessment_rating_record.review_id AND r.tenant_id=performance_assessment_rating_record.tenant_id
 AND app.onehr_cycle_admin(r.cycle_id) AND app.onehr_admin(r.company_id) AND app.onehr_admin(e.company_id) AND NOT app.is_self_person(e.person_id)));

--> statement-breakpoint
-- Deterministic counterpart of scoreKPI, kept internal and checked against the source golden cases.
CREATE FUNCTION app.assessment_kpi_score(actual numeric,scoring jsonb) RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE result numeric:=1; rate record; raw numeric; ceiling numeric;
BEGIN
 IF actual IS NULL THEN RETURN NULL; END IF;
 IF scoring->>'mechanism'='A' THEN
  FOR rate IN SELECT v::numeric threshold,i FROM jsonb_array_elements_text(scoring->'rates') WITH ORDINALITY q(v,i) LOOP
   IF scoring->>'method'='more' AND actual>=rate.threshold OR scoring->>'method'='less' AND actual<=rate.threshold THEN result:=rate.i; END IF;
  END LOOP;
  RETURN result;
 END IF;
 IF scoring->>'method'='more' AND actual<=(scoring->>'threshold')::numeric OR scoring->>'method'='less' AND actual>=(scoring->>'threshold')::numeric THEN RETURN 0; END IF;
 raw:=CASE WHEN scoring->>'method'='more' THEN actual/(scoring->>'target')::numeric*100 ELSE (2-actual/(scoring->>'target')::numeric)*100 END;
 IF scoring->>'variant'='excellence' THEN
  ceiling:=CASE WHEN scoring->>'method'='more' THEN (scoring->>'excellence')::numeric/(scoring->>'target')::numeric*100 ELSE (2-(scoring->>'excellence')::numeric/(scoring->>'target')::numeric)*100 END;
  RETURN least(raw,ceiling);
 END IF;
 RETURN CASE WHEN raw<=100 THEN raw ELSE 100+(raw-100)*coalesce((scoring->>'multiple')::numeric,0)/100 END;
END $$;
REVOKE ALL ON FUNCTION app.assessment_kpi_score(numeric,jsonb) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Captures an observation only. It cannot change the assessment or any Rewards decision.
CREATE FUNCTION app.assessment_rating_record_capture(wanted_review uuid,event text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r performance_onehr_review; cfg jsonb; snapshot jsonb; identity jsonb; effective jsonb; tiers jsonb;
 self_score numeric; covered numeric; total numeric; self_band text; mech text; minima jsonb; threshold record;
 submitted integer; maximum numeric; average_score numeric; tc_self numeric; tc_reviewed numeric; tc_max numeric;
 w numeric; pct360 numeric; pcttech numeric; pct numeric; combined_max numeric; combined_score numeric; computed_pot text; minimum integer; closed boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(wanted_review::text,0));
 SELECT * INTO r FROM performance_onehr_review WHERE review_id=wanted_review AND tenant_id=app.current_tenant_id();
 IF r.review_id IS NULL OR NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=r.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) OR EXISTS(SELECT 1 FROM performance_assessment_rating_record rr WHERE rr.review_id=r.review_id AND rr.frozen_at IS NOT NULL) THEN RETURN false; END IF;
 SELECT c.policy,rc.status='closed' INTO cfg,closed FROM performance_onehr_cycle c JOIN review_cycle rc ON rc.id=c.cycle_id AND rc.tenant_id=c.tenant_id WHERE c.cycle_id=r.cycle_id AND c.tenant_id=r.tenant_id;
 SELECT jsonb_build_object('employeeId',coalesce(e.employee_code,e.id::text),'name',p.full_name,'businessGroup',coalesce(bg.legal_name,co.legal_name),'company',co.legal_name,'department',d.name,'grade',r.grade,'title',pos.title) INTO identity
 FROM employment e JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id JOIN company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id LEFT JOIN company bg ON bg.id=co.parent_company_id AND bg.tenant_id=e.tenant_id
 LEFT JOIN LATERAL (SELECT a.* FROM assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1) a ON true
 LEFT JOIN department d ON d.id=a.department_id AND d.tenant_id=e.tenant_id LEFT JOIN position pos ON pos.id=a.position_id AND pos.tenant_id=e.tenant_id WHERE e.id=r.employment_id AND e.tenant_id=r.tenant_id;
 mech:=r.kpis->0->'scoring'->>'mechanism';
 SELECT sum((k->>'weightBp')::numeric),sum((k->>'weightBp')::numeric) FILTER(WHERE k->>'actual' IS NOT NULL),
 sum((k->>'weightBp')::numeric*app.assessment_kpi_score((k->>'actual')::numeric,k->'scoring'))/nullif(sum((k->>'weightBp')::numeric) FILTER(WHERE k->>'actual' IS NOT NULL),0)
 INTO total,covered,self_score FROM jsonb_array_elements(r.kpis) k;
 minima:=CASE WHEN mech='A' THEN cfg->'aBands' ELSE (SELECT b->'minima' FROM jsonb_array_elements(cfg->'bBands') b WHERE b->>'companyId'=r.company_id::text) END;
 IF self_score IS NOT NULL THEN
  FOR threshold IN SELECT v::numeric value,i FROM jsonb_array_elements_text(minima) WITH ORDINALITY q(v,i) LOOP
   IF self_score>=threshold.value THEN self_band:=(ARRAY['UA','BE','ME','AE','OU'])[threshold.i]; END IF;
  END LOOP;
 END IF;
 SELECT coalesce(sum(CASE WHEN (s->>'future')::boolean THEN 1.5 ELSE 1 END),0) INTO maximum FROM jsonb_array_elements(r.statements) s;
 SELECT count(*),avg(app.onehr_adjusted_score(a.request_id,(SELECT sum(CASE WHEN a.answers->>(s->>'id')='yes' THEN CASE WHEN (s->>'future')::boolean THEN 1.5 ELSE 1 END ELSE 0 END) FROM jsonb_array_elements(r.statements) s),maximum))
 INTO submitted,average_score FROM performance_onehr_panel a WHERE a.review_id=r.review_id AND a.tenant_id=r.tenant_id AND a.submitted_at IS NOT NULL AND a.archived_at IS NULL;
 SELECT sum(CASE WHEN s->>'self'='yes' THEN CASE WHEN (s->>'future')::boolean THEN 1.5 ELSE 1 END ELSE 0 END),
 sum(CASE WHEN coalesce(s->>'manager',s->>'self')='yes' THEN CASE WHEN (s->>'future')::boolean THEN 1.5 ELSE 1 END ELSE 0 END),
 sum(CASE WHEN (s->>'future')::boolean THEN 1.5 ELSE 1 END) INTO tc_self,tc_reviewed,tc_max FROM jsonb_array_elements(r.competencies) s;
 IF r.competency_status<>'reviewed' THEN tc_reviewed:=NULL; END IF;
 w:=coalesce((cfg->'weights'->>r.grade)::numeric,10000);
 pct360:=100*average_score/nullif(maximum,0);pcttech:=100*tc_reviewed/nullif(tc_max,0);
 pct:=CASE WHEN pcttech IS NOT NULL AND w<10000 THEN (pct360*w+pcttech*(10000-w))/10000 ELSE pct360 END;
 combined_max:=CASE WHEN pcttech IS NOT NULL AND w<10000 THEN maximum+tc_max ELSE maximum END;
 combined_score:=pct*combined_max/100;
 computed_pot:=CASE WHEN pct IS NULL THEN NULL WHEN pct<=(cfg->>'lowMaxPct')::numeric THEN 'Low' WHEN pct<=(cfg->>'midMaxPct')::numeric THEN 'Mid' ELSE 'High' END;
 minimum:=CASE WHEN r.grade ~ '^\d+$' THEN (cfg->>'minValid')::integer ELSE 1 END;
 effective:=app.assessment_working_result(r.review_id);
 SELECT coalesce(jsonb_object_agg(q.tier,q.value),'{}'::jsonb) INTO tiers FROM (
  SELECT cs.tier,jsonb_build_object('performance',CASE WHEN ce.performance_locked_at IS NOT NULL OR cs.performance_locked_at IS NOT NULL OR cs.tier='final' THEN ce.performance END,
   'potential',CASE WHEN ce.potential_locked_at IS NOT NULL OR cs.potential_locked_at IS NOT NULL OR cs.tier='final' THEN ce.potential END) value
  FROM performance_onehr_calibration_entry ce JOIN performance_onehr_calibration cs ON cs.id=ce.session_id AND cs.tenant_id=ce.tenant_id WHERE ce.review_id=r.review_id AND ce.tenant_id=r.tenant_id AND NOT(cs.tier='group' AND cs.mode='blend')
 ) q;
 snapshot:=identity||jsonb_build_object('mechanism',mech,'selfScore',self_score,'selfBand',self_band,'weightCovered',covered,'weightTotal',total,'managerScore',r.manager_score,'managerBand',r.manager_performance,
 'performance',effective->'performance','performanceSource',effective->'performanceSource','leadershipScore',average_score,'leadershipMax',nullif(maximum,0),'submitted',submitted,'valid',submitted>=minimum,
 'competencyStatus',CASE WHEN jsonb_array_length(r.competencies)>0 THEN r.competency_status END,'competencySelf',tc_self,'competencyReviewed',tc_reviewed,'competencyMax',tc_max,
 'potentialScore',combined_score,'potentialMax',nullif(combined_max,0),'potential360Pct',pct360,'potentialCompetencyPct',pcttech,'potentialBasis',CASE WHEN average_score IS NULL THEN 'none' WHEN pcttech IS NOT NULL AND w<10000 THEN 'combined' ELSE '360_only' END,
 'computedPotential',computed_pot,'potential',effective->'potential','potentialSource',effective->'potentialSource','tiers',tiers,
 'configuration',jsonb_build_object('lowMaxPct',cfg->'lowMaxPct','midMaxPct',cfg->'midMaxPct','weight360',w));
 INSERT INTO performance_assessment_rating_record(review_id,tenant_id,snapshot,last_event,recorded_by,frozen_at)
 VALUES(r.review_id,r.tenant_id,snapshot,event,app.current_user_id(),CASE WHEN closed THEN now() END)
 ON CONFLICT(review_id) DO UPDATE SET snapshot=excluded.snapshot,last_event=excluded.last_event,recorded_by=excluded.recorded_by,recorded_at=now(),frozen_at=excluded.frozen_at WHERE performance_assessment_rating_record.frozen_at IS NULL;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION app.assessment_rating_record_capture(uuid,text) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.assessment_rating_record_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE id uuid; event text;
BEGIN
 IF TG_TABLE_NAME='performance_onehr_review' THEN
  IF NEW.results_submitted_at IS DISTINCT FROM OLD.results_submitted_at THEN event:='pm_self_submit';
  ELSIF NEW.competency_status IS DISTINCT FROM OLD.competency_status THEN event:=CASE WHEN NEW.competency_status='reviewed' THEN 'tc_review' ELSE 'tc_submit' END;
  ELSIF NEW.kpis IS DISTINCT FROM OLD.kpis OR NEW.manager_performance IS DISTINCT FROM OLD.manager_performance OR NEW.manager_score IS DISTINCT FROM OLD.manager_score THEN
   IF NEW.results_submitted_at IS NULL AND NEW.manager_performance IS NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.kpis) k WHERE (k->>'hrOwned')::boolean AND (k->>'locked')::boolean) THEN RETURN NEW; END IF;
   event:='pm_manager_lock';
  ELSE RETURN NEW; END IF;
  PERFORM app.assessment_rating_record_capture(NEW.review_id,event);
 ELSIF TG_TABLE_NAME='performance_onehr_panel' THEN
  IF NEW.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN PERFORM app.assessment_rating_record_capture(NEW.review_id,'f360_submit'); END IF;
 ELSIF TG_TABLE_NAME='performance_onehr_calibration_entry' THEN
  IF NEW.performance_locked_at IS DISTINCT FROM OLD.performance_locked_at OR NEW.potential_locked_at IS DISTINCT FROM OLD.potential_locked_at THEN PERFORM app.assessment_rating_record_capture(NEW.review_id,'calibration_lock_or_reopen'); END IF;
 ELSIF TG_TABLE_NAME='performance_onehr_calibration' THEN
  IF NEW.performance_locked_at IS DISTINCT FROM OLD.performance_locked_at OR NEW.potential_locked_at IS DISTINCT FROM OLD.potential_locked_at OR NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
   FOR id IN SELECT review_id FROM performance_onehr_calibration_entry WHERE session_id=NEW.id AND tenant_id=NEW.tenant_id LOOP PERFORM app.assessment_rating_record_capture(id,'calibration_lock_or_reopen'); END LOOP;
  END IF;
 ELSIF TG_TABLE_NAME='review_cycle' THEN
  IF NEW.status='closed' AND OLD.status<>'closed' THEN UPDATE performance_assessment_rating_record rr SET frozen_at=now() FROM performance_onehr_review r WHERE rr.review_id=r.review_id AND rr.tenant_id=r.tenant_id AND r.cycle_id=NEW.id AND r.tenant_id=NEW.tenant_id AND rr.frozen_at IS NULL; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.assessment_rating_record_changed() FROM PUBLIC;
CREATE TRIGGER assessment_rating_record_changed AFTER UPDATE ON performance_onehr_review FOR EACH ROW EXECUTE FUNCTION app.assessment_rating_record_changed();
CREATE TRIGGER assessment_rating_record_changed AFTER UPDATE ON performance_onehr_panel FOR EACH ROW EXECUTE FUNCTION app.assessment_rating_record_changed();
CREATE TRIGGER assessment_rating_record_changed AFTER UPDATE ON performance_onehr_calibration_entry FOR EACH ROW EXECUTE FUNCTION app.assessment_rating_record_changed();
CREATE TRIGGER assessment_rating_record_changed AFTER UPDATE ON performance_onehr_calibration FOR EACH ROW EXECUTE FUNCTION app.assessment_rating_record_changed();
CREATE TRIGGER assessment_rating_record_changed AFTER UPDATE ON review_cycle FOR EACH ROW EXECUTE FUNCTION app.assessment_rating_record_changed();
-- The same projection is used from write triggers, which must observe the just-written row.
ALTER FUNCTION app.assessment_working_result(uuid) VOLATILE;


--> statement-breakpoint
CREATE FUNCTION app.assessment_rating_records_capture(wanted_cycle uuid,company_name text DEFAULT NULL,department_name text DEFAULT NULL,bg_name text DEFAULT NULL) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE id uuid; captured integer:=0;
BEGIN
 IF NOT app.onehr_cycle_admin(wanted_cycle) THEN RAISE EXCEPTION 'Performance administrator access is required'; END IF;
 FOR id IN
  SELECT r.review_id FROM performance_onehr_review r JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
  JOIN company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id LEFT JOIN company bg ON bg.id=co.parent_company_id AND bg.tenant_id=e.tenant_id
  LEFT JOIN performance_assessment_rating_record rr ON rr.review_id=r.review_id AND rr.tenant_id=r.tenant_id
  LEFT JOIN LATERAL (SELECT d.name FROM assignment a JOIN department d ON d.id=a.department_id AND d.tenant_id=a.tenant_id WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1) dept ON true
  WHERE r.cycle_id=wanted_cycle AND r.tenant_id=app.current_tenant_id() AND app.onehr_admin(r.company_id) AND app.onehr_admin(e.company_id) AND NOT app.is_self_person(e.person_id) AND rr.frozen_at IS NULL
   AND (jsonb_array_length(r.kpis)>0 OR jsonb_array_length(r.competencies)>0 OR EXISTS(SELECT 1 FROM performance_onehr_panel p WHERE p.review_id=r.review_id AND p.tenant_id=r.tenant_id AND p.archived_at IS NULL))
   AND (company_name IS NULL OR co.legal_name=company_name) AND (bg_name IS NULL OR coalesce(bg.legal_name,co.legal_name)=bg_name) AND (department_name IS NULL OR dept.name=department_name)
  ORDER BY rr.recorded_at NULLS FIRST,r.review_id LIMIT 300 FOR UPDATE OF r
 LOOP
  IF app.assessment_rating_record_capture(id,'admin_capture') THEN captured:=captured+1; END IF;
 END LOOP;
 RETURN captured;
END $$;
REVOKE ALL ON FUNCTION app.assessment_rating_records_capture(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_rating_records_capture(uuid,text,text,text) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.assessment_rating_record_validate() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.review_id<>OLD.review_id OR NEW.tenant_id<>OLD.tenant_id THEN RAISE EXCEPTION 'Rating record identity is immutable'; END IF;
 IF OLD.frozen_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Archived rating records are immutable'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.assessment_rating_record_validate() FROM PUBLIC;
CREATE TRIGGER assessment_rating_record_validate BEFORE UPDATE ON performance_assessment_rating_record FOR EACH ROW EXECUTE FUNCTION app.assessment_rating_record_validate();

--> statement-breakpoint
-- An assigned KPI approver keeps read access after approving, but only to the assigned line.
CREATE FUNCTION app.assessment_kpi_reader(wanted_review uuid,wanted_kpi uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_review r JOIN performance_review pr ON pr.id=r.review_id AND pr.tenant_id=r.tenant_id JOIN employment sub ON sub.id=r.employment_id AND sub.tenant_id=r.tenant_id JOIN app_user u ON u.id=app.current_user_id() AND u.tenant_id=r.tenant_id
 CROSS JOIN LATERAL jsonb_array_elements(r.kpis) k CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_array_length(coalesce(k->'approvalChain','[]'::jsonb))>0 THEN k->'approvalChain' ELSE jsonb_build_array(jsonb_build_object('employmentId',k->>'moderatorEmploymentId')) END) step
 JOIN employment m ON m.id=(step->>'employmentId')::uuid AND m.tenant_id=r.tenant_id AND m.person_id=u.person_id
 WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND k->>'id'=wanted_kpi::text AND sub.person_id<>m.person_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND (m.terminated_on IS NULL OR m.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 AND (k->>'moderatorSource'='matrix' OR m.id=pr.reviewer_employment_id OR EXISTS(SELECT 1 FROM reporting_line l WHERE l.subordinate_employment_id=sub.id AND l.manager_employment_id=m.id AND l.line_type IN ('functional','project','dotted') AND l.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (l.valid_to IS NULL OR l.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND l.superseded_at IS NULL)))
$$;
CREATE FUNCTION app.assessment_evidence_access(wanted_evidence uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_evidence e JOIN employment sub ON sub.id=e.employment_id AND sub.tenant_id=e.tenant_id JOIN performance_onehr_cycle c ON c.cycle_id=(SELECT cycle_id FROM performance_onehr_review WHERE review_id=e.review_id AND tenant_id=e.tenant_id) AND c.tenant_id=e.tenant_id
 JOIN app_user u ON u.id=app.current_user_id() AND u.tenant_id=e.tenant_id
 WHERE e.id=wanted_evidence AND e.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND coalesce((c.policy->'modules'->>'evidence')::boolean,false)
 AND (e.author_user_id=u.id OR e.state<>'draft' AND (app.is_self_person(sub.person_id) OR EXISTS(SELECT 1 FROM performance_onehr_review r WHERE r.employment_id=sub.id AND r.tenant_id=e.tenant_id AND app.onehr_manager(r.review_id)) OR e.state='shared' AND EXISTS(
  SELECT 1 FROM jsonb_array_elements(e.links) link JOIN performance_onehr_review r ON r.employment_id=e.employment_id AND r.tenant_id=e.tenant_id CROSS JOIN LATERAL jsonb_array_elements(r.kpis) k
  WHERE link->>'kind'='kpi' AND link->>'id'=k->>'id' AND (app.assessment_kpi_reader(r.review_id,(k->>'id')::uuid) OR app.onehr_cycle_admin(r.cycle_id) OR EXISTS(SELECT 1 FROM performance_onehr_calibration_entry ce WHERE ce.review_id=r.review_id AND ce.tenant_id=r.tenant_id AND app.onehr_calibration_access(ce.session_id)))))))
$$;
REVOKE ALL ON FUNCTION app.assessment_kpi_reader(uuid,uuid),app.assessment_evidence_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_kpi_reader(uuid,uuid),app.assessment_evidence_access(uuid) TO ai_hr_app;
ALTER POLICY onehr_evidence_read ON performance_onehr_evidence USING(tenant_id=app.current_tenant_id() AND (author_user_id=app.current_user_id() OR app.assessment_evidence_access(id)));
ALTER POLICY onehr_evidence_insert ON performance_onehr_evidence WITH CHECK(tenant_id=app.current_tenant_id() AND author_user_id=app.current_user_id() AND EXISTS(SELECT 1 FROM performance_onehr_review r JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id WHERE r.review_id=performance_onehr_evidence.review_id AND r.tenant_id=performance_onehr_evidence.tenant_id AND r.employment_id=performance_onehr_evidence.employment_id AND (app.is_self_person(e.person_id) OR app.onehr_manager(r.review_id) OR app.onehr_moderator(r.review_id))));
ALTER POLICY onehr_evidence_update ON performance_onehr_evidence USING(tenant_id=app.current_tenant_id() AND app.assessment_evidence_access(id) AND (author_user_id=app.current_user_id() OR state='shared' AND EXISTS(SELECT 1 FROM employment e WHERE e.id=employment_id AND e.tenant_id=performance_onehr_evidence.tenant_id AND (app.is_self_person(e.person_id) OR EXISTS(SELECT 1 FROM performance_onehr_review r WHERE r.employment_id=e.id AND r.tenant_id=e.tenant_id AND (app.onehr_manager(r.review_id) OR app.onehr_moderator(r.review_id)))))))
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.assessment_evidence_access(id));

--> statement-breakpoint
CREATE FUNCTION app.assessment_evidence_people(wanted_evidence uuid[]) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH visible AS(SELECT e.* FROM performance_onehr_evidence e WHERE e.tenant_id=app.current_tenant_id() AND e.id=ANY(wanted_evidence) AND app.assessment_evidence_access(e.id)),
 actors AS(SELECT author_user_id id FROM visible UNION SELECT CASE WHEN v->>'userId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN (v->>'userId')::uuid END FROM visible CROSS JOIN LATERAL jsonb_array_elements(responses) v UNION SELECT CASE WHEN v->>'userId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN (v->>'userId')::uuid END FROM visible CROSS JOIN LATERAL jsonb_array_elements(citations) v)
 SELECT coalesce(jsonb_object_agg(u.id::text,p.full_name),'{}'::jsonb) FROM actors a JOIN app_user u ON u.id=a.id AND u.tenant_id=app.current_tenant_id() JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
$$;
REVOKE ALL ON FUNCTION app.assessment_evidence_people(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_evidence_people(uuid[]) TO ai_hr_app;

--> statement-breakpoint
-- Changing a released panel's membership or resetting a submission revokes its anonymous report.
-- A normal later submission remains live, matching the source release behavior.
CREATE FUNCTION app.assessment_panel_release_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE subject uuid; changed boolean; affected integer;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN changed:=true; ELSE changed:=NEW.archived_at IS DISTINCT FROM OLD.archived_at OR OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS NULL; END IF;
 IF NOT changed THEN RETURN NEW; END IF;
 UPDATE performance_assessment_release SET feedback_released_at=NULL,updated_by=app.current_user_id(),updated_at=now() WHERE review_id=NEW.review_id AND tenant_id=NEW.tenant_id AND feedback_released_at IS NOT NULL;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected>0 THEN
  UPDATE performance_onehr_result SET feedback_released_at=NULL WHERE review_id=NEW.review_id AND tenant_id=NEW.tenant_id;
  SELECT employment_id INTO subject FROM performance_onehr_review WHERE review_id=NEW.review_id AND tenant_id=NEW.tenant_id;
  INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
   VALUES(NEW.tenant_id,'onehr',NEW.review_id,'onehr.result-revoked','user',app.current_user_id(),subject,jsonb_build_object('component','feedback','reason','panel_changed'));
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.assessment_panel_release_changed() FROM PUBLIC;
CREATE TRIGGER assessment_panel_release_changed AFTER INSERT OR UPDATE ON performance_onehr_panel FOR EACH ROW EXECUTE FUNCTION app.assessment_panel_release_changed();

--> statement-breakpoint
-- Bytes remain in the native file store. An optional evidence edge owns the file's audience.
ALTER TABLE performance_onehr_evidence DROP CONSTRAINT performance_onehr_evidence_body_check;
ALTER TABLE performance_onehr_evidence ADD CONSTRAINT performance_onehr_evidence_body_check CHECK(length(body) BETWEEN 1 AND 1200 OR body='' AND kind='recognition' AND coalesce((details->>'fileOnly')::boolean,false));
ALTER TABLE performance_onehr_review ADD COLUMN submitted_proof jsonb NOT NULL DEFAULT '[]';
CREATE INDEX assessment_submitted_proof_employment ON performance_onehr_review(employment_id) WHERE results_submitted_at IS NOT NULL;
ALTER TABLE performance_attachment ADD COLUMN evidence_id uuid REFERENCES performance_onehr_evidence(id) ON DELETE CASCADE;
ALTER TABLE performance_attachment ADD COLUMN removed_at timestamptz;
CREATE INDEX assessment_evidence_files ON performance_attachment(evidence_id) WHERE evidence_id IS NOT NULL AND removed_at IS NULL;

CREATE FUNCTION app.assessment_file_read(wanted_review uuid,wanted_evidence uuid,wanted_file uuid,author uuid,removed timestamptz) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN r.review_id IS NULL THEN NULL ELSE removed IS NULL
  AND coalesce((c.policy->'modules'->>'evidence')::boolean,false)
  AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=r.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
  AND (CASE WHEN wanted_evidence IS NOT NULL THEN EXISTS(SELECT 1 FROM performance_onehr_evidence e WHERE e.id=wanted_evidence AND e.review_id=r.review_id AND e.employment_id=r.employment_id AND e.tenant_id=r.tenant_id AND e.author_user_id=author AND app.assessment_evidence_access(e.id))
  ELSE EXISTS(SELECT 1 FROM employment e WHERE e.id=r.employment_id AND e.tenant_id=r.tenant_id AND app.is_self_person(e.person_id)) OR app.onehr_manager(r.review_id)
   OR EXISTS(SELECT 1 FROM performance_assessment_attachment_link l WHERE l.attachment_id=wanted_file AND l.review_id=r.review_id AND l.tenant_id=r.tenant_id AND (app.assessment_kpi_reader(r.review_id,l.kpi_id) OR app.onehr_cycle_admin(r.cycle_id) OR EXISTS(SELECT 1 FROM performance_onehr_calibration_entry ce WHERE ce.review_id=r.review_id AND ce.tenant_id=r.tenant_id AND app.onehr_calibration_access(ce.session_id)))) END
   OR EXISTS(SELECT 1 FROM performance_onehr_review target CROSS JOIN LATERAL jsonb_array_elements(target.submitted_proof) proof WHERE target.tenant_id=r.tenant_id AND target.employment_id=r.employment_id AND target.results_submitted_at IS NOT NULL AND proof->>'attachmentId'=wanted_file::text AND (app.assessment_kpi_reader(target.review_id,(proof->>'kpiId')::uuid) OR app.onehr_cycle_admin(target.cycle_id) OR EXISTS(SELECT 1 FROM performance_onehr_calibration_entry ce WHERE ce.review_id=target.review_id AND ce.tenant_id=target.tenant_id AND app.onehr_calibration_access(ce.session_id))))) END
 FROM (SELECT 1) seed LEFT JOIN performance_onehr_review r ON r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() LEFT JOIN performance_onehr_cycle c ON c.cycle_id=r.cycle_id AND c.tenant_id=r.tenant_id
$$;
CREATE FUNCTION app.assessment_file_write(wanted_review uuid,wanted_evidence uuid,author uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN r.review_id IS NULL THEN NULL ELSE author=app.current_user_id()
 AND coalesce((c.policy->'modules'->>'evidence')::boolean,false)
 AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=r.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 AND CASE WHEN wanted_evidence IS NOT NULL THEN EXISTS(SELECT 1 FROM performance_onehr_evidence e WHERE e.id=wanted_evidence AND e.review_id=r.review_id AND e.tenant_id=r.tenant_id AND e.author_user_id=author AND app.assessment_evidence_access(e.id))
 ELSE EXISTS(SELECT 1 FROM employment e WHERE e.id=r.employment_id AND e.tenant_id=r.tenant_id AND app.is_self_person(e.person_id)) OR app.onehr_manager(r.review_id) END END
 FROM (SELECT 1) seed LEFT JOIN performance_onehr_review r ON r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() LEFT JOIN performance_onehr_cycle c ON c.cycle_id=r.cycle_id AND c.tenant_id=r.tenant_id
$$;
REVOKE ALL ON FUNCTION app.assessment_file_read(uuid,uuid,uuid,uuid,timestamptz),app.assessment_file_write(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_file_read(uuid,uuid,uuid,uuid,timestamptz),app.assessment_file_write(uuid,uuid,uuid) TO ai_hr_app;

-- Preserve the native audience for classic reviews. Assessment files use their explicit evidence/KPI audience.
ALTER POLICY performance_attachment_rls ON performance_attachment USING(tenant_id=app.current_tenant_id() AND (employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]) OR app.can_admin_perfcomp_employment(employment_id) OR coalesce(app.assessment_file_read(review_id,evidence_id,id,uploaded_by_user_id,removed_at),false)))
 WITH CHECK(tenant_id=app.current_tenant_id() AND (employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]) OR app.can_admin_perfcomp_employment(employment_id) OR coalesce(app.assessment_file_write(review_id,evidence_id,uploaded_by_user_id),false)));
DROP POLICY onehr_attachment_scope ON performance_attachment;
CREATE POLICY assessment_file_read_scope ON performance_attachment AS RESTRICTIVE FOR SELECT USING(coalesce(app.assessment_file_read(review_id,evidence_id,id,uploaded_by_user_id,removed_at),true));
CREATE POLICY assessment_file_insert_scope ON performance_attachment AS RESTRICTIVE FOR INSERT WITH CHECK(removed_at IS NULL AND coalesce(app.assessment_file_write(review_id,evidence_id,uploaded_by_user_id),true));
CREATE POLICY assessment_file_update_scope ON performance_attachment AS RESTRICTIVE FOR UPDATE USING(coalesce(app.assessment_file_write(review_id,evidence_id,uploaded_by_user_id),true)) WITH CHECK(coalesce(app.assessment_file_write(review_id,evidence_id,uploaded_by_user_id),true));
CREATE POLICY assessment_file_delete_scope ON performance_attachment AS RESTRICTIVE FOR DELETE USING(app.assessment_file_write(review_id,evidence_id,uploaded_by_user_id) IS NULL);

CREATE FUNCTION app.assessment_file_removable(wanted_file uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_attachment a JOIN performance_onehr_evidence e ON e.id=a.evidence_id AND e.tenant_id=a.tenant_id
 WHERE a.id=wanted_file AND a.tenant_id=app.current_tenant_id() AND a.removed_at IS NULL AND a.uploaded_by_user_id=app.current_user_id() AND e.author_user_id=app.current_user_id()
  AND (e.state='draft' OR e.state='shared' AND e.kind='recognition') AND app.assessment_file_write(a.review_id,a.evidence_id,a.uploaded_by_user_id)
  AND NOT EXISTS(SELECT 1 FROM performance_onehr_review target WHERE target.tenant_id=e.tenant_id AND target.employment_id=e.employment_id AND target.results_submitted_at IS NOT NULL AND target.submitted_proof @> jsonb_build_array(jsonb_build_object('attachmentId',a.id::text)))
  AND NOT EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.tenant_id=e.tenant_id AND f.employment_id=e.employment_id AND f.result->'provenance'->'attachments' @> jsonb_build_array(jsonb_build_object('id',a.id::text)))
  AND NOT EXISTS(SELECT 1 FROM performance_assessment_attachment_link l JOIN performance_onehr_review target ON target.review_id=l.review_id AND target.tenant_id=l.tenant_id WHERE l.attachment_id=a.id AND (target.results_submitted_at IS NOT NULL OR EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=target.review_id AND f.tenant_id=target.tenant_id)))
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.links) link JOIN performance_onehr_review target ON target.employment_id=e.employment_id AND target.tenant_id=e.tenant_id CROSS JOIN LATERAL jsonb_array_elements(target.kpis) k WHERE link->>'kind'='kpi' AND link->>'id'=k->>'id' AND (target.results_submitted_at IS NOT NULL OR EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=target.review_id AND f.tenant_id=target.tenant_id))))
$$;
CREATE FUNCTION app.assessment_file_lock_targets(wanted_file uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE file performance_attachment%ROWTYPE; entry performance_onehr_evidence%ROWTYPE;
BEGIN
 SELECT * INTO file FROM performance_attachment WHERE id=wanted_file AND tenant_id=app.current_tenant_id() AND uploaded_by_user_id=app.current_user_id() AND removed_at IS NULL;
 SELECT * INTO entry FROM performance_onehr_evidence WHERE id=file.evidence_id AND tenant_id=file.tenant_id AND author_user_id=app.current_user_id();
 IF file.id IS NULL OR entry.id IS NULL OR NOT app.assessment_evidence_access(entry.id) THEN RAISE EXCEPTION 'Supporting file not found'; END IF;
 PERFORM 1 FROM performance_onehr_review r WHERE r.tenant_id=file.tenant_id AND (r.review_id=file.review_id OR EXISTS(SELECT 1 FROM performance_assessment_attachment_link l WHERE l.attachment_id=file.id AND l.review_id=r.review_id AND l.tenant_id=r.tenant_id) OR r.employment_id=entry.employment_id AND EXISTS(SELECT 1 FROM jsonb_array_elements(entry.links) link CROSS JOIN jsonb_array_elements(r.kpis) k WHERE link->>'kind'='kpi' AND link->>'id'=k->>'id')) ORDER BY r.review_id FOR UPDATE;
END $$;
REVOKE ALL ON FUNCTION app.assessment_file_removable(uuid),app.assessment_file_lock_targets(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_file_removable(uuid),app.assessment_file_lock_targets(uuid) TO ai_hr_app;

CREATE FUNCTION app.assessment_file_remove(wanted_file uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM app.assessment_file_lock_targets(wanted_file);
 PERFORM 1 FROM performance_attachment WHERE id=wanted_file AND tenant_id=app.current_tenant_id() FOR UPDATE;
 PERFORM 1 FROM performance_onehr_evidence e JOIN performance_attachment a ON a.evidence_id=e.id AND a.tenant_id=e.tenant_id WHERE a.id=wanted_file AND a.tenant_id=app.current_tenant_id() FOR UPDATE OF e;
 IF NOT app.assessment_file_removable(wanted_file) THEN RAISE EXCEPTION 'Submitted KPI supporting files cannot be removed'; END IF;
 UPDATE performance_attachment SET removed_at=now() WHERE id=wanted_file AND tenant_id=app.current_tenant_id();
END $$;
REVOKE ALL ON FUNCTION app.assessment_file_remove(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_file_remove(uuid) TO ai_hr_app;

CREATE FUNCTION app.assessment_file_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e performance_onehr_evidence%ROWTYPE; r performance_onehr_review%ROWTYPE;
BEGIN
 SELECT * INTO r FROM performance_onehr_review WHERE review_id=NEW.review_id AND tenant_id=NEW.tenant_id;
 IF r.review_id IS NULL THEN
  IF NEW.evidence_id IS NOT NULL THEN RAISE EXCEPTION 'Evidence files require an assessment'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.employment_id<>r.employment_id THEN RAISE EXCEPTION 'File subject does not match the assessment'; END IF;
 IF TG_OP='UPDATE' THEN
  IF to_jsonb(NEW)-'removed_at' IS DISTINCT FROM to_jsonb(OLD)-'removed_at' THEN RAISE EXCEPTION 'Assessment file contents and identity are immutable'; END IF;
  PERFORM app.assessment_file_lock_targets(OLD.id);
  IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL OR NOT app.assessment_file_removable(OLD.id) THEN RAISE EXCEPTION 'Submitted KPI supporting files cannot be removed'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.uploaded_by_user_id IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'File author must be the current actor'; END IF;
 IF NEW.size_bytes<>octet_length(NEW.content) OR NEW.size_bytes NOT BETWEEN 1 AND 2097152 OR length(NEW.file_name)>200 OR lower(NEW.file_name) !~ '\.(pdf|png|jpg|jpeg|gif|webp|doc|docx|xls|xlsx|csv|txt)$' THEN RAISE EXCEPTION 'Choose a supported file no larger than 2 MB'; END IF;
 IF NEW.evidence_id IS NOT NULL THEN
  SELECT * INTO e FROM performance_onehr_evidence WHERE id=NEW.evidence_id AND tenant_id=NEW.tenant_id FOR UPDATE;
  IF e.id IS NULL OR e.review_id<>NEW.review_id OR e.employment_id<>NEW.employment_id OR e.author_user_id<>NEW.uploaded_by_user_id OR NOT (e.state='draft' OR e.state='shared' AND e.kind='recognition') THEN RAISE EXCEPTION 'Attach only to your draft or shared review recognition'; END IF;
  IF (SELECT count(*) FROM performance_attachment a WHERE a.evidence_id=e.id AND a.tenant_id=e.tenant_id AND a.removed_at IS NULL)>=4 THEN RAISE EXCEPTION 'An evidence entry can carry up to four files'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.assessment_file_validate() FROM PUBLIC;
CREATE TRIGGER assessment_file_validate BEFORE INSERT OR UPDATE ON performance_attachment FOR EACH ROW EXECUTE FUNCTION app.assessment_file_validate();

--> statement-breakpoint
CREATE FUNCTION app.assessment_kpi_file_links(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(to_jsonb(files) ORDER BY files."createdAt",files."attachmentId",files."kpiId"),'[]'::jsonb) FROM (SELECT DISTINCT ON ("attachmentId","kpiId") * FROM (
  SELECT l.id,l.tenant_id AS "tenantId",l.review_id AS "reviewId",l.attachment_id AS "attachmentId",l.kpi_id AS "kpiId",l.created_at AS "createdAt"
  FROM performance_assessment_attachment_link l JOIN performance_attachment a ON a.id=l.attachment_id AND a.tenant_id=l.tenant_id
  WHERE l.review_id=wanted_review AND l.tenant_id=app.current_tenant_id() AND app.assessment_file_read(a.review_id,a.evidence_id,a.id,a.uploaded_by_user_id,a.removed_at)
  UNION
  SELECT a.id,a.tenant_id,r.review_id,a.id,(link->>'id')::uuid,a.created_at
  FROM performance_onehr_review r JOIN performance_onehr_evidence e ON e.employment_id=r.employment_id AND e.tenant_id=r.tenant_id
  JOIN employment sub ON sub.id=e.employment_id AND sub.tenant_id=e.tenant_id JOIN app_user author ON author.id=e.author_user_id AND author.tenant_id=e.tenant_id AND author.person_id=sub.person_id
  JOIN performance_attachment a ON a.evidence_id=e.id AND a.tenant_id=e.tenant_id
  CROSS JOIN LATERAL jsonb_array_elements(e.links) link CROSS JOIN LATERAL jsonb_array_elements(r.kpis) k
  WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND e.kind='recognition' AND e.state='shared' AND link->>'kind'='kpi' AND link->>'id'=k->>'id' AND NOT coalesce((k->>'hrOwned')::boolean,false)
   AND app.assessment_file_read(a.review_id,a.evidence_id,a.id,a.uploaded_by_user_id,a.removed_at)
 UNION
 SELECT a.id,a.tenant_id,r.review_id,a.id,(proof->>'kpiId')::uuid,a.created_at
 FROM performance_onehr_review r CROSS JOIN LATERAL jsonb_array_elements(r.submitted_proof) proof JOIN performance_attachment a ON a.id=(proof->>'attachmentId')::uuid AND a.tenant_id=r.tenant_id
 WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND r.results_submitted_at IS NOT NULL AND app.assessment_file_read(a.review_id,a.evidence_id,a.id,a.uploaded_by_user_id,a.removed_at)
 ) source ORDER BY "attachmentId","kpiId","createdAt",id) files
$$;
REVOKE ALL ON FUNCTION app.assessment_kpi_file_links(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_kpi_file_links(uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.assessment_file_lock_proof(wanted_review uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE wanted performance_onehr_review%ROWTYPE; proof jsonb;
BEGIN
 SELECT r.* INTO wanted FROM performance_onehr_review r JOIN review_cycle c ON c.id=r.cycle_id AND c.tenant_id=r.tenant_id JOIN performance_onehr_cycle cfg ON cfg.cycle_id=r.cycle_id AND cfg.tenant_id=r.tenant_id JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
 WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND r.results_submitted_at IS NULL AND c.status IN ('open','calibration') AND coalesce((cfg.policy->'modules'->>'evidence')::boolean,false) AND app.is_self_person(e.person_id) AND app.onehr_review_header(r.review_id) IS NOT NULL AND app.assessment_review_participates(r.review_id) FOR UPDATE OF r;
 IF wanted.review_id IS NULL THEN RAISE EXCEPTION 'KPI proof is not assigned to you for confirmation'; END IF;
 proof:=app.assessment_kpi_file_links(wanted_review);
 PERFORM 1 FROM performance_attachment a WHERE a.tenant_id=wanted.tenant_id AND a.id IN(SELECT (p->>'attachmentId')::uuid FROM jsonb_array_elements(proof) p) ORDER BY a.id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(proof) p WHERE NOT EXISTS(SELECT 1 FROM performance_attachment a WHERE a.id=(p->>'attachmentId')::uuid AND a.tenant_id=wanted.tenant_id AND a.removed_at IS NULL)) THEN RAISE EXCEPTION 'Supporting proof changed before confirmation; retry with the current files'; END IF;
 RETURN proof;
END $$;
REVOKE ALL ON FUNCTION app.assessment_file_lock_proof(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_file_lock_proof(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Aggregate workload only; no out-of-scope subjects, answers or rater identities are returned.
CREATE FUNCTION app.assessment_peer_load(wanted_cycle uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_object_agg(load.peer_employment_id::text,load.n),'{}'::jsonb) FROM (
  SELECT p.peer_employment_id,count(*)::integer n FROM performance_onehr_panel p JOIN performance_onehr_review r ON r.review_id=p.review_id AND r.tenant_id=p.tenant_id
  WHERE r.cycle_id=wanted_cycle AND p.tenant_id=app.current_tenant_id() AND p.archived_at IS NULL AND p.relationship='peer'
   AND app.onehr_cycle_admin(wanted_cycle) AND app.can_see_employment(p.peer_employment_id)
  GROUP BY p.peer_employment_id
 ) load
$$;
REVOKE ALL ON FUNCTION app.assessment_peer_load(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_peer_load(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Successful AI drafts have their own business counter, independent of best-effort proposal telemetry.
CREATE TABLE performance_assessment_ai_use (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 review_id uuid NOT NULL REFERENCES performance_onehr_review(review_id),actor_user_id uuid NOT NULL REFERENCES app_user(id),
 field_key text NOT NULL CHECK(length(field_key) BETWEEN 1 AND 200),request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,actor_user_id,request_id)
);
CREATE INDEX assessment_ai_use_daily ON performance_assessment_ai_use(tenant_id,actor_user_id,field_key,created_at);
ALTER TABLE performance_assessment_ai_use ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_assessment_ai_use FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON performance_assessment_ai_use TO ai_hr_app;
CREATE POLICY assessment_ai_use_read ON performance_assessment_ai_use FOR SELECT USING(tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id());
CREATE POLICY assessment_ai_use_insert ON performance_assessment_ai_use FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id() AND app.onehr_review_header(review_id) IS NOT NULL);
CREATE FUNCTION app.assessment_ai_use_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.actor_user_id IS DISTINCT FROM app.current_user_id() OR NOT EXISTS(SELECT 1 FROM performance_onehr_review WHERE review_id=NEW.review_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Invalid AI usage actor or assessment'; END IF;
 NEW.created_at:=now();
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':'||NEW.actor_user_id::text||':'||NEW.field_key||':'||(now() at time zone 'Asia/Kuala_Lumpur')::date::text,0));
 IF (SELECT count(*) FROM performance_assessment_ai_use WHERE tenant_id=NEW.tenant_id AND actor_user_id=NEW.actor_user_id AND field_key=NEW.field_key AND created_at>=((now() at time zone 'Asia/Kuala_Lumpur')::date::timestamp at time zone 'Asia/Kuala_Lumpur'))>=5 THEN RAISE EXCEPTION 'All 5 AI suggestions for this field have been used today. The limit resets at midnight Malaysia time.'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.assessment_ai_use_validate() FROM PUBLIC;
CREATE TRIGGER assessment_ai_use_guard BEFORE INSERT ON performance_assessment_ai_use FOR EACH ROW EXECUTE FUNCTION app.assessment_ai_use_validate();
--> statement-breakpoint
-- Derived contents are cached by the immutable native attachment; this is not another file store.
CREATE TABLE performance_assessment_file_text (
 attachment_id uuid PRIMARY KEY REFERENCES performance_attachment(id),tenant_id uuid NOT NULL REFERENCES tenant(id),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 status text NOT NULL CHECK(status IN ('ok','no_text','unsupported','too_big','unreadable','retry')),
 method text NOT NULL CHECK(method IN ('local','vision')),text text NOT NULL DEFAULT '' CHECK(length(text)<=6080),
 attempts integer NOT NULL DEFAULT 1 CHECK(attempts BETWEEN 1 AND 2),read_at timestamptz NOT NULL DEFAULT now(),
 CHECK(status='ok' OR text='')
);
ALTER TABLE performance_assessment_file_text ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_assessment_file_text FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON performance_assessment_file_text TO ai_hr_app;
CREATE POLICY assessment_file_text_access ON performance_assessment_file_text FOR ALL USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM performance_attachment a WHERE a.id=attachment_id AND a.tenant_id=performance_assessment_file_text.tenant_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM performance_attachment a WHERE a.id=attachment_id AND a.tenant_id=performance_assessment_file_text.tenant_id));
CREATE FUNCTION app.assessment_file_text_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM performance_attachment a JOIN performance_onehr_review r ON r.review_id=a.review_id AND r.tenant_id=a.tenant_id WHERE a.id=NEW.attachment_id AND a.tenant_id=NEW.tenant_id AND encode(sha256(a.content),'hex')=NEW.content_hash) THEN RAISE EXCEPTION 'File text must reference the immutable native attachment'; END IF;
 IF TG_OP='UPDATE' AND (NEW.attachment_id IS DISTINCT FROM OLD.attachment_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.content_hash IS DISTINCT FROM OLD.content_hash) THEN RAISE EXCEPTION 'File text identity is immutable'; END IF;
 NEW.read_at:=now();RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.assessment_file_text_validate() FROM PUBLIC;
CREATE TRIGGER assessment_file_text_guard BEFORE INSERT OR UPDATE ON performance_assessment_file_text FOR EACH ROW EXECUTE FUNCTION app.assessment_file_text_validate();

--> statement-breakpoint
-- An overall PM remark belongs to its author, including matrix co-approvers.
-- The legacy manager_remark column below is a derived compatibility projection.
ALTER TABLE performance_onehr_review ADD COLUMN manager_remark_by_user_id uuid REFERENCES app_user(id);
CREATE TABLE performance_assessment_reviewer_remark (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),review_id uuid NOT NULL REFERENCES performance_onehr_review(review_id),
 actor_user_id uuid REFERENCES app_user(id),actor_role text NOT NULL CHECK(actor_role IN ('line_manager','approver','legacy')),
 remark text NOT NULL CHECK(length(remark)<=4000),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(review_id,actor_user_id)
);
CREATE UNIQUE INDEX assessment_reviewer_remark_legacy_uq ON performance_assessment_reviewer_remark(review_id) WHERE actor_user_id IS NULL;
-- A historical author is recovered from the actual confirmation event, never guessed from today's org.
INSERT INTO performance_assessment_reviewer_remark(tenant_id,review_id,actor_user_id,actor_role,remark,updated_at)
 SELECT r.tenant_id,r.review_id,actor.id,CASE WHEN actor.id IS NULL THEN 'legacy' WHEN actor.person_id=m.person_id THEN 'line_manager' ELSE 'approver' END,r.manager_remark,coalesce(saved.occurred_at,r.created_at)
 FROM performance_onehr_review r JOIN performance_review pr ON pr.id=r.review_id AND pr.tenant_id=r.tenant_id LEFT JOIN employment m ON m.id=pr.reviewer_employment_id AND m.tenant_id=pr.tenant_id
 LEFT JOIN LATERAL (SELECT d.actor_id,d.occurred_at FROM domain_event d WHERE d.tenant_id=r.tenant_id AND d.aggregate_id=r.review_id AND d.event_type IN ('onehr.performance-confirmed','onehr.moderation-submitted') ORDER BY d.occurred_at DESC,d.id DESC LIMIT 1) saved ON true
 LEFT JOIN app_user actor ON actor.id=saved.actor_id AND actor.tenant_id=r.tenant_id WHERE trim(r.manager_remark)<>'';
-- Preserve any already-saved private reviewer words when upgrading the native draft representation.
INSERT INTO performance_assessment_reviewer_remark(tenant_id,review_id,actor_user_id,actor_role,remark,updated_at)
 SELECT d.tenant_id,d.review_id,d.actor_user_id,CASE WHEN u.person_id=m.person_id THEN 'line_manager' ELSE 'approver' END,trim(d.payload->>'remark'),d.updated_at
 FROM performance_assessment_draft d JOIN performance_onehr_review r ON r.review_id=d.review_id AND r.tenant_id=d.tenant_id JOIN performance_review pr ON pr.id=r.review_id AND pr.tenant_id=r.tenant_id
 JOIN app_user u ON u.id=d.actor_user_id AND u.tenant_id=d.tenant_id LEFT JOIN employment m ON m.id=pr.reviewer_employment_id AND m.tenant_id=pr.tenant_id
 WHERE d.kind='moderation' AND d.context_id=d.review_id AND trim(coalesce(d.payload->>'remark',''))<>'' AND NOT EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=r.review_id)
 ON CONFLICT(review_id,actor_user_id) DO NOTHING;
-- The shared review row must never cache private in-progress words.
WITH cache AS (
 SELECT r.review_id,CASE WHEN settled.ok THEN coalesce(n.remark,'') ELSE '' END AS remark,CASE WHEN settled.ok THEN n.actor_user_id ELSE NULL END AS actor_user_id
 FROM performance_onehr_review r CROSS JOIN LATERAL (SELECT r.results_submitted_at IS NOT NULL AND jsonb_array_length(r.kpis)>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.kpis) k WHERE NOT coalesce((k->>'locked')::boolean,false)) AS ok) settled
 LEFT JOIN LATERAL (SELECT note.remark,note.actor_user_id FROM performance_assessment_reviewer_remark note WHERE note.review_id=r.review_id AND note.tenant_id=r.tenant_id AND note.actor_role IN ('line_manager','legacy') ORDER BY CASE note.actor_role WHEN 'line_manager' THEN 0 ELSE 1 END,note.updated_at DESC,note.id DESC LIMIT 1) n ON true
 WHERE NOT EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=r.review_id) AND EXISTS(SELECT 1 FROM review_cycle c WHERE c.id=r.cycle_id AND c.tenant_id=r.tenant_id AND c.status<>'closed')
)
UPDATE performance_onehr_review r SET manager_remark=cache.remark,manager_remark_by_user_id=cache.actor_user_id FROM cache WHERE cache.review_id=r.review_id AND (r.manager_remark IS DISTINCT FROM cache.remark OR r.manager_remark_by_user_id IS DISTINCT FROM cache.actor_user_id);
CREATE FUNCTION app.assessment_reviewer_remark_pending(wanted_review uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_review r CROSS JOIN LATERAL jsonb_array_elements(r.kpis) k CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_array_length(coalesce(k->'approvalChain','[]'::jsonb))>0 THEN k->'approvalChain' ELSE jsonb_build_array(jsonb_build_object('employmentId',k->>'moderatorEmploymentId','at',NULL)) END) step
  JOIN employment m ON m.id=(step->>'employmentId')::uuid AND m.tenant_id=r.tenant_id JOIN app_user u ON u.person_id=m.person_id AND u.tenant_id=m.tenant_id
  WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id() AND NOT coalesce((k->>'hrOwned')::boolean,false) AND NOT coalesce((k->>'locked')::boolean,false) AND step->>'at' IS NULL AND app.onehr_moderator(r.review_id))
$$;
CREATE FUNCTION app.assessment_reviewer_remarks_settled(wanted_review uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_review r WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND r.results_submitted_at IS NOT NULL AND jsonb_array_length(r.kpis)>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.kpis) k WHERE NOT coalesce((k->>'locked')::boolean,false)))
$$;
CREATE FUNCTION app.assessment_reviewer_remarks_reader(wanted_review uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_review r JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id JOIN app_user u ON u.id=app.current_user_id() AND u.tenant_id=r.tenant_id
  WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND (app.is_self_person(e.person_id) OR app.onehr_manager(r.review_id) OR app.onehr_moderator(r.review_id) OR app.onehr_cycle_admin(r.cycle_id) OR EXISTS(SELECT 1 FROM performance_onehr_calibration_entry ce WHERE ce.review_id=r.review_id AND ce.tenant_id=r.tenant_id AND app.onehr_calibration_access(ce.session_id))))
$$;
CREATE FUNCTION app.assessment_locked_reviewer_remarks(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('actorUserId',n.actor_user_id,'author',coalesce(p.full_name,'Historical reviewer'),'remark',n.remark,'role',CASE WHEN u.person_id=manager.person_id THEN 'Line manager' ELSE 'Approver' END,'legacy',n.actor_user_id IS NULL) ORDER BY CASE WHEN u.person_id=manager.person_id THEN 0 ELSE 1 END,n.updated_at,n.id),'[]'::jsonb)
 FROM performance_assessment_reviewer_remark n JOIN performance_review pr ON pr.id=n.review_id AND pr.tenant_id=n.tenant_id LEFT JOIN employment manager ON manager.id=pr.reviewer_employment_id AND manager.tenant_id=pr.tenant_id
 LEFT JOIN app_user u ON u.id=n.actor_user_id AND u.tenant_id=n.tenant_id LEFT JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
 WHERE n.review_id=wanted_review AND n.tenant_id=app.current_tenant_id() AND trim(n.remark)<>'' AND app.assessment_reviewer_remarks_settled(wanted_review) AND app.assessment_reviewer_remarks_reader(wanted_review)
$$;
REVOKE ALL ON FUNCTION app.assessment_reviewer_remark_pending(uuid),app.assessment_reviewer_remarks_settled(uuid),app.assessment_reviewer_remarks_reader(uuid),app.assessment_locked_reviewer_remarks(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_reviewer_remark_pending(uuid),app.assessment_reviewer_remarks_settled(uuid),app.assessment_reviewer_remarks_reader(uuid),app.assessment_locked_reviewer_remarks(uuid) TO ai_hr_app;
ALTER TABLE performance_assessment_reviewer_remark ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_assessment_reviewer_remark FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON performance_assessment_reviewer_remark TO ai_hr_app;
CREATE POLICY assessment_reviewer_remark_read ON performance_assessment_reviewer_remark FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.assessment_reviewer_remarks_reader(review_id) AND (actor_user_id=app.current_user_id() OR app.assessment_reviewer_remarks_settled(review_id)));
CREATE POLICY assessment_reviewer_remark_insert ON performance_assessment_reviewer_remark FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id() AND (app.onehr_manager(review_id) OR app.onehr_moderator(review_id)));
CREATE POLICY assessment_reviewer_remark_update ON performance_assessment_reviewer_remark FOR UPDATE USING(tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id() AND (app.onehr_manager(review_id) OR app.onehr_moderator(review_id))) WITH CHECK(tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id() AND (app.onehr_manager(review_id) OR app.onehr_moderator(review_id)));
CREATE FUNCTION app.assessment_reviewer_remark_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r performance_onehr_review; c performance_onehr_cycle; status text;
BEGIN
 SELECT * INTO r FROM performance_onehr_review WHERE review_id=NEW.review_id AND tenant_id=NEW.tenant_id;
 SELECT * INTO c FROM performance_onehr_cycle WHERE cycle_id=r.cycle_id AND tenant_id=r.tenant_id;
 SELECT review_cycle.status INTO status FROM review_cycle WHERE id=r.cycle_id AND tenant_id=r.tenant_id;
 IF r.review_id IS NULL OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.actor_user_id IS DISTINCT FROM app.current_user_id() OR NOT (app.onehr_manager(r.review_id) OR app.onehr_moderator(r.review_id)) OR NOT app.assessment_review_participates(r.review_id) THEN RAISE EXCEPTION 'Invalid reviewer remark actor or assessment'; END IF;
 IF EXISTS(SELECT 1 FROM performance_onehr_result WHERE review_id=r.review_id) OR status NOT IN ('open','calibration') OR c.policy->>'kind'='quarterly' OR NOT coalesce((c.policy->'modules'->>'pm')::boolean,false) THEN RAISE EXCEPTION 'Reviewer remarks are read-only'; END IF;
 IF c.policy->'windows'->'pm_approve'->>'opensAt' IS NOT NULL AND now()<(c.policy->'windows'->'pm_approve'->>'opensAt')::timestamptz OR c.policy->'windows'->'pm_approve'->>'closesAt' IS NOT NULL AND now()>=(c.policy->'windows'->'pm_approve'->>'closesAt')::timestamptz THEN RAISE EXCEPTION 'Performance review is not open'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.review_id IS DISTINCT FROM OLD.review_id OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id) THEN RAISE EXCEPTION 'Reviewer remark identity is immutable'; END IF;
 NEW.remark:=trim(NEW.remark);
 IF NOT app.assessment_reviewer_remark_pending(r.review_id) AND NOT (TG_OP='INSERT' AND app.onehr_manager(r.review_id) AND r.manager_performance IS NULL) THEN
  IF TG_OP='UPDATE' AND NEW.remark IS NOT DISTINCT FROM OLD.remark THEN NEW.actor_role:=OLD.actor_role;NEW.updated_at:=OLD.updated_at;RETURN NEW; END IF;
  RAISE EXCEPTION 'Your completed reviewer remark is immutable';
 END IF;
 IF NEW.remark<>'' AND cardinality(regexp_split_to_array(NEW.remark,'\s+'))>220 THEN RAISE EXCEPTION 'Overall review remarks are limited to 220 words'; END IF;
 NEW.actor_role:=CASE WHEN app.onehr_manager(r.review_id) THEN 'line_manager' ELSE 'approver' END;NEW.updated_at:=now();RETURN NEW;
END $$;
CREATE FUNCTION app.assessment_manager_remark_cache_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE expected_text text; expected_actor uuid;
BEGIN
 IF NEW.manager_remark IS DISTINCT FROM OLD.manager_remark OR NEW.manager_remark_by_user_id IS DISTINCT FROM OLD.manager_remark_by_user_id THEN
  IF app.assessment_reviewer_remarks_settled(NEW.review_id) THEN
  SELECT n.remark,n.actor_user_id INTO expected_text,expected_actor FROM performance_assessment_reviewer_remark n WHERE n.review_id=NEW.review_id AND n.tenant_id=NEW.tenant_id AND n.actor_role IN ('line_manager','legacy') ORDER BY CASE n.actor_role WHEN 'line_manager' THEN 0 ELSE 1 END,n.updated_at DESC,n.id DESC LIMIT 1;
  END IF;
  IF NEW.manager_remark IS DISTINCT FROM coalesce(expected_text,'') OR NEW.manager_remark_by_user_id IS DISTINCT FROM expected_actor THEN RAISE EXCEPTION 'The manager remark is derived from its authored reviewer record'; END IF;
 END IF;RETURN NEW;
END $$;
CREATE FUNCTION app.assessment_manager_remark_cache_sync() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE expected_text text; expected_actor uuid;
BEGIN
 IF app.assessment_reviewer_remarks_settled(NEW.review_id) THEN
 SELECT n.remark,n.actor_user_id INTO expected_text,expected_actor FROM performance_assessment_reviewer_remark n WHERE n.review_id=NEW.review_id AND n.tenant_id=NEW.tenant_id AND n.actor_role IN ('line_manager','legacy') ORDER BY CASE n.actor_role WHEN 'line_manager' THEN 0 ELSE 1 END,n.updated_at DESC,n.id DESC LIMIT 1;
 END IF;
 UPDATE performance_onehr_review SET manager_remark=coalesce(expected_text,''),manager_remark_by_user_id=expected_actor WHERE review_id=NEW.review_id AND tenant_id=NEW.tenant_id AND (manager_remark IS DISTINCT FROM coalesce(expected_text,'') OR manager_remark_by_user_id IS DISTINCT FROM expected_actor);RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.assessment_reviewer_remark_validate(),app.assessment_manager_remark_cache_validate(),app.assessment_manager_remark_cache_sync() FROM PUBLIC;
CREATE TRIGGER assessment_reviewer_remark_guard BEFORE INSERT OR UPDATE ON performance_assessment_reviewer_remark FOR EACH ROW EXECUTE FUNCTION app.assessment_reviewer_remark_validate();
CREATE TRIGGER assessment_manager_remark_cache_guard BEFORE UPDATE ON performance_onehr_review FOR EACH ROW EXECUTE FUNCTION app.assessment_manager_remark_cache_validate();
CREATE TRIGGER assessment_manager_remark_cache_sync AFTER INSERT OR UPDATE ON performance_assessment_reviewer_remark FOR EACH ROW EXECUTE FUNCTION app.assessment_manager_remark_cache_sync();
CREATE TRIGGER assessment_manager_remark_publish AFTER UPDATE OF kpis,results_submitted_at ON performance_onehr_review FOR EACH ROW EXECUTE FUNCTION app.assessment_manager_remark_cache_sync();

--> statement-breakpoint
-- A scoped reviewer projection. It exposes submitted facts, never private drafts, peer answers or another scope.
CREATE FUNCTION app.assessment_insight_source(wanted_review uuid,wanted_context uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH authorized AS (
  SELECT r.*,p.full_name,c.policy,s.tier,s.id AS calibration_id,
   CASE WHEN wanted_context<>wanted_review THEN 'calibrator' ELSE 'manager' END AS reviewer_kind
  FROM performance_onehr_review r JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
   JOIN performance_onehr_cycle c ON c.cycle_id=r.cycle_id AND c.tenant_id=r.tenant_id
   LEFT JOIN performance_onehr_calibration s ON s.id=wanted_context AND s.cycle_id=r.cycle_id AND s.tenant_id=r.tenant_id AND wanted_context<>wanted_review
  WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND NOT app.is_self_person(e.person_id)
   AND coalesce((c.policy->'modules'->>'pm')::boolean,false) AND c.policy->>'kind'<>'quarterly'
   AND CASE WHEN wanted_context=wanted_review THEN app.onehr_manager(r.review_id) OR app.onehr_moderator(r.review_id)
    ELSE s.id IS NOT NULL AND coalesce((c.policy->'modules'->>'calibration')::boolean,true) AND app.onehr_calibration_access(s.id)
     AND EXISTS(SELECT 1 FROM performance_onehr_calibration_entry ce WHERE ce.session_id=s.id AND ce.review_id=r.review_id AND ce.tenant_id=r.tenant_id) END
 ), scoped AS (
  SELECT a.*,CASE WHEN a.results_submitted_at IS NULL THEN '[]'::jsonb ELSE coalesce((SELECT jsonb_agg(k ORDER BY ord) FROM jsonb_array_elements(a.kpis) WITH ORDINALITY q(k,ord)
   WHERE a.reviewer_kind='calibrator' OR coalesce((k->>'hrOwned')::boolean,false) OR EXISTS(
    SELECT 1 FROM employment m JOIN app_user u ON u.person_id=m.person_id AND u.tenant_id=m.tenant_id
     WHERE u.id=app.current_user_id() AND m.tenant_id=a.tenant_id AND (k->>'moderatorEmploymentId'=m.id::text OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(k->'approvalChain','[]'::jsonb)) ap WHERE ap->>'employmentId'=m.id::text))
   )),'[]'::jsonb) END AS visible_kpis FROM authorized a
 )
 SELECT jsonb_build_object('reviewId',a.review_id,'cycleId',a.cycle_id,'companyId',a.company_id,'name',a.full_name,'revision',a.revision,'reviewerKind',a.reviewer_kind,
  'kpis',a.visible_kpis,'submitted',a.results_submitted_at IS NOT NULL,'selfRemark',CASE WHEN a.results_submitted_at IS NOT NULL AND (a.reviewer_kind='calibrator' OR app.onehr_manager(a.review_id)) THEN a.self_remark ELSE '' END,
  'reviewerRemarks',CASE WHEN a.reviewer_kind='calibrator' THEN app.assessment_locked_reviewer_remarks(a.review_id) ELSE '[]'::jsonb END,
  'bands',jsonb_build_object('aBands',a.policy->'aBands','bBands',a.policy->'bBands'),'evidenceEnabled',coalesce((a.policy->'modules'->>'evidence')::boolean,false),
  'names',coalesce((SELECT jsonb_object_agg(m.id::text,p.full_name) FROM employment m JOIN person p ON p.id=m.person_id AND p.tenant_id=m.tenant_id WHERE m.tenant_id=a.tenant_id AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.visible_kpis) k WHERE k->>'moderatorEmploymentId'=m.id::text OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(k->'approvalChain','[]'::jsonb)) ap WHERE ap->>'employmentId'=m.id::text))),'{}'::jsonb),
  'fileLinks',CASE WHEN a.results_submitted_at IS NOT NULL THEN coalesce((SELECT jsonb_agg(link ORDER BY link->>'attachmentId',link->>'kpiId') FROM jsonb_array_elements(app.assessment_kpi_file_links(a.review_id)) link WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(a.visible_kpis) k WHERE k->>'id'=link->>'kpiId' AND NOT coalesce((k->>'hrOwned')::boolean,false))),'[]'::jsonb) ELSE '[]'::jsonb END,
  'trail',CASE WHEN a.reviewer_kind='calibrator' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('tier',s.tier,'label',CASE s.tier WHEN 'hod' THEN 'HOD' WHEN 'bu' THEN 'BU CEO' WHEN 'bg' THEN 'BG CEO' ELSE 'Group' END,'by',coalesce((SELECT p.full_name FROM domain_event d JOIN app_user u ON u.id=d.actor_id AND u.tenant_id=d.tenant_id JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE d.tenant_id=a.tenant_id AND d.aggregate_id=s.id AND d.event_type='onehr.calibration-recorded' AND d.payload->>'reviewId'=a.review_id::text ORDER BY d.occurred_at DESC,d.id DESC LIMIT 1),''),'from',ce.seen_performance,'band',ce.performance,'note',ce.performance_note) ORDER BY array_position(ARRAY['hod','bu','bg','group','final'],s.tier))
   FROM performance_onehr_calibration_entry ce JOIN performance_onehr_calibration s ON s.id=ce.session_id AND s.tenant_id=ce.tenant_id
   WHERE ce.review_id=a.review_id AND ce.tenant_id=a.tenant_id AND (ce.performance_locked_at IS NOT NULL OR s.performance_locked_at IS NOT NULL) AND array_position(ARRAY['hod','bu','bg','group','final'],s.tier)<array_position(ARRAY['hod','bu','bg','group','final'],a.tier)),'[]'::jsonb) ELSE '[]'::jsonb END
 ) FROM scoped a
$$;
REVOKE ALL ON FUNCTION app.assessment_insight_source(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_insight_source(uuid,uuid) TO ai_hr_app;

--> statement-breakpoint
-- A reviewer-owned, disposable cache. Every read also rechecks live assignment and the source fingerprint.
CREATE TABLE performance_assessment_insight (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),review_id uuid NOT NULL REFERENCES performance_onehr_review(review_id),
 actor_user_id uuid NOT NULL REFERENCES app_user(id),context_id uuid NOT NULL,fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 source text NOT NULL CHECK(source IN ('plain','ai')),data jsonb NOT NULL CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=120000),
 retry boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(review_id,actor_user_id,context_id)
);
ALTER TABLE performance_assessment_insight ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_assessment_insight FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON performance_assessment_insight TO ai_hr_app;
CREATE POLICY assessment_insight_access ON performance_assessment_insight FOR ALL USING(tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id() AND app.assessment_insight_source(review_id,context_id) IS NOT NULL) WITH CHECK(tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id() AND app.assessment_insight_source(review_id,context_id) IS NOT NULL);
CREATE FUNCTION app.assessment_insight_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.actor_user_id IS DISTINCT FROM app.current_user_id() OR app.assessment_insight_source(NEW.review_id,NEW.context_id) IS NULL THEN RAISE EXCEPTION 'Invalid assessment insight actor or scope'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.review_id IS DISTINCT FROM OLD.review_id OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id OR NEW.context_id IS DISTINCT FROM OLD.context_id) THEN RAISE EXCEPTION 'Assessment insight identity is immutable'; END IF;
 NEW.updated_at:=now();RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.assessment_insight_validate() FROM PUBLIC;
CREATE TRIGGER assessment_insight_guard BEFORE INSERT OR UPDATE ON performance_assessment_insight FOR EACH ROW EXECUTE FUNCTION app.assessment_insight_validate();
--> statement-breakpoint
-- A leader's cohort conversation and held department edits belong to the actor and scope.
CREATE TABLE performance_calibration_conversation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 session_id uuid NOT NULL REFERENCES performance_onehr_calibration(id),actor_user_id uuid NOT NULL REFERENCES app_user(id),
 axis text NOT NULL CHECK(axis IN ('performance','potential','both')),
 messages jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(messages)='array' AND jsonb_array_length(messages)<=300),
 held jsonb NOT NULL DEFAULT '{"lines":[],"focus":null,"requestId":null}' CHECK(jsonb_typeof(held)='object' AND jsonb_typeof(held->'lines')='array' AND jsonb_array_length(held->'lines')<=200),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT performance_calibration_conversation_actor_uq UNIQUE(session_id,actor_user_id,axis)
);
CREATE FUNCTION app.assessment_calibration_chat_access(wanted_session uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT app.onehr_calibration_access(wanted_session) AND EXISTS(
  SELECT 1 FROM performance_onehr_calibration s JOIN performance_onehr_cycle c ON c.cycle_id=s.cycle_id AND c.tenant_id=s.tenant_id
  WHERE s.id=wanted_session AND s.tenant_id=app.current_tenant_id()
   AND coalesce((c.policy->'modules'->>'calibration')::boolean,true) AND coalesce((c.policy->'modules'->>'review')::boolean,true))
$$;
CREATE FUNCTION app.assessment_calibration_chat_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM performance_onehr_calibration s JOIN review_cycle c ON c.id=s.cycle_id AND c.tenant_id=s.tenant_id JOIN app_user u ON u.id=NEW.actor_user_id AND u.tenant_id=s.tenant_id WHERE s.id=NEW.session_id AND s.tenant_id=NEW.tenant_id AND c.status IN ('open','calibration')) THEN RAISE EXCEPTION 'Invalid or closed calibration conversation'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.held->'lines') h WHERE jsonb_typeof(h->'sessionRevision') IS DISTINCT FROM 'number' OR (h->>'sessionRevision') !~ '^[1-9][0-9]*$' OR jsonb_typeof(h->'reason') IS DISTINCT FROM 'string' OR length(h->>'reason')>4000 OR h->>'axis' NOT IN ('performance','potential') OR h->>'axis' IS NULL OR h->>'band' IS NULL OR (h->>'axis'='performance' AND h->>'band' NOT IN ('UA','BE','ME','AE','OU')) OR (h->>'axis'='potential' AND h->>'band' NOT IN ('Low','Mid','High')) OR NOT EXISTS(SELECT 1 FROM performance_onehr_calibration_entry ce WHERE ce.session_id=NEW.session_id AND ce.tenant_id=NEW.tenant_id AND ce.review_id::text=h->>'reviewId')) THEN RAISE EXCEPTION 'Held review must belong to this calibration cohort'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.tenant_id,NEW.session_id,NEW.actor_user_id,NEW.axis) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.session_id,OLD.actor_user_id,OLD.axis) THEN RAISE EXCEPTION 'Calibration conversation identity is immutable'; END IF;
  IF jsonb_array_length(NEW.messages)<jsonb_array_length(OLD.messages) OR EXISTS(SELECT 1 FROM jsonb_array_elements(OLD.messages) WITH ORDINALITY p(v,i) WHERE NEW.messages->((p.i-1)::integer) IS DISTINCT FROM p.v) THEN RAISE EXCEPTION 'Calibration conversation is append-only'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.assessment_calibration_chat_access(uuid),app.assessment_calibration_chat_validate() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_calibration_chat_access(uuid) TO ai_hr_app;
ALTER TABLE performance_calibration_conversation ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_calibration_conversation FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON performance_calibration_conversation TO ai_hr_app;
CREATE POLICY calibration_conversation_read ON performance_calibration_conversation FOR SELECT USING(tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id() AND app.assessment_calibration_chat_access(session_id));
CREATE POLICY calibration_conversation_insert ON performance_calibration_conversation FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id() AND app.assessment_calibration_chat_access(session_id));
CREATE POLICY calibration_conversation_update ON performance_calibration_conversation FOR UPDATE USING(tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id() AND app.assessment_calibration_chat_access(session_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND actor_user_id=app.current_user_id() AND app.assessment_calibration_chat_access(session_id));
CREATE TRIGGER calibration_conversation_links BEFORE INSERT OR UPDATE ON performance_calibration_conversation FOR EACH ROW EXECUTE FUNCTION app.assessment_calibration_chat_validate();
--> statement-breakpoint
-- Development suggestions read only the employee's latest expressly released anonymous report.
CREATE FUNCTION app.assessment_development_feedback(wanted_review uuid) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT (
  SELECT card.value->'result'->'anonymousFeedback'
  FROM performance_onehr_review h JOIN review_cycle c ON c.id=h.cycle_id AND c.tenant_id=h.tenant_id
  CROSS JOIN LATERAL (SELECT app.onehr_result_card(h.review_id) AS value) card
  WHERE h.employment_id=r.employment_id AND h.tenant_id=r.tenant_id AND card.value->>'feedbackReleasedAt' IS NOT NULL
   AND jsonb_typeof(card.value->'result'->'anonymousFeedback')='object'
  ORDER BY c.period_end DESC,h.review_id LIMIT 1)
 FROM performance_onehr_review r JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
 JOIN performance_onehr_cycle cfg ON cfg.cycle_id=r.cycle_id AND cfg.tenant_id=r.tenant_id
 WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND app.is_self_person(e.person_id)
  AND coalesce((cfg.policy->'modules'->>'idp')::boolean,false)
$$;
REVOKE ALL ON FUNCTION app.assessment_development_feedback(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assessment_development_feedback(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Group mode is HR configuration. Final-tier decisions remain HR-owned even if an old cohort named a manager.
CREATE OR REPLACE FUNCTION app.onehr_calibration_access(wanted_session uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_calibration s JOIN app_user u ON u.id=app.current_user_id() AND u.tenant_id=s.tenant_id
 WHERE s.id=wanted_session AND s.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND CASE WHEN s.tier='final' THEN app.onehr_cycle_admin(s.cycle_id) ELSE app.onehr_admin(s.company_id) OR u.id=ANY(s.reviewer_user_ids) END)
$$;
CREATE FUNCTION app.assessment_final_authority() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s performance_onehr_calibration;
BEGIN
 IF TG_TABLE_NAME='performance_onehr_calibration' THEN
  IF TG_OP='UPDATE' AND (NEW.tier IS DISTINCT FROM OLD.tier OR NEW.company_id IS DISTINCT FROM OLD.company_id) THEN RAISE EXCEPTION 'Calibration scope identity is immutable'; END IF;
  IF NEW.tier<>'group' AND NEW.bg_weight<>50 THEN RAISE EXCEPTION 'Blend weights belong to Group calibration'; END IF;
  IF TG_OP='INSERT' OR NEW.mode IS DISTINCT FROM OLD.mode OR NEW.bg_weight IS DISTINCT FROM OLD.bg_weight OR NEW.tier='final' THEN
   IF NOT app.onehr_cycle_admin(NEW.cycle_id) THEN RAISE EXCEPTION 'Performance administrator access is required'; END IF;
  END IF;
 ELSE
  SELECT * INTO s FROM performance_onehr_calibration WHERE id=NEW.session_id AND tenant_id=NEW.tenant_id;
  IF s.tier='final' AND (NOT app.onehr_cycle_admin(s.cycle_id) OR TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM employment e WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id AND app.is_self_person(e.person_id))) THEN RAISE EXCEPTION 'Final bands require an independent performance administrator'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assessment_final_authority BEFORE INSERT OR UPDATE ON performance_onehr_calibration FOR EACH ROW EXECUTE FUNCTION app.assessment_final_authority();
CREATE TRIGGER assessment_final_authority BEFORE INSERT OR UPDATE ON performance_onehr_calibration_entry FOR EACH ROW EXECUTE FUNCTION app.assessment_final_authority();
REVOKE ALL ON FUNCTION app.assessment_final_authority(),app.onehr_calibration_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_calibration_access(uuid) TO ai_hr_app;
