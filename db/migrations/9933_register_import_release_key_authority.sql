-- UNALLOCATED DRAFT on branch claude/bulkjob-register-20261110 (register import release, security review fixes): not a
-- reservation, not an installation allocation. The journal position (idx 9933, when 1793330099330) exists only so this
-- branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when.
--
-- 9931's release decided authority on each capture's `subjects` but wrote to its `key`, and accepted the writers' audit
-- events as captured. The release now trusts nothing in the job's step rows for authority or for what is recorded:
--  * every capture's KEY (the employment for qualifications, the person for contacts) is decided itself, in the job's
--    tenant, as the profile value guard and row security decided each written row: live and visible, company
--    administered, workforce maintain without an explicit deny (app.access_workforce_employment /
--    app.access_workforce_person, per company), and an active employment;
--  * a capture needs at least one subject, every subject must be that key's own employment or person, and each is
--    re-checked as before (code, person, company, status);
--  * created rows attach only to the capture's key in the job's tenant, never archived;
--  * exactly one `added` event per created row and one `updated` event per updated existing row of the key; the event's
--    subject employment, actor and every value that describes the row are taken from the rows themselves, and its
--    references (the cleared or demoted holder) must be rows of the same key that this release changes;
--  * every changed existing row is named by the audit: an `updated` event whose diff lists each column it changes, or
--    the holder an event cleared or demoted, changing nothing else;
--  * the number of rows written is the number of events, and must be the file's row count.
-- The audit chain is armed by the caller from the creator's live session, as the employee import Revert does.
CREATE OR REPLACE FUNCTION app.register_import_release(p_job uuid,p_chain boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j public.bulk_job%ROWTYPE; t uuid; u uuid; kind_ text; tbl text; keycol text; vis uuid[]; today date;
 stale integer[]; bad boolean; allowed text[]; all_cols text[]; diff_fields text[]; grp record; n bigint; expected bigint; events integer;
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
  diff_fields:=ARRAY['qualification','description','fromYm','toYm','institute','major','graduationDate','result','isHighest'];
 ELSIF kind_='emergency' THEN tbl:='person_emergency_contact';keycol:='person_id';
  diff_fields:=ARRAY['fullName','relationship','mobilePhone','homePhone','address','remarks','priority'];
 ELSE RAISE EXCEPTION 'register_import_release_invalid' USING ERRCODE='22023'; END IF;
 -- The register writers' locks, in their order (lockProfileValueWritesTx): Access, its tuples, then the profile policy.
 PERFORM app.access_profile_policy_write_lock();
 today:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
 vis:=app.visible_employment_ids();

 CREATE TEMP TABLE register_release_capture ON COMMIT DROP AS
  SELECT s.seq,s.result AS r,(s.result->>'key')::uuid AS key FROM public.bulk_job_step s WHERE s.job_id=p_job AND s.state='applied';
 CREATE TEMP TABLE register_release_subject ON COMMIT DROP AS
  SELECT c.seq,c.key,x->>'code' AS code,(x->>'employmentId')::uuid AS employment_id,(x->>'personId')::uuid AS person_id
  FROM pg_temp.register_release_capture c CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.r->'subjects')='array' THEN c.r->'subjects' ELSE '[]'::jsonb END) x;
 -- Company verdicts once per company, over every employment of every key and subject in the job's tenant.
 CREATE TEMP TABLE register_release_company ON COMMIT DROP AS
  SELECT co.company_id,app.access_workforce_company(co.company_id,'workforce.maintain') AS ok,
   app.access_workforce_not_denied(co.company_id,'workforce.maintain') AS not_denied,app.is_admin_for(co.company_id) AS admin_for,
   (SELECT c.archived_at IS NULL FROM public.company c WHERE c.id=co.company_id AND c.tenant_id=t) AS live
  FROM (SELECT DISTINCT e.company_id FROM public.employment e WHERE e.tenant_id=t AND (
    e.id IN (SELECT c.key FROM pg_temp.register_release_capture c) OR e.person_id IN (SELECT c.key FROM pg_temp.register_release_capture c)
    OR e.id IN (SELECT s.employment_id FROM pg_temp.register_release_subject s))) co;

 -- A capture that is not about one employee of this tenant, or whose subjects are not that employee, is refused
 -- outright: nothing a recapture would change.
 SELECT EXISTS(SELECT 1 FROM pg_temp.register_release_capture c WHERE c.key IS NULL
   OR NOT EXISTS(SELECT 1 FROM pg_temp.register_release_subject s WHERE s.seq=c.seq))
  OR EXISTS(SELECT 1 FROM pg_temp.register_release_capture c GROUP BY c.key HAVING count(*)>1)
  OR EXISTS(SELECT 1 FROM pg_temp.register_release_subject s WHERE s.employment_id IS NULL OR s.person_id IS NULL OR s.code IS NULL
   OR (kind_='qualification' AND s.employment_id IS DISTINCT FROM s.key) OR (kind_='emergency' AND s.person_id IS DISTINCT FROM s.key))
  OR EXISTS(SELECT 1 FROM pg_temp.register_release_capture c WHERE
   (kind_='qualification' AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=c.key AND e.tenant_id=t))
   OR (kind_='emergency' AND NOT EXISTS(SELECT 1 FROM public.person p WHERE p.id=c.key AND p.tenant_id=t)))
 INTO bad;
 IF bad THEN RAISE EXCEPTION 'register_import_release_invalid' USING ERRCODE='22023'; END IF;

 -- Authority over every key, decided as the profile value guard and row security decided each written row: the
 -- employment visible to the creator in an administered company they maintain (qualifications), or the person with an
 -- employment in a maintained company and none in a denied one (contacts). A key outside that authority is refused,
 -- whatever its capture says; nothing is written.
 IF EXISTS(SELECT 1 FROM pg_temp.register_release_capture c WHERE
   (kind_='qualification' AND NOT EXISTS(SELECT 1 FROM public.employment e JOIN pg_temp.register_release_company rc ON rc.company_id=e.company_id
     WHERE e.id=c.key AND e.tenant_id=t AND e.id=ANY(vis) AND rc.ok AND rc.admin_for))
   OR (kind_='emergency' AND (NOT EXISTS(SELECT 1 FROM public.employment e2 JOIN pg_temp.register_release_company c2 ON c2.company_id=e2.company_id
      WHERE e2.person_id=c.key AND e2.tenant_id=t AND c2.ok AND c2.admin_for)
    OR EXISTS(SELECT 1 FROM public.employment e3 LEFT JOIN pg_temp.register_release_company c3 ON c3.company_id=e3.company_id
      WHERE e3.person_id=c.key AND e3.tenant_id=t AND NOT coalesce(c3.not_denied,false))))) THEN
  RAISE EXCEPTION 'register_import_release_forbidden' USING ERRCODE='42501';
 END IF;

 -- A capture is current when its key is still a live, active record, every subject still names the same live, active
 -- employment and person, and the register is what the capture started from (every row's identity and row version).
 -- Otherwise it is captured again.
 EXECUTE format($q$
  SELECT array_agg(DISTINCT seq ORDER BY seq) FROM (
   -- The key itself.
   SELECT c.seq FROM pg_temp.register_release_capture c
   WHERE ($2='qualification' AND NOT EXISTS(SELECT 1 FROM public.employment e JOIN pg_temp.register_release_company rc ON rc.company_id=e.company_id
      WHERE e.id=c.key AND e.tenant_id=$1 AND e.voided_at IS NULL AND app.import_marker_visible(e.import_pending_attempt_id)
       AND rc.live AND e.blacklisted_at IS NULL AND coalesce(least(e.resignation_date,e.last_working_date,e.terminated_on)>$4,true)))
    OR ($2='emergency' AND NOT EXISTS(SELECT 1 FROM public.person p WHERE p.id=c.key AND p.tenant_id=$1 AND p.voided_at IS NULL
      AND app.import_marker_visible(p.import_pending_attempt_id)))
   UNION ALL
   -- Every subject.
   SELECT s.seq FROM pg_temp.register_release_subject s
    LEFT JOIN public.employment e ON e.id=s.employment_id AND e.tenant_id=$1
    LEFT JOIN pg_temp.register_release_company rc ON rc.company_id=e.company_id
   WHERE e.id IS NULL OR e.person_id IS DISTINCT FROM s.person_id OR upper(btrim(coalesce(e.employee_code,'')))<>s.code
    OR e.voided_at IS NOT NULL OR NOT app.import_marker_visible(e.import_pending_attempt_id) OR NOT coalesce(rc.live,false)
    OR NOT coalesce(rc.admin_for,false) OR e.blacklisted_at IS NOT NULL
    OR least(e.resignation_date,e.last_working_date,e.terminated_on)<=$4
   UNION ALL
   SELECT c.seq FROM pg_temp.register_release_capture c
   WHERE (SELECT md5(coalesce(string_agg(r.id::text||'@'||r.xmin::text,',' ORDER BY r.id),'')) FROM public.%I r WHERE r.%I=c.key AND r.tenant_id=$1)
    IS DISTINCT FROM c.r->>'fingerprint'
  ) x$q$,tbl,keycol) INTO stale USING t,kind_,vis,today;
 IF stale IS NOT NULL THEN RETURN jsonb_build_object('released',false,'stale',to_jsonb(stale)); END IF;

 -- Captured rows are re-validated against their own key before anything is written.
 SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO all_cols FROM pg_catalog.pg_attribute a
  WHERE a.attrelid=('public.'||tbl)::regclass AND a.attnum>0 AND NOT a.attisdropped;
 allowed:=ARRAY(SELECT c FROM unnest(all_cols) c WHERE c NOT IN ('id','tenant_id','created_at','employment_id','person_id','archived_at'));
 CREATE TEMP TABLE register_release_changed ON COMMIT DROP AS
  SELECT c.seq,c.key,(x->>'id')::uuid AS id,x->'set' AS change FROM pg_temp.register_release_capture c
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.r->'changed')='array' THEN c.r->'changed' ELSE '[]'::jsonb END) x;
 CREATE TEMP TABLE register_release_created ON COMMIT DROP AS
  SELECT c.seq,c.key,x.value AS row,x.ordinality AS ord,(x.value->>'id')::uuid AS id FROM pg_temp.register_release_capture c
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.r->'created')='array' THEN c.r->'created' ELSE '[]'::jsonb END) WITH ORDINALITY x;
 CREATE TEMP TABLE register_release_event ON COMMIT DROP AS
  SELECT c.seq,c.key,e,o,(e->>'rowNum')::integer AS row_num,e->>'eventType' AS event_type,(e->>'aggregateId')::uuid AS aggregate_id
  FROM pg_temp.register_release_capture c
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.r->'events')='array' THEN c.r->'events' ELSE '[]'::jsonb END) WITH ORDINALITY ev(e,o);
 EXECUTE format($q$
  SELECT EXISTS(SELECT 1 FROM pg_temp.register_release_changed ch WHERE ch.id IS NULL OR jsonb_typeof(ch.change)<>'object'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(ch.change) k WHERE NOT (k=ANY($2)))
    OR NOT EXISTS(SELECT 1 FROM public.%1$I r WHERE r.id=ch.id AND r.%2$I=ch.key AND r.tenant_id=$1 AND r.archived_at IS NULL))
   OR EXISTS(SELECT 1 FROM pg_temp.register_release_changed ch GROUP BY ch.id HAVING count(*)>1)
   OR EXISTS(SELECT 1 FROM pg_temp.register_release_created cr WHERE cr.id IS NULL OR jsonb_typeof(cr.row)<>'object'
    OR (cr.row->>'tenant_id') IS DISTINCT FROM $1::text OR (cr.row->>%2$L) IS DISTINCT FROM cr.key::text
    OR nullif(cr.row->>'archived_at','') IS NOT NULL OR EXISTS(SELECT 1 FROM jsonb_object_keys(cr.row) k WHERE NOT (k=ANY($3))))
   OR EXISTS(SELECT 1 FROM pg_temp.register_release_created cr GROUP BY cr.id HAVING count(*)>1)
  $q$,tbl,keycol) INTO bad USING t,allowed,all_cols;
 IF bad THEN RAISE EXCEPTION 'register_import_release_invalid' USING ERRCODE='22023'; END IF;
 -- Events: exactly one `added` per created row and one `updated` per updated existing row, about rows of the key.
 IF EXISTS(SELECT 1 FROM pg_temp.register_release_event ev WHERE ev.row_num IS NULL OR ev.aggregate_id IS NULL
   OR ev.event_type IS DISTINCT FROM CASE WHEN EXISTS(SELECT 1 FROM pg_temp.register_release_created cr WHERE cr.seq=ev.seq AND cr.id=ev.aggregate_id)
     THEN CASE kind_ WHEN 'qualification' THEN 'qualification.added' ELSE 'emergency-contact.added' END
     WHEN EXISTS(SELECT 1 FROM pg_temp.register_release_changed ch WHERE ch.seq=ev.seq AND ch.id=ev.aggregate_id)
     THEN CASE kind_ WHEN 'qualification' THEN 'qualification.updated' ELSE 'emergency-contact.updated' END END
   OR jsonb_typeof(ev.e->'payload')<>'object'
   OR (ev.event_type LIKE '%.updated' AND (jsonb_typeof(ev.e->'payload'->'diff')<>'array'
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(ev.e->'payload'->'diff') d WHERE jsonb_typeof(d)<>'string' OR NOT ((d#>>'{}')=ANY(diff_fields)))))
   -- The holder a row took the exclusive flag from must be a row of the same key that this release clears.
   OR (ev.e->'payload' ? 'clearedHighestId' AND NOT EXISTS(SELECT 1 FROM pg_temp.register_release_changed ch
     WHERE ch.seq=ev.seq AND ch.id::text=ev.e->'payload'->>'clearedHighestId' AND (ch.change->>'is_highest')='false'))
   OR (ev.e->'payload' ? 'demotedId' AND NOT EXISTS(SELECT 1 FROM pg_temp.register_release_changed ch
     WHERE ch.seq=ev.seq AND ch.id::text=ev.e->'payload'->>'demotedId' AND ch.change ? 'priority' AND (ch.change->>'priority')<>'primary')))
  OR EXISTS(SELECT 1 FROM pg_temp.register_release_created cr WHERE (SELECT count(*) FROM pg_temp.register_release_event ev WHERE ev.seq=cr.seq AND ev.aggregate_id=cr.id)<>1)
  OR EXISTS(SELECT 1 FROM pg_temp.register_release_event ev GROUP BY ev.row_num HAVING count(*)>1)
  OR (SELECT count(*) FROM pg_temp.register_release_event)<>jsonb_array_length(coalesce(j.input->'records','[]'::jsonb)) THEN
  RAISE EXCEPTION 'register_import_release_invalid' USING ERRCODE='22023';
 END IF;
 -- Every changed existing row is accounted for by the audit: it is the row of an `updated` event whose diff names every
 -- column it changes, or the holder an event cleared (Highest) or demoted (Primary), whose only other change is that flag.
 IF EXISTS(SELECT 1 FROM pg_temp.register_release_changed ch WHERE
   NOT EXISTS(SELECT 1 FROM pg_temp.register_release_event ev WHERE ev.seq=ch.seq AND ((ev.aggregate_id=ch.id AND ev.event_type LIKE '%.updated')
     OR ev.e->'payload'->>'clearedHighestId'=ch.id::text OR ev.e->'payload'->>'demotedId'=ch.id::text))
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(ch.change) k WHERE k<>'updated_at'
    AND NOT EXISTS(SELECT 1 FROM pg_temp.register_release_event ev
      CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(ev.e->'payload'->'diff')='array' THEN ev.e->'payload'->'diff' ELSE '[]'::jsonb END) d
      WHERE ev.seq=ch.seq AND ev.aggregate_id=ch.id AND ev.event_type LIKE '%.updated' AND lower(regexp_replace(d,'([A-Z])','_\1','g'))=k)
    AND NOT (kind_='qualification' AND k='is_highest' AND (ch.change->>'is_highest')='false'
     AND EXISTS(SELECT 1 FROM pg_temp.register_release_event ev WHERE ev.seq=ch.seq AND ev.e->'payload'->>'clearedHighestId'=ch.id::text))
    AND NOT (kind_='emergency' AND k='priority' AND (ch.change->>'priority')='secondary'
     AND EXISTS(SELECT 1 FROM pg_temp.register_release_event ev WHERE ev.seq=ch.seq AND ev.e->'payload'->>'demotedId'=ch.id::text)))) THEN
  RAISE EXCEPTION 'register_import_release_invalid' USING ERRCODE='22023';
 END IF;

 -- Changed rows that clear or keep an exclusive flag, then rows that take one, then new rows: each partial unique
 -- index sees at most one holder at every point. updated_at is the moment the change becomes visible.
 FOR grp IN
  SELECT g.cols,g.takes_flag,jsonb_agg(jsonb_build_object('id',g.id,keycol,g.key)||g.change) AS rows FROM (
   SELECT ch.id,ch.key,ch.change,(SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(ch.change) k) AS cols,
    coalesce(CASE WHEN kind_='qualification' THEN (ch.change->>'is_highest')='true' ELSE (ch.change->>'priority')='primary' END,false) AS takes_flag
   FROM pg_temp.register_release_changed ch) g
  GROUP BY g.cols,g.takes_flag ORDER BY g.takes_flag,g.cols
 LOOP
  EXECUTE format('UPDATE public.%I t SET %s FROM jsonb_populate_recordset(null::public.%I,$1) x WHERE t.id=x.id AND t.%I=x.%I AND t.tenant_id=$2 AND t.archived_at IS NULL',
   tbl,(SELECT string_agg(CASE WHEN c='updated_at' THEN 'updated_at=now()' ELSE format('%I=x.%I',c,c) END,',') FROM unnest(grp.cols) c),tbl,keycol,keycol)
   USING grp.rows,t;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>jsonb_array_length(grp.rows) THEN RAISE EXCEPTION 'register_import_release_invalid' USING ERRCODE='22023'; END IF;
 END LOOP;
 SELECT count(*) INTO expected FROM pg_temp.register_release_created;
 IF expected>0 THEN
  EXECUTE format('INSERT INTO public.%I(%s) SELECT %s FROM jsonb_populate_recordset(null::public.%I,$1) x',tbl,
   (SELECT string_agg(format('%I',c),',') FROM unnest(all_cols) c),
   (SELECT string_agg(CASE WHEN c IN ('created_at','updated_at') THEN 'now()' WHEN c='tenant_id' THEN quote_literal(t::text)||'::uuid'
     WHEN c='archived_at' THEN 'NULL' ELSE format('x.%I',c) END,',') FROM unnest(all_cols) c),tbl)
   USING (SELECT jsonb_agg(cr.row ORDER BY cr.seq,cr.ord) FROM pg_temp.register_release_created cr);
 END IF;

 -- The audit events, in file order, by the creator. Every value describing a row is read from the row as written;
 -- the field list and the holder reference were validated above. The subject employment is the key (qualifications)
 -- or the person's employment subjectEmploymentForPerson resolves (contacts).
 IF kind_='qualification' THEN
  INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
  SELECT t,'employee-qualification',ev.aggregate_id,ev.event_type,'user',u,ev.key,
   CASE WHEN ev.event_type='qualification.added' THEN jsonb_build_object('qualification',q.qualification,'isHighest',q.is_highest)
    ELSE jsonb_build_object('diff',ev.e->'payload'->'diff') END
   ||CASE WHEN ev.e->'payload' ? 'clearedHighestId' THEN jsonb_build_object('clearedHighestId',ev.e->'payload'->>'clearedHighestId') ELSE '{}'::jsonb END
  FROM pg_temp.register_release_event ev JOIN public.employee_qualification q ON q.id=ev.aggregate_id AND q.employment_id=ev.key AND q.tenant_id=t
  ORDER BY ev.row_num,ev.seq,ev.o;
 ELSE
  INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
  SELECT t,'person-emergency-contact',ev.aggregate_id,ev.event_type,'user',u,
   (SELECT e.id FROM public.employment e WHERE e.tenant_id=t AND e.person_id=ev.key AND e.voided_at IS NULL AND e.id=ANY(vis)
     ORDER BY (e.terminated_on IS NOT NULL),e.hired_on,e.id LIMIT 1),
   CASE WHEN ev.event_type='emergency-contact.added' THEN jsonb_build_object('priority',pc.priority,'relationship',pc.relationship)
    ELSE jsonb_build_object('diff',ev.e->'payload'->'diff')||CASE WHEN ev.e->'payload' ? 'priority' THEN jsonb_build_object('priority',pc.priority) ELSE '{}'::jsonb END END
   ||CASE WHEN ev.e->'payload' ? 'demotedId' THEN jsonb_build_object('demotedId',ev.e->'payload'->>'demotedId') ELSE '{}'::jsonb END
  FROM pg_temp.register_release_event ev JOIN public.person_emergency_contact pc ON pc.id=ev.aggregate_id AND pc.person_id=ev.key AND pc.tenant_id=t
  ORDER BY ev.row_num,ev.seq,ev.o;
 END IF;
 GET DIAGNOSTICS events=ROW_COUNT;
 IF events<>(SELECT count(*) FROM pg_temp.register_release_event) THEN RAISE EXCEPTION 'register_import_release_invalid' USING ERRCODE='22023'; END IF;
 UPDATE public.bulk_job SET plan=coalesce(plan,'{}'::jsonb)||jsonb_build_object('released',true,'updated',events),updated_at=now() WHERE id=p_job;
 RETURN jsonb_build_object('released',true,'updated',events,'events',events);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.register_import_release(uuid,boolean) FROM PUBLIC,ai_hr_app;
