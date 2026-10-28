-- Claims provider source custody (N7).
-- Finite source footprint ONLY for claims triage and current-own claim status provider replay.
-- Actual source: claim status/type/item/amount/dates/redacted description, own employment membership
-- and native scope predicates. No receipt bytes, attachment content, policy math or new data grants.
-- Access -> shared global + exclusive tenant TRY custody -> exact native projection -> ai_admit COMMIT.
-- Native row DML takes shared tenant TRY custody even for hidden-row changes and membership phantoms.
-- Any partial/busy acquisition requires WHOLE Tx rollback. No lock spans provider latency.
-- Lock protocol (tenant key 'claims-provider-source-tenant-v1', global key 'claims-provider-source-global-v1'):
--  * Native writers (the BEFORE row triggers below) take the TENANT key SHARED with TRY, held to commit.
--    Shared holds are compatible, so two ordinary concurrent HR writes in one tenant never refuse each
--    other because of this footprint.
--  * The provider-source reader (claims_provider_source_read_hold_v1) takes the TENANT key EXCLUSIVE with
--    TRY and keeps it through ai_admit COMMIT, never through external transport. It refuses (55P03,
--    fail closed) while any uncommitted native write in that tenant holds the shared key; while it holds
--    the key every native write in that tenant refuses with 55P03 and must roll back its whole
--    transaction. Capture/write exclusion is therefore unchanged; only writer/writer exclusion is gone.
--    Two concurrent captures in one tenant now also exclude each other (the second refuses busy).
--  * Nobody waits for custody: writers can already hold native rows, so a wait could invert lock order.
--    A backend's own shared and exclusive holds never conflict, so one transaction may write and capture.
--  * TRUNCATE (privileged DDL) takes the GLOBAL key EXCLUSIVE; readers and row writers take it SHARED,
--    so independent tenants are never serialized.
-- TRUNCATE is privileged/native PostgreSQL DDL: its normal table locking is not bypassed or removed.
CREATE FUNCTION app.claims_provider_source_read_hold_v1() RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();
BEGIN
 IF tid IS NULL OR uid IS NULL OR current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Current Claims source could not be confirmed' USING ERRCODE='42501';
 END IF;
 IF NOT pg_try_advisory_xact_lock_shared(hashtext('claims-provider-source-global-v1'),0) THEN
  RAISE EXCEPTION 'Claims source is busy' USING ERRCODE='55P03';
 END IF;
 -- EXCLUSIVE tenant custody: refuses while any native writer in this tenant is uncommitted.
 IF NOT pg_try_advisory_xact_lock(hashtext('claims-provider-source-tenant-v1'),hashtext(tid::text)) THEN
  RAISE EXCEPTION 'Claims source is busy' USING ERRCODE='55P03';
 END IF;
 -- Recheck the actual login AFTER ownership. This is still no subject/role/data grant: every
 -- canonical supplied-Tx owner must freshly enforce its own RLS, assignment and field projection.
 IF NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.tenant_id=tid AND u.id=uid
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) OR app.principal_snapshot_current() IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Current Claims source could not be confirmed' USING ERRCODE='42501';
 END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claims_provider_source_read_hold_v1() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.claims_provider_source_read_hold_v1() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.claims_provider_source_write_guard_v1() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tid uuid;subjects uuid[];
BEGIN
 IF TG_OP='TRUNCATE' THEN
  IF NOT pg_try_advisory_xact_lock(hashtext('claims-provider-source-global-v1'),0) THEN
   RAISE EXCEPTION 'Claims source is busy' USING ERRCODE='55P03';
  END IF;
  RETURN NULL;
 END IF;
 IF NOT pg_try_advisory_xact_lock_shared(hashtext('claims-provider-source-global-v1'),0) THEN
  RAISE EXCEPTION 'Claims source is busy' USING ERRCODE='55P03';
 END IF;
 subjects:=CASE TG_OP WHEN 'INSERT' THEN ARRAY[NEW.tenant_id] WHEN 'DELETE' THEN ARRAY[OLD.tenant_id]
   ELSE ARRAY[OLD.tenant_id,NEW.tenant_id] END;
 FOR tid IN SELECT DISTINCT id FROM unnest(subjects) ids(id) WHERE id IS NOT NULL ORDER BY id LOOP
  -- SHARED tenant custody: concurrent native writers coexist; only a holding reader refuses them.
  IF NOT pg_try_advisory_xact_lock_shared(hashtext('claims-provider-source-tenant-v1'),hashtext(tid::text)) THEN
   RAISE EXCEPTION 'Claims source is busy' USING ERRCODE='55P03';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claims_provider_source_write_guard_v1() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Explicit reviewed footprint. Installation must fail if a named relation/tenant column is absent;
-- never silently skip a missing owner and pretend it participates. Cross-tenant moves protect both
-- actual OLD/NEW tenant IDs. Foreign-key cascades and definer mutations fire the same native guards.
DO $$
DECLARE relation_name text;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY[
  'app_user','role_assignment','person','employment','assignment','reporting_line','company',
  'claim_request','claim_type','claim_item'
 ] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=format('public.%I',relation_name)::regclass
    AND attname='tenant_id' AND NOT attisdropped) THEN RAISE EXCEPTION 'Missing Claims source tenant binding';END IF;
  EXECUTE format('CREATE TRIGGER claims_provider_source_row_v1 BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.claims_provider_source_write_guard_v1()',relation_name);
  EXECUTE format('CREATE TRIGGER claims_provider_source_truncate_v1 BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION app.claims_provider_source_write_guard_v1()',relation_name);
 END LOOP;
END $$;
