-- Approved board successor: idx679 / sequence1793330000015 after the preserved 562-entry prefix and reserved AI0687.
CREATE TABLE public.reward_governance (
 unit_id uuid PRIMARY KEY REFERENCES public.reward_unit(id),tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 state jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT reward_governance_shape CHECK(jsonb_typeof(state)='object' AND state->>'version'='1')
);
CREATE TABLE public.reward_governance_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),unit_id uuid NOT NULL REFERENCES public.reward_unit(id),
 actor_id uuid NOT NULL REFERENCES public.app_user(id),kind text NOT NULL,reason text NOT NULL,before_state jsonb,after_state jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.reward_senior_evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),unit_id uuid NOT NULL REFERENCES public.reward_unit(id),entry_id uuid NOT NULL REFERENCES public.reward_entry(id),
 uploaded_by uuid NOT NULL REFERENCES public.app_user(id),name text NOT NULL,mime text NOT NULL,content text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT reward_senior_evidence_limit CHECK(length(content)<=14000000 AND mime IN ('application/pdf','image/png','image/jpeg'))
);
ALTER TABLE public.reward_governance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_governance FORCE ROW LEVEL SECURITY;
ALTER TABLE public.reward_governance_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_governance_history FORCE ROW LEVEL SECURITY;
ALTER TABLE public.reward_senior_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_senior_evidence FORCE ROW LEVEL SECURITY;
-- Raw PAT and pending Senior inputs stay under Group Rewards custody.
CREATE POLICY reward_governance_read ON public.reward_governance FOR SELECT USING(tenant_id=app.current_tenant_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))));
CREATE POLICY reward_governance_write ON public.reward_governance FOR ALL USING(tenant_id=app.current_tenant_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id)))) WITH CHECK(tenant_id=app.current_tenant_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))));
CREATE POLICY reward_governance_history_read ON public.reward_governance_history FOR SELECT USING(tenant_id=app.current_tenant_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))));
CREATE POLICY reward_governance_history_append ON public.reward_governance_history FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))));
CREATE POLICY reward_senior_evidence_read ON public.reward_senior_evidence FOR SELECT USING(tenant_id=app.current_tenant_id() AND ARRAY(SELECT app.reward_roles(unit_id)) && ARRAY['gr','ctro','ec']);
CREATE POLICY reward_senior_evidence_append ON public.reward_senior_evidence FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))));
GRANT SELECT,INSERT,UPDATE ON public.reward_governance TO ai_hr_app;
GRANT SELECT,INSERT ON public.reward_governance_history,public.reward_senior_evidence TO ai_hr_app;

CREATE TABLE public.reward_governance_public (
 unit_id uuid PRIMARY KEY REFERENCES public.reward_unit(id),tenant_id uuid NOT NULL REFERENCES public.tenant(id),snapshot jsonb NOT NULL
);
CREATE TABLE public.reward_senior_award (
 entry_id uuid PRIMARY KEY REFERENCES public.reward_entry(id),tenant_id uuid NOT NULL REFERENCES public.tenant(id),unit_id uuid NOT NULL REFERENCES public.reward_unit(id),award jsonb NOT NULL
);
ALTER TABLE public.reward_governance_public ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_governance_public FORCE ROW LEVEL SECURITY;
ALTER TABLE public.reward_senior_award ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_senior_award FORCE ROW LEVEL SECURITY;
CREATE POLICY reward_governance_public_read ON public.reward_governance_public FOR SELECT USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=reward_governance_public.unit_id AND u.tenant_id=reward_governance_public.tenant_id));
CREATE POLICY reward_governance_public_write ON public.reward_governance_public FOR ALL USING(tenant_id=app.current_tenant_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id)))) WITH CHECK(tenant_id=app.current_tenant_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))));
CREATE POLICY reward_senior_award_read ON public.reward_senior_award FOR SELECT USING(tenant_id=app.current_tenant_id() AND ARRAY(SELECT app.reward_roles(unit_id)) && ARRAY['gr','ctro','ec']);
-- A dedicated nonlogin function owner, never the runtime/table owner, owns the bounded posting read.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='ai_hr_rewards_post_reader') THEN CREATE ROLE ai_hr_rewards_post_reader NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='ai_hr_rewards_post_reader' AND (rolcanlogin OR rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe rewards posting reader role'; END IF;
END $$;
GRANT USAGE ON SCHEMA public,app TO ai_hr_rewards_post_reader;
GRANT SELECT ON public.reward_unit,public.reward_senior_award TO ai_hr_rewards_post_reader;
GRANT EXECUTE ON FUNCTION app.reward_roles(uuid),app.reward_admin(uuid),app.current_tenant_id(),app.current_user_id() TO ai_hr_rewards_post_reader;
CREATE POLICY reward_senior_award_post_read ON public.reward_senior_award FOR SELECT TO ai_hr_rewards_post_reader USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=reward_senior_award.unit_id AND u.tenant_id=reward_senior_award.tenant_id AND u.status='approved' AND u.deleted_at IS NULL AND app.reward_admin(u.company_id) AND 'payroll'=ANY(ARRAY(SELECT app.reward_roles(u.id)))));
CREATE POLICY reward_senior_award_write ON public.reward_senior_award FOR ALL USING(tenant_id=app.current_tenant_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id)))) WITH CHECK(tenant_id=app.current_tenant_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))));
GRANT SELECT,INSERT,UPDATE ON public.reward_governance_public TO ai_hr_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.reward_senior_award TO ai_hr_app;
-- Posting is the one purpose-bound read for the payroll seat: no PAT, pending decisions or evidence.
CREATE OR REPLACE FUNCTION app.reward_senior_awards_for_post(p_unit uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=p_unit AND u.tenant_id=app.current_tenant_id() AND u.status='approved' AND u.deleted_at IS NULL AND app.reward_admin(u.company_id) AND 'payroll'=ANY(ARRAY(SELECT app.reward_roles(u.id)))) THEN
  RAISE EXCEPTION 'Approved payroll posting authority required' USING ERRCODE='42501';
 END IF;
 SELECT coalesce(jsonb_object_agg(a.entry_id::text,a.award - 'evidence' - 'approvalReference' - 'reason' - 'approvalDate'),'{}'::jsonb) INTO result FROM public.reward_senior_award a WHERE a.unit_id=p_unit AND a.tenant_id=app.current_tenant_id() AND a.award->>'confirmedBy' IS NOT NULL;
 RETURN result;
END $$;
ALTER FUNCTION app.reward_senior_awards_for_post(uuid) OWNER TO ai_hr_rewards_post_reader;
REVOKE ALL ON FUNCTION app.reward_senior_awards_for_post(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_senior_awards_for_post(uuid) TO ai_hr_app;

ALTER TABLE public.payroll_input ADD COLUMN reward_provenance jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.payroll_input ADD CONSTRAINT payroll_input_reward_provenance_shape CHECK(jsonb_typeof(reward_provenance)='array');

-- Scope-bound source freshness check for a GR checker who has no generic People/Compensation read.
GRANT SELECT ON public.reward_entry,public.employment,public.compensation,public.app_user,public.job_grade TO ai_hr_rewards_post_reader;
CREATE POLICY reward_senior_source_employment_read ON public.employment FOR SELECT TO ai_hr_rewards_post_reader USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.reward_entry e JOIN public.reward_unit u ON u.id=e.unit_id AND u.tenant_id=e.tenant_id WHERE e.employment_id=employment.id AND e.tenant_id=employment.tenant_id AND u.status='draft' AND u.deleted_at IS NULL AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(u.id)))));
CREATE POLICY reward_senior_source_compensation_read ON public.compensation FOR SELECT TO ai_hr_rewards_post_reader USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.reward_entry e JOIN public.reward_unit u ON u.id=e.unit_id AND u.tenant_id=e.tenant_id WHERE e.employment_id=compensation.employment_id AND e.tenant_id=compensation.tenant_id AND u.status='draft' AND u.deleted_at IS NULL AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(u.id)))));
CREATE FUNCTION app.reward_senior_source_current(p_unit uuid,p_entry uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(SELECT 1 FROM public.reward_unit u JOIN public.reward_entry e ON e.unit_id=u.id AND e.tenant_id=u.tenant_id
 JOIN public.app_user actor ON actor.id=app.current_user_id() AND actor.tenant_id=u.tenant_id
 JOIN public.employment emp ON emp.id=e.employment_id AND emp.tenant_id=e.tenant_id
 JOIN public.job_grade g ON g.id=emp.grade_id AND g.tenant_id=emp.tenant_id
 JOIN public.compensation c ON c.employment_id=emp.id AND c.tenant_id=emp.tenant_id AND c.valid_to IS NULL AND c.superseded_at IS NULL
 WHERE u.id=p_unit AND e.id=p_entry AND u.tenant_id=app.current_tenant_id() AND u.status='draft' AND u.deleted_at IS NULL AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(u.id)))
 AND actor.person_id IS NOT NULL AND e.source->>'personId'<>actor.person_id::text
 AND emp.company_id=u.company_id AND emp.terminated_on IS NULL AND emp.grade_id IS NOT DISTINCT FROM nullif(e.source->>'gradeId','')::uuid
 AND btrim(regexp_replace(g.code,'^JG\s*','','i'))=e.source->>'grade' AND btrim(regexp_replace(g.code,'^JG\s*','','i')) IN ('21','22','23')
 AND c.id=nullif(e.source->>'compensationId','')::uuid AND c.basic_salary*100=(e.source->>'basicCents')::numeric AND c.currency=e.source->>'currency' AND c.pay_mode::text=e.source->>'payMode')
$$;
ALTER FUNCTION app.reward_senior_source_current(uuid,uuid) OWNER TO ai_hr_rewards_post_reader;
REVOKE ALL ON FUNCTION app.reward_senior_source_current(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_senior_source_current(uuid,uuid) TO ai_hr_app;

CREATE UNIQUE INDEX reward_entry_tenant_unit_identity ON public.reward_entry(tenant_id,unit_id,id);
ALTER TABLE public.reward_governance ADD CONSTRAINT reward_governance_tenant_unit FOREIGN KEY(tenant_id,unit_id) REFERENCES public.reward_unit(tenant_id,id);
ALTER TABLE public.reward_governance_public ADD CONSTRAINT reward_governance_public_tenant_unit FOREIGN KEY(tenant_id,unit_id) REFERENCES public.reward_unit(tenant_id,id);
ALTER TABLE public.reward_governance_history ADD CONSTRAINT reward_governance_history_tenant_unit FOREIGN KEY(tenant_id,unit_id) REFERENCES public.reward_unit(tenant_id,id);
ALTER TABLE public.reward_senior_evidence ADD CONSTRAINT reward_senior_evidence_tenant_entry FOREIGN KEY(tenant_id,unit_id,entry_id) REFERENCES public.reward_entry(tenant_id,unit_id,id);
ALTER TABLE public.reward_senior_award ADD CONSTRAINT reward_senior_award_tenant_entry FOREIGN KEY(tenant_id,unit_id,entry_id) REFERENCES public.reward_entry(tenant_id,unit_id,id);
ALTER POLICY reward_governance_history_append ON public.reward_governance_history WITH CHECK(tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))));
ALTER POLICY reward_senior_evidence_append ON public.reward_senior_evidence WITH CHECK(tenant_id=app.current_tenant_id() AND uploaded_by=app.current_user_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))));

-- Pool changes notify all currently eligible approval seats, rather than only the current route stage.
CREATE FUNCTION app.reward_pool_notification_recipients(wanted_unit uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT DISTINCT e.id FROM public.reward_unit r JOIN public.reward_member m ON m.unit_id=r.id AND m.tenant_id=r.tenant_id
 JOIN public.app_user u ON u.id=m.user_id AND u.tenant_id=r.tenant_id
 JOIN public.employment e ON e.person_id=u.person_id AND e.tenant_id=r.tenant_id AND (e.company_id=r.company_id OR m.role IN ('gr','ctro','ec'))
 WHERE r.id=wanted_unit AND r.tenant_id=app.current_tenant_id() AND r.deleted_at IS NULL
 AND app.is_admin() AND (app.current_user_id() IS NULL OR app.reward_admin(r.company_id))
 AND m.role IN ('bu','bg','gr','ctro','ec') AND app.reward_member_eligible_internal(m.id)
 AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND e.terminated_on IS NULL
$$;
REVOKE ALL ON FUNCTION app.reward_pool_notification_recipients(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_pool_notification_recipients(uuid) TO ai_hr_app;

-- Preserve removal of untouched drafts without treating their initial owned projections as outside use.
CREATE OR REPLACE FUNCTION app.reward_deletion_reason(wanted_unit uuid) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE u reward_unit; link record; predicate text; used boolean;
BEGIN
 SELECT * INTO u FROM reward_unit WHERE id=wanted_unit AND tenant_id=app.current_tenant_id();
 IF u.id IS NULL OR NOT app.reward_admin(u.company_id) THEN RAISE EXCEPTION 'Reward administration access denied' USING ERRCODE='42501'; END IF;
 IF u.deleted_at IS NOT NULL THEN RETURN 'deleted'; END IF;
 IF u.status<>'draft' THEN RETURN 'locked'; END IF;
 IF u.posted_at IS NOT NULL OR u.posted_batch_id IS NOT NULL OR u.approved_digest IS NOT NULL
  OR u.funding_cents<>'{"standard":0,"h":0}'::jsonb OR u.reserved_cents<>'{"standard":0,"h":0}'::jsonb THEN RETURN 'payroll'; END IF;
 IF EXISTS(SELECT 1 FROM reward_decision WHERE tenant_id=u.tenant_id AND unit_id=u.id) THEN RETURN 'decisions'; END IF;
 IF EXISTS(SELECT 1 FROM reward_unit WHERE tenant_id=u.tenant_id AND parent_unit_id=u.id) THEN RETURN 'children'; END IF;
 IF EXISTS(SELECT 1 FROM domain_event WHERE tenant_id=u.tenant_id AND aggregate_type='reward-unit' AND aggregate_id=u.id
  AND event_type IN ('reward-unit.recommendation-updated','reward-unit.facts-imported','reward-unit.senior-membership-updated','reward-unit.onehr-results-imported','reward-unit.lump-updated')) THEN RETURN 'recommendations'; END IF;
 IF EXISTS(SELECT 1 FROM reward_entry WHERE tenant_id=u.tenant_id AND unit_id=u.id AND (
  enacted_compensation_id IS NOT NULL OR source ? 'onehrFactImport'
  OR facts <> '{"talent":null,"performance":null,"confidentiality":"standard","seniorPlan":false,"erCase":false,"pipCase":false,"erDecision":"pending","pipDecision":"pending","caseReason":"","segment":"","branch":"","reviewed":false}'::jsonb
  OR recommendation <> '{"meritBp":null,"promotionGrade":null,"promotionBp":null,"specialBp":null,"multiplierBp":null,"bonusCents":null,"lumpCents":null,"reason":"","currentRoleSummary":"","proposedRoleSummary":""}'::jsonb
 )) THEN RETURN 'recommendations'; END IF;
 -- Initial governance snapshots are owned review scaffolding, retained by the tombstone.
 -- Any proposal, confirmation, budget input, award or private history remains business evidence.
 IF EXISTS(SELECT 1 FROM reward_governance g WHERE g.unit_id=u.id AND g.tenant_id=u.tenant_id AND g.state IS DISTINCT FROM
  jsonb_build_object('version',1,'inputs',jsonb_build_object('forecastCents',NULL,'actualCents',NULL,'targetCents',NULL,'targetMonthsBp',0,'multiplierBp',CASE WHEN u.policy->>'bonusStructure'='branch' THEN 10000 ELSE NULL END,'branchRatings','{}'::jsonb),
   'selection',jsonb_build_object('employmentIds','[]'::jsonb,'proposedBy',u.created_by,'confirmedBy',NULL,'confirmedAt',NULL),'exemption',NULL,'awards','{}'::jsonb,'previousPools',NULL))
 THEN RETURN 'recommendations'; END IF;
 IF EXISTS(SELECT 1 FROM reward_governance_public p WHERE p.unit_id=u.id AND p.tenant_id=u.tenant_id AND
  (p.snapshot->>'status' IS DISTINCT FROM 'not-set' OR p.snapshot->'pools' IS DISTINCT FROM '{"standard":0,"h":0}'::jsonb OR p.snapshot->'selectionConfirmed' IS DISTINCT FROM 'false'::jsonb))
 THEN RETURN 'recommendations'; END IF;
 -- Fail closed for future relational consumers rather than assuming the original three tables
 -- remain the complete dependency graph. Known owned rows are retained by the tombstone.
 FOR link IN SELECT c.oid,c.conrelid,c.conkey,c.confkey FROM pg_constraint c
  WHERE c.contype='f' AND c.confrelid='public.reward_unit'::regclass
   AND c.conrelid NOT IN ('public.reward_member'::regclass,'public.reward_entry'::regclass,'public.reward_decision'::regclass,'public.reward_unit'::regclass,'public.reward_governance'::regclass,'public.reward_governance_public'::regclass)
 LOOP
  SELECT string_agg(format('to_jsonb(t)->%L = to_jsonb($1)->%L',a.attname,b.attname),' AND ' ORDER BY k.n) INTO predicate
   FROM generate_subscripts(link.conkey,1) k(n)
   JOIN pg_attribute a ON a.attrelid=link.conrelid AND a.attnum=link.conkey[k.n]
   JOIN pg_attribute b ON b.attrelid='public.reward_unit'::regclass AND b.attnum=link.confkey[k.n];
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s t WHERE %s)',link.conrelid::regclass,predicate) INTO used USING u;
  IF used THEN RETURN 'external'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
