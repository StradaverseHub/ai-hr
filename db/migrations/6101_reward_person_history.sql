-- Board d8d2123a: provisional source reservation 6101 / idx5501 / when1794841006101.
-- The production migration ledger must be rechecked before installation.
CREATE TABLE public.reward_person_history(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL REFERENCES public.company(id),employment_id uuid NOT NULL REFERENCES public.employment(id),
 year integer NOT NULL CHECK(year BETWEEN 2000 AND 2200),kind text NOT NULL CHECK(kind IN('annual','offcycle')),
 source text NOT NULL CHECK(source IN('review','upload')),unit_id uuid REFERENCES public.reward_unit(id),entry_id uuid REFERENCES public.reward_entry(id),
 upload_batch_id uuid REFERENCES public.bulk_job(id),talent text CHECK(talent IS NULL OR talent IN('SSTAR','STAR','SCORE','IMPRO','PIP')),
 performance text CHECK(performance IS NULL OR performance IN('UA','BE','ME','AE','OU')),
 merit_bp integer NOT NULL CHECK(merit_bp>=0),promotion_bp integer NOT NULL CHECK(promotion_bp>=0),special_bp integer NOT NULL CHECK(special_bp>=0),
 increment_cents bigint NOT NULL CHECK(increment_cents BETWEEN 0 AND 100000000000),total_increase_bp integer NOT NULL CHECK(total_increase_bp>=0),promoted boolean NOT NULL,promotion_grade text,
 bonus_cents bigint NOT NULL CHECK(bonus_cents>=0),bonus_months_bp integer NOT NULL CHECK(bonus_months_bp>=0),lump_cents bigint NOT NULL CHECK(lump_cents>=0),
 withheld jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(withheld)='object'),created_by uuid NOT NULL REFERENCES public.app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),superseded_at timestamptz,
 CHECK((source='review' AND unit_id IS NOT NULL AND entry_id IS NOT NULL AND upload_batch_id IS NULL)
  OR(source='upload' AND unit_id IS NULL AND entry_id IS NULL AND upload_batch_id IS NOT NULL)),
 CHECK(source='upload' OR superseded_at IS NULL)
);
CREATE UNIQUE INDEX reward_person_history_review ON public.reward_person_history(entry_id) WHERE source='review';
CREATE UNIQUE INDEX reward_person_history_upload_current ON public.reward_person_history(tenant_id,company_id,employment_id,year,kind) WHERE source='upload' AND superseded_at IS NULL;
CREATE INDEX reward_person_history_person_year ON public.reward_person_history(tenant_id,employment_id,year DESC,kind,created_at,id) WHERE superseded_at IS NULL;
ALTER TABLE public.reward_person_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_person_history FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION app.reward_history_upload_authorized(wanted_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT app.principal_snapshot_current() AND app.reward_not_viewing_as() AND app.reward_actor_holds_role('gr')
  AND app.reward_setup_allowed(NULL,'manage') AND app.reward_setup_allowed(wanted_company,'manage')
$$;
REVOKE ALL ON FUNCTION app.reward_history_upload_authorized(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_history_upload_authorized(uuid) TO ai_hr_app;
CREATE POLICY reward_history_owner_read ON public.reward_person_history FOR SELECT TO ai_hr_owner USING(tenant_id=app.current_tenant_id());
CREATE POLICY reward_history_upload_read ON public.reward_person_history FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.reward_history_upload_authorized(company_id));
CREATE POLICY reward_history_insert ON public.reward_person_history FOR INSERT TO ai_hr_app WITH CHECK(
 tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.reward_not_viewing_as()
 AND((source='upload' AND app.reward_history_upload_authorized(company_id)) OR(source='review' AND EXISTS(
  SELECT 1 FROM public.reward_unit u WHERE u.id=unit_id AND u.tenant_id=reward_person_history.tenant_id AND u.company_id=reward_person_history.company_id
   AND u.status IN('approved','posted') AND app.reward_admin(u.company_id) AND 'payroll'=ANY(ARRAY(SELECT app.reward_roles(u.id)))))));
CREATE POLICY reward_history_supersede ON public.reward_person_history FOR UPDATE TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND source='upload' AND superseded_at IS NULL AND app.reward_history_upload_authorized(company_id))
 WITH CHECK(tenant_id=app.current_tenant_id() AND source='upload' AND superseded_at IS NOT NULL AND app.reward_history_upload_authorized(company_id));
GRANT SELECT,INSERT ON public.reward_person_history TO ai_hr_app;
GRANT UPDATE(superseded_at) ON public.reward_person_history TO ai_hr_app;
--> statement-breakpoint
-- Group Rewards need not hold generic Personnel access to bind a history upload. No names or salary
-- facts leave this narrow owner projection, and the uploader's own person is excluded.
CREATE FUNCTION app.reward_history_upload_context(wanted_company uuid,wanted_codes text[]) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('firstReviewYear',(SELECT min((u.policy->>'year')::integer) FROM public.reward_unit u
  WHERE u.tenant_id=app.current_tenant_id() AND u.company_id=wanted_company AND u.status='posted' AND u.deleted_at IS NULL),
  'people',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'code',e.employee_code) ORDER BY e.employee_code,e.id),'[]'::jsonb)
  FROM public.employment e WHERE e.tenant_id=app.current_tenant_id() AND e.company_id=wanted_company AND e.employee_code=ANY(wanted_codes)
   AND NOT app.is_self_person(e.person_id)))
 WHERE app.reward_history_upload_authorized(wanted_company)
$$;
REVOKE ALL ON FUNCTION app.reward_history_upload_context(uuid,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_history_upload_context(uuid,text[]) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_history_shape() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.source<>'upload' OR OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL OR (to_jsonb(NEW)-'superseded_at') IS DISTINCT FROM (to_jsonb(OLD)-'superseded_at') THEN
   RAISE EXCEPTION 'Reward history is append only' USING ERRCODE='42501';
  END IF;RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id AND e.company_id=NEW.company_id) THEN
  RAISE EXCEPTION 'Reward history employment binding is invalid' USING ERRCODE='23514';END IF;
 IF NEW.source='review' AND NOT EXISTS(SELECT 1 FROM public.reward_entry e JOIN public.reward_unit u ON u.id=e.unit_id AND u.tenant_id=e.tenant_id
  WHERE e.id=NEW.entry_id AND e.unit_id=NEW.unit_id AND e.employment_id=NEW.employment_id AND u.tenant_id=NEW.tenant_id AND u.company_id=NEW.company_id
   AND (u.policy->>'year')::integer=NEW.year AND NEW.kind=CASE WHEN u.kind='annual' THEN 'annual' ELSE 'offcycle' END) THEN
  RAISE EXCEPTION 'Reward history review binding is invalid' USING ERRCODE='23514';END IF;
 IF NEW.source='upload' AND (NOT EXISTS(SELECT 1 FROM public.bulk_job j WHERE j.id=NEW.upload_batch_id AND j.tenant_id=NEW.tenant_id
  AND j.kind='reward_person_history' AND j.created_by=app.current_user_id() AND j.input->>'companyId'=NEW.company_id::text)
  OR EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.tenant_id=NEW.tenant_id AND u.company_id=NEW.company_id AND u.status='posted' AND u.deleted_at IS NULL AND (u.policy->>'year')::integer<=NEW.year)
  OR EXISTS(SELECT 1 FROM public.employment e WHERE e.id=NEW.employment_id AND app.is_self_person(e.person_id))) THEN
  RAISE EXCEPTION 'Reward history upload binding or year is invalid' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_history_shape() FROM PUBLIC;
CREATE TRIGGER reward_history_shape BEFORE INSERT OR UPDATE ON public.reward_person_history FOR EACH ROW EXECUTE FUNCTION app.reward_history_shape();
CREATE TRIGGER reward_history_readonly BEFORE INSERT OR UPDATE OR DELETE ON public.reward_person_history FOR EACH ROW EXECUTE FUNCTION app.reward_view_as_write_guard();
--> statement-breakpoint
-- Current-review visibility is the sole disclosure authority. Historical rows do not grant access.
CREATE FUNCTION app.reward_person_history(wanted_unit uuid,wanted_entry uuid) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH principal AS MATERIALIZED(
  SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()
   AND a.archived_at IS NULL AND NOT app.login_blocked(a.id) AND app.principal_snapshot_current()
 ),roles AS MATERIALIZED(SELECT coalesce(array_agg(role),ARRAY[]::text[]) AS value FROM app.reward_roles(wanted_unit) role),
 subject AS MATERIALIZED(
  SELECT e.employment_id,u.tenant_id,(u.policy->>'year')::integer AS year,
   NOT(coalesce((e.facts->>'seniorPlan')::boolean,false) OR(coalesce(u.policy->>'seniorMembershipMode','legacy-grades')<>'named-members' AND u.policy->'seniorGrades' ? (e.source->>'grade')))
    OR(roles.value&&ARRAY['gr','ctro','ec'] AND app.reward_level_rank(app.reward_unit_level(u.id,'senior.manage'))>=1) AS amounts
  FROM public.reward_unit u JOIN public.reward_entry e ON e.unit_id=u.id AND e.tenant_id=u.tenant_id CROSS JOIN principal CROSS JOIN roles
  WHERE u.id=wanted_unit AND e.id=wanted_entry AND u.tenant_id=app.current_tenant_id() AND u.deleted_at IS NULL
   AND app.reward_access_scope(u.id) AND app.reward_capability(u.id,'review.view') AND cardinality(roles.value)>0
   AND principal.person_id::text IS DISTINCT FROM e.source->>'personId'
   AND(e.facts->>'reviewed'='true' OR 'gr'=ANY(roles.value))
   AND(e.facts->>'confidentiality'<>'bg' OR roles.value&&ARRAY['bg','gr','ctro','ec','payroll'])
   AND((e.facts->>'confidentiality'<>'ec' AND e.employment_id NOT IN(SELECT app.reward_group_ec_direct_reports(u.id)))
    OR(roles.value&&ARRAY['gr','ctro','ec'] AND app.reward_level_rank(app.reward_unit_level(u.id,'restricted.view'))>=1))
 ),records AS(
  SELECT h.*,s.amounts FROM subject s JOIN public.reward_person_history h ON h.tenant_id=s.tenant_id AND h.employment_id=s.employment_id
  WHERE h.superseded_at IS NULL AND h.year BETWEEN s.year-2 AND s.year AND(h.year<s.year OR h.kind='offcycle')
  ORDER BY h.year DESC,h.kind,h.created_at,h.id LIMIT 100
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'year',year,'kind',kind,'source',source,'talent',talent,'performance',performance,
  'meritBp',CASE WHEN amounts THEN merit_bp END,'promotionBp',CASE WHEN amounts THEN promotion_bp END,'specialBp',CASE WHEN amounts THEN special_bp END,
  'incrementCents',CASE WHEN amounts THEN increment_cents END,'totalIncreaseBp',CASE WHEN amounts THEN total_increase_bp END,'promoted',promoted,'promotionGrade',promotion_grade,
  'bonusCents',CASE WHEN amounts THEN bonus_cents END,'bonusMonthsBp',CASE WHEN amounts THEN bonus_months_bp END,'lumpCents',CASE WHEN amounts THEN lump_cents END,
  'withheld',CASE WHEN amounts THEN withheld END) ORDER BY year DESC,kind,created_at,id),'[]'::jsonb) FROM records
$$;
REVOKE ALL ON FUNCTION app.reward_person_history(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_person_history(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
INSERT INTO public.bulk_job_kind(kind,scope_kind,exclusive,input_shape,finalize_owner)
 VALUES('reward_person_history',NULL,'tenant','{"companyId":"string","token":"string"}'::jsonb,false);
--> statement-breakpoint
CREATE FUNCTION app.reward_history_audit_value(wanted_field text,value jsonb) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN wanted_field='withhold' AND jsonb_typeof(value)='object' THEN jsonb_strip_nulls(jsonb_build_object(
  'increase',CASE WHEN jsonb_typeof(value->'increase')='string' THEN left(value->>'increase',2000) END,
  'bonus',CASE WHEN jsonb_typeof(value->'bonus')='string' THEN left(value->>'bonus',2000) END,
  'lump',CASE WHEN jsonb_typeof(value->'lump')='string' THEN left(value->>'lump',2000) END))
  WHEN jsonb_typeof(value)='string' THEN to_jsonb(left(value#>>'{}',8000))
  WHEN jsonb_typeof(value) IN('number','boolean','null') THEN value ELSE 'null'::jsonb END
$$;
REVOKE ALL ON FUNCTION app.reward_history_audit_value(text,jsonb) FROM PUBLIC;
CREATE FUNCTION app.reward_review_activity_changes(wanted_units uuid[],wanted_actor uuid,wanted_subject uuid)
 RETURNS TABLE(id uuid,changes jsonb) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT d.id,coalesce((SELECT jsonb_agg(jsonb_build_object('field',c.value->>'field',
   'before',app.reward_history_audit_value(c.value->>'field',c.value->'before'),
   'after',app.reward_history_audit_value(c.value->>'field',c.value->'after')) ORDER BY c.ordinality)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.payload->'changes')='array' THEN d.payload->'changes' ELSE '[]'::jsonb END) WITH ORDINALITY c(value,ordinality)
  WHERE c.value->>'field' IN('meritBp','promotionGrade','promotionBp','specialBp','multiplierBp','bonusCents','lumpCents',
   'reason','note','erDecision','pipDecision','caseReason','currentRoleSummary','proposedRoleSummary','withhold')),'[]'::jsonb)
 FROM app.reward_review_activity(wanted_units,wanted_actor,wanted_subject) allowed
 JOIN public.domain_event d ON d.id=allowed.id AND d.tenant_id=app.current_tenant_id()
 JOIN public.reward_entry e ON e.id::text=d.payload->>'entryId' AND e.unit_id=allowed.unit_id AND e.tenant_id=d.tenant_id
 JOIN public.reward_unit u ON u.id=e.unit_id AND u.tenant_id=e.tenant_id
 WHERE d.event_type='reward-unit.recommendation-updated' AND app.reward_private_entry_visible(u.id,e.id)
  AND((e.facts->>'confidentiality'<>'ec' AND e.employment_id NOT IN(SELECT app.reward_group_ec_direct_reports(u.id)))
   OR app.reward_level_rank(app.reward_unit_level(u.id,'restricted.view'))>=1)
  AND(NOT(coalesce((e.facts->>'seniorPlan')::boolean,false) OR(coalesce(u.policy->>'seniorMembershipMode','legacy-grades')<>'named-members' AND u.policy->'seniorGrades' ? (e.source->>'grade')))
   OR app.reward_level_rank(app.reward_unit_level(u.id,'senior.manage'))>=1)
$$;
REVOKE ALL ON FUNCTION app.reward_review_activity_changes(uuid[],uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_review_activity_changes(uuid[],uuid,uuid) TO ai_hr_app;
