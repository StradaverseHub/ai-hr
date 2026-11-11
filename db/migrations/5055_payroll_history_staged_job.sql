-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5055_payroll_history_staged_job, idx 4455, when 1793330004755.
-- Draft name on its branch: 9955_payroll_history_staged_job. Any draft note below describes that unallocated branch position.
-- UNALLOCATED DRAFT on branch claude/bulkjob-payroll-20261110 (payroll's last long holders, 11 Nov 2026): not a
-- reservation, not an installation allocation. The journal position (idx 9955, when 1793330099955) exists only so
-- this branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when after the
-- freshly verified ledger, per docs/MIGRATION-ALLOCATION.md.
--
-- Payroll history upload confirm and revert as staged all-or-nothing jobs on the shared kernel (9003). Each used to
-- run as one transaction holding the tenant's history barrier and Access lock exclusively (105.6 s and 28.2 s at
-- 2,994 employees). The job now writes its rows in short chunk transactions holding no tenant-wide exclusive lock;
-- every row a chunk writes stays invisible until one short release transaction makes the whole attempt visible at
-- once (docs/adr/2026-11-10-payroll-processing-job.md, "Payroll history upload").
--
-- Why a pending-row registry instead of a pending column on each table (as 9001/9004 put on employment and person):
-- payslip and payroll_batch rows are hashed and published whole (to_jsonb) by existing owners (the information
-- payslip document, assistant payroll review witnesses, attendance payroll digests), and the history tables are
-- immutable by trigger. A new column would change every existing payslip document and witness, and could never be
-- cleared after release. The registry leaves every row byte-identical to the single transaction's, and the visible
-- switch is one row: the stage's state.

-- 1. The kind. One stage per tenant at a time (the unique index below), which is what the exclusive history barrier
--    gave: a second confirm or revert never refuses, it waits until the open stage is released or discarded.
--    Hardened kernel (5013): the kind declares the top-level keys and JSON types of the input its admission passes
--    (core/payroll-history-job.ts); app.bulk_job_enqueue refuses anything else. `operation` is 'confirm' or 'revert';
--    both carry the attempt and its preview hash, and a confirm adds its selection (confirmReplacement always, the
--    other options when the screen sends them). A shape has no null, so an absent option is left out and is optional
--    here. input_max_bytes: selectedRecordKeys names every ticked record (about 120 bytes each as stored text), so a
--    large file's selection passes the 1 MiB default; 16 MiB covers about 130,000 records. Finalize clears the
--    released stage's registry rows on the queue-owner connection (finalizeOwner on the handler), so the kind declares
--    finalize_owner. The worker writes its plan through the kernel's sealed definers: no grant on the job store here.
INSERT INTO bulk_job_kind(kind,scope_kind,exclusive,input_shape,input_max_bytes,finalize_owner)
 VALUES('payroll_history',NULL,'none','{"operation":"string","attemptId":"string","previewHash":"string","confirmReplacement":"boolean?","skipReplacements":"boolean?","selectedRecordKeys":"array?","acknowledgeWarnings":"boolean?","expectedCompanyId":"string?"}'::jsonb,16777216,true);
--> statement-breakpoint
CREATE TABLE app.payroll_history_stage (
 stage_id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 job_id uuid NOT NULL,
 attempt_id uuid NOT NULL REFERENCES public.payroll_history_import_attempt(id),
 operation text NOT NULL CHECK(operation IN ('confirm','revert')),
 state text NOT NULL DEFAULT 'staged' CHECK(state IN ('staged','released','discarded')),
 created_by uuid NOT NULL REFERENCES public.app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 released_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX payroll_history_stage_one_open ON app.payroll_history_stage(tenant_id) WHERE state='staged';
--> statement-breakpoint
-- Every row a chunk inserts, registered by the database (the stamp trigger below), never by the writer.
CREATE TABLE app.payroll_history_staged_row (
 stage_id uuid NOT NULL REFERENCES app.payroll_history_stage(stage_id),
 relation text NOT NULL CHECK(relation IN ('payroll_batch','payslip','payroll_history_import_record','payroll_history_import_snapshot','payroll_history_import_revision')),
 row_id uuid NOT NULL,
 PRIMARY KEY(relation,row_id)
);
--> statement-breakpoint
CREATE INDEX payroll_history_staged_row_stage ON app.payroll_history_staged_row(stage_id,relation);
--> statement-breakpoint
REVOKE ALL ON app.payroll_history_stage,app.payroll_history_staged_row FROM PUBLIC;
--> statement-breakpoint
-- 2. Stamp: a row inserted while app.payroll_history_stage names this tenant's open stage is registered to it. Only the
--    job's chunk transactions set the setting (transaction-local); any other session's inserts are ordinary.
CREATE FUNCTION app.payroll_history_stage_stamp() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE stage uuid:=nullif(current_setting('app.payroll_history_stage',true),'')::uuid;
BEGIN
 IF stage IS NULL THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.payroll_history_stage s WHERE s.stage_id=stage AND s.tenant_id=NEW.tenant_id AND s.state='staged') THEN
  RAISE EXCEPTION 'payroll_history_stage_unavailable' USING ERRCODE='55000';
 END IF;
 INSERT INTO app.payroll_history_staged_row(stage_id,relation,row_id) VALUES(stage,TG_TABLE_NAME,NEW.id);
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_stage_stamp() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_history_stage_stamp() TO ai_hr_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['payroll_batch','payslip','payroll_history_import_record','payroll_history_import_snapshot','payroll_history_import_revision'] LOOP
  EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.payroll_history_stage_stamp()',t||'_history_stage_stamp',t);
 END LOOP;
END $$;
--> statement-breakpoint
-- 3. Visibility. Policy side: the current tenant's rows staged by an open stage that is not this session's own, as one
--    array per statement (InitPlan, hashed). With nothing staged it is one probe of the partial index above.
CREATE FUNCTION app.payroll_history_hidden_rows(p_relation text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(array_agg(r.row_id),'{}'::uuid[]) FROM app.payroll_history_stage s
  JOIN app.payroll_history_staged_row r ON r.stage_id=s.stage_id AND r.relation=p_relation
 WHERE s.tenant_id=app.current_tenant_id() AND s.state='staged'
  AND s.stage_id::text IS DISTINCT FROM current_setting('app.payroll_history_stage',true);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_hidden_rows(text) FROM PUBLIC;
--> statement-breakpoint
-- RESTRICTIVE, ANDed with each table's own policies, for every role subject to row security (FOR ALL: another session
-- can neither read, update nor delete a staged row). The owner and BYPASSRLS roles are audited below.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['payroll_batch','payslip','payroll_history_import_record','payroll_history_import_snapshot','payroll_history_import_revision'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL USING (NOT (id IN (SELECT unnest(app.payroll_history_hidden_rows(%L)))))',t||'_history_stage',t,t);
 END LOOP;
END $$;
--> statement-breakpoint
-- app.payroll_history_hidden_rows(text) is evaluated by row security under whichever role a policy applies to, so it is executable by exactly
-- those roles instead of PUBLIC: a policy's own roles, or, for a policy to PUBLIC, every role holding a privilege on
-- the policy's table (and the table owner where row security is forced). A role granted such a table later needs
-- this grant too; without it the policy fails closed (permission denied), never open.
DO $policy_function_grants$
DECLARE fn regprocedure:='app.payroll_history_hidden_rows(text)'::regprocedure; r record;
BEGIN
 FOR r IN
  WITH policies AS (
   SELECT DISTINCT p.oid,p.polrelid,p.polroles FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_depend d
    ON d.classid='pg_catalog.pg_policy'::regclass AND d.objid=p.oid AND d.refclassid='pg_catalog.pg_proc'::regclass AND d.refobjid=fn)
  SELECT DISTINCT g.grantee FROM (
   SELECT unnest(p.polroles) AS grantee FROM policies p
   UNION ALL
   SELECT a.grantee FROM policies p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    WHERE 0=ANY(p.polroles) AND (a.grantee<>c.relowner OR c.relforcerowsecurity)
   UNION ALL
   SELECT a.grantee FROM policies p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
    JOIN pg_catalog.pg_attribute att ON att.attrelid=c.oid AND att.attacl IS NOT NULL
    CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
    WHERE 0=ANY(p.polroles) AND (a.grantee<>c.relowner OR c.relforcerowsecurity)
   UNION ALL
   SELECT c.relowner FROM policies p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid WHERE 0=ANY(p.polroles) AND c.relforcerowsecurity
  ) g WHERE g.grantee<>0
 LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',fn,pg_catalog.pg_get_userbyid(r.grantee));
 END LOOP;
END $policy_function_grants$;
--> statement-breakpoint
-- Definer side: the same rule for one row. SQL, invoker, no SET clause, so the planner inlines it into each definer.
CREATE FUNCTION app.payroll_history_row_visible(p_relation text,p_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM app.payroll_history_staged_row r JOIN app.payroll_history_stage s ON s.stage_id=r.stage_id
  WHERE r.relation=p_relation AND r.row_id=p_id AND s.state='staged'
   AND s.stage_id::text IS DISTINCT FROM current_setting('app.payroll_history_stage',true));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_row_visible(text,uuid) FROM PUBLIC;
--> statement-breakpoint
-- 4. The effective-snapshot owner (0602/0660), which every payslip reader and the payslip policy apply. A staged
--    revision does not move a record's effective snapshot; a staged imported payslip is not effective; an ordinary
--    payslip a staged import would adopt stays effective until the release. Same result as before when nothing is
--    staged. Each replaced owner is checked against its reviewed predecessor first.
DO $$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('app.payroll_history_effective(uuid)','77febf7562467db258f085d13373fcc1'),
  ('app.payroll_history_batch_adopted(uuid)','606eb7f00b41f0c7ada58645b60f6b23'),
  ('app.payroll_history_self_issued(uuid)','1f3a3dfb5d6df0e2464c20049a5da3c1'),
  ('app.payroll_history_bind_snapshot()','890f803df021ccfe51a1ab7e50ca0fa6'),
  ('app.payroll_history_immutable()','f96e4ac4a5c744008f9e29209f6e67ac'),
  ('app.payroll_history_guard_adopted_payslip()','4e976c0766547590dffe1da3951fa663')
 ) v(sig,body) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=r.sig::regprocedure AND md5(p.prosrc)=r.body) THEN
   RAISE EXCEPTION 'payroll history stage: % differs from its reviewed predecessor',r.sig USING ERRCODE='55000';
  END IF;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_history_effective(subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.payroll_history_import_snapshot s
  WHERE s.id=subject AND s.tenant_id=app.current_tenant_id()
  AND CASE WHEN app.payroll_history_row_visible('payroll_history_import_snapshot',s.id)
   THEN (SELECT r.snapshot_id FROM public.payroll_history_import_revision r WHERE r.record_id=s.record_id
     AND app.payroll_history_row_visible('payroll_history_import_revision',r.id) ORDER BY r.ordinal DESC LIMIT 1) IS DISTINCT FROM subject
   ELSE NOT app.payroll_history_row_visible('payslip',subject) END)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_history_batch_adopted(subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(SELECT 1 FROM public.payroll_history_import_snapshot s JOIN public.payslip p ON p.id=s.id
  WHERE p.batch_id=subject AND s.tenant_id=app.current_tenant_id() AND app.payroll_history_row_visible('payroll_history_import_snapshot',s.id))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_history_self_issued(subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT coalesce(current_setting('app.payslip_self_issued',true),'')='on'
 AND EXISTS(SELECT 1 FROM public.payroll_history_import_snapshot s
  JOIN public.payslip p ON p.id=s.id JOIN public.payroll_batch b ON b.id=p.batch_id
  JOIN public.employment e ON e.id=p.employment_id
  WHERE s.id=subject AND s.tenant_id=app.current_tenant_id() AND b.history_import_attempt_id IS NULL
  AND app.payroll_history_row_visible('payroll_history_import_snapshot',s.id)
  AND app.principal_snapshot_current() AND app.is_self_person(e.person_id))
$$;
--> statement-breakpoint
-- An imported snapshot binds to its closed imported batch, as before, or to the draft batch its own stage wrote: the
-- staged batch closes in the release, after its snapshots (the single transaction closed it before them).
-- The check is the same conjunction as 0660's, split in two statements: record, payslip and batch are each unique for
-- the new snapshot, so its attempt is found first and only that attempt's planned rows are scanned. As one statement,
-- the cached generic plan could expand the planned rows of every attempt of the tenant for each snapshot (about 250 ms
-- per snapshot once a tenant holds a few large attempts, instead of about 5 ms).
CREATE OR REPLACE FUNCTION app.payroll_history_bind_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE attempt_ uuid; planned_rows jsonb;
BEGIN
 -- Adoption of an ordinary processed payslip: the record's first snapshot, values are its own columns.
 IF EXISTS(SELECT 1 FROM public.payroll_history_import_record r JOIN public.payslip p ON p.id=NEW.id
  JOIN public.payroll_batch b ON b.id=p.batch_id
  WHERE r.id=NEW.record_id AND r.tenant_id=NEW.tenant_id AND p.tenant_id=r.tenant_id AND b.tenant_id=r.tenant_id
  AND p.employment_id=r.employment_id AND b.company_id=r.company_id AND b.pay_period=r.period
  AND (b.payroll_cycle_id=r.cycle_id OR b.payroll_cycle_id IS NULL)
  AND b.history_import_attempt_id IS NULL AND b.status='closed'
  AND NOT EXISTS(SELECT 1 FROM public.payroll_history_import_snapshot o WHERE o.record_id=r.id)
  AND NEW."values"=jsonb_build_object('basicSalary',p.basic_salary::text,'allowance',p.allowance::text,
   'overtimePay',p.overtime_pay::text,'bonus',p.bonus::text,'grossPay',p.gross_pay::text,'statutory',p.statutory,
   'otherDeductions',p.other_deductions::text,'totalDeductions',p.total_deductions::text,'netPay',p.net_pay::text,'employerCost',p.employer_cost::text))
 THEN RETURN NEW; END IF;
 SELECT b.history_import_attempt_id INTO attempt_ FROM public.payroll_history_import_record r JOIN public.payslip p ON p.id=NEW.id
  JOIN public.payroll_batch b ON b.id=p.batch_id
  WHERE r.id=NEW.record_id AND r.tenant_id=NEW.tenant_id AND p.tenant_id=r.tenant_id AND b.tenant_id=r.tenant_id
  AND p.employment_id=r.employment_id AND b.company_id=r.company_id AND b.pay_period=r.period
  AND b.payroll_cycle_id=r.cycle_id AND b.history_import_attempt_id IS NOT NULL
  AND (b.status='closed' OR (b.status='draft' AND EXISTS(SELECT 1 FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage st ON st.stage_id=sr.stage_id
   WHERE sr.relation='payroll_batch' AND sr.row_id=b.id AND st.state='staged' AND st.stage_id::text=current_setting('app.payroll_history_stage',true))))
  AND NEW."values"=jsonb_build_object('basicSalary',p.basic_salary::text,'allowance',p.allowance::text,
   'overtimePay',p.overtime_pay::text,'bonus',p.bonus::text,'grossPay',p.gross_pay::text,'statutory',p.statutory,
   'otherDeductions',p.other_deductions::text,'totalDeductions',p.total_deductions::text,'netPay',p.net_pay::text,'employerCost',p.employer_cost::text);
 IF attempt_ IS NOT NULL THEN
  SELECT a.plan->'rows' INTO planned_rows FROM public.payroll_history_import_attempt a WHERE a.id=attempt_ AND a.tenant_id=NEW.tenant_id;
 END IF;
 IF attempt_ IS NULL OR planned_rows IS NULL OR NOT EXISTS(SELECT 1 FROM public.payroll_history_import_record r, jsonb_array_elements(planned_rows) planned
   WHERE r.id=NEW.record_id AND planned->>'companyId'=r.company_id::text AND planned->>'employmentId'=r.employment_id::text
   AND planned->>'period'=r.period AND planned->>'cycleId'=r.cycle_id::text
   AND planned->>'operation' IN ('create','replace') AND planned->'values'=NEW."values" AND planned->>'valueHash'=NEW.value_hash)
 THEN RAISE EXCEPTION 'Payroll import snapshot identity mismatch'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
-- Provenance stays immutable. The one exception is the job's discard: the queue owner deletes rows of a stage that was
-- never released, which nobody has seen.
CREATE OR REPLACE FUNCTION app.payroll_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND current_user=(SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid=TG_RELID)
  AND EXISTS(SELECT 1 FROM app.payroll_history_staged_row r JOIN app.payroll_history_stage s ON s.stage_id=r.stage_id
   WHERE r.relation=TG_TABLE_NAME AND r.row_id=OLD.id AND s.state='staged') THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Payroll import provenance is immutable; append a correction or revert revision';
END $$;
--> statement-breakpoint
-- An adopted payslip is frozen (0660). It now also counts the adoption a staged import is writing, which the guard,
-- as a row-security reader, could not see: an unlock or reset of that payslip is refused as it would be a moment
-- later, instead of failing on the snapshot's foreign key.
ALTER FUNCTION app.payroll_history_guard_adopted_payslip() SECURITY DEFINER SET search_path=pg_catalog,public,app;
--> statement-breakpoint
-- 5. Definer audit. Definers bypass row security. Of the 68 SECURITY DEFINER functions that read payslip,
--    payroll_batch or the history record, snapshot and revision tables, these enumerate rows independently of a
--    stored reference and would count, lock, fingerprint or preserve a staged row; each is re-created from its
--    installed definition with the predicate on exactly the listed reads, after checking how many it has. Every
--    other one reaches these rows only by a stored or caller-supplied id (no staged id is ever disclosed), through
--    app.payroll_history_effective (staged payslips are not effective), by pay_period_id (a staged batch has none),
--    or by a status a staged draft batch never has ('processed', 'closed'); triggers act on their own transaction's
--    rows exactly as they did in the single transaction.
DO $$
DECLARE r record; def text; found integer; owner_ name;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  -- Whether any run exists for the periods (payroll timeline and setup refusals).
  ('app.payroll_run_exists_for_periods(text[])','(FROM payroll_batch b\s+WHERE )','payroll_batch','b.id',1),
  -- Row locks taken before a leave or attendance decision re-reads coverage (NOWAIT would refuse on a chunk's lock).
  ('app.leave_payroll_coverage(uuid[])','(PERFORM b\.id FROM payroll_batch b WHERE )','payroll_batch','b.id',1),
  ('app.attendance_payroll_protection_rows(uuid)','(PERFORM b\.id FROM payroll_batch b\s+WHERE )','payroll_batch','b.id',1),
  -- Information preservation copies and counts every payslip of an employment.
  ('app.preserve_information_payroll(uuid)','(FROM public\.payslip p JOIN public\.payroll_batch b ON b\.id=p\.batch_id\s+WHERE )','payslip','p.id',1),
  ('app.preserve_information_payroll(uuid)','(LEFT JOIN public\.job_grade g ON g\.id=e\.grade_id AND g\.tenant_id=e\.tenant_id\s+WHERE )','payslip','p.id',1),
  ('app.preserve_information_payroll(uuid)','(SELECT count\(\*\) INTO n FROM public\.payslip WHERE )','payslip','id',1),
  ('app.information_payroll_ready(uuid)','(NOT EXISTS\(SELECT 1 FROM public\.payslip p JOIN public\.payroll_batch b ON b\.id=p\.batch_id\s+WHERE )','payslip','p.id',1),
  -- The assistant's family-maintenance context fingerprints this month's runs.
  ('app.assistant_family_maintenance_context(uuid)','(FROM public\.payroll_batch b WHERE )','payroll_batch','b.id',2),
  -- A leaver is due for learning only when no open payroll holds them.
  ('app._payroll_learning_leaver_due(uuid)','(FROM public\.payslip s JOIN public\.payroll_batch b ON b\.id=s\.batch_id AND b\.tenant_id=s\.tenant_id\s+WHERE )','payslip','s.id',2),
  -- Child-relief resync waits while a run of the period is open.
  ('app.my_sync_family_child_relief(uuid,timestamp with time zone)','(FROM public\.payroll_batch p WHERE )','payroll_batch','p.id',1),
  -- The attendance review's payroll dependency fingerprint enumerates an employment's history.
  ('app._assistant_attendance_dependency_rows(uuid,date)','(FROM public\.payroll_history_import_record h WHERE )','payroll_history_import_record','h.id',3),
  ('app._assistant_attendance_dependency_rows(uuid,date)','(FROM public\.payroll_history_import_snapshot WHERE )','payroll_history_import_snapshot','id',1),
  ('app._assistant_attendance_dependency_rows(uuid,date)','(FROM public\.payroll_history_import_revision WHERE )','payroll_history_import_revision','id',1),
  ('app._assistant_attendance_dependency_rows(uuid,date)','(FROM public\.payroll_history_import_snapshot h WHERE )','payroll_history_import_snapshot','h.id',1),
  ('app._assistant_attendance_dependency_rows(uuid,date)','(FROM public\.payroll_history_import_revision h WHERE )','payroll_history_import_revision','h.id',1),
  -- The income-tax basis binders accept an employment only with a payslip on file.
  ('app.payroll_tax_basis_bind()','(FROM public\.payslip p JOIN public\.payroll_batch b ON b\.id=p\.batch_id WHERE )','payslip','p.id',2)
 ) v(sig,pattern,relation,expr,expected) LOOP
  def:=pg_catalog.pg_get_functiondef(r.sig::regprocedure);
  SELECT count(*) INTO found FROM regexp_matches(def,r.pattern,'g');
  IF found<>r.expected THEN RAISE EXCEPTION 'payroll history stage predicate: % has % reads matching %, expected %',r.sig,found,r.pattern,r.expected; END IF;
  -- One function appears more than once (one entry per read shape); each later entry rewrites the rewritten text.
  EXECUTE regexp_replace(def,r.pattern,'\1app.payroll_history_row_visible('||quote_literal(r.relation)||','||r.expr||') AND ','g');
  SELECT o.rolname INTO owner_ FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles o ON o.oid=p.proowner WHERE p.oid=r.sig::regprocedure;
  IF owner_<>current_user THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION app.payroll_history_row_visible(text,uuid) TO %I',owner_);
   EXECUTE format('GRANT SELECT ON app.payroll_history_stage,app.payroll_history_staged_row TO %I',owner_);
  END IF;
 END LOOP;
END $$;
--> statement-breakpoint
-- 6. Staged batches. A staged batch has no pay period yet: the release resolves or creates the period and allocates
--    the run sequence under the release's locks, exactly as the single transaction did, so a run an operator creates
--    meanwhile in the same month never collides with a sequence nobody can see. Every visible batch still has one.
ALTER TABLE public.payroll_batch ALTER COLUMN pay_period_id DROP NOT NULL;
--> statement-breakpoint
CREATE FUNCTION app.payroll_batch_period_required() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.pay_period_id IS NOT NULL THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM app.payroll_history_staged_row r JOIN app.payroll_history_stage s ON s.stage_id=r.stage_id
  WHERE r.relation='payroll_batch' AND r.row_id=NEW.id AND s.state='staged' AND NEW.status='draft' AND NEW.history_import_attempt_id IS NOT NULL) THEN RETURN NULL; END IF;
 RAISE EXCEPTION 'payroll_batch.pay_period_id is required' USING ERRCODE='23502';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_batch_period_required() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_batch_period_required() TO ai_hr_app;
--> statement-breakpoint
-- Deferred to commit, so the stamp (an AFTER row trigger of the same insert) has registered the staged batch, and a
-- stage released or discarded with a period-less batch still in it can never commit.
CREATE CONSTRAINT TRIGGER payroll_batch_period_required AFTER INSERT OR UPDATE OF pay_period_id,status ON public.payroll_batch
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.payroll_batch_period_required();
--> statement-breakpoint
-- 7. Stage lifecycle, under the initiator's freshly checked authority (open, release) or the queue owner (settle).
-- Open: the job's own stage for an attempt the initiator can administer. Returns false while another stage of the
-- tenant is open (the job waits; it never refuses).
CREATE FUNCTION app.payroll_history_stage_open(p_stage uuid,p_attempt uuid,p_operation text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); u uuid:=app.current_user_id();
BEGIN
 IF t IS NULL OR u IS NULL OR p_stage IS NULL OR p_attempt IS NULL OR p_operation NOT IN ('confirm','revert') THEN RAISE EXCEPTION 'payroll_history_stage_invalid' USING ERRCODE='22023'; END IF;
 IF NOT app.principal_snapshot_current() OR NOT app.payroll_history_attempt_access(p_attempt)
  OR NOT EXISTS(SELECT 1 FROM public.bulk_job j WHERE j.id=p_stage AND j.tenant_id=t AND j.created_by=u AND j.kind='payroll_history' AND j.state IN ('queued','preparing'))
 THEN RAISE EXCEPTION 'payroll_history_stage_forbidden' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM app.payroll_history_stage s WHERE s.stage_id=p_stage) THEN
  RETURN EXISTS(SELECT 1 FROM app.payroll_history_stage s WHERE s.stage_id=p_stage AND s.state='staged');
 END IF;
 IF EXISTS(SELECT 1 FROM app.payroll_history_stage s WHERE s.tenant_id=t AND s.state='staged') THEN RETURN false; END IF;
 INSERT INTO app.payroll_history_stage(stage_id,tenant_id,job_id,attempt_id,operation,created_by) VALUES(p_stage,t,p_stage,p_attempt,p_operation,u)
  ON CONFLICT DO NOTHING;
 RETURN EXISTS(SELECT 1 FROM app.payroll_history_stage s WHERE s.stage_id=p_stage AND s.state='staged');
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_stage_open(uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_history_stage_open(uuid,uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- Whether another stage of this tenant is open (reveals a boolean only).
CREATE FUNCTION app.payroll_history_stage_busy(p_stage uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.payroll_history_stage s WHERE s.tenant_id=app.current_tenant_id() AND s.state='staged' AND s.stage_id IS DISTINCT FROM p_stage);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_stage_busy(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_history_stage_busy(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Release (the visibility flip): one row, inside the release transaction that rechecked the plan under the history
-- and Access write locks and appended the attempt's history and audit events.
CREATE FUNCTION app.payroll_history_stage_release(p_stage uuid) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); u uuid:=app.current_user_id(); staged bigint;
BEGIN
 IF NOT app.principal_snapshot_current() OR NOT EXISTS(SELECT 1 FROM app.payroll_history_stage s WHERE s.stage_id=p_stage AND s.tenant_id=t AND s.created_by=u AND s.state='staged'
  AND app.payroll_history_attempt_access(s.attempt_id)) THEN RAISE EXCEPTION 'payroll_history_stage_release_unavailable' USING ERRCODE='42501'; END IF;
 -- Every staged batch was closed into its pay period by this release transaction.
 IF EXISTS(SELECT 1 FROM app.payroll_history_staged_row r JOIN public.payroll_batch b ON b.id=r.row_id
  WHERE r.stage_id=p_stage AND r.relation='payroll_batch' AND (b.pay_period_id IS NULL OR b.status::text<>'closed')) THEN
  RAISE EXCEPTION 'payroll_history_stage_incomplete' USING ERRCODE='55000';
 END IF;
 SELECT count(*) INTO staged FROM app.payroll_history_staged_row r WHERE r.stage_id=p_stage;
 UPDATE app.payroll_history_stage SET state='released',released_at=now() WHERE stage_id=p_stage;
 RETURN staged;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_stage_release(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_history_stage_release(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The job's own progress reads the rows it staged (its chunks need each group's staged batch and the changes made).
-- Owner-connection maintenance (settle after release, discard) deletes registry rows and staged rows directly.
