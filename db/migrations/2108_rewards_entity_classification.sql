-- Explicit Rewards picker designations only. No entity deletion, scope change, data merge or backfill.
CREATE TABLE reward_company_classification (
 tenant_id uuid NOT NULL REFERENCES tenant(id), company_id uuid NOT NULL REFERENCES company(id),
 disposition text NOT NULL CHECK(disposition IN ('visible','test_demo','alias')),
 canonical_company_id uuid REFERENCES company(id), reason text NOT NULL CHECK(length(app.reward_exclusion_reason_trim(reason)) BETWEEN 10 AND 2000),
 updated_by uuid NOT NULL REFERENCES app_user(id), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,company_id),
 FOREIGN KEY(company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 FOREIGN KEY(canonical_company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 CHECK((disposition='alias' AND canonical_company_id IS NOT NULL AND canonical_company_id<>company_id) OR (disposition<>'alias' AND canonical_company_id IS NULL))
);
--> statement-breakpoint
ALTER TABLE reward_company_classification ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_company_classification FORCE ROW LEVEL SECURITY;
REVOKE ALL ON reward_company_classification FROM PUBLIC,ai_hr_app;
GRANT SELECT ON reward_company_classification TO ai_hr_app;
CREATE POLICY reward_company_classification_read ON reward_company_classification FOR SELECT USING (
 tenant_id=app.current_tenant_id() AND (current_user<>'ai_hr_app' OR app.reward_admin(company_id)));
CREATE POLICY reward_company_classification_write ON reward_company_classification FOR ALL USING (
 tenant_id=app.current_tenant_id() AND current_user<>'ai_hr_app') WITH CHECK(tenant_id=app.current_tenant_id() AND current_user<>'ai_hr_app');
--> statement-breakpoint
CREATE FUNCTION app.reward_company_classify(p_company uuid,p_disposition text,p_canonical uuid,p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); actor uuid:=app.current_user_id(); previous jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF actor IS NULL OR NOT app.reward_admin(p_company) OR NOT EXISTS(SELECT 1 FROM public.company WHERE id=p_company AND tenant_id=t)
 THEN RAISE EXCEPTION 'Rewards company permission required' USING ERRCODE='42501'; END IF;
 IF p_disposition IS NULL OR p_disposition NOT IN ('visible','test_demo','alias') OR p_reason IS NULL OR length(app.reward_exclusion_reason_trim(p_reason)) NOT BETWEEN 10 AND 2000
 OR (p_disposition='alias') IS DISTINCT FROM (p_canonical IS NOT NULL) OR p_canonical=p_company
 THEN RAISE EXCEPTION 'Select an explicit designation and supply a reviewed reason' USING ERRCODE='23514'; END IF;
 IF p_canonical IS NOT NULL THEN
  IF NOT app.reward_admin(p_canonical) OR NOT EXISTS(SELECT 1 FROM public.company WHERE id=p_canonical AND tenant_id=t AND archived_at IS NULL)
  THEN RAISE EXCEPTION 'Canonical company permission required' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.reward_company_classification WHERE tenant_id=t AND company_id=p_canonical AND disposition<>'visible')
  THEN RAISE EXCEPTION 'Canonical company must be visible' USING ERRCODE='23514'; END IF;
 END IF;
 IF p_disposition<>'visible' AND EXISTS(SELECT 1 FROM public.reward_company_classification WHERE tenant_id=t AND canonical_company_id=p_company)
 THEN RAISE EXCEPTION 'Resolve existing aliases before hiding their canonical company' USING ERRCODE='23514'; END IF;
 SELECT jsonb_build_object('disposition',disposition,'canonicalCompanyId',canonical_company_id,'reason',reason) INTO previous
 FROM public.reward_company_classification WHERE tenant_id=t AND company_id=p_company;
 INSERT INTO public.reward_company_classification(tenant_id,company_id,disposition,canonical_company_id,reason,updated_by)
 VALUES(t,p_company,p_disposition,p_canonical,app.reward_exclusion_reason_trim(p_reason),actor)
 ON CONFLICT(tenant_id,company_id) DO UPDATE SET disposition=excluded.disposition,canonical_company_id=excluded.canonical_company_id,reason=excluded.reason,updated_by=actor,updated_at=now();
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'reward-company-classification',p_company,'reward.company-classified','user',actor,
 jsonb_build_object('previous',previous,'disposition',p_disposition,'canonicalCompanyId',p_canonical,'reason',app.reward_exclusion_reason_trim(p_reason)));
END $$;
REVOKE ALL ON FUNCTION app.reward_company_classify(uuid,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_company_classify(uuid,text,uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_company_classification_audit_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF (NEW.aggregate_type='reward-company-classification' OR NEW.event_type='reward.company-classified') AND NOT app.acting_as_owner()
 THEN RAISE EXCEPTION 'Reward classification audit requires its native writer' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_company_classification_audit_owner() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER reward_company_classification_audit_owner BEFORE INSERT ON domain_event FOR EACH ROW EXECUTE FUNCTION app.reward_company_classification_audit_owner();
