-- Audit chain sealed at commit (phase 0): a tenant's chain position is taken at the last moment of the
-- transaction, under the same audit-chain advisory key, for only as long as the seal itself. A long
-- transaction that writes one audit event no longer blocks every other audited write of that tenant
-- (login, MFA, logout, idle expiry, clock-in) until it commits. "Committed" still means "chained":
-- the seal is a deferred constraint trigger, so a failed seal aborts the commit.
--
-- Unchanged: app.domain_event_hash, the chain columns, verifyTenantChain, app._domain_event_next and
-- every caller of it. A transaction that already owns the audit-chain key (the Assistant bank and
-- catalogue frames, the MFA admission path, a tenant's first armed write) keeps immediate assignment
-- exactly as before, so its preimage and position fences see the same values. The onboarding, lifecycle,
-- probation, contract and draft-discard writers stop taking the key (see the end of this file).
--
-- The tables are private: no grants, RLS enabled with no policy, reached only through SECURITY DEFINER
-- trigger functions owned by the native audit owner.
--
-- SET CONSTRAINTS ALL IMMEDIATE fires the seal at the end of the statement instead of at commit. The
-- transaction then holds the chain key until it commits, as every audited transaction did before.
CREATE TABLE app.domain_event_chain_pending (
 event_id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 sequence bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX domain_event_chain_pending_order ON app.domain_event_chain_pending (tenant_id,sequence);
--> statement-breakpoint
-- One row per tenant per transaction with work to seal. Inserted at commit by the arm trigger, so its
-- own deferred trigger is queued after every deferred trigger already pending in the transaction.
CREATE TABLE app.domain_event_chain_seal (
 xid xid8 NOT NULL,
 tenant_id uuid NOT NULL,
 sealing boolean NOT NULL DEFAULT false,
 PRIMARY KEY (xid,tenant_id)
);
--> statement-breakpoint
ALTER TABLE app.domain_event_chain_pending ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.domain_event_chain_seal ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON app.domain_event_chain_pending, app.domain_event_chain_seal FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- Does this transaction already own the tenant's audit-chain key, by any route? pg_locks stores a
-- single-bigint advisory key as classid = high 32 bits, objid = low 32 bits, objsubid = 1, and
-- hashtext can be negative, so the int4 sign-extends into the high word.
CREATE FUNCTION app._domain_event_chain_key_held(p_tenant uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE k bigint:=hashtext('audit-chain:'||p_tenant::text);
BEGIN
 RETURN EXISTS(SELECT 1 FROM pg_catalog.pg_locks l
  WHERE l.locktype='advisory' AND l.pid=pg_backend_pid() AND l.granted AND l.objsubid=1
   AND l.database=(SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname=current_database())
   AND l.classid::bigint=((k>>32)&4294967295) AND l.objid::bigint=(k&4294967295));
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._domain_event_chain_key_held(uuid) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- True only while this transaction's seal is writing the chain columns. Unforgeable: the row is written
-- only by the seal function, and no caller role can touch the table.
CREATE FUNCTION app.domain_event_chain_sealing() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
 -- Evaluated per row per fence trigger during a seal, so it keeps a cached plan and no SET clause; every name
 -- and operator is schema-qualified instead.
 RETURN EXISTS(SELECT 1 FROM app.domain_event_chain_seal s
  WHERE s.xid OPERATOR(pg_catalog.=) pg_catalog.pg_current_xact_id_if_assigned() AND s.sealing);
END $$;
--> statement-breakpoint
-- Evaluated by the domain_event fence triggers' WHEN clause, under whichever role fired them.
REVOKE ALL ON FUNCTION app.domain_event_chain_sealing() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.domain_event_chain_sealing() TO PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.domain_event_chain_arm() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 INSERT INTO app.domain_event_chain_seal(xid,tenant_id) VALUES(pg_current_xact_id(),NEW.tenant_id)
  ON CONFLICT (xid,tenant_id) DO NOTHING;
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.domain_event_chain_arm() FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- One tenant's seal: under the key, chain this transaction's pending events onto the head in sequence
-- order, then clear them. Used at commit by the seal trigger and, earlier, by domain_event_chain_flush.
CREATE FUNCTION app._domain_event_chain_seal_tenant(p_tenant uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r record;s bigint;h text;armed boolean;n integer:=0;
 ids uuid[]:='{}';seqs bigint[]:='{}';prevs text[]:='{}';hashes text[]:='{}';
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('audit-chain:'||p_tenant::text));
 -- This transaction's still-pending rows are not the chain head, even if a caller supplied slot values.
 SELECT e.chain_seq,e.hash INTO s,h FROM public.domain_event e
  WHERE e.tenant_id=p_tenant AND e.chain_seq IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM app.domain_event_chain_pending p WHERE p.event_id=e.id)
  ORDER BY e.chain_seq DESC LIMIT 1;
 armed:=current_setting('app.audit_hash_chain',true) IS NOT DISTINCT FROM 'on' OR s IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.tenant_setting t WHERE t.tenant_id=p_tenant AND t.key='audit.hash_chain_enabled' AND t.value='true'::jsonb);
 IF armed THEN
  s:=coalesce(s,0);h:=coalesce(h,'GENESIS');
  FOR r IN SELECT e.id,e.tenant_id,e.aggregate_type,e.aggregate_id,e.event_type,e.actor_type,e.actor_id,e.subject_employment_id,e.payload
   FROM app.domain_event_chain_pending p JOIN public.domain_event e ON e.id=p.event_id
   WHERE p.tenant_id=p_tenant ORDER BY p.sequence LOOP
   s:=s+1;ids:=ids||r.id;seqs:=seqs||s;prevs:=prevs||h;
   h:=app.domain_event_hash(h,r.tenant_id,s,r.aggregate_type,r.aggregate_id,r.event_type,r.actor_type::text,r.actor_id,r.subject_employment_id,r.payload);
   hashes:=hashes||h;n:=n+1;
  END LOOP;
  IF n>0 THEN
   -- One UPDATE for the whole transaction: the fence triggers see the sealing marker and stand aside.
   INSERT INTO app.domain_event_chain_seal(xid,tenant_id,sealing) VALUES(pg_current_xact_id(),p_tenant,true)
    ON CONFLICT (xid,tenant_id) DO UPDATE SET sealing=true;
   UPDATE public.domain_event d SET chain_seq=u.seq,prev_hash=u.prev,hash=u.hash
    FROM unnest(ids,seqs,prevs,hashes) u(id,seq,prev,hash) WHERE d.id=u.id;
  END IF;
 END IF;
 DELETE FROM app.domain_event_chain_pending WHERE tenant_id=p_tenant;
 DELETE FROM app.domain_event_chain_seal WHERE xid=pg_current_xact_id() AND tenant_id=p_tenant;
 RETURN n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._domain_event_chain_seal_tenant(uuid) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.domain_event_chain_seal_now() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._domain_event_chain_seal_tenant(NEW.tenant_id);
 RETURN NULL;
END $$;
--> statement-breakpoint
-- For a reader that needs its own transaction's chain columns before commit. A no-op, taking no key,
-- unless this transaction has pending events for the tenant; otherwise it seals them now and then holds
-- the key to commit, exactly as an audited transaction did before this migration.
CREATE FUNCTION app.domain_event_chain_flush(p_tenant uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.domain_event_chain_pending p WHERE p.tenant_id=p_tenant) THEN RETURN 0;END IF;
 RETURN app._domain_event_chain_seal_tenant(p_tenant);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.domain_event_chain_flush(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.domain_event_chain_flush(uuid) TO ai_hr_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.domain_event_chain_seal_now() FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER domain_event_chain_arm AFTER INSERT ON app.domain_event_chain_pending
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.domain_event_chain_arm();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER domain_event_chain_seal_now AFTER INSERT ON app.domain_event_chain_seal
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.domain_event_chain_seal_now();
--> statement-breakpoint
-- Same native owner as the rest of the audit chain, whichever role runs this migration.
DO $audit_owner$
DECLARE native_owner name;
BEGIN
 SELECT r.rolname INTO STRICT native_owner FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='app.domain_event_chain_tg()'::regprocedure;
 EXECUTE format('ALTER TABLE app.domain_event_chain_pending OWNER TO %I',native_owner);
 EXECUTE format('ALTER TABLE app.domain_event_chain_seal OWNER TO %I',native_owner);
 EXECUTE format('ALTER FUNCTION app._domain_event_chain_key_held(uuid) OWNER TO %I',native_owner);
 EXECUTE format('ALTER FUNCTION app.domain_event_chain_sealing() OWNER TO %I',native_owner);
 EXECUTE format('ALTER FUNCTION app.domain_event_chain_arm() OWNER TO %I',native_owner);
 EXECUTE format('ALTER FUNCTION app.domain_event_chain_seal_now() OWNER TO %I',native_owner);
 EXECUTE format('ALTER FUNCTION app._domain_event_chain_seal_tenant(uuid) OWNER TO %I',native_owner);
 EXECUTE format('ALTER FUNCTION app.domain_event_chain_flush(uuid) OWNER TO %I',native_owner);
END $audit_owner$;
--> statement-breakpoint
-- Append replacement only: 0534, 0863 and 0864 stay byte-identical. The frame guards run first and
-- unchanged. The no-chain-head branch keeps the 0534 first-arming serialization for armed writers; an
-- unarmed writer takes no key and is decided at its seal, under the key. A REPEATABLE READ or SERIALIZABLE
-- writer keeps the immediate path: a seal under its old snapshot would read a stale chain head.
CREATE OR REPLACE FUNCTION app.domain_event_chain_tg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pre jsonb;head bigint;
BEGIN
 PERFORM app._bank_audit_owner_frame_guard();
 PERFORM app._assistant_catalogue_audit_owner_frame_guard();
 IF current_setting('transaction_isolation')='read committed' AND NOT app._domain_event_chain_key_held(NEW.tenant_id) THEN
  SELECT chain_seq INTO head FROM public.domain_event
   WHERE tenant_id=NEW.tenant_id AND chain_seq IS NOT NULL ORDER BY chain_seq DESC LIMIT 1;
  IF head IS NOT NULL THEN
   NEW.chain_seq:=NULL;NEW.prev_hash:=NULL;NEW.hash:=NULL;
   INSERT INTO app.domain_event_chain_pending(event_id,tenant_id,sequence) VALUES(NEW.id,NEW.tenant_id,NEW.sequence);
   RETURN NEW;
  END IF;
  IF current_setting('app.audit_hash_chain',true) IS DISTINCT FROM 'on'
   AND NOT EXISTS(SELECT 1 FROM public.tenant_setting WHERE tenant_id=NEW.tenant_id AND key='audit.hash_chain_enabled' AND value='true'::jsonb) THEN
   INSERT INTO app.domain_event_chain_pending(event_id,tenant_id,sequence) VALUES(NEW.id,NEW.tenant_id,NEW.sequence);
   RETURN NEW;
  END IF;
 END IF;
 pre:=app._domain_event_next(NEW.tenant_id);
 IF NOT (pre->>'armed')::boolean THEN RETURN NEW;END IF;
 NEW.chain_seq:=coalesce((pre->>'priorSeq')::bigint,0)+1;
 NEW.prev_hash:=coalesce(pre->>'priorHash','GENESIS');
 NEW.hash:=app.domain_event_hash(NEW.prev_hash,NEW.tenant_id,NEW.chain_seq,NEW.aggregate_type,
  NEW.aggregate_id,NEW.event_type,NEW.actor_type::text,NEW.actor_id,NEW.subject_employment_id,NEW.payload);
 RETURN NEW;
END $$;
--> statement-breakpoint
-- The onboarding, lifecycle, probation, contract and draft-discard writers took the audit-chain key first
-- only to match the insert trigger's lock order (d839ff30). The trigger no longer takes it, so holding it
-- would now make them the long key holders that block every seal, and a key holder waiting on a row lock
-- of a sealing transaction is a deadlock. Each body loses exactly that one acquisition; the onboarding and
-- lifecycle keys that follow keep these writers serialized among themselves. Everything else is unchanged.
DO $holders$
DECLARE
 edit record;
 def text;
BEGIN
 FOR edit IN SELECT * FROM (VALUES
  ('app.onboarding_v9_save_case_values(uuid,integer,jsonb)',
   E' PERFORM pg_advisory_xact_lock(hashtext(''audit-chain:''||app.current_tenant_id()::text));\n',''),
  ('app.onboarding_v9_receipt(uuid,integer,text,text,text)',
   E' PERFORM pg_advisory_xact_lock(hashtext(''audit-chain:'' || app.current_tenant_id()::text));\n',''),
  ('app.lc_v9_report_return(uuid,integer,text,text)',
   E' PERFORM pg_advisory_xact_lock(hashtext(''audit-chain:'' || app.current_tenant_id()::text));\n',''),
  ('app.lc_v9_assigned_item(uuid,integer,text)',
   E' PERFORM pg_advisory_xact_lock(hashtext(''audit-chain:'' || app.current_tenant_id()::text));\n',''),
  ('app.onboarding_draft_discard_absence_context(uuid,uuid,uuid)',
   E' -- Exactly audit-chain -> onboarding, as lockOnboardingTx and persisted audit-chain trigger.\n IF NOT pg_try_advisory_xact_lock(hashtext(''audit-chain:''||t::uuid::text)) THEN\n  RAISE EXCEPTION ''Draft discard unavailable'' USING ERRCODE=''42501'';END IF;\n',
   E' -- The onboarding key first, as lockOnboardingTx. The audit chain is sealed at commit.\n'),
  ('app.probation_offboarding_intent(uuid)',
   E' IF NOT pg_try_advisory_xact_lock(hashtext(''audit-chain:''||app.current_tenant_id()::text)) THEN RAISE EXCEPTION ''Offboarding audit writer is busy'' USING ERRCODE=''55P03'';END IF;\n',''),
  ('app.contract_lock_authority_sources()',
   E'IF NOT pg_try_advisory_xact_lock(hashtext(''audit-chain:''||app.current_tenant_id()::text)) OR NOT pg_try_advisory_xact_lock(hashtextextended(',
   E'IF NOT pg_try_advisory_xact_lock(hashtextextended(')
 ) v(signature,old_text,new_text) LOOP
  def:=pg_get_functiondef(edit.signature::regprocedure);
  IF (length(def)-length(replace(def,edit.old_text,'')))/length(edit.old_text)<>1 OR position('audit-chain' IN replace(def,edit.old_text,edit.new_text))<>0 THEN
   RAISE EXCEPTION 'Unexpected audit-chain acquisition in %',edit.signature USING ERRCODE='55000';
  END IF;
  EXECUTE replace(def,edit.old_text,edit.new_text);
 END LOOP;
END $holders$;
--> statement-breakpoint
-- The only lock on a populated table: CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE on domain_event, which
-- blocks event writes (not reads) until the whole migration batch commits. It is the last statement here and this
-- should be the last migration of its batch. The wait for it is bounded, so a busy table fails the batch instead
-- of queueing writers, and the caller's lock_timeout is restored afterwards.
DO $seal_lock_timeout$ BEGIN
 PERFORM set_config('aihr.audit_chain_seal_lock_timeout',current_setting('lock_timeout'),true);
 PERFORM set_config('lock_timeout','5s',true);
END $seal_lock_timeout$;
--> statement-breakpoint
-- The seal fills three NULL chain columns on rows this transaction just inserted. It is not an edit of
-- a completed record, so the completed-root fences must not refuse it. Function bodies stay byte-identical; each trigger
-- gains one WHEN. pg_trigger_depth() = 0 short-circuits ordinary top-level writes past the function call.
DO $fences$
DECLARE
 expected text[]:=ARRAY[
  'assistant_attendance_root_effect','assistant_attendance_root_effect_after','assistant_case_cancel_root_fence',
  'assistant_case_cancel_root_fence_after','assistant_catalogue_audit_dependency_after','assistant_catalogue_event_root_after',
  'assistant_rewards_return_sealed','assistant_step_root_fence','assistant_step_root_fence_after','bank_audit_dependency_fence_after',
  'bank_completed_event_fence','bank_completed_event_fence_after','contract_event_custody_guard',
  'domain_event_native_catalogue_audit_dependency_before','native_bank_audit_dependency_fence','payroll_completion_after',
  'payroll_completion_before','payroll_reset_transition','people_general_event_root_fence','performance_completed_event_after',
  'performance_completed_event_fence'];
 found text[];
 t record;
 def text;
BEGIN
 SELECT array_agg(tgname::text ORDER BY tgname::text) INTO found FROM pg_trigger
  WHERE tgrelid='public.domain_event'::regclass AND NOT tgisinternal AND (tgtype & 16)<>0;
 IF found IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(expected) x) THEN
  RAISE EXCEPTION 'domain_event UPDATE triggers differ from the reviewed set: %',found USING ERRCODE='55000';
 END IF;
 FOR t IN SELECT oid,tgname,tgqual FROM pg_trigger WHERE tgrelid='public.domain_event'::regclass AND tgname::text=ANY(expected) ORDER BY tgname LOOP
  IF t.tgqual IS NOT NULL THEN RAISE EXCEPTION 'Trigger % already has a WHEN clause',t.tgname USING ERRCODE='55000';END IF;
  def:=pg_get_triggerdef(t.oid);
  IF def NOT LIKE 'CREATE TRIGGER %' OR position(' FOR EACH ROW EXECUTE ' IN def)=0 THEN
   RAISE EXCEPTION 'Unexpected definition for trigger %',t.tgname USING ERRCODE='55000';
  END IF;
  EXECUTE replace(regexp_replace(def,'^CREATE TRIGGER','CREATE OR REPLACE TRIGGER'),
   ' FOR EACH ROW EXECUTE ',' FOR EACH ROW WHEN (pg_trigger_depth() = 0 OR NOT app.domain_event_chain_sealing()) EXECUTE ');
 END LOOP;
END $fences$;
--> statement-breakpoint
DO $seal_lock_timeout$ BEGIN
 PERFORM set_config('lock_timeout',current_setting('aihr.audit_chain_seal_lock_timeout'),true);
END $seal_lock_timeout$;
