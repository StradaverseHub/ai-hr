-- Native OneHR aggregates. No source users, passwords, salary tables or transcripts are imported.
CREATE TABLE performance_onehr_cycle(cycle_id uuid PRIMARY KEY REFERENCES review_cycle(id),tenant_id uuid NOT NULL REFERENCES tenant(id),policy jsonb NOT NULL,revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE performance_onehr_review(review_id uuid PRIMARY KEY REFERENCES performance_review(id),tenant_id uuid NOT NULL REFERENCES tenant(id),cycle_id uuid NOT NULL REFERENCES review_cycle(id),employment_id uuid NOT NULL REFERENCES employment(id),company_id uuid NOT NULL REFERENCES company(id),grade text NOT NULL,kpis jsonb NOT NULL DEFAULT '[]',competencies jsonb NOT NULL DEFAULT '[]',statements jsonb NOT NULL DEFAULT '[]',results_submitted_at timestamptz,competency_status text NOT NULL DEFAULT 'pending' CHECK(competency_status IN ('pending','submitted','reviewed')),manager_performance text CHECK(manager_performance IN ('UA','BE','ME','AE','OU')),manager_score numeric(20,8),manager_remark text NOT NULL DEFAULT '',revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE performance_onehr_panel(request_id uuid PRIMARY KEY REFERENCES peer_feedback_request(id),tenant_id uuid NOT NULL REFERENCES tenant(id),review_id uuid NOT NULL REFERENCES performance_review(id),subject_employment_id uuid NOT NULL REFERENCES employment(id),peer_employment_id uuid NOT NULL REFERENCES employment(id),relationship text NOT NULL CHECK(relationship IN ('line_manager','matrix_manager','peer','direct_report')),answers jsonb,remark text NOT NULL DEFAULT '',submitted_at timestamptz,archived_at timestamptz);
CREATE TABLE performance_onehr_calibration(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),cycle_id uuid NOT NULL REFERENCES review_cycle(id),company_id uuid REFERENCES company(id),name text NOT NULL,tier text NOT NULL CHECK(tier IN ('hod','bu','bg','group','final')),reviewer_user_ids uuid[] NOT NULL,pbt_achievement numeric(12,2),mode text NOT NULL DEFAULT 'after' CHECK(mode IN ('after','replace','blend')),performance_locked_at timestamptz,potential_locked_at timestamptz,locked_at timestamptz,revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE performance_onehr_calibration_entry(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),session_id uuid NOT NULL REFERENCES performance_onehr_calibration(id),review_id uuid NOT NULL REFERENCES performance_review(id),employment_id uuid NOT NULL REFERENCES employment(id),performance text CHECK(performance IN ('UA','BE','ME','AE','OU')),potential text CHECK(potential IN ('Low','Mid','High')),performance_note text NOT NULL DEFAULT '',potential_note text NOT NULL DEFAULT '',seen_performance text,seen_potential text,performance_locked_at timestamptz,potential_locked_at timestamptz,locked_at timestamptz,pip boolean NOT NULL DEFAULT false,promotion boolean NOT NULL DEFAULT false,special_reward boolean NOT NULL DEFAULT false,UNIQUE(session_id,review_id));
CREATE TABLE performance_onehr_plan(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),employment_id uuid NOT NULL REFERENCES employment(id),review_id uuid NOT NULL REFERENCES performance_review(id),plan_year integer NOT NULL,status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','shared','closed')),career jsonb,goals jsonb NOT NULL DEFAULT '[]',manager_comment text NOT NULL DEFAULT '',conversation text NOT NULL DEFAULT '',acknowledged_at timestamptz,revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(employment_id,plan_year));
CREATE TABLE performance_onehr_evidence(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),employment_id uuid NOT NULL REFERENCES employment(id),review_id uuid NOT NULL REFERENCES performance_review(id),author_user_id uuid NOT NULL REFERENCES app_user(id),kind text NOT NULL CHECK(kind IN ('delivery','problem','behaviour','learning','recognition','support','told','other')),body text NOT NULL CHECK(length(body) BETWEEN 1 AND 1200),occurred_on date NOT NULL,state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','shared','retracted')),supersedes_id uuid REFERENCES performance_onehr_evidence(id),links jsonb NOT NULL DEFAULT '[]',responses jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE performance_onehr_result(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),review_id uuid NOT NULL REFERENCES performance_review(id),cycle_id uuid NOT NULL REFERENCES review_cycle(id),employment_id uuid NOT NULL REFERENCES employment(id),result jsonb NOT NULL,digest text NOT NULL,frozen_at timestamptz NOT NULL DEFAULT now(),performance_released_at timestamptz,potential_released_at timestamptz,talent_released_at timestamptz,feedback_released_at timestamptz,UNIQUE(review_id));
CREATE INDEX performance_onehr_review_cycle_idx ON performance_onehr_review(cycle_id);
CREATE INDEX performance_onehr_panel_review_idx ON performance_onehr_panel(review_id);
CREATE INDEX performance_onehr_calibration_entry_review_idx ON performance_onehr_calibration_entry(review_id);
CREATE INDEX performance_onehr_panel_peer_idx ON performance_onehr_panel(peer_employment_id) WHERE submitted_at IS NULL AND archived_at IS NULL;
CREATE INDEX performance_onehr_calibration_cycle_idx ON performance_onehr_calibration(cycle_id);
CREATE INDEX performance_onehr_evidence_subject_idx ON performance_onehr_evidence(employment_id);
CREATE INDEX performance_onehr_result_subject_idx ON performance_onehr_result(employment_id,cycle_id);
--> statement-breakpoint
CREATE FUNCTION app.onehr_admin(wanted_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app_user u JOIN role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND r.role::text IN ('hr_admin','super_admin','performance_comp_partner') AND (r.company_id IS NULL OR wanted_company IS NOT NULL AND (r.company_id=wanted_company OR app.is_company_descendant(wanted_company,r.company_id))))
$$;
CREATE FUNCTION app.onehr_cycle_admin(wanted_cycle uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM review_cycle c WHERE c.id=wanted_cycle AND c.tenant_id=app.current_tenant_id() AND app.onehr_admin(c.company_id)) $$;
CREATE FUNCTION app.onehr_manager(wanted_review uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_review r JOIN employment e ON e.id=r.reviewer_employment_id AND e.tenant_id=r.tenant_id JOIN employment s ON s.id=r.employment_id AND s.tenant_id=r.tenant_id JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id WHERE r.id=wanted_review AND r.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND e.person_id<>s.person_id AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))
$$;
CREATE FUNCTION app.onehr_calibration_access(wanted_session uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_calibration s JOIN app_user u ON u.id=app.current_user_id() AND u.tenant_id=s.tenant_id WHERE s.id=wanted_session AND s.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND (app.onehr_admin(s.company_id) OR u.id=ANY(s.reviewer_user_ids)))
$$;
--> statement-breakpoint
CREATE FUNCTION app.onehr_moderator(wanted_review uuid,wanted_kpi uuid DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_review r JOIN performance_review pr ON pr.id=r.review_id JOIN employment sub ON sub.id=r.employment_id JOIN app_user u ON u.id=app.current_user_id() AND u.tenant_id=r.tenant_id CROSS JOIN LATERAL jsonb_array_elements(r.kpis) k CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_array_length(coalesce(k->'approvalChain','[]'::jsonb))>0 THEN k->'approvalChain' ELSE jsonb_build_array(jsonb_build_object('employmentId',k->>'moderatorEmploymentId','at',NULL)) END) WITH ORDINALITY step(v,idx) JOIN employment m ON m.id=(step.v->>'employmentId')::uuid AND m.tenant_id=r.tenant_id AND m.person_id=u.person_id
 WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND (wanted_kpi IS NULL OR k->>'id'=wanted_kpi::text AND coalesce((k->>'locked')::boolean,false)=false AND step.v->>'at' IS NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(k->'approvalChain','[]'::jsonb)) WITH ORDINALITY earlier(v,idx) WHERE earlier.idx<step.idx AND earlier.v->>'at' IS NULL)) AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND sub.person_id<>m.person_id AND (m.terminated_on IS NULL OR m.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND (m.id=pr.reviewer_employment_id OR EXISTS(SELECT 1 FROM reporting_line l WHERE l.subordinate_employment_id=sub.id AND l.manager_employment_id=m.id AND l.line_type IN ('functional','project','dotted') AND l.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (l.valid_to IS NULL OR l.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND l.superseded_at IS NULL)))
$$;
CREATE FUNCTION app.onehr_review_header(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('reviewerEmploymentId',r.reviewer_employment_id,'closedAt',r.closed_at,'name',p.full_name,'ownEmploymentIds',(SELECT coalesce(jsonb_agg(e.id),'[]'::jsonb) FROM employment e WHERE e.person_id=u.person_id AND e.tenant_id=u.tenant_id))
 FROM performance_review r JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id JOIN person p ON p.id=e.person_id JOIN app_user u ON u.id=app.current_user_id() AND u.tenant_id=r.tenant_id WHERE r.id=wanted_review AND r.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND (app.is_self_person(e.person_id) OR app.onehr_manager(r.id) OR app.onehr_cycle_admin(r.cycle_id) OR app.onehr_moderator(r.id))
$$;
CREATE FUNCTION app.onehr_moderator_choices(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'name',p.full_name,'personId',m.person_id)),'[]'::jsonb) FROM performance_review r JOIN employment sub ON sub.id=r.employment_id AND sub.tenant_id=r.tenant_id JOIN employment m ON m.tenant_id=r.tenant_id JOIN person p ON p.id=m.person_id WHERE r.id=wanted_review AND r.tenant_id=app.current_tenant_id() AND app.onehr_review_header(r.id) IS NOT NULL AND sub.person_id<>m.person_id AND (m.terminated_on IS NULL OR m.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND (m.id=r.reviewer_employment_id OR EXISTS(SELECT 1 FROM reporting_line l WHERE l.subordinate_employment_id=sub.id AND l.manager_employment_id=m.id AND l.line_type IN ('functional','project','dotted') AND l.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (l.valid_to IS NULL OR l.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND l.superseded_at IS NULL))
$$;
REVOKE ALL ON FUNCTION app.onehr_moderator(uuid,uuid),app.onehr_review_header(uuid),app.onehr_moderator_choices(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_moderator(uuid,uuid),app.onehr_review_header(uuid),app.onehr_moderator_choices(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Validate every denormalized identity against its native parent, including tenant IDs.
CREATE FUNCTION app.onehr_validate_links() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r performance_review; s performance_onehr_calibration; n jsonb:=to_jsonb(NEW); o jsonb; rid uuid:=(n->>'review_id')::uuid; eid uuid:=(n->>'employment_id')::uuid; tid uuid:=(n->>'tenant_id')::uuid;
BEGIN
 IF TG_TABLE_NAME='performance_onehr_cycle' THEN
  IF NOT EXISTS(SELECT 1 FROM review_cycle c WHERE c.id=(n->>'cycle_id')::uuid AND c.tenant_id=tid) THEN RAISE EXCEPTION 'Invalid OneHR cycle'; END IF;
 ELSIF TG_TABLE_NAME='performance_onehr_calibration' THEN
  IF NOT EXISTS(SELECT 1 FROM performance_onehr_cycle c WHERE c.cycle_id=(n->>'cycle_id')::uuid AND c.tenant_id=tid) OR (n->>'company_id') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM company c WHERE c.id=(n->>'company_id')::uuid AND c.tenant_id=tid) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(n->'reviewer_user_ids') uid WHERE NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=uid::uuid AND u.tenant_id=tid AND u.archived_at IS NULL)) THEN RAISE EXCEPTION 'Invalid OneHR calibration scope or reviewer'; END IF;
 ELSE
  SELECT * INTO r FROM performance_review WHERE id=rid AND tenant_id=tid;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Invalid OneHR review'; END IF;
  IF TG_TABLE_NAME='performance_onehr_panel' THEN
   IF NOT EXISTS(SELECT 1 FROM peer_feedback_request f JOIN employment e ON e.id=f.peer_employment_id AND e.tenant_id=f.tenant_id JOIN employment sub ON sub.id=f.subject_employment_id AND sub.tenant_id=f.tenant_id WHERE f.id=(n->>'request_id')::uuid AND f.tenant_id=tid AND f.review_id=r.id AND f.subject_employment_id=(n->>'subject_employment_id')::uuid AND f.peer_employment_id=(n->>'peer_employment_id')::uuid AND e.person_id<>sub.person_id) OR (n->>'subject_employment_id')::uuid<>r.employment_id THEN RAISE EXCEPTION 'Invalid OneHR panel'; END IF;
  ELSE
   IF eid<>r.employment_id THEN RAISE EXCEPTION 'Invalid OneHR subject'; END IF;
   IF TG_TABLE_NAME IN ('performance_onehr_review','performance_onehr_result') AND (n->>'cycle_id')::uuid<>r.cycle_id THEN RAISE EXCEPTION 'Invalid OneHR cycle reference'; END IF;
   IF TG_TABLE_NAME='performance_onehr_review' AND TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=eid AND e.tenant_id=tid AND e.company_id=(n->>'company_id')::uuid) THEN RAISE EXCEPTION 'Invalid OneHR company'; END IF;
   IF TG_TABLE_NAME='performance_onehr_calibration_entry' THEN
    SELECT * INTO s FROM performance_onehr_calibration WHERE id=(n->>'session_id')::uuid AND tenant_id=tid;
    IF s.id IS NULL OR s.cycle_id<>r.cycle_id OR s.company_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM performance_onehr_review e WHERE e.review_id=r.id AND e.tenant_id=tid AND (e.company_id=s.company_id OR app.is_company_descendant(e.company_id,s.company_id))) THEN RAISE EXCEPTION 'Invalid OneHR calibration cohort'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(r.id::text,0));
    IF EXISTS(SELECT 1 FROM performance_onehr_calibration_entry e JOIN performance_onehr_calibration c ON c.id=e.session_id WHERE e.review_id=rid AND c.tier=s.tier AND e.session_id<>s.id) THEN RAISE EXCEPTION 'A person may belong to one calibration scope at each tier'; END IF;
   END IF;
   IF TG_TABLE_NAME='performance_onehr_evidence' AND (n->>'supersedes_id') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM performance_onehr_evidence e WHERE e.id=(n->>'supersedes_id')::uuid AND e.tenant_id=tid AND e.employment_id=eid) THEN RAISE EXCEPTION 'Invalid OneHR evidence correction'; END IF;
  END IF;
 END IF;
 IF TG_TABLE_NAME IN ('performance_onehr_panel','performance_onehr_calibration_entry') AND TG_OP='INSERT' AND EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=rid) THEN RAISE EXCEPTION 'Finalized assessment inputs are immutable'; END IF;
 IF TG_OP='UPDATE' THEN
  o:=to_jsonb(OLD);
  IF n->>'tenant_id' IS DISTINCT FROM o->>'tenant_id' OR n->>'review_id' IS DISTINCT FROM o->>'review_id' OR n->>'employment_id' IS DISTINCT FROM o->>'employment_id' OR n->>'cycle_id' IS DISTINCT FROM o->>'cycle_id' THEN RAISE EXCEPTION 'OneHR record identity is immutable'; END IF;
  IF TG_TABLE_NAME='performance_onehr_review' AND (n->'company_id' IS DISTINCT FROM o->'company_id' OR n->'grade' IS DISTINCT FROM o->'grade' OR n->'statements' IS DISTINCT FROM o->'statements') THEN RAISE EXCEPTION 'OneHR opening snapshot is immutable'; END IF;
  IF TG_TABLE_NAME='performance_onehr_cycle' AND EXISTS(SELECT 1 FROM review_cycle c WHERE c.id=(n->>'cycle_id')::uuid AND c.status<>'draft') THEN RAISE EXCEPTION 'An opened OneHR policy is immutable'; END IF;
  IF TG_TABLE_NAME='performance_onehr_result' AND n-ARRAY['performance_released_at','potential_released_at','talent_released_at','feedback_released_at'] IS DISTINCT FROM o-ARRAY['performance_released_at','potential_released_at','talent_released_at','feedback_released_at'] THEN RAISE EXCEPTION 'A frozen OneHR result is immutable'; END IF;
  IF TG_TABLE_NAME IN ('performance_onehr_panel','performance_onehr_calibration_entry') AND EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=rid) AND n IS DISTINCT FROM o THEN RAISE EXCEPTION 'Finalized assessment inputs are immutable'; END IF;
  IF TG_TABLE_NAME='performance_onehr_panel' AND (o->>'submitted_at') IS NOT NULL AND n IS DISTINCT FROM o THEN RAISE EXCEPTION 'Submitted feedback is immutable'; END IF;
  IF TG_TABLE_NAME='performance_onehr_review' AND EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=rid) THEN RAISE EXCEPTION 'A finalized OneHR review is immutable'; END IF;
  IF TG_TABLE_NAME='performance_onehr_evidence' AND n->'responses' IS DISTINCT FROM o->'responses' AND (o->>'state'<>'shared' OR jsonb_array_length(n->'responses')<>jsonb_array_length(o->'responses')+1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(o->'responses') WITH ORDINALITY prev(v,idx) WHERE n->'responses'->((prev.idx-1)::integer) IS DISTINCT FROM prev.v) OR n->'responses'->(jsonb_array_length(o->'responses'))->>'userId' IS DISTINCT FROM app.current_user_id()::text) THEN RAISE EXCEPTION 'Evidence responses are append-only'; END IF;
  IF TG_TABLE_NAME='performance_onehr_evidence' AND o->>'state'<>'draft' AND n-ARRAY['state','responses'] IS DISTINCT FROM o-ARRAY['state','responses'] THEN RAISE EXCEPTION 'Correct shared evidence with a new entry'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['performance_onehr_cycle','performance_onehr_review','performance_onehr_panel','performance_onehr_calibration','performance_onehr_calibration_entry','performance_onehr_plan','performance_onehr_evidence','performance_onehr_result'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO ai_hr_app',t);
 EXECUTE format('CREATE TRIGGER onehr_links BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.onehr_validate_links()',t);
END LOOP; END $$;
--> statement-breakpoint
CREATE POLICY onehr_cycle_read ON performance_onehr_cycle FOR SELECT USING(tenant_id=app.current_tenant_id());
CREATE POLICY onehr_cycle_insert ON performance_onehr_cycle FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.onehr_cycle_admin(cycle_id));
CREATE POLICY onehr_cycle_update ON performance_onehr_cycle FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.onehr_cycle_admin(cycle_id));
CREATE POLICY onehr_review_read ON performance_onehr_review FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.onehr_review_header(review_id) IS NOT NULL);
CREATE POLICY onehr_review_insert ON performance_onehr_review FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.onehr_cycle_admin(cycle_id));
CREATE POLICY onehr_review_update ON performance_onehr_review FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.onehr_review_header(review_id) IS NOT NULL);
CREATE POLICY onehr_panel_read ON performance_onehr_panel FOR SELECT USING(tenant_id=app.current_tenant_id() AND (app.onehr_cycle_admin((SELECT cycle_id FROM performance_review WHERE id=review_id)) OR app.onehr_manager(review_id) OR EXISTS(SELECT 1 FROM employment e WHERE e.id=peer_employment_id AND app.is_self_person(e.person_id))));
CREATE POLICY onehr_panel_insert ON performance_onehr_panel FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND (app.onehr_manager(review_id) OR app.onehr_cycle_admin((SELECT cycle_id FROM performance_review WHERE id=review_id))));
CREATE POLICY onehr_panel_update ON performance_onehr_panel FOR UPDATE USING(tenant_id=app.current_tenant_id() AND (app.onehr_manager(review_id) OR app.onehr_cycle_admin((SELECT cycle_id FROM performance_review WHERE id=review_id)) OR EXISTS(SELECT 1 FROM employment e WHERE e.id=peer_employment_id AND app.is_self_person(e.person_id))));
CREATE POLICY onehr_calibration_read ON performance_onehr_calibration FOR SELECT USING(tenant_id=app.current_tenant_id() AND (app.onehr_admin(company_id) OR app.onehr_calibration_access(id)));
CREATE POLICY onehr_calibration_insert ON performance_onehr_calibration FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.onehr_cycle_admin(cycle_id));
CREATE POLICY onehr_calibration_update ON performance_onehr_calibration FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.onehr_calibration_access(id));
CREATE POLICY onehr_calibration_entry_access ON performance_onehr_calibration_entry FOR ALL USING(tenant_id=app.current_tenant_id() AND app.onehr_calibration_access(session_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.onehr_calibration_access(session_id));
CREATE POLICY onehr_plan_access ON performance_onehr_plan FOR ALL USING(tenant_id=app.current_tenant_id() AND employment_id = ANY((SELECT app.visible_employment_ids())::uuid[])) WITH CHECK(tenant_id=app.current_tenant_id() AND app.can_see_employment(employment_id));
CREATE POLICY onehr_evidence_read ON performance_onehr_evidence FOR SELECT USING(tenant_id=app.current_tenant_id() AND employment_id = ANY((SELECT app.visible_employment_ids())::uuid[]) AND (state='shared' OR author_user_id=app.current_user_id()));
CREATE POLICY onehr_evidence_insert ON performance_onehr_evidence FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND author_user_id=app.current_user_id() AND app.can_see_employment(employment_id));
CREATE POLICY onehr_evidence_update ON performance_onehr_evidence FOR UPDATE USING(tenant_id=app.current_tenant_id() AND author_user_id=app.current_user_id() AND employment_id = ANY((SELECT app.visible_employment_ids())::uuid[]));
CREATE POLICY onehr_result_read ON performance_onehr_result FOR SELECT USING(tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=employment_id AND app.is_self_person(e.person_id)) AND (app.onehr_cycle_admin(cycle_id) OR app.onehr_manager(review_id)));
CREATE POLICY onehr_result_insert ON performance_onehr_result FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.onehr_cycle_admin(cycle_id));
CREATE POLICY onehr_result_update ON performance_onehr_result FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.onehr_cycle_admin(cycle_id));
--> statement-breakpoint
CREATE FUNCTION app.onehr_adjusted_score(wanted_request uuid,raw_score numeric,ceiling numeric) RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cfg jsonb; subject_cycle uuid; peer_person uuid; all_yes boolean; all_no boolean;
BEGIN
 SELECT c.policy,r.cycle_id,e.person_id INTO cfg,subject_cycle,peer_person FROM performance_onehr_panel a JOIN performance_onehr_review r ON r.review_id=a.review_id JOIN performance_onehr_cycle c ON c.cycle_id=r.cycle_id JOIN employment e ON e.id=a.peer_employment_id WHERE a.request_id=wanted_request;
 IF coalesce((cfg->'extremes'->>'enabled')::boolean,false)=false THEN RETURN raw_score; END IF;
 SELECT bool_and(v.value='yes'),bool_and(v.value='no') INTO all_yes,all_no FROM performance_onehr_panel a JOIN performance_onehr_review r ON r.review_id=a.review_id JOIN employment e ON e.id=a.peer_employment_id CROSS JOIN LATERAL jsonb_each_text(a.answers) v WHERE r.cycle_id=subject_cycle AND e.person_id=peer_person AND a.submitted_at IS NOT NULL AND a.archived_at IS NULL;
 RETURN CASE WHEN all_no THEN least(ceiling,raw_score+coalesce((cfg->'extremes'->>'bonus')::numeric,5)) WHEN all_yes THEN greatest(0,raw_score-coalesce((cfg->'extremes'->>'penalty')::numeric,5)) ELSE raw_score END;
END $$;
REVOKE ALL ON FUNCTION app.onehr_adjusted_score(uuid,numeric,numeric) FROM PUBLIC;
--> statement-breakpoint
-- Narrow assessment projection for a named manager or a live calibration cohort. Never returns rater identities, drafts, transcripts, or salary.
CREATE FUNCTION app.onehr_assessment_inputs(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('reviewId',r.review_id,'employmentId',r.employment_id,'companyId',r.company_id,'grade',r.grade,'name',p.full_name,'performance',r.manager_performance,'managerScore',r.manager_score,'finalized',EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=r.review_id),'competencyStatus',r.competency_status,'competencies',CASE WHEN r.competency_status='reviewed' THEN r.competencies ELSE '[]'::jsonb END,'principles',coalesce((SELECT jsonb_agg(jsonb_build_object('principle',q.principle,'pct',q.pct)) FROM (SELECT st->>'principle' principle,100*sum(CASE WHEN a.answers->>(st->>'id')='yes' THEN CASE WHEN (st->>'future')::boolean THEN 1.5 ELSE 1 END ELSE 0 END)/nullif(sum(CASE WHEN (st->>'future')::boolean THEN 1.5 ELSE 1 END),0) pct FROM performance_onehr_panel a CROSS JOIN LATERAL jsonb_array_elements(r.statements) st WHERE a.review_id=r.review_id AND a.submitted_at IS NOT NULL AND a.archived_at IS NULL GROUP BY st->>'principle') q),'[]'::jsonb),'leadership',coalesce((SELECT jsonb_agg(jsonb_build_object('score',app.onehr_adjusted_score(a.request_id,(SELECT sum(CASE WHEN a.answers->>(st->>'id')='yes' THEN CASE WHEN (st->>'future')::boolean THEN 1.5 ELSE 1 END ELSE 0 END) FROM jsonb_array_elements(r.statements) st),(SELECT sum(CASE WHEN (st->>'future')::boolean THEN 1.5 ELSE 1 END) FROM jsonb_array_elements(r.statements) st)),'max',(SELECT sum(CASE WHEN (st->>'future')::boolean THEN 1.5 ELSE 1 END) FROM jsonb_array_elements(r.statements) st))) FROM performance_onehr_panel a WHERE a.review_id=r.review_id AND a.submitted_at IS NOT NULL AND a.archived_at IS NULL),'[]'::jsonb))
 FROM performance_onehr_review r JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND NOT app.is_self_person(p.id) AND (app.onehr_cycle_admin(r.cycle_id) OR app.onehr_manager(r.review_id) OR EXISTS(SELECT 1 FROM performance_onehr_calibration_entry ce JOIN performance_onehr_calibration cs ON cs.id=ce.session_id WHERE ce.review_id=r.review_id AND app.onehr_calibration_access(cs.id) AND NOT app.is_self_person(p.id)))
$$;
REVOKE ALL ON FUNCTION app.onehr_assessment_inputs(uuid),app.onehr_admin(uuid),app.onehr_cycle_admin(uuid),app.onehr_manager(uuid),app.onehr_calibration_access(uuid),app.onehr_validate_links() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_assessment_inputs(uuid),app.onehr_admin(uuid),app.onehr_cycle_admin(uuid),app.onehr_manager(uuid),app.onehr_calibration_access(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.onehr_feedback_card(wanted_request uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('requestId',f.id,'reviewId',r.review_id,'cycleId',r.cycle_id,'subject',f.subject_name,'statements',r.statements,'answers',a.answers,'remark',a.remark,'submitted',a.submitted_at IS NOT NULL,'frozen',EXISTS(SELECT 1 FROM performance_onehr_result x WHERE x.review_id=r.review_id))
 FROM performance_onehr_panel a JOIN peer_feedback_request f ON f.id=a.request_id AND f.tenant_id=a.tenant_id JOIN performance_onehr_review r ON r.review_id=a.review_id AND r.tenant_id=a.tenant_id JOIN employment e ON e.id=a.peer_employment_id AND e.tenant_id=a.tenant_id JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
 WHERE f.id=wanted_request AND a.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND a.archived_at IS NULL
$$;
REVOKE ALL ON FUNCTION app.onehr_feedback_card(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_feedback_card(uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.onehr_decisions(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('tier',s.tier,'mode',s.mode,'performance',e.performance,'potential',e.potential,'performanceLocked',e.performance_locked_at IS NOT NULL OR s.performance_locked_at IS NOT NULL,'potentialLocked',e.potential_locked_at IS NOT NULL OR s.potential_locked_at IS NOT NULL,'locked',e.locked_at IS NOT NULL OR s.locked_at IS NOT NULL,'pip',e.pip,'promotion',e.promotion,'specialReward',e.special_reward) ORDER BY CASE s.tier WHEN 'hod' THEN 1 WHEN 'bu' THEN 2 WHEN 'bg' THEN 3 WHEN 'group' THEN 4 ELSE 5 END),'[]'::jsonb)
 FROM performance_onehr_calibration_entry e JOIN performance_onehr_calibration s ON s.id=e.session_id AND s.tenant_id=e.tenant_id JOIN performance_review r ON r.id=e.review_id AND r.tenant_id=e.tenant_id JOIN employment emp ON emp.id=e.employment_id AND emp.tenant_id=e.tenant_id
 WHERE e.review_id=wanted_review AND e.tenant_id=app.current_tenant_id() AND NOT app.is_self_person(emp.person_id) AND (app.onehr_cycle_admin(r.cycle_id) OR app.onehr_manager(r.id) OR EXISTS(SELECT 1 FROM performance_onehr_calibration_entry ce WHERE ce.review_id=r.id AND app.onehr_calibration_access(ce.session_id)))
$$;
REVOKE ALL ON FUNCTION app.onehr_decisions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_decisions(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Rewards-owned access contract: fresh GR membership/admin scope, exact roster + year, own-person exclusion.
CREATE FUNCTION app.reward_onehr_source(wanted_unit uuid,wanted_employment uuid,wanted_year integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('id',f.id,'reviewId',f.review_id,'cycleId',f.cycle_id,'digest',f.digest,'frozenAt',f.frozen_at,'performance',f.result->'performance','potential',f.result->'potential','talent',f.result->'talent','pip',f.result->'pip','promotion',f.result->'promotion','specialReward',f.result->'specialReward','policyDigest',f.result->'policyDigest')
 FROM performance_onehr_result f JOIN review_cycle c ON c.id=f.cycle_id AND c.tenant_id=f.tenant_id JOIN employment e ON e.id=f.employment_id AND e.tenant_id=f.tenant_id JOIN reward_unit u ON u.id=wanted_unit AND u.tenant_id=e.tenant_id AND u.company_id=e.company_id JOIN app_user a ON a.id=app.current_user_id() AND a.tenant_id=u.tenant_id
 WHERE f.tenant_id=app.current_tenant_id() AND f.employment_id=wanted_employment AND (f.result->>'performance' IS NOT NULL OR f.result->>'potential' IS NOT NULL OR f.result->>'pip'='true' OR f.result->>'promotion'='true' OR f.result->>'specialReward'='true') AND extract(year from c.period_end)::integer=wanted_year AND (u.policy->>'year')::integer=wanted_year AND a.archived_at IS NULL AND NOT app.login_blocked(a.id) AND NOT app.is_self_person(e.person_id) AND (app.reward_admin(u.company_id) OR 'gr' IN (SELECT app.reward_roles(u.id))) AND (app.reward_admin(u.company_id) OR EXISTS(SELECT 1 FROM reward_entry re WHERE re.unit_id=u.id AND re.employment_id=e.id))
 ORDER BY c.period_end DESC,CASE WHEN (SELECT policy->>'kind' FROM performance_onehr_cycle oc WHERE oc.cycle_id=f.cycle_id)='year_end' THEN 0 ELSE 1 END,f.frozen_at DESC,f.id DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.reward_onehr_source(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_onehr_source(uuid,uuid,integer) TO ai_hr_app;

--> statement-breakpoint
-- Employee result projection: releases are component-specific; never expose raw scores, counts or provenance inputs.
CREATE FUNCTION app.onehr_result_card(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('id',f.id,'digest',f.digest,'performanceReleasedAt',f.performance_released_at,'potentialReleasedAt',f.potential_released_at,'talentReleasedAt',f.talent_released_at,'feedbackReleasedAt',f.feedback_released_at,'result',jsonb_build_object('performance',CASE WHEN f.performance_released_at IS NOT NULL THEN f.result->'performance' ELSE 'null'::jsonb END,'potential',CASE WHEN f.potential_released_at IS NOT NULL THEN f.result->'potential' ELSE 'null'::jsonb END,'talent',CASE WHEN f.talent_released_at IS NOT NULL THEN f.result->'talent' ELSE 'null'::jsonb END,'feedback',CASE WHEN f.feedback_released_at IS NOT NULL THEN f.result->'feedback' ELSE '[]'::jsonb END))
 FROM performance_onehr_result f JOIN employment e ON e.id=f.employment_id AND e.tenant_id=f.tenant_id JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
 WHERE f.review_id=wanted_review AND f.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
$$;
REVOKE ALL ON FUNCTION app.onehr_result_card(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_result_card(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Subject admins still cannot see their own panel identities. Raters retain only their own live card.
ALTER POLICY onehr_panel_read ON performance_onehr_panel USING(tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM employment sub WHERE sub.id=subject_employment_id AND app.is_self_person(sub.person_id)) AND (app.onehr_cycle_admin((SELECT cycle_id FROM performance_review WHERE id=review_id)) OR app.onehr_manager(review_id) OR app.onehr_feedback_card(request_id) IS NOT NULL));
ALTER POLICY onehr_panel_update ON performance_onehr_panel USING(tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM employment sub WHERE sub.id=subject_employment_id AND app.is_self_person(sub.person_id)) AND (app.onehr_cycle_admin((SELECT cycle_id FROM performance_review WHERE id=review_id)) OR app.onehr_manager(review_id) OR app.onehr_feedback_card(request_id) IS NOT NULL));

--> statement-breakpoint
ALTER POLICY onehr_panel_update ON performance_onehr_panel WITH CHECK(tenant_id=app.current_tenant_id() AND (app.onehr_manager(review_id) OR app.onehr_cycle_admin((SELECT cycle_id FROM performance_review WHERE id=review_id)) OR EXISTS(SELECT 1 FROM employment e JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id WHERE e.id=peer_employment_id AND u.id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))));

--> statement-breakpoint
ALTER POLICY onehr_evidence_update ON performance_onehr_evidence USING(tenant_id=app.current_tenant_id() AND employment_id = ANY((SELECT app.visible_employment_ids())::uuid[]) AND (author_user_id=app.current_user_id() OR state='shared' AND (EXISTS(SELECT 1 FROM employment e WHERE e.id=employment_id AND app.is_self_person(e.person_id)) OR EXISTS(SELECT 1 FROM performance_onehr_review rr WHERE rr.employment_id=performance_onehr_evidence.employment_id AND app.onehr_manager(rr.review_id)))));
--> statement-breakpoint
-- Cohort membership does not let a reviewer read or lock their own calibration.
CREATE FUNCTION app.onehr_cohort_own(wanted_session uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT app.onehr_calibration_access(wanted_session) AND EXISTS(SELECT 1 FROM performance_onehr_calibration_entry ce JOIN employment e ON e.id=ce.employment_id AND e.tenant_id=ce.tenant_id WHERE ce.session_id=wanted_session AND ce.tenant_id=app.current_tenant_id() AND app.is_self_person(e.person_id))
$$;
REVOKE ALL ON FUNCTION app.onehr_cohort_own(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_cohort_own(uuid) TO ai_hr_app;
DROP POLICY onehr_calibration_entry_access ON performance_onehr_calibration_entry;
CREATE POLICY onehr_calibration_entry_read ON performance_onehr_calibration_entry FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.onehr_calibration_access(session_id) AND NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=employment_id AND app.is_self_person(e.person_id)));
CREATE POLICY onehr_calibration_entry_insert ON performance_onehr_calibration_entry FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.onehr_cycle_admin((SELECT s.cycle_id FROM performance_onehr_calibration s WHERE s.id=session_id)));
CREATE POLICY onehr_calibration_entry_update ON performance_onehr_calibration_entry FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.onehr_calibration_access(session_id) AND NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=employment_id AND app.is_self_person(e.person_id)));


--> statement-breakpoint
-- Keep the native file store, but intersect its visibility with the OneHR evidence role.
-- A delegated KPI moderator does not receive the employee's evidence attachments.
CREATE FUNCTION app.onehr_attachment_access(wanted_review uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM performance_onehr_review r WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id()) OR EXISTS(SELECT 1 FROM performance_onehr_review r JOIN performance_onehr_cycle c ON c.cycle_id=r.cycle_id AND c.tenant_id=r.tenant_id JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND coalesce((c.policy->'modules'->>'evidence')::boolean,false) AND (app.is_self_person(e.person_id) OR app.onehr_manager(r.review_id) OR app.onehr_cycle_admin(r.cycle_id)))
$$;
REVOKE ALL ON FUNCTION app.onehr_attachment_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onehr_attachment_access(uuid) TO ai_hr_app;
CREATE POLICY onehr_attachment_scope ON performance_attachment AS RESTRICTIVE FOR ALL USING(app.onehr_attachment_access(review_id)) WITH CHECK(app.onehr_attachment_access(review_id));
