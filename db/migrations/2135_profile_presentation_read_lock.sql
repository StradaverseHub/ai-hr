-- Display-only profile policy reads overlap one another. Mutation owners retain the original
-- exclusive advisory locks and physical generation-row barrier, unchanged.
CREATE FUNCTION app.access_profile_policy_read_lock() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();
BEGIN
 IF t IS NULL OR current_setting('transaction_read_only')<>'on'
  OR current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Profile presentation requires a read-only Read Committed transaction' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('access-configuration:'||t::text,0));
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('profile-edit-policy:'||t::text,0));
 -- Read Committed refreshes after waiting for a writer. Readers never lock a physical tuple
 -- or upgrade to write; settings/grant writers still take the matching exclusive advisory keys.
 PERFORM 1 FROM app.access_profile_write_generation WHERE tenant_id=t;
 IF NOT FOUND THEN RAISE EXCEPTION 'Workforce policy generation unavailable' USING ERRCODE='42501'; END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_policy_read_lock() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_profile_policy_read_lock() TO ai_hr_app;
