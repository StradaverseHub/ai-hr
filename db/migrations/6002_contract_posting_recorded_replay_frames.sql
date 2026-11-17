-- UNAPPROVED / UNAPPLIED / UNREGISTERED source proposal.6000 Shared capture is an explicit prerequisite.
-- Install reviewed6000→6001→6002→6003→6004→6005→6006→6007→6008 in order. No forward helper references.
-- INACTIVE EXECUTABLE PROPOSAL: UNAPPROVED / UNAPPLIED / NOT IN JOURNAL OR PINS.
-- Depends on6001 and6003–6008 plus the fixed, private canonical TS handler in this proposal packet.
-- Source IDs come ONLY from the canonical immutable laterReplayPlan, never a request/job JSON payload.
-- SQL owns identity, original ledger hashes, company endpoints, frame sequencing and exact between-frame
-- image seals. The ONE canonical TS owner retains replay semantics and validates the final business projection.
-- This is not a second replay algorithm or a general owner-transaction API.
CREATE TABLE app.contract_posting_replay_state(
 tenant_id uuid NOT NULL,job_id uuid NOT NULL,employment_id uuid NOT NULL,xact_id bigint NOT NULL,
 backend_pid integer NOT NULL,login_name text NOT NULL,source_hash bytea NOT NULL,
 next_ordinal integer NOT NULL DEFAULT 1,active_ordinal integer,target_open boolean NOT NULL DEFAULT false,
 target_completed boolean NOT NULL DEFAULT false,target_prepared boolean NOT NULL DEFAULT false,checkpoint_employment bytea NOT NULL,checkpoint_assignment bytea NOT NULL,
 target_employment jsonb,target_assignment jsonb,
 PRIMARY KEY(tenant_id,job_id,xact_id,backend_pid),
 FOREIGN KEY(job_id) REFERENCES app.contract_posting_job_source(job_id)
);
CREATE TABLE app.contract_posting_replay_step(
 tenant_id uuid NOT NULL,job_id uuid NOT NULL,xact_id bigint NOT NULL,backend_pid integer NOT NULL,
 ordinal integer NOT NULL,event_id uuid NOT NULL,direction text NOT NULL CHECK(direction IN('inverse','replay')),
 group_id text,group_hash bytea NOT NULL,company_before uuid NOT NULL,company_after uuid NOT NULL,
 completed boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,job_id,xact_id,backend_pid,ordinal),
 UNIQUE(tenant_id,job_id,xact_id,backend_pid,event_id,direction),
 FOREIGN KEY(tenant_id,job_id,xact_id,backend_pid) REFERENCES app.contract_posting_replay_state(tenant_id,job_id,xact_id,backend_pid)
);
CREATE UNIQUE INDEX contract_posting_replay_group_once ON app.contract_posting_replay_step(tenant_id,job_id,xact_id,backend_pid,group_id,direction) WHERE group_id IS NOT NULL;
ALTER TABLE app.contract_posting_replay_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contract_posting_replay_state FORCE ROW LEVEL SECURITY;
ALTER TABLE app.contract_posting_replay_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contract_posting_replay_step FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_posting_replay_state_owner ON app.contract_posting_replay_state FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY contract_posting_replay_step_owner ON app.contract_posting_replay_step FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON app.contract_posting_replay_state,app.contract_posting_replay_step FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT,UPDATE ON app.contract_posting_replay_state,app.contract_posting_replay_step TO ai_hr_owner;

CREATE FUNCTION app.contract_posting_assignment_hash(p_employment uuid) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.bulk_job_value_digest(coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb))
 FROM public.assignment a WHERE a.tenant_id=app.current_tenant_id() AND a.employment_id=p_employment
 AND a.superseded_at IS NULL AND a.valid_to IS NULL
$$;
REVOKE ALL ON FUNCTION app.contract_posting_assignment_hash(uuid) FROM PUBLIC,ai_hr_app;

-- Copy the ONE initial source/job validator, then separate only the current Employment-company test.
-- The public/source initial begin retains its original strict validator. No app role can call this leaf.
DO $factor$
DECLARE body text;
BEGIN
 body:=pg_get_functiondef('app.contract_posting_job_held(uuid)'::regprocedure);
 IF strpos(body,'AND e.company_id=source.company_id')=0 THEN RAISE EXCEPTION 'Review posting job source before factoring';END IF;
 body:=replace(body,'FUNCTION app.contract_posting_job_held(','FUNCTION app.contract_posting_job_identity_held(');
 body:=replace(body,'AND e.company_id=source.company_id','');
 EXECUTE body;
END $factor$;
REVOKE ALL ON FUNCTION app.contract_posting_job_identity_held(uuid) FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app.contract_posting_group_hash(p_job uuid,p_event uuid) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.bulk_job_value_digest(jsonb_agg(to_jsonb(d) ORDER BY d.sequence))
 FROM app.contract_posting_job_tx x JOIN public.domain_event root ON root.tenant_id=x.tenant_id AND root.id=p_event
 AND root.subject_employment_id=x.employment_id AND root.sequence<=x.ledger_max_sequence
 JOIN public.domain_event d ON d.tenant_id=x.tenant_id AND d.subject_employment_id=x.employment_id
 AND d.sequence<=x.ledger_max_sequence AND CASE WHEN root.payload->'movement'->>'groupId' IS NULL THEN d.id=root.id
 ELSE d.payload->'movement'->>'groupId'=root.payload->'movement'->>'groupId' END
 WHERE x.tenant_id=app.current_tenant_id() AND x.job_id=p_job AND x.xact_id=txid_current()
 AND x.backend_pid=pg_backend_pid() AND x.login_name=session_user
$$;
REVOKE ALL ON FUNCTION app.contract_posting_group_hash(uuid,uuid) FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app.contract_posting_replay_checkpoint_held(p_job uuid,p_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(EXISTS(SELECT 1 FROM app.contract_posting_replay_state state
 JOIN app.contract_posting_job_tx x ON x.tenant_id=state.tenant_id AND x.job_id=state.job_id AND x.xact_id=state.xact_id AND x.backend_pid=state.backend_pid
 JOIN public.employment e ON e.tenant_id=x.tenant_id AND e.id=x.employment_id
 LEFT JOIN app.contract_posting_replay_step step ON step.tenant_id=state.tenant_id AND step.job_id=state.job_id
 AND step.xact_id=state.xact_id AND step.backend_pid=state.backend_pid AND step.ordinal=state.active_ordinal
 WHERE state.tenant_id=app.current_tenant_id() AND state.job_id=p_job AND state.employment_id=p_employment
 AND state.xact_id=txid_current() AND state.backend_pid=pg_backend_pid() AND state.login_name=session_user
 AND x.actor_user_id=app.current_user_id() AND x.actor_person_id=app.contract_actor_person(app.current_user_id()) AND x.protected
 AND state.source_hash=x.source_hash AND x.ledger_hash=app.contract_posting_ledger_hash(p_employment,x.ledger_max_sequence)
 AND CASE WHEN state.active_ordinal IS NOT NULL THEN step.ordinal IS NOT NULL AND NOT step.completed
 AND step.group_hash=app.contract_posting_group_hash(p_job,step.event_id) AND e.company_id IN(step.company_before,step.company_after)
 WHEN state.target_open THEN e.company_id=(x.original_employment->>'company_id')::uuid
 ELSE state.checkpoint_employment=app.bulk_job_value_digest(to_jsonb(e))
 AND state.checkpoint_assignment=app.contract_posting_assignment_hash(p_employment) END),false)
$$;
REVOKE ALL ON FUNCTION app.contract_posting_replay_checkpoint_held(uuid,uuid) FROM PUBLIC,ai_hr_app;

-- SAME OID. Initial strict source-company validation stays job_held. Its only intermediate extension is
-- the private, actual recorded step frame/checkpoint; target/bind/final enforce source company again.
CREATE OR REPLACE FUNCTION app.contract_posting_job_tx_held(p_job uuid,p_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_posting_job_identity_held(p_job) AND EXISTS(SELECT 1 FROM app.contract_posting_job_tx x
 JOIN public.employment e ON e.tenant_id=x.tenant_id AND e.id=x.employment_id
 WHERE x.tenant_id=app.current_tenant_id() AND x.job_id=p_job AND x.employment_id=p_employment
 AND x.xact_id=txid_current() AND x.backend_pid=pg_backend_pid() AND x.login_name=session_user
 AND x.actor_user_id=app.current_user_id() AND x.actor_person_id=app.contract_actor_person(app.current_user_id())
 AND CASE WHEN EXISTS(SELECT 1 FROM app.contract_posting_replay_state state WHERE state.tenant_id=x.tenant_id
 AND state.job_id=x.job_id AND state.xact_id=x.xact_id AND state.backend_pid=x.backend_pid)
 THEN app.contract_posting_replay_checkpoint_held(p_job,p_employment)
 ELSE e.company_id=(x.original_employment->>'company_id')::uuid END)
$$;
REVOKE ALL ON FUNCTION app.contract_posting_job_tx_held(uuid,uuid) FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app.contract_posting_replay_plan(p_job uuid,p_steps jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE x app.contract_posting_job_tx;source app.contract_posting_job_source;item jsonb;root public.domain_event;
 group_events jsonb;transfer jsonb;before_company uuid;after_company uuid;current_company uuid;
 ord integer:=0;seen_replay boolean:=false;prior_inverse bigint;group_max bigint;step_direction text;step_event uuid;
BEGIN
 SELECT * INTO x FROM app.contract_posting_job_tx WHERE tenant_id=app.current_tenant_id() AND job_id=p_job
 AND xact_id=txid_current() AND backend_pid=pg_backend_pid() AND login_name=session_user;
 SELECT * INTO source FROM app.contract_posting_job_source WHERE tenant_id=x.tenant_id AND job_id=p_job;
 IF x.job_id IS NULL OR app.contract_posting_original_source_intact(p_job,x.employment_id) IS NOT TRUE
 OR NOT x.protected OR p_steps IS NULL OR jsonb_typeof(p_steps)<>'array' OR jsonb_array_length(p_steps)>1024
 OR EXISTS(SELECT 1 FROM app.contract_posting_replay_state s WHERE s.tenant_id=x.tenant_id AND s.job_id=p_job AND s.xact_id=x.xact_id AND s.backend_pid=x.backend_pid)
 OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=x.tenant_id AND e.id=x.employment_id AND to_jsonb(e)=x.original_employment)
 OR app.contract_posting_assignment_hash(x.employment_id) IS DISTINCT FROM app.bulk_job_value_digest(jsonb_build_array(x.original_assignment))
 THEN RAISE EXCEPTION 'Protected original canonical replay source required' USING ERRCODE='42501';END IF;
 current_company:=source.company_id;
 INSERT INTO app.contract_posting_replay_state(tenant_id,job_id,employment_id,xact_id,backend_pid,login_name,source_hash,checkpoint_employment,checkpoint_assignment)
 VALUES(x.tenant_id,p_job,x.employment_id,x.xact_id,x.backend_pid,x.login_name,x.source_hash,app.bulk_job_value_digest(x.original_employment),app.contract_posting_assignment_hash(x.employment_id));
 FOR item IN SELECT value FROM jsonb_array_elements(p_steps) LOOP
  ord:=ord+1;
  IF jsonb_typeof(item)<>'object' OR item-ARRAY['eventId','direction']<>'{}'::jsonb
  OR coalesce(item->>'direction','') NOT IN('inverse','replay') OR item->>'eventId' IS NULL
  THEN RAISE EXCEPTION 'Canonical recorded replay IDs required' USING ERRCODE='22023';END IF;
  step_event:=(item->>'eventId')::uuid;step_direction:=item->>'direction';
  SELECT * INTO root FROM public.domain_event WHERE tenant_id=x.tenant_id AND id=step_event AND subject_employment_id=x.employment_id AND sequence<=x.ledger_max_sequence;
  IF root.id IS NULL OR root.payload->'movement'->'secondary'='true'::jsonb OR app.contract_posting_group_hash(p_job,root.id) IS NULL THEN RAISE EXCEPTION 'Recorded canonical group is unavailable' USING ERRCODE='42501';END IF;
  SELECT jsonb_agg(to_jsonb(d) ORDER BY d.sequence),max(d.sequence) INTO group_events,group_max
  FROM public.domain_event d WHERE d.tenant_id=x.tenant_id AND d.subject_employment_id=x.employment_id AND d.sequence<=x.ledger_max_sequence
  AND CASE WHEN root.payload->'movement'->>'groupId' IS NULL THEN d.id=root.id ELSE d.payload->'movement'->>'groupId'=root.payload->'movement'->>'groupId' END;
  IF root.payload->'movement'->>'groupId' IS NOT NULL AND (SELECT count(*) FROM jsonb_array_elements(group_events) d WHERE d->'payload'->'movement'->'secondary' IS DISTINCT FROM 'true'::jsonb)<>1
  THEN RAISE EXCEPTION 'A canonical movement requires exactly one actual primary row' USING ERRCODE='40001';END IF;
  IF step_direction='inverse' THEN
   IF seen_replay OR prior_inverse IS NOT NULL AND group_max>=prior_inverse THEN RAISE EXCEPTION 'Inverse groups must follow the canonical descending ledger order' USING ERRCODE='22023';END IF;
   prior_inverse:=group_max;
  ELSIF NOT seen_replay THEN
   IF current_company<>source.company_id THEN RAISE EXCEPTION 'Contract target belongs to another dated legal employer' USING ERRCODE='42501';END IF;
   seen_replay:=true;
  END IF;
  -- A group may contain at most one actual company move. No synthetic caller endpoint is accepted.
  IF (SELECT count(*) FROM jsonb_array_elements(group_events) d WHERE d->>'event_type'='employment.company.transferred')>1
  THEN RAISE EXCEPTION 'Ambiguous recorded legal-company group requires reconciliation' USING ERRCODE='40001';END IF;
  SELECT d->'payload' INTO transfer FROM jsonb_array_elements(group_events) d WHERE d->>'event_type'='employment.company.transferred';
  IF transfer IS NOT NULL THEN
   before_company:=(transfer->'before'->>'companyId')::uuid;after_company:=(transfer->'after'->>'companyId')::uuid;
   IF before_company IS NULL OR after_company IS NULL OR current_company IS DISTINCT FROM CASE step_direction WHEN 'inverse' THEN after_company ELSE before_company END
   THEN RAISE EXCEPTION 'Recorded company sequence requires reconciliation' USING ERRCODE='40001';END IF;
  ELSE before_company:=current_company;after_company:=current_company;END IF;
  INSERT INTO app.contract_posting_replay_step(tenant_id,job_id,xact_id,backend_pid,ordinal,event_id,direction,group_id,group_hash,company_before,company_after)
  VALUES(x.tenant_id,p_job,x.xact_id,x.backend_pid,ord,root.id,step_direction,root.payload->'movement'->>'groupId',app.contract_posting_group_hash(p_job,root.id),before_company,after_company);
  current_company:=CASE step_direction WHEN 'inverse' THEN before_company ELSE after_company END;
 END LOOP;
 IF current_company<>source.company_id OR EXISTS(
  SELECT 1 FROM app.contract_posting_replay_step s WHERE s.tenant_id=x.tenant_id AND s.job_id=p_job AND s.xact_id=x.xact_id AND s.backend_pid=x.backend_pid
  AND NOT EXISTS(SELECT 1 FROM app.contract_posting_replay_step other WHERE other.tenant_id=s.tenant_id AND other.job_id=s.job_id AND other.xact_id=s.xact_id
   AND other.backend_pid=s.backend_pid AND other.event_id=s.event_id AND other.direction<>s.direction AND other.group_hash=s.group_hash))
 THEN RAISE EXCEPTION 'Canonical inverse/replay plan must pair every immutable group and restore its legal employer' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_replay_plan(uuid,jsonb) FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app.contract_posting_replay_step_begin(p_job uuid,p_event uuid,p_direction text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE state app.contract_posting_replay_state;step app.contract_posting_replay_step;company uuid;
BEGIN
 SELECT * INTO state FROM app.contract_posting_replay_state WHERE tenant_id=app.current_tenant_id() AND job_id=p_job
 AND xact_id=txid_current() AND backend_pid=pg_backend_pid() AND login_name=session_user FOR UPDATE;
 IF state.job_id IS NULL OR app.contract_posting_original_source_intact(p_job,state.employment_id) IS NOT TRUE
 OR state.active_ordinal IS NOT NULL OR state.target_open THEN RAISE EXCEPTION 'Exact canonical replay checkpoint required' USING ERRCODE='42501';END IF;
 SELECT * INTO step FROM app.contract_posting_replay_step WHERE tenant_id=state.tenant_id AND job_id=p_job AND xact_id=state.xact_id AND backend_pid=state.backend_pid AND ordinal=state.next_ordinal;
 SELECT company_id INTO company FROM public.employment WHERE tenant_id=state.tenant_id AND id=state.employment_id;
 IF step.ordinal IS NULL OR step.event_id IS DISTINCT FROM p_event OR step.direction IS DISTINCT FROM p_direction OR step.completed
 OR (p_direction='inverse' AND state.target_completed) OR (p_direction='replay' AND NOT state.target_completed)
 OR company IS DISTINCT FROM CASE p_direction WHEN 'inverse' THEN step.company_after ELSE step.company_before END
 OR step.group_hash IS DISTINCT FROM app.contract_posting_group_hash(p_job,p_event)
 THEN RAISE EXCEPTION 'Actual next recorded canonical step required' USING ERRCODE='42501';END IF;
 UPDATE app.contract_posting_replay_state SET active_ordinal=step.ordinal WHERE tenant_id=state.tenant_id AND job_id=p_job AND xact_id=state.xact_id AND backend_pid=state.backend_pid;
 RETURN jsonb_build_object('eventId',step.event_id,'direction',step.direction,'sourceHash',encode(step.group_hash,'hex'));
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_replay_step_begin(uuid,uuid,text) FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app.contract_posting_replay_step_end(p_job uuid,p_event uuid,p_direction text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE state app.contract_posting_replay_state;step app.contract_posting_replay_step;e public.employment;
BEGIN
 SELECT * INTO state FROM app.contract_posting_replay_state WHERE tenant_id=app.current_tenant_id() AND job_id=p_job
 AND xact_id=txid_current() AND backend_pid=pg_backend_pid() AND login_name=session_user FOR UPDATE;
 IF state.job_id IS NULL OR app.contract_posting_original_source_intact(p_job,state.employment_id) IS NOT TRUE OR state.target_open
 THEN RAISE EXCEPTION 'Actual active canonical step required' USING ERRCODE='42501';END IF;
 SELECT * INTO step FROM app.contract_posting_replay_step WHERE tenant_id=state.tenant_id AND job_id=p_job AND xact_id=state.xact_id AND backend_pid=state.backend_pid AND ordinal=state.active_ordinal;
 SELECT * INTO e FROM public.employment WHERE tenant_id=state.tenant_id AND id=state.employment_id;
 IF step.ordinal IS NULL OR step.event_id IS DISTINCT FROM p_event OR step.direction IS DISTINCT FROM p_direction OR step.completed
 OR e.company_id IS DISTINCT FROM CASE p_direction WHEN 'inverse' THEN step.company_before ELSE step.company_after END
 OR step.group_hash IS DISTINCT FROM app.contract_posting_group_hash(p_job,p_event)
 THEN RAISE EXCEPTION 'Recorded canonical company endpoint required' USING ERRCODE='42501';END IF;
 UPDATE app.contract_posting_replay_step SET completed=true WHERE tenant_id=state.tenant_id AND job_id=p_job AND xact_id=state.xact_id AND backend_pid=state.backend_pid AND ordinal=step.ordinal;
 UPDATE app.contract_posting_replay_state SET active_ordinal=NULL,next_ordinal=step.ordinal+1,
 checkpoint_employment=app.bulk_job_value_digest(to_jsonb(e)),checkpoint_assignment=app.contract_posting_assignment_hash(state.employment_id)
 WHERE tenant_id=state.tenant_id AND job_id=p_job AND xact_id=state.xact_id AND backend_pid=state.backend_pid;
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_replay_step_end(uuid,uuid,text) FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app.contract_posting_history_write_held(p_job uuid,p_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_posting_job_tx_held(p_job,p_employment) AND EXISTS(SELECT 1 FROM app.contract_posting_replay_state s
 WHERE s.tenant_id=app.current_tenant_id() AND s.job_id=p_job AND s.employment_id=p_employment AND s.xact_id=txid_current()
 AND s.backend_pid=pg_backend_pid() AND s.login_name=session_user AND (s.active_ordinal IS NOT NULL OR s.target_open))
$$;
REVOKE ALL ON FUNCTION app.contract_posting_history_write_held(uuid,uuid) FROM PUBLIC,ai_hr_app;
