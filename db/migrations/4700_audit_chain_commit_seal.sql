-- Audit chain sealed at commit (phase 0): a tenant's chain position is taken at the last moment of the
-- transaction, under the same audit-chain advisory key, for only as long as the seal itself. A long
-- transaction that writes one audit event no longer blocks every other audited write of that tenant
-- (login, MFA, logout, idle expiry, clock-in) until it commits. "Committed" still means "chained":
-- the seal is a deferred constraint trigger, so a failed seal aborts the commit.
--
-- Unchanged: app.domain_event_hash, the chain columns, verifyTenantChain, app._domain_event_next and
-- every caller of it. A transaction that already owns the audit-chain key (the Assistant bank and
-- catalogue frames, onboarding and lifecycle services, the MFA admission path, a genesis write) keeps
-- immediate assignment exactly as before, so its preimage and position fences see the same values.
--
-- The tables are private: no grants, RLS enabled with no policy, reached only through SECURITY DEFINER
-- trigger functions owned by the native audit owner.
--
-- SET CONSTRAINTS ALL IMMEDIATE fires the seal at the end of the statement instead of at commit. The
-- transaction then holds the chain key until it commits, as every audited transaction did before.
DO $m4700$ BEGIN
 PERFORM set_config('aihr.m4700_lock_timeout',current_setting('lock_timeout'),true);
 PERFORM set_config('lock_timeout','5s',true);
END $m4700$;
--> statement-breakpoint
LOCK TABLE public.domain_event IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
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
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.domain_event_chain_seal s
  WHERE s.xid=pg_current_xact_id_if_assigned() AND s.sealing);
$$;
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
CREATE FUNCTION app.domain_event_chain_seal_now() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r public.domain_event%ROWTYPE;s bigint;h text;armed boolean;next_hash text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('audit-chain:'||NEW.tenant_id::text));
 -- This transaction's still-pending rows are not the chain head, even if a caller supplied slot values.
 SELECT e.chain_seq,e.hash INTO s,h FROM public.domain_event e
  WHERE e.tenant_id=NEW.tenant_id AND e.chain_seq IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM app.domain_event_chain_pending p WHERE p.event_id=e.id)
  ORDER BY e.chain_seq DESC LIMIT 1;
 armed:=current_setting('app.audit_hash_chain',true) IS NOT DISTINCT FROM 'on' OR s IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.tenant_setting t WHERE t.tenant_id=NEW.tenant_id AND t.key='audit.hash_chain_enabled' AND t.value='true'::jsonb);
 IF armed THEN
  s:=coalesce(s,0);h:=coalesce(h,'GENESIS');
  UPDATE app.domain_event_chain_seal SET sealing=true WHERE xid=NEW.xid AND tenant_id=NEW.tenant_id;
  FOR r IN SELECT e.* FROM app.domain_event_chain_pending p JOIN public.domain_event e ON e.id=p.event_id
   WHERE p.tenant_id=NEW.tenant_id ORDER BY p.sequence LOOP
   s:=s+1;
   next_hash:=app.domain_event_hash(h,r.tenant_id,s,r.aggregate_type,r.aggregate_id,r.event_type,r.actor_type::text,r.actor_id,r.subject_employment_id,r.payload);
   UPDATE public.domain_event SET chain_seq=s,prev_hash=h,hash=next_hash WHERE id=r.id;
   h:=next_hash;
  END LOOP;
 END IF;
 DELETE FROM app.domain_event_chain_pending WHERE tenant_id=NEW.tenant_id;
 DELETE FROM app.domain_event_chain_seal WHERE xid=NEW.xid AND tenant_id=NEW.tenant_id;
 RETURN NULL;
END $$;
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
DO $m4700$ BEGIN
 PERFORM set_config('lock_timeout',current_setting('aihr.m4700_lock_timeout'),true);
END $m4700$;
