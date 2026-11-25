-- ADR 0181 payroll read addendum, step P4 (section 9 step 6; section 5 as revised by 11.4, 11.5 and 11.7): the payroll
-- history barrier's committed part stored, so payroll_history_effective_only no longer runs the whole
-- app.payroll_history_effective_ids chain for every payslip. Installed inert on the 7460 switch: no policy changes here.
--
-- What the barrier hides (6695, through 7010's app.payroll_history_effective(id)): a payslip id x is ineffective when
--   A. x is an imported snapshot of the tenant and the latest revision of its record (by ordinal, ignoring revisions
--      hidden by another session's staged import) points at another snapshot or none (superseded); while x's own
--      snapshot is staged for another session, x is hidden only when x itself is staged as a payslip; or
--   R. x is a native payslip that a history record adopted (the 6693 native_replaced proof) and that record's latest
--      revision (ignoring revisions staged in the tenant) carries a snapshot.
-- With no stage in state 'staged' both depend only on committed rows. This migration stores exactly that answer:
--   * public.payroll_history_ineffective_payslip: the payslip ids that A or R hide with no stage in flight (usually few:
--     superseded imports and replaced native payslips). Readable by the application role within its tenant.
--   * app.payroll_history_ineffective_compute(tenant, ids): A and R set-wise for those payslips (all when NULL), the
--     6695 statements with the staged-row conditions removed.
--   * Maintenance attached to the inputs, not to each writer (section 5, revised by 11.5), and done once per writing
--     transaction, at its commit:
--       payslip: AFTER INSERT (statement, transition table), noting only inserted payslips that are imported snapshots
--         or belong to a run a history record captured (one index probe each otherwise); AFTER UPDATE OF batch_id,
--         employment_id (row, WHEN either changed). Money updates by processing, reprocessing and corrections fire
--         nothing. A deleted payslip leaves the set by its foreign key (ON DELETE CASCADE).
--       payroll_batch: AFTER UPDATE OF company_id, pay_period, payroll_cycle_id (row, WHEN changed), only for a run a
--         history record captured.
--       payroll_history_import_snapshot / _revision / _record and app.payroll_history_native_capture: AFTER INSERT,
--         UPDATE and DELETE (statement, transition tables).
--     Each trigger only appends what it touched (payslips, records, runs) to the transaction-local setting
--     app.payroll_history_pending; the first one in a transaction also inserts the transaction's row into
--     public.payroll_history_ineffective_commit, whose DEFERRABLE INITIALLY DEFERRED constraint trigger recomputes all
--     the noted payslips once, at commit, after locking each tenant's row in public.payroll_history_ineffective_state
--     (so two writers of one tenant cannot each miss the other's change). A rolled-back savepoint rolls back both its
--     notes and its rows. While a transaction has notes pending, the state below is NULL for it, so its own reads use
--     the legacy function and see its own writes exactly (the set is current again from its commit on).
--     The first build measured a history confirm at 12% upkeep with per-statement recompute; section 11.6 allows 2%.
--   * The restated piece calls app.payroll_history_effective_arm(id, state). The state is read once per statement:
--     NULL when the step does not serve the tenant (mode, or an untrusted tenant) or this transaction has notes
--     pending; otherwise a map of the tenant's stored payslip ids ('i') and of the payslips an in-progress stage
--     touches ('t', section 11.4: payslips staged directly, the snapshots of every record with a staged revision or
--     snapshot, and the native payslips captured for those records). The arm answers from the map: absent is
--     effective, 'i' is not, 't' runs the legacy function. No per-row table access.
--   * app.payroll_history_ineffective_verify(tenant) recomputes the whole set and compares it with the stored one; a
--     difference marks the tenant's step untrusted (reads use the legacy function) with counts only.
--     app.payroll_history_ineffective_rebuild(tenant) recomputes it; app.payroll_read_access_retrust then trusts it
--     only after a clean every-user comparison.
-- Planner view: the arm is a plain PL/pgSQL function with the cost (100), volatility and parallel safety of
-- app.payroll_history_effective, so payslip estimates do not move.
DO $payroll_read_p4_predecessor$
DECLARE r record;p pg_catalog.pg_proc%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.payroll_read_access_control WHERE step='p3_own_payslips') THEN
  RAISE EXCEPTION 'The 7480 payroll read step P3 is missing' USING ERRCODE='55000';
 END IF;
 FOR r IN SELECT * FROM (VALUES
  ('app.payroll_history_effective(uuid)','0b6f7d01e84d4d37145e3cf48564c5c2',true),
  ('app.payroll_history_effective_ids(uuid[])','9f768a50eb222bb2b2ab3140d0ee0616',false)) v(fn,body,definer) LOOP
  SELECT * INTO p FROM pg_catalog.pg_proc WHERE oid=to_regprocedure(r.fn);
  IF NOT FOUND OR md5(p.prosrc) IS DISTINCT FROM r.body OR p.prosecdef IS DISTINCT FROM r.definer OR p.provolatile<>'s' THEN
   RAISE EXCEPTION 'Unexpected % predecessor; review before storing it',r.fn USING ERRCODE='55000';
  END IF;
 END LOOP;
 SELECT * INTO p FROM pg_catalog.pg_proc WHERE oid=to_regprocedure('app.payroll_history_effective(uuid)');
 IF p.procost<>100 OR p.proparallel<>'u' THEN RAISE EXCEPTION 'Unexpected payroll_history_effective planner properties' USING ERRCODE='55000'; END IF;
 IF to_regclass('public.payroll_history_ineffective_payslip') IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.payroll_read_access_fragment WHERE table_name='payslip' AND policy_name='payroll_history_effective_only') THEN
  RAISE EXCEPTION 'Payroll read step P4 already exists' USING ERRCODE='55000';
 END IF;
END;
$payroll_read_p4_predecessor$;
--> statement-breakpoint
CREATE TABLE public.payroll_history_ineffective_payslip(
 payslip_id uuid PRIMARY KEY REFERENCES public.payslip(id) ON DELETE CASCADE,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
 reason text NOT NULL CHECK(reason IN ('superseded_snapshot','native_replaced'))
);
--> statement-breakpoint
CREATE INDEX payroll_history_ineffective_payslip_tenant_idx ON public.payroll_history_ineffective_payslip(tenant_id);
--> statement-breakpoint
CREATE TABLE public.payroll_history_ineffective_state(
 tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id) ON DELETE CASCADE,
 version bigint NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE public.payroll_history_ineffective_commit(
 txid bigint PRIMARY KEY
);
--> statement-breakpoint
ALTER TABLE public.payroll_history_ineffective_payslip ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_history_ineffective_payslip FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payroll_history_ineffective_payslip_owner ON public.payroll_history_ineffective_payslip FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
REVOKE ALL ON public.payroll_history_ineffective_payslip FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER TABLE public.payroll_history_ineffective_commit ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_history_ineffective_commit FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payroll_history_ineffective_commit_owner ON public.payroll_history_ineffective_commit FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
REVOKE ALL ON public.payroll_history_ineffective_commit FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER TABLE public.payroll_history_ineffective_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_history_ineffective_state FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payroll_history_ineffective_state_owner ON public.payroll_history_ineffective_state FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
REVOKE ALL ON public.payroll_history_ineffective_state FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- A and R of the header, set-wise, for the tenant's payslips among p_ids (all of them when NULL), with no stage in
-- flight: 6695's statements without their staged-row conditions.
CREATE FUNCTION app.payroll_history_ineffective_compute(p_tenant uuid,p_ids uuid[]) RETURNS TABLE(payslip_id uuid,reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 WITH cand AS MATERIALIZED(
  SELECT p.id,p.batch_id,p.employment_id FROM public.payslip p WHERE p.tenant_id=p_tenant AND (p_ids IS NULL OR p.id=ANY(p_ids))
 ), superseded AS MATERIALIZED(
  SELECT c.id FROM cand c JOIN public.payroll_history_import_snapshot s ON s.id=c.id AND s.tenant_id=p_tenant
  WHERE (SELECT r.snapshot_id FROM public.payroll_history_import_revision r WHERE r.record_id=s.record_id ORDER BY r.ordinal DESC LIMIT 1) IS DISTINCT FROM c.id
 ), native_candidates AS MATERIALIZED(
  SELECT p.id,cap.record_id FROM cand p
  JOIN public.payroll_batch original_batch ON original_batch.id=p.batch_id AND original_batch.tenant_id=p_tenant
  JOIN app.payroll_history_native_capture cap ON cap.source_batch_id=p.batch_id AND cap.tenant_id=p_tenant
  JOIN public.payroll_history_import_record identity ON identity.id=cap.record_id AND identity.tenant_id=cap.tenant_id AND identity.employment_id=p.employment_id
  JOIN public.payroll_history_import_revision adopted ON adopted.record_id=cap.record_id AND adopted.ordinal=1
   AND adopted.snapshot_id=cap.snapshot_id AND adopted.kind='adopted' AND adopted.native_source=app.payroll_history_native_proof(cap)
  WHERE original_batch.company_id=identity.company_id AND original_batch.pay_period=identity.period
   AND (original_batch.payroll_cycle_id IS NULL OR original_batch.payroll_cycle_id=identity.cycle_id)
 ), native_latest AS MATERIALIZED(
  SELECT DISTINCT ON(r.record_id) r.record_id,r.snapshot_id FROM public.payroll_history_import_revision r
  WHERE r.record_id IN (SELECT n.record_id FROM native_candidates n) ORDER BY r.record_id,r.ordinal DESC
 )
 SELECT s.id,'superseded_snapshot'::text FROM superseded s
 UNION ALL
 SELECT DISTINCT n.id,'native_replaced'::text FROM native_candidates n JOIN native_latest l ON l.record_id=n.record_id
 WHERE l.snapshot_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM superseded s WHERE s.id=n.id);
$$;
--> statement-breakpoint
-- The payslips whose answer a change to these history records can move: the records' snapshots and the payslips of
-- the runs captured for them.
CREATE FUNCTION app.payroll_history_ineffective_record_payslips(p_tenant uuid,p_records uuid[]) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(array_agg(DISTINCT q.id),'{}'::uuid[]) FROM (
  SELECT s.id FROM public.payroll_history_import_snapshot s WHERE s.tenant_id=p_tenant AND s.record_id=ANY(p_records)
  UNION ALL
  SELECT p.id FROM app.payroll_history_native_capture c JOIN public.payslip p ON p.batch_id=c.source_batch_id AND p.tenant_id=c.tenant_id
  WHERE c.tenant_id=p_tenant AND c.record_id=ANY(p_records)) q;
$$;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_ineffective_batch_payslips(p_tenant uuid,p_batches uuid[]) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(array_agg(p.id),'{}'::uuid[]) FROM public.payslip p WHERE p.tenant_id=p_tenant AND p.batch_id=ANY(p_batches);
$$;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_ineffective_refresh(p_tenant uuid,p_ids uuid[]) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_tenant IS NULL OR p_ids IS NULL OR cardinality(p_ids)=0 THEN RETURN; END IF;
 -- The tenant's row lock serialises maintainers within one tenant; the statements below run after it, so each sees
 -- what an earlier maintainer committed.
 INSERT INTO public.payroll_history_ineffective_state AS s(tenant_id,version) VALUES(p_tenant,1)
  ON CONFLICT(tenant_id) DO UPDATE SET version=s.version+1;
 DELETE FROM public.payroll_history_ineffective_payslip x WHERE x.tenant_id=p_tenant AND x.payslip_id=ANY(p_ids);
 INSERT INTO public.payroll_history_ineffective_payslip(payslip_id,tenant_id,reason)
  SELECT c.payslip_id,p_tenant,c.reason FROM app.payroll_history_ineffective_compute(p_tenant,p_ids) c;
END;
$$;
--> statement-breakpoint
-- Note touched keys for this transaction: lines 'tenant|kind|id' with kind p (payslip), r (record) or b (run). The
-- first note of a transaction also inserts its commit row, which fires the deferred recompute.
CREATE FUNCTION app.payroll_history_ineffective_note(p_lines text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pending text:=coalesce(current_setting('app.payroll_history_pending',true),'');
BEGIN
 IF p_lines IS NULL OR p_lines='' THEN RETURN; END IF;
 IF pending='' THEN
  INSERT INTO public.payroll_history_ineffective_commit(txid) VALUES(txid_current()) ON CONFLICT(txid) DO NOTHING;
  PERFORM set_config('app.payroll_history_pending',p_lines,true);
 ELSE
  PERFORM set_config('app.payroll_history_pending',pending||E'\n'||p_lines,true);
 END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_ineffective_payslip_inserted() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.payroll_history_ineffective_note((SELECT string_agg(n.tenant_id||'|p|'||n.id,E'\n') FROM new_rows n
  WHERE EXISTS(SELECT 1 FROM public.payroll_history_import_snapshot s WHERE s.id=n.id)
   OR EXISTS(SELECT 1 FROM app.payroll_history_native_capture c WHERE c.tenant_id=n.tenant_id AND c.source_batch_id=n.batch_id)));
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_ineffective_payslip_moved() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.payroll_history_ineffective_note(NEW.tenant_id||'|p|'||NEW.id);
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_ineffective_batch_moved() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM app.payroll_history_native_capture c WHERE c.tenant_id=NEW.tenant_id AND c.source_batch_id=NEW.id) THEN
  PERFORM app.payroll_history_ineffective_note(NEW.tenant_id||'|b|'||NEW.id);
 END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
-- History tables: snapshots note themselves; revisions, records and captures note their records; captures also their
-- captured runs.
CREATE FUNCTION app.payroll_history_ineffective_history_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_rows text;after_rows text;
BEGIN
 -- Static statements, one branch per table, so each trigger's plans are cached (a dynamic statement was re-planned on
 -- every call). PL/pgSQL compiles this function once per table, and a branch runs only for its own table and events.
 IF TG_TABLE_NAME='payroll_history_import_snapshot' THEN
  IF TG_OP<>'INSERT' THEN SELECT string_agg(x.tenant_id||'|p|'||x.id,E'\n') INTO before_rows FROM old_rows x; END IF;
  IF TG_OP<>'DELETE' THEN SELECT string_agg(x.tenant_id||'|p|'||x.id,E'\n') INTO after_rows FROM new_rows x; END IF;
 ELSIF TG_TABLE_NAME='payroll_history_import_revision' THEN
  IF TG_OP<>'INSERT' THEN SELECT string_agg(DISTINCT x.tenant_id||'|r|'||x.record_id,E'\n') INTO before_rows FROM old_rows x; END IF;
  IF TG_OP<>'DELETE' THEN SELECT string_agg(DISTINCT x.tenant_id||'|r|'||x.record_id,E'\n') INTO after_rows FROM new_rows x; END IF;
 ELSIF TG_TABLE_NAME='payroll_history_import_record' THEN
  IF TG_OP<>'INSERT' THEN SELECT string_agg(x.tenant_id||'|r|'||x.id,E'\n') INTO before_rows FROM old_rows x; END IF;
  IF TG_OP<>'DELETE' THEN SELECT string_agg(x.tenant_id||'|r|'||x.id,E'\n') INTO after_rows FROM new_rows x; END IF;
 ELSE
  IF TG_OP<>'INSERT' THEN SELECT string_agg(x.tenant_id||'|r|'||x.record_id||E'\n'||x.tenant_id||'|b|'||x.source_batch_id,E'\n') INTO before_rows FROM old_rows x; END IF;
  IF TG_OP<>'DELETE' THEN SELECT string_agg(x.tenant_id||'|r|'||x.record_id||E'\n'||x.tenant_id||'|b|'||x.source_batch_id,E'\n') INTO after_rows FROM new_rows x; END IF;
 END IF;
 PERFORM app.payroll_history_ineffective_note(concat_ws(E'\n',nullif(before_rows,''),nullif(after_rows,'')));
 RETURN NULL;
END;
$$;
--> statement-breakpoint
-- At commit (deferred): recompute every noted payslip once per tenant, then clear the notes and the commit row.
CREATE FUNCTION app.payroll_history_ineffective_commit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pending text:=coalesce(current_setting('app.payroll_history_pending',true),'');r record;
BEGIN
 IF pending<>'' THEN
  FOR r IN WITH note AS (SELECT split_part(x,'|',1)::uuid AS t,split_part(x,'|',2) AS k,split_part(x,'|',3)::uuid AS id
    FROM regexp_split_to_table(pending,E'\n') x WHERE x<>'')
   SELECT n.t,coalesce(array_agg(DISTINCT n.id) FILTER (WHERE n.k='p'),'{}') AS p,coalesce(array_agg(DISTINCT n.id) FILTER (WHERE n.k='r'),'{}') AS rec,
    coalesce(array_agg(DISTINCT n.id) FILTER (WHERE n.k='b'),'{}') AS runs FROM note n GROUP BY n.t ORDER BY n.t LOOP
   PERFORM app.payroll_history_ineffective_refresh(r.t,r.p||app.payroll_history_ineffective_record_payslips(r.t,r.rec)||app.payroll_history_ineffective_batch_payslips(r.t,r.runs));
  END LOOP;
  PERFORM set_config('app.payroll_history_pending','',true);
 END IF;
 DELETE FROM public.payroll_history_ineffective_commit c WHERE c.txid=txid_current();
 RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_ineffective_compute(uuid,uuid[]),app.payroll_history_ineffective_record_payslips(uuid,uuid[]),
 app.payroll_history_ineffective_batch_payslips(uuid,uuid[]),app.payroll_history_ineffective_refresh(uuid,uuid[]),app.payroll_history_ineffective_note(text),
 app.payroll_history_ineffective_payslip_inserted(),app.payroll_history_ineffective_payslip_moved(),app.payroll_history_ineffective_batch_moved(),
 app.payroll_history_ineffective_history_changed(),app.payroll_history_ineffective_commit() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payroll_history_ineffective_commit AFTER INSERT ON public.payroll_history_ineffective_commit
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.payroll_history_ineffective_commit();
--> statement-breakpoint
CREATE TRIGGER payroll_history_ineffective_inserted AFTER INSERT ON public.payslip REFERENCING NEW TABLE AS new_rows
 FOR EACH STATEMENT EXECUTE FUNCTION app.payroll_history_ineffective_payslip_inserted();
--> statement-breakpoint
CREATE TRIGGER payroll_history_ineffective_moved AFTER UPDATE OF batch_id,employment_id ON public.payslip
 FOR EACH ROW WHEN (OLD.batch_id IS DISTINCT FROM NEW.batch_id OR OLD.employment_id IS DISTINCT FROM NEW.employment_id)
 EXECUTE FUNCTION app.payroll_history_ineffective_payslip_moved();
--> statement-breakpoint
CREATE TRIGGER payroll_history_ineffective_batch_moved AFTER UPDATE OF company_id,pay_period,payroll_cycle_id ON public.payroll_batch
 FOR EACH ROW WHEN (OLD.company_id IS DISTINCT FROM NEW.company_id OR OLD.pay_period IS DISTINCT FROM NEW.pay_period OR OLD.payroll_cycle_id IS DISTINCT FROM NEW.payroll_cycle_id)
 EXECUTE FUNCTION app.payroll_history_ineffective_batch_moved();
--> statement-breakpoint
DO $payroll_read_p4_history_triggers$
DECLARE t text;ev text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.payroll_history_import_snapshot','public.payroll_history_import_revision','public.payroll_history_import_record','app.payroll_history_native_capture'] LOOP
  FOREACH ev IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
   EXECUTE format('CREATE TRIGGER %I AFTER %s ON %s REFERENCING %s FOR EACH STATEMENT EXECUTE FUNCTION app.payroll_history_ineffective_history_changed()',
    'payroll_history_ineffective_'||lower(ev),ev,t,
    CASE ev WHEN 'INSERT' THEN 'NEW TABLE AS new_rows' WHEN 'DELETE' THEN 'OLD TABLE AS old_rows' ELSE 'OLD TABLE AS old_rows NEW TABLE AS new_rows' END);
  END LOOP;
 END LOOP;
END;
$payroll_read_p4_history_triggers$;
--> statement-breakpoint
-- Once per statement: NULL while this transaction has maintenance notes pending; otherwise the tenant's stored payslips
-- ('i') overlaid by the payslips an in-progress stage touches ('t', section 11.4).
CREATE FUNCTION app.payroll_history_store_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();records uuid[];stored jsonb;
BEGIN
 IF coalesce(current_setting('app.payroll_history_pending',true),'')<>'' THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_object_agg(x.payslip_id::text,'i'),'{}'::jsonb) INTO stored FROM public.payroll_history_ineffective_payslip x WHERE x.tenant_id=t;
 IF NOT EXISTS(SELECT 1 FROM app.payroll_history_stage s WHERE s.state='staged') THEN RETURN stored; END IF;
 SELECT coalesce(array_agg(DISTINCT x.record_id),'{}'::uuid[]) INTO records FROM (
  SELECT v.record_id FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage s ON s.stage_id=sr.stage_id
   JOIN public.payroll_history_import_revision v ON v.id=sr.row_id
  WHERE s.state='staged' AND sr.relation='payroll_history_import_revision'
  UNION ALL
  SELECT n.record_id FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage s ON s.stage_id=sr.stage_id
   JOIN public.payroll_history_import_snapshot n ON n.id=sr.row_id
  WHERE s.state='staged' AND sr.relation='payroll_history_import_snapshot') x;
 RETURN stored||(SELECT coalesce(jsonb_object_agg(y.id::text,'t'),'{}'::jsonb) FROM (
  SELECT unnest(app.payroll_history_ineffective_record_payslips(t,records)) AS id
  UNION
  SELECT sr.row_id FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage s ON s.stage_id=sr.stage_id
  WHERE s.state='staged' AND sr.relation IN ('payslip','payroll_history_import_snapshot')) y);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_effective_arm(p_id uuid,p_state jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE COST 100 AS $$
DECLARE v text;
BEGIN
 IF p_state IS NULL OR p_id IS NULL THEN RETURN app.payroll_history_effective(p_id); END IF;
 v:=p_state->>p_id::text;
 IF v IS NULL THEN RETURN true; END IF;
 IF v='i' THEN RETURN false; END IF;
 RETURN app.payroll_history_effective(p_id);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_store_state(),app.payroll_history_effective_arm(uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
-- payroll_history_effective_only is TO ai_hr_app.
GRANT EXECUTE ON FUNCTION app.payroll_history_store_state(),app.payroll_history_effective_arm(uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
-- Operator only (section 8.3): recompute the tenant's whole set and compare; a difference marks the step untrusted.
CREATE FUNCTION app.payroll_history_ineffective_verify(p_tenant uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE missing bigint;extra bigint;
BEGIN
 SELECT count(*) INTO missing FROM (SELECT c.payslip_id,c.reason FROM app.payroll_history_ineffective_compute(p_tenant,NULL) c
  EXCEPT SELECT x.payslip_id,x.reason FROM public.payroll_history_ineffective_payslip x WHERE x.tenant_id=p_tenant) d;
 SELECT count(*) INTO extra FROM (SELECT x.payslip_id,x.reason FROM public.payroll_history_ineffective_payslip x WHERE x.tenant_id=p_tenant
  EXCEPT SELECT c.payslip_id,c.reason FROM app.payroll_history_ineffective_compute(p_tenant,NULL) c) d;
 IF missing+extra>0 THEN
  INSERT INTO public.payroll_read_access_tenant AS t(tenant_id,step,trusted,last_difference_count) VALUES(p_tenant,'p4_history_filter',false,missing+extra)
   ON CONFLICT(tenant_id,step) DO UPDATE SET trusted=false,last_difference_count=excluded.last_difference_count;
  RAISE LOG 'payroll_read_access verify step=p4_history_filter missing=% extra=%',missing,extra;
 END IF;
 RETURN jsonb_build_object('missing',missing,'extra',extra,
  'trusted',coalesce((SELECT t.trusted FROM public.payroll_read_access_tenant t WHERE t.tenant_id=p_tenant AND t.step='p4_history_filter'),true));
END;
$$;
--> statement-breakpoint
-- Operator only: recompute the tenant's whole set (trust is unchanged; app.payroll_read_access_retrust restores it).
CREATE FUNCTION app.payroll_history_ineffective_rebuild(p_tenant uuid) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n bigint;
BEGIN
 INSERT INTO public.payroll_history_ineffective_state AS s(tenant_id,version) VALUES(p_tenant,1)
  ON CONFLICT(tenant_id) DO UPDATE SET version=s.version+1;
 DELETE FROM public.payroll_history_ineffective_payslip x WHERE x.tenant_id=p_tenant;
 INSERT INTO public.payroll_history_ineffective_payslip(payslip_id,tenant_id,reason)
  SELECT c.payslip_id,p_tenant,c.reason FROM app.payroll_history_ineffective_compute(p_tenant,NULL) c;
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_ineffective_verify(uuid),app.payroll_history_ineffective_rebuild(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
INSERT INTO public.payroll_read_access_control(step,mode) VALUES('p4_history_filter','legacy');
--> statement-breakpoint
INSERT INTO public.payroll_read_access_fragment(table_name,policy_name,ordinal,step,legacy_text,restated_text,inputs) VALUES
 ('payslip','payroll_history_effective_only',1,'p4_history_filter',
  $q$app.payroll_history_effective(id)$q$,
  $q$app.payroll_history_effective_arm(id, (SELECT CASE WHEN app.payroll_read_access_on('p4_history_filter') THEN app.payroll_history_store_state() END))$q$,
  ARRAY['id']),
 ('payslip','payroll_history_effective_only',2,NULL,$q$ OR app.payroll_history_self_issued(id)$q$,NULL,NULL);
--> statement-breakpoint
DO $payroll_read_p4_policy$
BEGIN
 IF NOT app.payroll_read_access_installed_as('payslip','payroll_history_effective_only',app.payroll_read_access_policy_text('payslip','payroll_history_effective_only',NULL)) THEN
  RAISE EXCEPTION 'payroll_history_effective_only differs from the reviewed predecessor' USING ERRCODE='55000';
 END IF;
END;
$payroll_read_p4_policy$;
--> statement-breakpoint
-- Build every tenant's set once, as the owner, in this migration's transaction.
DO $payroll_read_p4_build$
DECLARE t uuid;
BEGIN
 FOR t IN SELECT x.id FROM public.tenant x ORDER BY 1 LOOP PERFORM app.payroll_history_ineffective_rebuild(t); END LOOP;
END;
$payroll_read_p4_build$;
