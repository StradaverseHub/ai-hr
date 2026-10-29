-- Reserved 0689, idx679 / sequence1793330000015. Not journaled until the prerequisite prefix is frozen.
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
GRANT EXECUTE ON FUNCTION app.reward_roles(uuid),app.reward_admin(uuid),app.current_tenant_id() TO ai_hr_rewards_post_reader;
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
