-- Explicit owner approval: only Contract morning admission and its scheduled mail/workflows may have no creator.
-- No application grants, synthetic person, captured operator, app-role HR transaction or human outcome authority.
CREATE TABLE app.contract_system_job_source(
 job_id uuid PRIMARY KEY REFERENCES public.bulk_job(id) DEFERRABLE INITIALLY DEFERRED,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 kind text NOT NULL CHECK(kind IN('contract_schedule','contract_scheduled_automation')),
 cause text NOT NULL CHECK(cause IN('morning','caseOpened','beforeContractEnd','afterContractEnd')),
 source_date date NOT NULL,case_id uuid,employment_id uuid,period_revision text,event_id uuid,input_digest bytea NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,event_id) REFERENCES public.contract_shared_event(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((kind='contract_schedule' AND cause='morning' AND case_id IS NULL AND event_id IS NULL) OR (kind='contract_scheduled_automation' AND cause<>'morning' AND case_id IS NOT NULL AND employment_id IS NOT NULL AND period_revision IS NOT NULL AND event_id IS NOT NULL))
);
REVOKE ALL ON app.contract_system_job_source FROM PUBLIC,ai_hr_app;
CREATE INDEX contract_system_job_source_day ON app.contract_system_job_source(tenant_id,kind,source_date);
--> statement-breakpoint
ALTER TABLE public.bulk_job ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE public.bulk_job ADD CONSTRAINT bulk_job_contract_system_principal CHECK((created_by IS NULL)=(kind IN('contract_schedule','contract_scheduled_automation')));
INSERT INTO public.bulk_job_kind(kind,scope_kind,exclusive,input_shape,finalize_owner) VALUES
 ('contract_schedule',NULL,'tenant_queue','{"day":"string"}'::jsonb,true),('contract_scheduled_automation',NULL,'none','{"eventId":"string"}'::jsonb,true);
--> statement-breakpoint
ALTER TABLE public.contract_shared_event ADD COLUMN actor_type text NOT NULL DEFAULT 'user' CHECK(actor_type IN('user','system'));
ALTER TABLE public.contract_shared_event ADD CONSTRAINT contract_shared_event_system_actor CHECK(actor_type<>'system' OR (actor_user_id IS NULL AND actor_person_id IS NULL AND trigger_event IN('caseOpened','beforeContractEnd','afterContractEnd')));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.bulk_job_admit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE mode text;
BEGIN
 IF NEW.created_by IS NULL THEN
  IF app.current_user_id() IS NOT NULL OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id()
   OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolname='ai_hr_owner' OR rolsuper))
   OR NEW.kind NOT IN('contract_schedule','contract_scheduled_automation')
   OR NOT EXISTS(SELECT 1 FROM app.contract_system_job_source source WHERE source.job_id=NEW.id AND source.tenant_id=NEW.tenant_id AND source.kind=NEW.kind AND source.input_digest=app.bulk_job_value_digest(NEW.input))
   THEN RAISE EXCEPTION 'Private native Contract system provenance required' USING ERRCODE='42501';END IF;
  NEW.context:=jsonb_build_object('tenantId',NEW.tenant_id,'roles','[]'::jsonb);
  NEW.exclusive_key:='job:'||NEW.id::text;NEW.state:='queued';NEW.outcome:=NULL;NEW.lease_token:=NULL;NEW.lease_expires_at:=NULL;NEW.notice_event_id:=NULL;NEW.notified_at:=NULL;
  NEW.created_at:=now();NEW.updated_at:=now();NEW.finished_at:=NULL;NEW.watched_at:=NULL;RETURN NEW;
 END IF;
 IF NEW.kind IN('contract_schedule','contract_scheduled_automation') THEN RAISE EXCEPTION 'System kinds cannot capture a human principal' USING ERRCODE='42501';END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by IS DISTINCT FROM app.current_user_id()
 OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Bulk job access denied' USING ERRCODE='42501';END IF;
 SELECT k.exclusive INTO mode FROM public.bulk_job_kind k WHERE k.kind=NEW.kind;
 IF mode IS NULL THEN RAISE EXCEPTION 'Unknown bulk job kind' USING ERRCODE='22023';END IF;
 NEW.context:=jsonb_build_object('tenantId',app.current_tenant_id(),'userId',app.current_user_id(),
  'roles',to_jsonb(app.current_roles()),'grants',coalesce(nullif(current_setting('app.grants',true),'')::jsonb,'[]'::jsonb));
 IF NEW.id IS NULL THEN NEW.id:=gen_random_uuid(); END IF;
 -- A queued kind's key is the job's own id, so bulk_job_one_active never refuses it; the worker serialises instead.
 -- 'none' keeps its own-id key too and is never serialised.
 NEW.exclusive_key:=CASE mode WHEN 'tenant' THEN 'tenant' WHEN 'creator' THEN NEW.created_by::text
  WHEN 'tenant_queue' THEN 'queue:'||NEW.id::text ELSE 'job:'||NEW.id::text END;
 NEW.state:='queued';NEW.outcome:=NULL;NEW.lease_token:=NULL;NEW.lease_expires_at:=NULL;NEW.notice_event_id:=NULL;NEW.notified_at:=NULL;
 NEW.created_at:=now();NEW.updated_at:=now();NEW.finished_at:=NULL;NEW.watched_at:=NULL;
 RETURN NEW;
END $$;

--> statement-breakpoint
CREATE FUNCTION app.contract_shared_system_job_held(p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_shared_storage_runner() AND app.bulk_job_capability_held(p_job) AND EXISTS(
 SELECT 1 FROM public.bulk_job j JOIN public.bulk_job_kind k ON k.kind=j.kind AND k.finalize_owner JOIN app.contract_system_job_source source ON source.job_id=j.id AND source.tenant_id=j.tenant_id AND source.kind=j.kind
 JOIN public.tenant tenant ON tenant.id=j.tenant_id AND tenant.status IN('active','trial')
 WHERE j.id=p_job AND j.tenant_id=app.current_tenant_id() AND j.created_by IS NULL AND j.kind IN('contract_schedule','contract_scheduled_automation')
 AND j.state IN('queued','preparing','finalizing') AND j.lease_expires_at>clock_timestamp() AND j.cancel_requested_at IS NULL
 AND j.context=jsonb_build_object('tenantId',j.tenant_id,'roles','[]'::jsonb) AND source.input_digest=app.bulk_job_value_digest(j.input)
 AND source.source_date<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 AND EXISTS(SELECT 1 FROM public.tenant_module module WHERE module.tenant_id=j.tenant_id AND module.module_code='lifecycle' AND module.status IN('active','trial') AND (module.expires_at IS NULL OR module.expires_at>now()))
 AND (j.kind<>'contract_schedule' OR source.source_date=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 AND (j.kind='contract_schedule' OR EXISTS(SELECT 1 FROM public.contract_case c JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id
 JOIN public.contract_shared_event event ON event.tenant_id=c.tenant_id AND event.case_id=c.id AND event.id=source.event_id AND event.actor_type='system' AND event.actor_user_id IS NULL AND event.actor_person_id IS NULL AND event.job_id=j.id AND event.trigger_event=source.cause
 WHERE c.tenant_id=j.tenant_id AND c.id=source.case_id AND c.employment_id=source.employment_id AND source.period_revision=app.contract_shared_period_revision(c.employment_id)
 AND f.data->'period'->>'sourceRevision'=source.period_revision AND c.source_conflict IS NULL AND app.contract_case_company_current(c.id)
 AND app.contract_company_writable(c.company_id) AND app.contract_shared_native_intake_hold(c.employment_id) IS NULL
 AND j.input=jsonb_build_object('eventId',event.id))) )
$$;
REVOKE ALL ON FUNCTION app.contract_shared_system_job_held(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Owner-private admission; a child automation job must be admitted from an already held morning kernel unit.
CREATE FUNCTION app.contract_shared_system_enqueue(p_kind text,p_key uuid,p_input jsonb,p_cause text,p_day date,p_case uuid DEFAULT NULL,p_event uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result uuid;subject public.contract_case;
BEGIN
 IF app.contract_shared_storage_runner() IS NOT TRUE OR p_day IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 OR p_kind NOT IN('contract_schedule','contract_scheduled_automation') THEN RAISE EXCEPTION 'Native Contract system admission unavailable' USING ERRCODE='42501';END IF;
 IF p_kind='contract_schedule' AND (p_input IS DISTINCT FROM jsonb_build_object('day',p_day::text) OR p_cause<>'morning' OR p_case IS NOT NULL OR p_event IS NOT NULL) THEN RAISE EXCEPTION 'Invalid native morning source' USING ERRCODE='42501';END IF;
 IF p_kind='contract_scheduled_automation' AND (p_input IS DISTINCT FROM jsonb_build_object('eventId',p_event) OR NOT EXISTS(SELECT 1 FROM public.contract_shared_event event WHERE event.tenant_id=app.current_tenant_id() AND event.id=p_event AND event.case_id=p_case AND event.actor_type='system' AND event.trigger_event=p_cause)) THEN RAISE EXCEPTION 'Invalid scheduled event source' USING ERRCODE='42501';END IF;
 IF p_kind='contract_scheduled_automation' THEN
  IF app.contract_shared_system_job_held(nullif(current_setting('app.bulk_job',true),'')::uuid) IS NOT TRUE
   OR NOT EXISTS(SELECT 1 FROM public.bulk_job WHERE id::text=current_setting('app.bulk_job',true) AND kind='contract_schedule') THEN RAISE EXCEPTION 'Held native morning admission required' USING ERRCODE='42501';END IF;
  SELECT * INTO subject FROM public.contract_case WHERE tenant_id=app.current_tenant_id() AND id=p_case;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('contract-system:'||app.current_tenant_id()::text||':'||p_kind||':'||CASE WHEN p_kind='contract_schedule' THEN p_day::text ELSE p_key::text END,0));
 IF p_kind='contract_schedule' THEN SELECT job_id INTO result FROM app.contract_system_job_source WHERE tenant_id=app.current_tenant_id() AND kind=p_kind AND source_date=p_day;IF result IS NOT NULL THEN RETURN result;END IF;END IF;
 SELECT id INTO result FROM public.bulk_job WHERE tenant_id=app.current_tenant_id() AND kind=p_kind AND operation_key=p_key;
 IF result IS NOT NULL THEN RETURN result;END IF;
 result:=gen_random_uuid();
 INSERT INTO app.contract_system_job_source(job_id,tenant_id,kind,cause,source_date,case_id,employment_id,period_revision,event_id,input_digest)
 VALUES(result,app.current_tenant_id(),p_kind,p_cause,p_day,p_case,subject.employment_id,CASE WHEN subject.id IS NOT NULL THEN app.contract_shared_period_revision(subject.employment_id) END,p_event,app.bulk_job_value_digest(p_input));
 INSERT INTO public.bulk_job(id,tenant_id,kind,created_by,context,operation_key,exclusive_key,input)
 VALUES(result,app.current_tenant_id(),p_kind,NULL,'{}'::jsonb,p_key,'native',p_input);
 INSERT INTO app.bulk_job_seal(job_id,tenant_id,input_digest,plan_digest) VALUES(result,app.current_tenant_id(),app.bulk_job_value_digest(p_input),app.bulk_job_value_digest(NULL));
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_system_enqueue(text,uuid,jsonb,text,date,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Called once by the physical worker before its normal claim. One tenant/day admission per tick, never a tenant loop.
CREATE FUNCTION app.contract_shared_schedule_admit() RETURNS uuid
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE wanted uuid;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;result uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolname='ai_hr_owner' OR rolsuper)) OR app.current_user_id() IS NOT NULL THEN RAISE EXCEPTION 'Physical worker required' USING ERRCODE='42501';END IF;
 IF (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::time<'08:00'::time THEN RETURN NULL;END IF;
 SELECT tenant.id INTO wanted FROM public.tenant tenant WHERE tenant.status IN('active','trial')
 AND EXISTS(SELECT 1 FROM public.tenant_module module WHERE module.tenant_id=tenant.id AND module.module_code='lifecycle' AND module.status IN('active','trial') AND (module.expires_at IS NULL OR module.expires_at>now()))
 AND EXISTS(SELECT 1 FROM public.contract_shared_settings settings WHERE settings.tenant_id=tenant.id)
 AND NOT EXISTS(SELECT 1 FROM app.contract_system_job_source source WHERE source.tenant_id=tenant.id AND source.kind='contract_schedule' AND source.source_date=day)
 ORDER BY tenant.id LIMIT 1 FOR UPDATE OF tenant SKIP LOCKED;
 IF wanted IS NULL THEN RETURN NULL;END IF;
 PERFORM set_config('app.tenant_id',wanted::text,true);PERFORM set_config('app.user_id','',true);
 result:=app.contract_shared_system_enqueue('contract_schedule',md5('contract-morning:'||wanted::text||':'||day::text)::uuid,jsonb_build_object('day',day::text),'morning',day);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_schedule_admit() FROM PUBLIC,ai_hr_app;
