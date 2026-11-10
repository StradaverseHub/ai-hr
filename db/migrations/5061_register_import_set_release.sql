-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5061_register_import_set_release, idx 4461, when 1793330004761.
-- Draft name on its branch: 9931_register_import_set_release. Any draft note below describes that unallocated branch position.
-- UNALLOCATED DRAFT on branch claude/bulkjob-register-20261110 (register import release, set-based): not a reservation,
-- not an installation allocation. The journal position (idx 9931, when 1793330099310) exists only so this branch's
-- schema is executable and reviewable; the integration owner assigns the final tag/idx/when.
--
-- The register import release (docs/adr/2026-11-10-register-section-import-jobs.md) applied every captured row through
-- the app role, so the database re-ran the profile value guard, row security and the statement lock once PER ROW
-- (about 1.3 ms each for emergency contacts, measured with track_functions). This owner-only routine runs the same
-- decision once per statement instead: the creator's captured session (the job is readable only while those grants
-- stay current), the same company-level workforce maintain predicates the guard evaluates per row, the tables' row
-- security conditions, the employees' identity and status, and every employee's register fingerprint, then applies
-- all captured rows and events set-based in one transaction. The system label guard and every domain_event trigger
-- still run per row, as for any writer. Called only by the protected import worker on its queue-owner connection.
CREATE FUNCTION app.register_import_release(p_job uuid,p_chain boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j public.bulk_job%ROWTYPE; t uuid; u uuid; kind_ text; tbl text; keycol text; vis uuid[];
 stale integer[]; bad boolean; allowed text[]; all_cols text[]; grp record; n bigint; expected bigint; total integer; events integer;
BEGIN
 IF NOT app.access_workforce_storage_owner() THEN RAISE EXCEPTION 'register_import_release_forbidden' USING ERRCODE='42501'; END IF;
 PERFORM set_config('application_name','aihr-bulk:register_import:release',true);
 SELECT * INTO j FROM public.bulk_job b WHERE b.id=p_job FOR UPDATE;
 IF NOT FOUND OR j.kind<>'register_import' OR j.state<>'finalizing' OR j.lease_expires_at IS NULL OR j.lease_expires_at<now()
  OR coalesce((j.plan->>'released')::boolean,false) THEN
  RAISE EXCEPTION 'register_import_release_unavailable' USING ERRCODE='55000';
 END IF;
 t:=j.tenant_id;u:=j.created_by;
 IF (j.context->>'tenantId') IS DISTINCT FROM t::text OR (j.context->>'userId') IS DISTINCT FROM u::text THEN
  RAISE EXCEPTION 'register_import_release_unavailable' USING ERRCODE='55000';
 END IF;
 -- The creator's session exactly as withTenant opens it, from the grants the database captured at admission.
 PERFORM set_config('app.tenant_id',t::text,true),set_config('app.user_id',u::text,true),
  set_config('app.roles',coalesce((SELECT string_agg(r,',') FROM jsonb_array_elements_text(j.context->'roles') r),''),true),
  set_config('app.grants',coalesce(j.context->'grants','[]'::jsonb)::text,true),set_config('app.agent_principal_id','',true),
  set_config('app.payroll_tax_basis_reader','1',true);
 IF p_chain THEN PERFORM set_config('app.audit_hash_chain','on',true); END IF;
 IF NOT app.bank_import_context_current(j.context) OR NOT app.is_admin() THEN
  RAISE EXCEPTION 'register_import_release_forbidden' USING ERRCODE='42501';
 END IF;
 kind_:=j.input->>'section';
 IF kind_='qualification' THEN tbl:='employee_qualification';keycol:='employment_id';
 ELSIF kind_='emergency' THEN tbl:='person_emergency_contact';keycol:='person_id';
 ELSE RAISE EXCEPTION 'register_import_release_invalid' USING ERRCODE='22023'; END IF;
 -- The register writers' locks, in their order (lockProfileValueWritesTx): Access, its tuples, then the profile policy.
 PERFORM app.access_profile_policy_write_lock();

 CREATE TEMP TABLE register_release_capture ON COMMIT DROP AS
  SELECT s.seq,s.result AS r,(s.result->>'key')::uuid AS key FROM public.bulk_job_step s WHERE s.job_id=p_job AND s.state='applied';
 CREATE TEMP TABLE register_release_subject ON COMMIT DROP AS
  SELECT c.seq,x->>'code' AS code,(x->>'employmentId')::uuid AS employment_id,(x->>'personId')::uuid AS person_id
  FROM pg_temp.register_release_capture c CROSS JOIN LATERAL jsonb_array_elements(c.r->'subjects') x;
 -- The guard's per-row decision, once per company: app.access_workforce_employment and app.access_workforce_person
 -- are these two company predicates over the subject's employments.
 CREATE TEMP TABLE register_release_company ON COMMIT DROP AS
  SELECT co.company_id,app.access_workforce_company(co.company_id,'workforce.maintain') AS ok,
   app.access_workforce_not_denied(co.company_id,'workforce.maintain') AS not_denied,app.is_admin_for(co.company_id) AS admin_for
  FROM (SELECT DISTINCT e.company_id FROM public.employment e WHERE e.tenant_id=t AND e.person_id IN (SELECT s.person_id FROM pg_temp.register_release_subject s)) co;
 vis:=app.visible_employment_ids();

 -- An employee is current when the code still names the same employment and person, the employment is live in a live
 -- company the creator administers and maintains (row security, the profile value guard), and the register is
 -- what the capture started from (every row's identity and row version).
 EXECUTE format($q$
  SELECT array_agg(DISTINCT seq ORDER BY seq) FROM (
   SELECT s.seq FROM pg_temp.register_release_subject s
    LEFT JOIN public.employment e ON e.id=s.employment_id AND e.tenant_id=$1
    LEFT JOIN public.company co ON co.id=e.company_id
    LEFT JOIN pg_temp.register_release_company rc ON rc.company_id=e.company_id
   WHERE e.id IS NULL OR e.person_id IS DISTINCT FROM s.person_id OR upper(btrim(coalesce(e.employee_code,'')))<>s.code
    OR e.voided_at IS NOT NULL OR NOT app.import_marker_visible(e.import_pending_attempt_id) OR co.archived_at IS NOT NULL
    OR NOT coalesce(rc.admin_for,false) OR e.blacklisted_at IS NOT NULL
    OR least(e.resignation_date,e.last_working_date,e.terminated_on)<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
    OR ($2='qualification' AND (NOT coalesce(rc.ok,false) OR NOT (e.id=ANY($3))))
    OR ($2='emergency' AND (NOT EXISTS(SELECT 1 FROM public.employment e2 JOIN pg_temp.register_release_company c2 ON c2.company_id=e2.company_id
       WHERE e2.person_id=s.person_id AND e2.tenant_id=$1 AND c2.ok)
     OR EXISTS(SELECT 1 FROM public.employment e3 JOIN pg_temp.register_release_company c3 ON c3.company_id=e3.company_id
       WHERE e3.person_id=s.person_id AND e3.tenant_id=$1 AND NOT c3.not_denied)))
   UNION ALL
   SELECT c.seq FROM pg_temp.register_release_capture c
   WHERE (SELECT md5(coalesce(string_agg(r.id::text||'@'||r.xmin::text,',' ORDER BY r.id),'')) FROM public.%I r WHERE r.%I=c.key) IS DISTINCT FROM c.r->>'fingerprint'
  ) x$q$,tbl,keycol) INTO stale USING t,kind_,vis;
 IF stale IS NOT NULL THEN RETURN jsonb_build_object('released',false,'stale',to_jsonb(stale)); END IF;

 -- Captured rows are re-validated against their own employee before anything is written.
 SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO all_cols FROM pg_catalog.pg_attribute a
  WHERE a.attrelid=('public.'||tbl)::regclass AND a.attnum>0 AND NOT a.attisdropped;
 allowed:=ARRAY(SELECT c FROM unnest(all_cols) c WHERE c NOT IN ('id','tenant_id','created_at','employment_id','person_id'));
 CREATE TEMP TABLE register_release_changed ON COMMIT DROP AS
  SELECT c.seq,c.key,(x->>'id')::uuid AS id,x->'set' AS change FROM pg_temp.register_release_capture c CROSS JOIN LATERAL jsonb_array_elements(c.r->'changed') x;
 CREATE TEMP TABLE register_release_created ON COMMIT DROP AS
  SELECT c.seq,c.key,x.value AS row,x.ordinality AS ord FROM pg_temp.register_release_capture c CROSS JOIN LATERAL jsonb_array_elements(c.r->'created') WITH ORDINALITY x;
 SELECT EXISTS(SELECT 1 FROM pg_temp.register_release_changed ch CROSS JOIN LATERAL jsonb_object_keys(ch.change) k WHERE NOT (k=ANY(allowed)))
  OR EXISTS(SELECT 1 FROM pg_temp.register_release_created cr WHERE (cr.row->>'tenant_id') IS DISTINCT FROM t::text OR (cr.row->>keycol) IS DISTINCT FROM cr.key::text
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(cr.row) k WHERE NOT (k=ANY(all_cols))))
  INTO bad;
 IF bad THEN RAISE EXCEPTION 'register_import_release_invalid' USING ERRCODE='22023'; END IF;

 -- Changed rows that clear or keep an exclusive flag, then rows that take one, then new rows: each partial unique
 -- index sees at most one holder at every point. updated_at is the moment the change becomes visible.
 FOR grp IN
  SELECT g.cols,g.takes_flag,jsonb_agg(jsonb_build_object('id',g.id,keycol,g.key)||g.change) AS rows FROM (
   SELECT ch.id,ch.key,ch.change,(SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(ch.change) k) AS cols,
    coalesce(CASE WHEN kind_='qualification' THEN (ch.change->>'is_highest')='true' ELSE (ch.change->>'priority')='primary' END,false) AS takes_flag
   FROM pg_temp.register_release_changed ch) g
  GROUP BY g.cols,g.takes_flag ORDER BY g.takes_flag,g.cols
 LOOP
  EXECUTE format('UPDATE public.%I t SET %s FROM jsonb_populate_recordset(null::public.%I,$1) x WHERE t.id=x.id AND t.%I=x.%I AND t.tenant_id=$2',
   tbl,(SELECT string_agg(CASE WHEN c='updated_at' THEN 'updated_at=now()' ELSE format('%I=x.%I',c,c) END,',') FROM unnest(grp.cols) c),tbl,keycol,keycol)
   USING grp.rows,t;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>jsonb_array_length(grp.rows) THEN RAISE EXCEPTION 'register_import_release_invalid' USING ERRCODE='22023'; END IF;
 END LOOP;
 SELECT count(*) INTO expected FROM pg_temp.register_release_created;
 IF expected>0 THEN
  EXECUTE format('INSERT INTO public.%I(%s) SELECT %s FROM jsonb_populate_recordset(null::public.%I,$1) x',tbl,
   (SELECT string_agg(format('%I',c),',') FROM unnest(all_cols) c),
   (SELECT string_agg(CASE WHEN c IN ('created_at','updated_at') THEN 'now()' ELSE format('x.%I',c) END,',') FROM unnest(all_cols) c),tbl)
   USING (SELECT jsonb_agg(cr.row ORDER BY cr.seq,cr.ord) FROM pg_temp.register_release_created cr);
 END IF;

 -- The writers' own audit events, verbatim, in file order: one per row, about that employee's rows, by the creator.
 IF EXISTS(SELECT 1 FROM pg_temp.register_release_capture c CROSS JOIN LATERAL jsonb_array_elements(c.r->'events') ev(e)
  WHERE (e->>'actorType')<>'user' OR (e->>'actorId') IS DISTINCT FROM u::text
   OR (kind_='qualification' AND ((e->>'aggregateType')<>'employee-qualification' OR (e->>'eventType')<>ALL(ARRAY['qualification.added','qualification.updated'])
     OR (e->>'subjectEmploymentId') IS DISTINCT FROM c.key::text))
   OR (kind_='emergency' AND ((e->>'aggregateType')<>'person-emergency-contact' OR (e->>'eventType')<>ALL(ARRAY['emergency-contact.added','emergency-contact.updated'])
     OR (nullif(e->>'subjectEmploymentId','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.employment se WHERE se.id=(e->>'subjectEmploymentId')::uuid AND se.person_id=c.key))))
   OR NOT EXISTS(SELECT 1 FROM pg_temp.register_release_created cr WHERE cr.seq=c.seq AND cr.row->>'id'=e->>'aggregateId')
    AND NOT EXISTS(SELECT 1 FROM pg_temp.register_release_changed ch WHERE ch.seq=c.seq AND ch.id::text=e->>'aggregateId')) THEN
  RAISE EXCEPTION 'register_import_release_invalid' USING ERRCODE='22023';
 END IF;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
 SELECT t,e->>'aggregateType',(e->>'aggregateId')::uuid,e->>'eventType',(e->>'actorType')::public.actor_type,(e->>'actorId')::uuid,
  nullif(e->>'subjectEmploymentId','')::uuid,e->'payload'
 FROM pg_temp.register_release_capture c CROSS JOIN LATERAL jsonb_array_elements(c.r->'events') WITH ORDINALITY ev(e,o)
 ORDER BY (e->>'rowNum')::integer,c.seq,o;
 GET DIAGNOSTICS events=ROW_COUNT;
 SELECT coalesce(sum((c.r->>'rows')::integer),0) INTO total FROM pg_temp.register_release_capture c;
 UPDATE public.bulk_job SET plan=coalesce(plan,'{}'::jsonb)||jsonb_build_object('released',true,'updated',total),updated_at=now() WHERE id=p_job;
 RETURN jsonb_build_object('released',true,'updated',total,'events',events);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.register_import_release(uuid,boolean) FROM PUBLIC,ai_hr_app;
