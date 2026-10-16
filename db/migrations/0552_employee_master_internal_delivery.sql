-- Managed report internal-mode nonce context and immutable artifact start binding.
-- Board 8bade99d798f29e7e086a97633e77e683615fa04 / 0549 unchanged at inspection.
-- Auth accepted 55005531: 0543_embedded_authentication.sql. e5 explicit-Tx leaves are a
-- separately reviewed application prerequisite, not SQL authority supplied here.
-- Reserved 0552 / idx552 / when1791900000032; journal remains parent-owned.
-- Existing migration owner creates these definers, as in0543/0549. No role, Auth
-- ciphertext accessor, generic record-key parameter, sender grant or queue is added.
-- Requires the accepted0543 Auth union; no fallback Auth schema or substitute owner is created.
DO $$ BEGIN
 IF to_regclass('public.app_internal_auth_record') IS NULL
  OR to_regprocedure('app.internal_auth_read(text,boolean)') IS NULL THEN
  RAISE EXCEPTION 'Accepted embedded authentication migration0543 is required';
 END IF;
END $$;

--> statement-breakpoint
ALTER TABLE public.custom_report_occurrence
 ADD COLUMN artifact_sha256 text,
 ADD COLUMN artifact_byte_length integer,
 ADD COLUMN artifact_content_type text;

--> statement-breakpoint
ALTER TABLE public.custom_report_occurrence ADD CONSTRAINT custom_report_artifact_complete CHECK (
 num_nonnulls(artifact_sha256,artifact_byte_length,artifact_content_type)=0 OR
 (num_nonnulls(artifact_sha256,artifact_byte_length,artifact_content_type)=3
  AND artifact_sha256 ~ '^[a-f0-9]{64}$'
  AND artifact_byte_length BETWEEN 1 AND 20000000
  AND artifact_content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
);

-- Exact DTO validation; CASE protects the cast of untrusted JSON. No path/bytes/name.
--> statement-breakpoint
CREATE FUNCTION identity_email.report_artifact_valid(p_artifact jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(p_artifact)='object'
  AND p_artifact ?& ARRAY['sha256','byteLength','contentType']
  AND p_artifact-ARRAY['sha256','byteLength','contentType']='{}'::jsonb
  AND jsonb_typeof(p_artifact->'sha256')='string'
  AND p_artifact->>'sha256' ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof(p_artifact->'contentType')='string'
  AND p_artifact->>'contentType'='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  AND jsonb_typeof(p_artifact->'byteLength')='number'
  AND p_artifact->>'byteLength' ~ '^[1-9][0-9]{0,7}$'
 THEN (p_artifact->>'byteLength')::integer BETWEEN 1 AND 20000000 ELSE false END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION identity_email.report_artifact_valid(jsonb) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.custom_report_artifact_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF num_nonnulls(NEW.artifact_sha256,NEW.artifact_byte_length,NEW.artifact_content_type)<>0 THEN
   RAISE EXCEPTION 'Artifact may only be pinned at delivery start';
  END IF;
 ELSIF ROW(NEW.artifact_sha256,NEW.artifact_byte_length,NEW.artifact_content_type)
   IS DISTINCT FROM ROW(OLD.artifact_sha256,OLD.artifact_byte_length,OLD.artifact_content_type) THEN
  IF num_nonnulls(OLD.artifact_sha256,OLD.artifact_byte_length,OLD.artifact_content_type)<>0
   OR OLD.status<>'pending' OR OLD.started_at IS NOT NULL OR NEW.status<>'started'
   OR NEW.started_at IS NULL
   OR num_nonnulls(NEW.artifact_sha256,NEW.artifact_byte_length,NEW.artifact_content_type)<>3 THEN
   RAISE EXCEPTION 'Pinned delivery artifact is immutable';
  END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.custom_report_artifact_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER custom_report_artifact_guard BEFORE INSERT OR UPDATE ON public.custom_report_occurrence
 FOR EACH ROW EXECUTE FUNCTION app.custom_report_artifact_guard();
-- Preserve0549's column-only SELECT: never restore table-wide nonce visibility.
--> statement-breakpoint
GRANT SELECT(artifact_sha256,artifact_byte_length,artifact_content_type)
 ON public.custom_report_occurrence TO ai_hr_app;

-- Private nonce-derived context. Installed code must first validate origin using canonical
-- internalConfig(); this SQL is only a lexical bound, not a competing URL parser/config owner.
-- Eligibility still requires an existing exact issuer binding. No email auto-link.
--> statement-breakpoint
CREATE FUNCTION identity_email.internal_report_context(p_id uuid,p_token uuid,p_origin text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.custom_report_occurrence;target jsonb;v_issuer text;
 owner_binding public.app_external_identity;recipient_binding public.app_external_identity;
 owner_count integer;owner_subject text;bindings jsonb;
BEGIN
 IF p_origin IS NULL OR length(p_origin) NOT BETWEEN 9 AND 458
  OR p_origin !~ '^https://[^/?#[:space:]@]+$' THEN RETURN NULL;END IF;
 SELECT * INTO job FROM public.custom_report_occurrence o
 WHERE o.id=p_id AND o.lease_token=p_token AND o.status='pending' AND o.started_at IS NULL
  AND o.lease_until>clock_timestamp();
 IF NOT FOUND THEN RETURN NULL;END IF;
 v_issuer:=p_origin||'/auth/'||job.tenant_id::text;
 target:=identity_email.report_target(p_id,p_token,v_issuer);
 IF target IS NULL OR jsonb_array_length(target->'ownerGrants')>1000
  OR jsonb_array_length(target->'recipientGrants')>1000 THEN RETURN NULL;END IF;
 -- Owner must have one selected active internal identity; recipient is the EXACT opt-in
 -- identity already selected by report_target. Multiple recipient identities do not pick an email.
 SELECT count(*),min(b.subject) INTO owner_count,owner_subject FROM (
  SELECT i.subject FROM public.app_external_identity i WHERE i.app_user_id=job.owner_user_id
   AND i.issuer=v_issuer AND i.revoked_at IS NULL ORDER BY i.subject LIMIT 2
 ) b;
 IF owner_count<>1 THEN RETURN NULL;END IF;
 SELECT * INTO owner_binding FROM public.app_external_identity i
 WHERE i.app_user_id=job.owner_user_id AND i.issuer=v_issuer AND i.subject=owner_subject AND i.revoked_at IS NULL;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO recipient_binding FROM public.app_external_identity i
 WHERE i.app_user_id=job.recipient_user_id AND i.issuer=v_issuer
  AND i.subject=target->>'subject' AND i.revoked_at IS NULL;
 IF NOT FOUND OR owner_binding.subject !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR recipient_binding.subject !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 THEN RETURN NULL;END IF;
 bindings:=jsonb_build_object(
  'owner',jsonb_build_object('issuer',v_issuer,'subject',owner_binding.subject,'userId',owner_binding.app_user_id,
   'personId',target->'ownerPersonId','createdAt',to_char(owner_binding.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
  'recipient',jsonb_build_object('issuer',v_issuer,'subject',recipient_binding.subject,'userId',recipient_binding.app_user_id,
   'personId',target->'recipientPersonId','createdAt',to_char(recipient_binding.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
 );
 RETURN jsonb_build_object('target',target,'issuer',v_issuer,'bindings',bindings,
  'leaseUntil',to_char(job.lease_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION identity_email.internal_report_context(uuid,uuid,text) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.internal_auth_report_context(p_id uuid,p_token uuid,p_origin text) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT identity_email.internal_report_context(p_id,p_token,p_origin)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.internal_auth_report_context(uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.internal_auth_report_context(uuid,uuid,text) TO ai_hr_app;

-- Keyless renderer uses the same canonical target, stripped of address/provider subject.
-- No encrypted Auth record or grant to internal_auth_read is introduced for a new role.
--> statement-breakpoint
CREATE FUNCTION app.employee_master_internal_render_context(p_id uuid,p_token uuid,p_origin text) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT (identity_email.internal_report_context(p_id,p_token,p_origin)->'target')-ARRAY['email','subject']
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.employee_master_internal_render_context(uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.employee_master_internal_render_context(uuid,uuid,text) TO ai_hr_app;

-- Final broker Tx MUST be READ COMMITTED/read-write, max1 connection, no singleton escape:
-- BEGIN; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='250ms'; ...
-- statement_timeout belongs on the OUTER command before invoking this function. Changing it
-- inside a running statement is not claimed to time-bound that statement. NOWAIT and try-locks
-- below avoid waiting cycles; the caller rolls back on unavailable/expired/credential failure.
-- Results: {status:ready,context:...}|{status:busy}|{status:notEligible}|{status:unavailable}.
-- The exception subtransaction releases ALL partial row/advisory locks on bounded refusal.
--> statement-breakpoint
CREATE FUNCTION app.internal_auth_report_lock_context(p_id uuid,p_token uuid,p_origin text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.custom_report_occurrence;initial jsonb;fresh jsonb;result jsonb;
 actors uuid[];people uuid[];subjects text[];lock_key text;actor uuid;v_person uuid;
 row_item record;n integer;v_issuer text;prior_timeout text:=current_setting('lock_timeout');
 locked_employments uuid[]:=ARRAY[]::uuid[];locked_grants uuid[]:=ARRAY[]::uuid[];
 locked_bindings jsonb:='[]'::jsonb;observed_ids uuid[];observed_bindings jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' THEN
  RAISE EXCEPTION 'Delivery requires its bounded read-committed transaction' USING ERRCODE='22023';
 END IF;
 BEGIN
  PERFORM set_config('lock_timeout','250ms',true);
  -- Canonical order is occurrence -> report -> schedule, including deleted/disabled races.
  SELECT * INTO job FROM public.custom_report_occurrence o
  WHERE o.id=p_id AND o.lease_token=p_token AND o.status='pending' AND o.started_at IS NULL
   AND o.lease_until>clock_timestamp() FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE no_data_found;END IF;
  PERFORM r.id FROM public.custom_report r WHERE r.id=job.report_id AND r.tenant_id=job.tenant_id FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE no_data_found;END IF;
  PERFORM s.id FROM public.custom_report_schedule s WHERE s.id=job.schedule_id AND s.tenant_id=job.tenant_id
   AND s.report_id=job.report_id FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE no_data_found;END IF;
  initial:=identity_email.internal_report_context(p_id,p_token,p_origin);
  IF initial IS NULL THEN RAISE no_data_found;END IF;
  v_issuer:=initial->>'issuer';
  SELECT array_agg(DISTINCT v ORDER BY v) INTO actors FROM unnest(ARRAY[job.owner_user_id,job.recipient_user_id]) v;
  SELECT array_agg(DISTINCT v ORDER BY v) INTO subjects FROM unnest(ARRAY[
   initial#>>'{bindings,owner,subject}',initial#>>'{bindings,recipient,subject}']) v;
  -- Same canonical keys as Auth store/settings and Notifications. No alternative lock authority.
  FOREACH lock_key IN ARRAY subjects LOOP
   IF NOT pg_try_advisory_xact_lock(hashtextextended('internal-auth:'||lock_key,0)) THEN
    RAISE lock_not_available;END IF;
  END LOOP;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('internal-auth:email-state',0)) THEN RAISE lock_not_available;END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('workflow-email-policy:'||job.tenant_id::text,0)) THEN RAISE lock_not_available;END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('workflow-email-consent:'||job.tenant_id::text||':'||job.recipient_employment_id::text,0)) THEN RAISE lock_not_available;END IF;
  -- Locks only fixed nonce-derived credential keys and existing canonical email-state.
  -- No ciphertext or caller-selectable key is returned. e5 readRecord(...,true) later decrypts.
  FOREACH lock_key IN ARRAY subjects LOOP
   PERFORM r.record_key FROM public.app_internal_auth_record r
   WHERE r.record_key='credential:'||lock_key FOR UPDATE NOWAIT;
   IF NOT FOUND THEN RAISE no_data_found;END IF;
  END LOOP;
  PERFORM r.record_key FROM public.app_internal_auth_record r WHERE r.record_key='email-state' FOR UPDATE NOWAIT;
  -- Tenant standing is a live receiving prerequisite, not merely the queue-time state.
  PERFORM t.id FROM public.tenant t WHERE t.id=job.tenant_id FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE no_data_found;END IF;
  FOREACH actor IN ARRAY actors LOOP
   PERFORM u.id FROM public.app_user u WHERE u.id=actor AND u.tenant_id=job.tenant_id FOR UPDATE NOWAIT;
   IF NOT FOUND THEN RAISE no_data_found;END IF;
  END LOOP;
  SELECT coalesce(array_agg(DISTINCT u.person_id ORDER BY u.person_id) FILTER(WHERE u.person_id IS NOT NULL),ARRAY[]::uuid[])
   INTO people FROM public.app_user u WHERE u.id=ANY(actors);
  -- Person before preferences: email-change/PDPA writers update Person -> pref without consent advisory.
  FOREACH v_person IN ARRAY people LOOP
   PERFORM p.id FROM public.person p WHERE p.id=v_person AND p.tenant_id=job.tenant_id FOR UPDATE NOWAIT;
   IF NOT FOUND THEN RAISE no_data_found;END IF;
  END LOOP;
  -- Canonical login_blocked reads ALL employments for its Person. Lock the actual set, not
  -- current-company substitutes; a cross-tenant corrupt reference refuses, never leaks a row.
  FOREACH v_person IN ARRAY people LOOP
   n:=0;
   FOR row_item IN SELECT e.id,e.tenant_id FROM public.employment e WHERE e.person_id=v_person
    ORDER BY e.id LIMIT 1001 FOR SHARE NOWAIT LOOP
    n:=n+1;IF n>1000 THEN RAISE program_limit_exceeded;END IF;
    IF row_item.tenant_id<>job.tenant_id THEN RAISE no_data_found;END IF;
    locked_employments:=array_append(locked_employments,row_item.id);
   END LOOP;
  END LOOP;
  IF NOT job.recipient_employment_id=ANY(locked_employments) THEN RAISE no_data_found;END IF;
  FOREACH actor IN ARRAY actors LOOP
   n:=0;
   FOR row_item IN SELECT i.issuer,i.subject,i.app_user_id FROM public.app_external_identity i
    WHERE i.app_user_id=actor AND i.issuer=v_issuer ORDER BY i.issuer,i.subject LIMIT 1001 FOR SHARE NOWAIT LOOP
    n:=n+1;IF n>1000 THEN RAISE program_limit_exceeded;END IF;
    locked_bindings:=locked_bindings||jsonb_build_array(jsonb_build_array(row_item.issuer,row_item.subject,row_item.app_user_id));
   END LOOP;
   n:=0;
   FOR row_item IN SELECT g.id,g.tenant_id FROM public.role_assignment g WHERE g.app_user_id=actor
    ORDER BY g.id LIMIT 1001 FOR SHARE NOWAIT LOOP
    n:=n+1;IF n>1000 THEN RAISE program_limit_exceeded;END IF;
    IF row_item.tenant_id<>job.tenant_id THEN RAISE no_data_found;END IF;
    locked_grants:=array_append(locked_grants,row_item.id);
   END LOOP;
  END LOOP;
  PERFORM p.id FROM public.notification_email_policy p WHERE p.tenant_id=job.tenant_id
   AND p.category='employee_master_reports' FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE no_data_found;END IF;
  PERFORM p.id FROM public.notification_pref p WHERE p.tenant_id=job.tenant_id
   AND p.recipient_employment_id=job.recipient_employment_id AND p.category='employee_master_reports'
   AND p.channel='email' FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE no_data_found;END IF;
  -- Recompare exact proof sets. User/Person FOR UPDATE also conflicts with new FK-backed
  -- binding/grant/employment insert/retarget checks; concurrency controls remain mandatory.
  SELECT coalesce(array_agg(e.id ORDER BY e.id),ARRAY[]::uuid[]) INTO observed_ids
   FROM public.employment e WHERE e.person_id=ANY(people);
  IF observed_ids IS DISTINCT FROM ARRAY(SELECT v FROM unnest(locked_employments) v ORDER BY v) THEN RAISE no_data_found;END IF;
  SELECT coalesce(array_agg(g.id ORDER BY g.id),ARRAY[]::uuid[]) INTO observed_ids
   FROM public.role_assignment g WHERE g.app_user_id=ANY(actors);
  IF observed_ids IS DISTINCT FROM ARRAY(SELECT v FROM unnest(locked_grants) v ORDER BY v) THEN RAISE no_data_found;END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_array(i.issuer,i.subject,i.app_user_id) ORDER BY i.app_user_id,i.issuer,i.subject),'[]'::jsonb)
   INTO observed_bindings FROM public.app_external_identity i WHERE i.app_user_id=ANY(actors) AND i.issuer=v_issuer;
  IF observed_bindings IS DISTINCT FROM locked_bindings THEN RAISE no_data_found;END IF;
  fresh:=identity_email.internal_report_context(p_id,p_token,p_origin);
  IF fresh IS NULL OR fresh IS DISTINCT FROM initial THEN RAISE no_data_found;END IF;
  result:=jsonb_build_object('status','ready','context',fresh);
  PERFORM set_config('lock_timeout',prior_timeout,true);
 EXCEPTION
  WHEN lock_not_available OR deadlock_detected OR serialization_failure THEN result:=jsonb_build_object('status','busy');
  WHEN no_data_found THEN result:=jsonb_build_object('status','notEligible');
  WHEN program_limit_exceeded THEN result:=jsonb_build_object('status','unavailable');
 END;
 -- Exception rollback restores settings and releases locks acquired inside that subtransaction.
 -- Success retains locks until OUTER commit/rollback. Do not commit after a refused Auth/relay check.
 RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.internal_auth_report_lock_context(uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.internal_auth_report_lock_context(uuid,uuid,text) TO ai_hr_app;

-- ONE transition implementation. Existing four-argument API passes NULL artifact, retaining
-- its boolean result and compatibility/history NULLs. Existing direct private sender grants
-- remain untouched by this migration; internal-mode installer must separately revoke start/target.
-- Normal locks preserve compatibility waiting. New broker already holds these rows NOWAIT.
--> statement-breakpoint
CREATE FUNCTION identity_email.start_report_bound(p_id uuid,p_token uuid,p_issuer text,p_target jsonb,p_artifact jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.custom_report_occurrence;fresh jsonb;
BEGIN
 IF p_artifact IS NOT NULL AND NOT identity_email.report_artifact_valid(p_artifact) THEN RETURN false;END IF;
 SELECT * INTO job FROM public.custom_report_occurrence o WHERE o.id=p_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false;END IF;
 PERFORM r.id FROM public.custom_report r WHERE r.id=job.report_id AND r.tenant_id=job.tenant_id FOR SHARE;
 IF NOT FOUND THEN RETURN false;END IF;
 PERFORM s.id FROM public.custom_report_schedule s WHERE s.id=job.schedule_id AND s.tenant_id=job.tenant_id
  AND s.report_id=job.report_id FOR SHARE;
 IF NOT FOUND THEN RETURN false;END IF;
 fresh:=identity_email.report_target(p_id,p_token,p_issuer);
 IF fresh IS NULL OR fresh IS DISTINCT FROM p_target THEN RETURN false;END IF;
 UPDATE public.custom_report_occurrence SET status='started',started_at=now(),lease_until=now()+interval '180 seconds',
  artifact_sha256=p_artifact->>'sha256',artifact_byte_length=(p_artifact->>'byteLength')::integer,
  artifact_content_type=p_artifact->>'contentType'
 WHERE id=p_id AND lease_token=p_token AND status='pending' AND started_at IS NULL
  AND lease_until>clock_timestamp()
  AND num_nonnulls(artifact_sha256,artifact_byte_length,artifact_content_type)=0;
 RETURN FOUND;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION identity_email.start_report_bound(uuid,uuid,text,jsonb,jsonb) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION identity_email.start_report(p_id uuid,p_token uuid,p_issuer text,p_target jsonb) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT identity_email.start_report_bound(p_id,p_token,p_issuer,p_target,NULL)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION identity_email.start_report(uuid,uuid,text,jsonb) FROM PUBLIC,ai_hr_app;

-- Application-only broker composition calls AFTER direct renderer manifest, proof validation,
-- canonical active Credential/relay reads and canonical app permission checks in the SAME Tx.
-- SQL does NOT claim it can decrypt/validate these Auth facts or attest renderer origin.
-- expected_context is a stale-change constraint, not caller-supplied verified/authorized flags.
--> statement-breakpoint
CREATE FUNCTION app.internal_auth_report_start(p_id uuid,p_token uuid,p_origin text,p_expected_context jsonb,p_artifact jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE locked jsonb;fresh jsonb;
BEGIN
 IF NOT identity_email.report_artifact_valid(p_artifact) THEN RETURN 'notEligible';END IF;
 locked:=app.internal_auth_report_lock_context(p_id,p_token,p_origin);
 IF locked->>'status' IN ('busy','unavailable') THEN RETURN locked->>'status';END IF;
 IF locked->>'status'<>'ready' THEN RETURN 'notEligible';END IF;
 fresh:=locked->'context';
 IF fresh IS DISTINCT FROM p_expected_context THEN RETURN 'notEligible';END IF;
 IF identity_email.start_report_bound(p_id,p_token,fresh->>'issuer',fresh->'target',p_artifact)
 THEN RETURN 'started';ELSE RETURN 'notEligible';END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.internal_auth_report_start(uuid,uuid,text,jsonb,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.internal_auth_report_start(uuid,uuid,text,jsonb,jsonb) TO ai_hr_app;

-- finish_report/claim_reports/queue_report/target and all notification/auth defaults stay unchanged.
-- In particular: failed/generationFailed is legal pending OR started; skipped is pending-only;
-- sent/uncertain is started-only; expired started attempts become uncertain, never automatic retries.
-- All newly revoked helper EXECUTEs must also be checked for inherited/PUBLIC leakage at rehearsal.
-- Existing ai_hr_app has canonical0543 internal_auth_read authority. SQL cannot distinguish broker
-- from renderer on that shared DB role; OS key/file/peer isolation is the agreed separate boundary.
