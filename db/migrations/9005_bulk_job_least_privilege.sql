-- UNALLOCATED DRAFT on branch claude/bulk-job-kernel-hardening-20261111 (assigned draft range 9005-9009): not a
-- reservation, not an installation allocation. The journal position (idx 9005, when 1793330090005) exists only so
-- this branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when after the
-- freshly verified ledger, per docs/MIGRATION-ALLOCATION.md. Requires 9003 (bulk_job kernel).
--
-- Least privilege and integrity for the shared bulk-job kernel (ADR 2026-11-10 employee import, "Shared job kernel",
-- section "Hardened kernel").
--
-- Before: 9003 revoked only from PUBLIC. The public-schema default privileges (deploy/bootstrap-db.sql) had already
-- given ai_hr_app SELECT/INSERT/UPDATE/DELETE on bulk_job, bulk_job_step, bulk_job_worker and bulk_job_kind, and 9003
-- added column UPDATE on 22 job columns and INSERT/DELETE/UPDATE(state,result,error) on steps. Any application-role
-- statement (a web bug, an injection) could therefore rewrite a job's input, plan, captured context, lease, a step's
-- payload or result, or a kind's scope, and the worker's privileged finalize/release would apply it.
--
-- After: ai_hr_app keeps SELECT on bulk_job, bulk_job_step (creator-only row security) and bulk_job_kind, and nothing
-- else. The web side reaches the store only through two definers: app.bulk_job_enqueue (validates kind, tenant,
-- creator, companies and the kind's declared input shape) and app.bulk_job_request_cancel. The worker's own writes
-- inside its app-role transactions go through definers that require the job's lease capability: a random 256-bit
-- secret the worker generates per claim, held only in worker memory and as a sha256 digest in app.bulk_job_seal (no
-- application grant). The web can read lease_token; it cannot learn the capability.
--
-- Seal: app.bulk_job_seal holds digests of the job's input and plan; app.bulk_job_step_seal one digest per step over
-- (kind,row_num,payload,state,result,error). Only the worker writes them (its capability-gated definers and owner
-- connection); every capability-gated write first checks the value it changes still matches its seal, the chunk
-- reader verifies each pending step before it is applied, and the worker verifies the whole seal before the first
-- finalize unit (release) and whenever a kind asks (app.bulk_job_seal_verify, owner only).

-- ── Kind declarations ──
-- input_shape: the top-level keys an admission's input may carry, each with its JSON type ('object', 'array',
-- 'string', 'number', 'boolean'; a trailing '?' marks it optional). NULL: the kind takes no input.
-- finalize_owner: the kind's finalize needs the queue-owner connection (BulkJobHandler.finalizeOwner must agree).
CREATE FUNCTION app.bulk_job_input_shape_valid(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT p IS NULL OR (jsonb_typeof(p)='object' AND NOT EXISTS(SELECT 1 FROM jsonb_each(p) e(k,v)
  WHERE e.k!~'^[A-Za-z][A-Za-z0-9_]{0,63}$' OR jsonb_typeof(e.v)<>'string' OR (e.v#>>'{}')!~'^(object|array|string|number|boolean)\??$'));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_input_shape_valid(jsonb) FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE public.bulk_job_kind
 ADD COLUMN input_shape jsonb CHECK(app.bulk_job_input_shape_valid(input_shape)),
 ADD COLUMN input_max_bytes integer NOT NULL DEFAULT 1048576 CHECK(input_max_bytes BETWEEN 0 AND 134217728),
 ADD COLUMN finalize_owner boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE public.bulk_job_kind SET input_shape='{"upload":"object","evaluationBinding":"object?"}'::jsonb,input_max_bytes=67108864,finalize_owner=true
 WHERE kind='employee_import';
--> statement-breakpoint
CREATE FUNCTION app.bulk_job_input_conforms(p_shape jsonb,p_max integer,p_input jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE
  WHEN p_input IS NULL THEN NOT EXISTS(SELECT 1 FROM jsonb_each_text(coalesce(p_shape,'{}'::jsonb)) s(k,t) WHERE right(s.t,1)<>'?')
  WHEN p_shape IS NULL OR jsonb_typeof(p_input)<>'object' OR octet_length(p_input::text)>p_max THEN false
  ELSE NOT EXISTS(SELECT 1 FROM jsonb_each(p_input) i(k,v) WHERE NOT p_shape ? i.k OR jsonb_typeof(i.v)<>rtrim(p_shape->>i.k,'?'))
   AND NOT EXISTS(SELECT 1 FROM jsonb_each_text(p_shape) s(k,t) WHERE right(s.t,1)<>'?' AND NOT p_input ? s.k)
 END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_input_conforms(jsonb,integer,jsonb) FROM PUBLIC;
--> statement-breakpoint
-- ── Seal and lease capability (worker only) ──
CREATE TABLE app.bulk_job_seal (
 job_id uuid PRIMARY KEY REFERENCES public.bulk_job(id) ON DELETE CASCADE,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 input_digest bytea NOT NULL,
 plan_digest bytea NOT NULL,
 steps_sealed integer NOT NULL DEFAULT 0 CHECK(steps_sealed>=0),
 -- Set when the whole seal was last verified; any step write clears it, so the next finalize unit verifies again.
 verified_at timestamptz,
 -- The claim this capability belongs to: a definer accepts it only while bulk_job.lease_token is still this token.
 lease_token uuid,
 capability_digest bytea,
 updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE app.bulk_job_step_seal (
 job_id uuid NOT NULL,
 seq integer NOT NULL,
 digest bytea NOT NULL,
 PRIMARY KEY(job_id,seq),
 FOREIGN KEY(job_id,seq) REFERENCES public.bulk_job_step(job_id,seq) ON DELETE CASCADE
);
--> statement-breakpoint
REVOKE ALL ON app.bulk_job_seal,app.bulk_job_step_seal FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER TABLE app.bulk_job_seal ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.bulk_job_step_seal ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION app.bulk_job_value_digest(p jsonb) RETURNS bytea LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT sha256(convert_to(coalesce(p,'null'::jsonb)::text,'UTF8'));
$$;
--> statement-breakpoint
CREATE FUNCTION app.bulk_job_step_digest(p_kind text,p_row_num integer,p_payload jsonb,p_state text,p_result jsonb,p_error text) RETURNS bytea
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT sha256(convert_to(jsonb_build_array(p_kind,p_row_num,p_payload,p_state,p_result,p_error)::text,'UTF8'));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_value_digest(jsonb),app.bulk_job_step_digest(text,integer,jsonb,text,jsonb,text) FROM PUBLIC;
--> statement-breakpoint
-- Every existing job and step is sealed as it stands (the drafts were never installed; normally no rows).
INSERT INTO app.bulk_job_seal(job_id,tenant_id,input_digest,plan_digest,steps_sealed)
 SELECT j.id,j.tenant_id,app.bulk_job_value_digest(j.input),app.bulk_job_value_digest(j.plan),(SELECT count(*) FROM public.bulk_job_step s WHERE s.job_id=j.id)
 FROM public.bulk_job j;
--> statement-breakpoint
INSERT INTO app.bulk_job_step_seal(job_id,seq,digest)
 SELECT s.job_id,s.seq,app.bulk_job_step_digest(s.kind,s.row_num,s.payload,s.state,s.result,s.error) FROM public.bulk_job_step s;
--> statement-breakpoint
-- Whether this session holds the lease capability of the job (app.bulk_job_capability, set transaction-locally by
-- the worker). No lock; worker-internal.
CREATE FUNCTION app.bulk_job_capability_held(p_job uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(nullif(current_setting('app.bulk_job_capability',true),'')~'^[0-9a-f]{64}$',false) AND EXISTS(
  SELECT 1 FROM public.bulk_job j JOIN app.bulk_job_seal s ON s.job_id=j.id
  WHERE j.id=p_job AND j.lease_token IS NOT NULL AND s.lease_token=j.lease_token
   AND s.capability_digest=sha256(convert_to(current_setting('app.bulk_job_capability',true),'UTF8')));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_capability_held(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The job row, locked, when this session holds its lease capability; otherwise refused. A tenant or user session
-- must also be the job's own (the worker runs app-role transactions as the creator). Worker-internal.
CREATE FUNCTION app.bulk_job_held(p_job uuid) RETURNS public.bulk_job LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j public.bulk_job; cap text:=nullif(current_setting('app.bulk_job_capability',true),'');
BEGIN
 IF p_job IS NOT NULL AND cap~'^[0-9a-f]{64}$' THEN
  SELECT jj.* INTO j FROM public.bulk_job jj JOIN app.bulk_job_seal s ON s.job_id=jj.id
   WHERE jj.id=p_job AND jj.lease_token IS NOT NULL AND s.lease_token=jj.lease_token AND s.capability_digest=sha256(convert_to(cap,'UTF8'))
   FOR UPDATE OF jj;
 END IF;
 IF j.id IS NULL OR (app.current_tenant_id() IS NOT NULL AND j.tenant_id IS DISTINCT FROM app.current_tenant_id())
  OR (app.current_user_id() IS NOT NULL AND j.created_by IS DISTINCT FROM app.current_user_id()) THEN
  RAISE EXCEPTION 'bulk_job_lease_required' USING ERRCODE='42501';
 END IF;
 RETURN j;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_held(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Claim: the worker (owner connection) binds a fresh capability to the lease it just took. A job without a seal row
-- (none after this migration) gets one for its header only, so any step it has fails verification.
CREATE FUNCTION app.bulk_job_lease_capability(p_job uuid,p_token uuid,p_capability text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_capability IS NULL OR p_capability!~'^[0-9a-f]{64}$' OR p_token IS NULL THEN RAISE EXCEPTION 'bulk_job_capability_invalid' USING ERRCODE='22023'; END IF;
 INSERT INTO app.bulk_job_seal(job_id,tenant_id,input_digest,plan_digest,lease_token,capability_digest)
  SELECT j.id,j.tenant_id,app.bulk_job_value_digest(j.input),app.bulk_job_value_digest(j.plan),p_token,sha256(convert_to(p_capability,'UTF8'))
  FROM public.bulk_job j WHERE j.id=p_job AND j.lease_token=p_token
 ON CONFLICT(job_id) DO UPDATE SET lease_token=excluded.lease_token,capability_digest=excluded.capability_digest,updated_at=now();
 RETURN FOUND;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_lease_capability(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Verification (owner connection). 'header': input and plan; 'full': also every step; 'first': full unless the seal
-- was verified since the last step write. Returns NULL when intact, otherwise what failed.
CREATE FUNCTION app.bulk_job_seal_verify(p_job uuid,p_mode text) RETURNS text LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j public.bulk_job; s app.bulk_job_seal; n bigint;
BEGIN
 IF p_mode IS NULL OR p_mode NOT IN ('header','full','first') THEN RAISE EXCEPTION 'bulk_job_seal_mode' USING ERRCODE='22023'; END IF;
 SELECT * INTO j FROM public.bulk_job WHERE id=p_job;
 IF j.id IS NULL THEN RETURN 'job'; END IF;
 SELECT * INTO s FROM app.bulk_job_seal WHERE job_id=p_job;
 IF s.job_id IS NULL THEN RETURN 'seal'; END IF;
 IF s.input_digest IS DISTINCT FROM app.bulk_job_value_digest(j.input) THEN RETURN 'input'; END IF;
 IF s.plan_digest IS DISTINCT FROM app.bulk_job_value_digest(j.plan) THEN RETURN 'plan'; END IF;
 IF p_mode='header' OR (p_mode='first' AND s.verified_at IS NOT NULL) THEN RETURN NULL; END IF;
 SELECT count(*) INTO n FROM public.bulk_job_step st WHERE st.job_id=p_job;
 IF n<>s.steps_sealed THEN RETURN 'steps'; END IF;
 IF EXISTS(SELECT 1 FROM public.bulk_job_step st LEFT JOIN app.bulk_job_step_seal z ON z.job_id=st.job_id AND z.seq=st.seq
  WHERE st.job_id=p_job AND z.digest IS DISTINCT FROM app.bulk_job_step_digest(st.kind,st.row_num,st.payload,st.state,st.result,st.error)) THEN
  RETURN 'step';
 END IF;
 UPDATE app.bulk_job_seal SET verified_at=now() WHERE job_id=p_job;
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_seal_verify(uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Terminal clean-up (owner connection): the inputs, per-step payloads and, when the kind asks, the plan; the seal
-- follows so it never describes data that is gone.
CREATE FUNCTION app.bulk_job_clear_inputs(p_job uuid,p_plan boolean) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 UPDATE public.bulk_job SET input=NULL,source_content=NULL,plan=CASE WHEN p_plan THEN NULL ELSE plan END
  WHERE id=p_job AND state IN ('completed','failed','cancelled');
 IF NOT FOUND THEN RETURN; END IF;
 DELETE FROM public.bulk_job_step WHERE job_id=p_job;
 UPDATE app.bulk_job_seal SET input_digest=app.bulk_job_value_digest(NULL),
  plan_digest=CASE WHEN p_plan THEN app.bulk_job_value_digest(NULL) ELSE plan_digest END,steps_sealed=0,updated_at=now()
  WHERE job_id=p_job;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_clear_inputs(uuid,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- ── Web side ──
-- Admission. The session's own tenant and user, a current principal, a known kind, companies of that tenant and an
-- input of the kind's declared shape; idempotent per (creator, operation key); the kind's exclusivity stays with
-- the bulk_job_admit trigger and bulk_job_one_active. Returns {id, existing} or {refused: 'running'|'kind'}.
CREATE FUNCTION app.bulk_job_enqueue(p_kind text,p_operation_key uuid,p_company_ids uuid[],p_source_name text,p_source bytea,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); u uuid:=app.current_user_id(); k public.bulk_job_kind; prior_id uuid; prior_kind text;
 input_ jsonb:=CASE WHEN p_input='null'::jsonb THEN NULL ELSE p_input END; companies uuid[]; id_ uuid;
BEGIN
 IF t IS NULL OR u IS NULL OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Bulk job access denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO k FROM public.bulk_job_kind WHERE kind=p_kind;
 IF k.kind IS NULL THEN RAISE EXCEPTION 'Unknown bulk job kind' USING ERRCODE='22023'; END IF;
 IF p_operation_key IS NULL OR p_source_name IS NULL OR length(p_source_name)>255 OR octet_length(p_source)>134217728 THEN
  RAISE EXCEPTION 'Bulk job admission invalid' USING ERRCODE='22023';
 END IF;
 IF NOT app.bulk_job_input_conforms(k.input_shape,k.input_max_bytes,input_) THEN
  RAISE EXCEPTION 'Bulk job input does not match its kind' USING ERRCODE='22023';
 END IF;
 SELECT coalesce(array_agg(DISTINCT c.id),'{}'::uuid[]) INTO companies FROM unnest(coalesce(p_company_ids,'{}'::uuid[])) c(id);
 IF cardinality(companies)>1000 OR EXISTS(SELECT 1 FROM unnest(coalesce(p_company_ids,'{}'::uuid[])) c(id)
  WHERE c.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.company co WHERE co.id=c.id AND co.tenant_id=t)) THEN
  RAISE EXCEPTION 'Bulk job company unavailable' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('bulk-job-admit:'||t::text||':'||p_kind,0));
 SELECT j.id,j.kind INTO prior_id,prior_kind FROM public.bulk_job j WHERE j.tenant_id=t AND j.created_by=u AND j.operation_key=p_operation_key;
 IF prior_id IS NOT NULL THEN
  IF prior_kind<>p_kind THEN RETURN jsonb_build_object('refused','kind'); END IF;
  RETURN jsonb_build_object('id',prior_id,'existing',true);
 END IF;
 INSERT INTO public.bulk_job(tenant_id,kind,created_by,context,operation_key,exclusive_key,company_ids,source_name,source_hash,source_bytes,source_content,input)
  VALUES(t,p_kind,u,'{}'::jsonb,p_operation_key,'',companies,p_source_name,
   CASE WHEN p_source IS NULL THEN NULL ELSE encode(sha256(p_source),'hex') END,coalesce(octet_length(p_source),0),p_source,input_)
  ON CONFLICT DO NOTHING RETURNING id INTO id_;
 IF id_ IS NULL THEN RETURN jsonb_build_object('refused','running'); END IF;
 INSERT INTO app.bulk_job_seal(job_id,tenant_id,input_digest,plan_digest) VALUES(id_,t,app.bulk_job_value_digest(input_),app.bulk_job_value_digest(NULL));
 RETURN jsonb_build_object('id',id_,'existing',false);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_enqueue(text,uuid,uuid[],text,bytea,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.bulk_job_enqueue(text,uuid,uuid[],text,bytea,jsonb) TO ai_hr_app;
--> statement-breakpoint
-- The creator asks a queued or running job to stop. 'requested', 'unavailable' (not theirs, or not visible to them
-- any more) or 'final' (already finalizing or ended).
CREATE FUNCTION app.bulk_job_request_cancel(p_job uuid,p_kind text) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE s text;
BEGIN
 SELECT j.state INTO s FROM public.bulk_job j WHERE j.id=p_job AND (p_kind IS NULL OR j.kind=p_kind) AND app.bulk_job_access(j.id) FOR UPDATE;
 IF s IS NULL THEN RETURN 'unavailable'; END IF;
 IF s NOT IN ('queued','preparing','running') THEN RETURN 'final'; END IF;
 UPDATE public.bulk_job SET cancel_requested_at=coalesce(cancel_requested_at,now()),updated_at=now() WHERE id=p_job;
 RETURN 'requested';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_request_cancel(uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.bulk_job_request_cancel(uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- ── Worker side, inside its app-role transactions (capability-gated) ──
-- Fence: binds this transaction to the capability, locks the job row while the lease is this worker's, and tells a
-- lost lease from lost authority (the creator's captured grants or company access changed).
CREATE FUNCTION app.bulk_job_fence(p_job uuid,p_capability text) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_job IS NULL OR p_capability IS NULL OR p_capability!~'^[0-9a-f]{64}$' THEN RETURN 'lost'; END IF;
 PERFORM set_config('app.bulk_job_capability',p_capability,true);
 PERFORM 1 FROM public.bulk_job j JOIN app.bulk_job_seal s ON s.job_id=j.id
  WHERE j.id=p_job AND j.lease_token IS NOT NULL AND s.lease_token=j.lease_token AND s.capability_digest=sha256(convert_to(p_capability,'UTF8'))
  FOR UPDATE OF j;
 IF NOT FOUND THEN RETURN 'lost'; END IF;
 IF NOT app.bulk_job_access(p_job) THEN RETURN 'authority'; END IF;
 RETURN 'held';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_fence(uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.bulk_job_fence(uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- Prepare: insert one batch of ordered steps (replacing any earlier attempt's steps first) and seal each.
CREATE FUNCTION app.bulk_job_steps_put(p_job uuid,p_replace boolean,p_steps jsonb) RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j public.bulk_job; n integer;
BEGIN
 IF p_replace IS NULL OR p_steps IS NULL OR jsonb_typeof(p_steps)<>'array' OR jsonb_array_length(p_steps)>5000 THEN
  RAISE EXCEPTION 'bulk_job_steps_invalid' USING ERRCODE='22023';
 END IF;
 j:=app.bulk_job_held(p_job);
 IF j.state<>'preparing' THEN RAISE EXCEPTION 'bulk_job_state' USING ERRCODE='55000'; END IF;
 IF p_replace THEN
  DELETE FROM public.bulk_job_step WHERE job_id=p_job;
  UPDATE app.bulk_job_seal SET steps_sealed=0 WHERE job_id=p_job;
 END IF;
 WITH ins AS (
  INSERT INTO public.bulk_job_step(job_id,tenant_id,seq,kind,row_num,payload)
   SELECT p_job,j.tenant_id,x.seq,x.kind,x.row_num,x.payload FROM jsonb_to_recordset(p_steps) x(seq integer,kind text,row_num integer,payload jsonb)
   RETURNING job_id,seq,kind,row_num,payload,state,result,error)
 INSERT INTO app.bulk_job_step_seal(job_id,seq,digest)
  SELECT ins.job_id,ins.seq,app.bulk_job_step_digest(ins.kind,ins.row_num,ins.payload,ins.state,ins.result,ins.error) FROM ins;
 GET DIAGNOSTICS n=ROW_COUNT;
 UPDATE app.bulk_job_seal SET steps_sealed=steps_sealed+n,verified_at=NULL,updated_at=now() WHERE job_id=p_job;
 RETURN n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_steps_put(uuid,boolean,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.bulk_job_steps_put(uuid,boolean,jsonb) TO ai_hr_app;
--> statement-breakpoint
-- Chunk reader: the next pending steps in order, each verified against its seal before the worker applies it.
CREATE FUNCTION app.bulk_job_pending_steps(p_job uuid,p_limit integer) RETURNS TABLE(seq integer,kind text,row_num integer,payload jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
#variable_conflict use_column
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'bulk_job_steps_invalid' USING ERRCODE='22023'; END IF;
 PERFORM app.bulk_job_held(p_job);
 IF EXISTS(SELECT 1 FROM (SELECT st.* FROM public.bulk_job_step st WHERE st.job_id=p_job AND st.state='pending' ORDER BY st.seq LIMIT p_limit) st
  LEFT JOIN app.bulk_job_step_seal z ON z.job_id=st.job_id AND z.seq=st.seq
  WHERE z.digest IS DISTINCT FROM app.bulk_job_step_digest(st.kind,st.row_num,st.payload,st.state,st.result,st.error)) THEN
  RAISE EXCEPTION 'bulk_job_seal_mismatch' USING ERRCODE='XX001';
 END IF;
 RETURN QUERY SELECT st.seq,st.kind,st.row_num,st.payload FROM public.bulk_job_step st WHERE st.job_id=p_job AND st.state='pending' ORDER BY st.seq LIMIT p_limit;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_pending_steps(uuid,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.bulk_job_pending_steps(uuid,integer) TO ai_hr_app;
--> statement-breakpoint
-- A step's state, result or error (the applied marker commits with the step's own write). Each step must still match
-- its seal before it changes, and is resealed after. Keys: state, result, resultMerge, error.
CREATE FUNCTION app.bulk_job_step_update(p_job uuid,p_seqs integer[],p_set jsonb) RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j public.bulk_job; n integer;
BEGIN
 IF p_seqs IS NULL OR p_set IS NULL OR jsonb_typeof(p_set)<>'object'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_set) k WHERE k<>ALL(ARRAY['state','result','resultMerge','error']))
  OR (p_set ? 'state' AND coalesce(p_set->>'state','') NOT IN ('pending','applied','failed'))
  OR (p_set ? 'resultMerge' AND jsonb_typeof(p_set->'resultMerge')<>'object') THEN
  RAISE EXCEPTION 'bulk_job_step_update_invalid' USING ERRCODE='22023';
 END IF;
 j:=app.bulk_job_held(p_job);
 IF j.state NOT IN ('preparing','running','finalizing') THEN RAISE EXCEPTION 'bulk_job_state' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.bulk_job_step st LEFT JOIN app.bulk_job_step_seal z ON z.job_id=st.job_id AND z.seq=st.seq
  WHERE st.job_id=p_job AND st.seq=ANY(p_seqs)
   AND z.digest IS DISTINCT FROM app.bulk_job_step_digest(st.kind,st.row_num,st.payload,st.state,st.result,st.error)) THEN
  RAISE EXCEPTION 'bulk_job_seal_mismatch' USING ERRCODE='XX001';
 END IF;
 WITH up AS (
  UPDATE public.bulk_job_step st SET
   state=CASE WHEN p_set ? 'state' THEN p_set->>'state' ELSE st.state END,
   result=CASE
    WHEN p_set ? 'resultMerge' THEN coalesce(CASE WHEN p_set ? 'result' THEN nullif(p_set->'result','null'::jsonb) ELSE st.result END,'{}'::jsonb)||(p_set->'resultMerge')
    WHEN p_set ? 'result' THEN nullif(p_set->'result','null'::jsonb) ELSE st.result END,
   error=CASE WHEN p_set ? 'error' THEN left(p_set->>'error',1000) ELSE st.error END
  WHERE st.job_id=p_job AND st.seq=ANY(p_seqs)
  RETURNING st.seq,st.kind,st.row_num,st.payload,st.state,st.result,st.error)
 UPDATE app.bulk_job_step_seal z SET digest=app.bulk_job_step_digest(up.kind,up.row_num,up.payload,up.state,up.result,up.error)
  FROM up WHERE z.job_id=p_job AND z.seq=up.seq;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n>0 THEN UPDATE app.bulk_job_seal SET verified_at=NULL,updated_at=now() WHERE job_id=p_job; END IF;
 RETURN n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_step_update(uuid,integer[],jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.bulk_job_step_update(uuid,integer[],jsonb) TO ai_hr_app;
--> statement-breakpoint
-- The worker's writes to its job row, from its fenced app-role transaction or its owner transaction. Keys (camelCase,
-- as core/bulk-job-worker.ts BulkJobWorkerSet): state (only the worker's forward transitions; terminal and discard
-- transitions stay on the owner connection), expectState (no-op unless the job is in one of these states), phase,
-- stepsTotal, stepsDone, stepsDoneAdd, counters, countersMerge, countersAdd, plan, planMerge, attemptId, companyIds,
-- result, error, errors, errorsAppend, resetTransientRetries, finished, noticeEventId. A plan change is resealed, and
-- refused if the stored plan no longer matches its seal. Returns false when expectState did not match.
CREATE FUNCTION app.bulk_job_worker_update(p_job uuid,p_set jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j public.bulk_job; seal_plan bytea; add_ jsonb;
 v_state text; v_phase text; v_total integer; v_done integer; v_counters jsonb; v_plan jsonb; v_attempt uuid; v_companies uuid[];
 v_result jsonb; v_error text; v_errors jsonb; v_retries integer; v_finished timestamptz; v_notice uuid; v_notified timestamptz;
BEGIN
 IF p_set IS NULL OR jsonb_typeof(p_set)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_set) k WHERE k<>ALL(ARRAY['state','expectState',
  'phase','stepsTotal','stepsDone','stepsDoneAdd','counters','countersMerge','countersAdd','plan','planMerge','attemptId','companyIds','result',
  'error','errors','errorsAppend','resetTransientRetries','finished','noticeEventId']))
  OR (p_set ? 'expectState' AND jsonb_typeof(p_set->'expectState')<>'array')
  OR (p_set ? 'counters' AND jsonb_typeof(p_set->'counters')<>'object') OR (p_set ? 'countersMerge' AND jsonb_typeof(p_set->'countersMerge')<>'object')
  OR (p_set ? 'countersAdd' AND jsonb_typeof(p_set->'countersAdd')<>'object') OR (p_set ? 'planMerge' AND jsonb_typeof(p_set->'planMerge')<>'object')
  OR (p_set ? 'companyIds' AND jsonb_typeof(p_set->'companyIds')<>'array') OR (p_set ? 'errors' AND jsonb_typeof(p_set->'errors')<>'array')
  OR (p_set ? 'errorsAppend' AND jsonb_typeof(p_set->'errorsAppend')<>'array') THEN
  RAISE EXCEPTION 'bulk_job_update_invalid' USING ERRCODE='22023';
 END IF;
 j:=app.bulk_job_held(p_job);
 IF p_set ? 'expectState' AND NOT j.state=ANY(ARRAY(SELECT jsonb_array_elements_text(p_set->'expectState'))) THEN RETURN false; END IF;
 v_state:=j.state;
 IF p_set ? 'state' AND (p_set->>'state') IS DISTINCT FROM j.state THEN
  v_state:=p_set->>'state';
  IF NOT ((j.state='queued' AND v_state='preparing') OR (j.state='preparing' AND v_state IN ('running','finalizing','completed','failed'))
   OR (j.state='running' AND v_state IN ('finalizing','completed')) OR (j.state='finalizing' AND v_state IN ('running','completed'))) THEN
   RAISE EXCEPTION 'bulk_job_transition_invalid' USING ERRCODE='22023';
  END IF;
 END IF;
 v_phase:=CASE WHEN p_set ? 'phase' THEN p_set->>'phase' ELSE j.phase END;
 v_total:=CASE WHEN p_set ? 'stepsTotal' THEN (p_set->>'stepsTotal')::integer ELSE j.steps_total END;
 v_done:=CASE WHEN p_set ? 'stepsDone' THEN (p_set->>'stepsDone')::integer ELSE j.steps_done END+coalesce((p_set->>'stepsDoneAdd')::integer,0);
 v_counters:=CASE WHEN p_set ? 'counters' THEN p_set->'counters' ELSE j.counters END;
 IF p_set ? 'countersMerge' THEN v_counters:=v_counters||(p_set->'countersMerge'); END IF;
 IF p_set ? 'countersAdd' THEN
  add_:=p_set->'countersAdd';
  SELECT coalesce(jsonb_object_agg(keys.k,coalesce((v_counters->>keys.k)::numeric,0)+coalesce((add_->>keys.k)::numeric,0)),'{}'::jsonb) INTO v_counters
   FROM (SELECT jsonb_object_keys(v_counters) k UNION SELECT jsonb_object_keys(add_)) keys;
 END IF;
 v_plan:=CASE WHEN p_set ? 'plan' THEN nullif(p_set->'plan','null'::jsonb) ELSE j.plan END;
 IF p_set ? 'planMerge' THEN v_plan:=coalesce(v_plan,'{}'::jsonb)||(p_set->'planMerge'); END IF;
 IF p_set ? 'plan' OR p_set ? 'planMerge' THEN
  SELECT s.plan_digest INTO seal_plan FROM app.bulk_job_seal s WHERE s.job_id=p_job;
  IF seal_plan IS DISTINCT FROM app.bulk_job_value_digest(j.plan) THEN RAISE EXCEPTION 'bulk_job_seal_mismatch' USING ERRCODE='XX001'; END IF;
 END IF;
 v_attempt:=CASE WHEN p_set ? 'attemptId' THEN (p_set->>'attemptId')::uuid ELSE j.attempt_id END;
 v_companies:=CASE WHEN p_set ? 'companyIds' THEN ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p_set->'companyIds') x) ELSE j.company_ids END;
 IF p_set ? 'companyIds' AND EXISTS(SELECT 1 FROM unnest(v_companies) c(id) WHERE NOT EXISTS(SELECT 1 FROM public.company co WHERE co.id=c.id AND co.tenant_id=j.tenant_id)) THEN
  RAISE EXCEPTION 'bulk_job_company_invalid' USING ERRCODE='42501';
 END IF;
 v_result:=CASE WHEN p_set ? 'result' THEN nullif(p_set->'result','null'::jsonb) ELSE j.result END;
 v_error:=CASE WHEN p_set ? 'error' THEN left(p_set->>'error',4000) ELSE j.error END;
 v_errors:=CASE WHEN p_set ? 'errors' THEN p_set->'errors' ELSE j.errors END;
 IF p_set ? 'errorsAppend' AND jsonb_array_length(v_errors)<2000 THEN v_errors:=v_errors||(p_set->'errorsAppend'); END IF;
 v_retries:=CASE WHEN coalesce((p_set->>'resetTransientRetries')::boolean,false) THEN 0 ELSE j.transient_retries END;
 v_finished:=CASE WHEN coalesce((p_set->>'finished')::boolean,false) THEN now() ELSE j.finished_at END;
 v_notice:=j.notice_event_id;v_notified:=j.notified_at;
 IF p_set ? 'noticeEventId' THEN
  v_notice:=(p_set->>'noticeEventId')::uuid;
  IF j.notified_at IS NOT NULL OR v_state NOT IN ('completed','failed','cancelled') OR NOT EXISTS(SELECT 1 FROM public.domain_event ev
   WHERE ev.id=v_notice AND ev.tenant_id=j.tenant_id AND ev.aggregate_type='bulk-job' AND ev.aggregate_id=j.id
    AND ev.event_type='bulk-job.finished' AND ev.actor_id=j.created_by) THEN
   RAISE EXCEPTION 'bulk_job_notice_invalid' USING ERRCODE='22023';
  END IF;
  v_notified:=now();
 END IF;
 UPDATE public.bulk_job SET state=v_state,phase=v_phase,steps_total=v_total,steps_done=v_done,counters=v_counters,plan=v_plan,attempt_id=v_attempt,
  company_ids=v_companies,result=v_result,error=v_error,errors=v_errors,transient_retries=v_retries,finished_at=v_finished,
  notice_event_id=v_notice,notified_at=v_notified,updated_at=now()
  WHERE id=p_job;
 IF p_set ? 'plan' OR p_set ? 'planMerge' THEN
  UPDATE app.bulk_job_seal SET plan_digest=app.bulk_job_value_digest(v_plan),updated_at=now() WHERE job_id=p_job;
 END IF;
 RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_worker_update(uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.bulk_job_worker_update(uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
-- ── Grants: the application role reads; it never writes the store ──
DROP POLICY bulk_job_insert ON public.bulk_job;
--> statement-breakpoint
DROP POLICY bulk_job_update ON public.bulk_job;
--> statement-breakpoint
DROP POLICY bulk_job_step_access ON public.bulk_job_step;
--> statement-breakpoint
CREATE POLICY bulk_job_step_read ON public.bulk_job_step FOR SELECT USING(job_id IN (SELECT id FROM public.bulk_job));
--> statement-breakpoint
REVOKE ALL ON public.bulk_job,public.bulk_job_step,public.bulk_job_worker,public.bulk_job_kind FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT ON public.bulk_job,public.bulk_job_step,public.bulk_job_kind TO ai_hr_app;
