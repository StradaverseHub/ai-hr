-- Reader/writer Access lock, wave 4 (admin, AI Centre and operator tools). Draft number: the
-- integration step renumbers it.
--
-- Maintenance, operator tools and rare governance actions still need the exclusive Access lock, but
-- they run while ordinary writers hold it shared all day. Neither existing way to ask for it works
-- under that traffic:
-- * a plain try (pg_try_advisory_xact_lock) fails whenever any shared writer is open, so under
--   continuous overlapping traffic it never succeeds and the work starves;
-- * an unbounded wait holds its place in the lock queue, and PostgreSQL then queues every later
--   shared request behind it for as long as the oldest shared holder runs, so one long holder stops
--   every clock-in in the tenant.
-- This waits in the queue for at most p_wait_ms. Later shared writers are delayed by at most that,
-- the current short holders drain, and the exclusive request is granted. When a long holder is still
-- running at the deadline it returns false instead of raising, so the caller backs off with nothing
-- held and tries again later. The wait runs in a subtransaction, so a timeout neither aborts the
-- caller's transaction nor leaves a partial lock; a granted lock is kept to commit as usual.
CREATE FUNCTION app.access_configuration_exclusive_wait(p_tenant uuid,p_wait_ms integer) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k bigint; saved text:=current_setting('lock_timeout'); bounded integer;
BEGIN
 IF p_tenant IS NULL OR p_wait_ms IS NULL OR p_wait_ms NOT BETWEEN 1 AND 5000 THEN
  RAISE EXCEPTION 'Access lock wait unavailable' USING ERRCODE='22023';
 END IF;
 -- A request site may only wait for its own tenant. Owner and maintenance sessions have no tenant.
 IF app.current_tenant_id() IS NOT NULL AND p_tenant IS DISTINCT FROM app.current_tenant_id() THEN
  RAISE EXCEPTION 'Access lock wait unavailable' USING ERRCODE='42501';
 END IF;
 -- A shared holder asking for exclusive would deadlock against another one doing the same.
 IF app.access_lock_mode_held(p_tenant)='S' THEN
  RAISE EXCEPTION 'Access lock: shared holder requested the exclusive lock' USING ERRCODE='AL001';
 END IF;
 k:=hashtextextended('access-configuration:'||p_tenant::text,0);
 IF pg_try_advisory_xact_lock(k) THEN RETURN true; END IF;
 -- Keep a tighter limit the caller already set; 0 means no limit.
 SELECT CASE WHEN setting::bigint=0 THEN p_wait_ms ELSE least(setting::bigint,p_wait_ms)::integer END INTO bounded
  FROM pg_catalog.pg_settings WHERE name='lock_timeout';
 PERFORM set_config('lock_timeout',bounded::text||'ms',true);
 BEGIN
  PERFORM pg_advisory_xact_lock(k);
 EXCEPTION WHEN lock_not_available THEN
  PERFORM set_config('lock_timeout',saved,true);
  RETURN false;
 END;
 PERFORM set_config('lock_timeout',saved,true);
 RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_configuration_exclusive_wait(uuid,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_configuration_exclusive_wait(uuid,integer) TO ai_hr_app;
