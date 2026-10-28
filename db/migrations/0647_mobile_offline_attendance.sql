-- Filename reserved centrally. DRAFT: no journal idx/when, not authorized for application.
-- Durable offline evidence ownership only; routes/rollout remain disabled.
-- ADR-0088 offline punch provenance, as 0528:3 added 'admin'. A value added in this transaction is not usable
-- as an enum literal here, so this file compares it only as text. PostgreSQL cannot drop an enum value.
ALTER TYPE clock_method ADD VALUE IF NOT EXISTS 'mobile_offline';--> statement-breakpoint
-- effective_at: the accepted offline instant; NULL is an online capture, whose instant stays server_recorded_at
-- (never overloaded: 0528's legacy-in synthesis needs it within 5 s). Whole seconds, as online punch_at is, and
-- never after the receipt. Epoch arithmetic keeps the CHECK independent of the session TimeZone.
-- Writers of attendance_clock_capture, none broken (only the first ever sets the column; NULL satisfies it):
-- core/attendance-clock.ts (sole application insert; only its mobile_offline source sets effective_at),
-- scripts/dev-fixture-board1-policy-release.ts and test fixtures (owner inserts), app.purge_attendance_clock_photo
-- (0500; UPDATEs photo columns only, so the CHECK re-evaluates unchanged values). Nothing else updates or
-- deletes the table. ai_hr_app's table-level SELECT, INSERT (0500) covers the new column; no grant added.
ALTER TABLE attendance_clock_capture ADD COLUMN effective_at timestamptz,
 ADD CONSTRAINT attendance_clock_capture_effective_at_ck CHECK(effective_at IS NULL OR
 (effective_at<=server_recorded_at AND extract(epoch FROM effective_at)=trunc(extract(epoch FROM effective_at))));
-- 0528's guard with every check kept. A capture-linked punch is web or mobile_offline, and mobile_offline exactly
-- when its capture holds effective_at; a mobile_offline punch without a capture is refused for every role.
CREATE OR REPLACE FUNCTION app.attendance_capture_punch_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE cap attendance_clock_capture;
BEGIN
 IF NEW.clock_capture_id IS NOT NULL THEN
  SELECT * INTO cap FROM attendance_clock_capture WHERE id=NEW.clock_capture_id;
  IF NOT FOUND OR cap.tenant_id<>NEW.tenant_id OR cap.employment_id<>NEW.employment_id OR cap.attendance_date<>NEW.attendance_date OR cap.direction<>NEW.direction
   OR NEW.method::text NOT IN ('web','mobile_offline') OR (NEW.method::text='mobile_offline')<>(cap.effective_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Invalid attendance capture reference';
  END IF;
 ELSIF NEW.method::text='mobile_offline' THEN
  RAISE EXCEPTION 'Offline clocking requires its attendance capture';
 ELSIF current_user='ai_hr_app' AND NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=NEW.employment_id AND app.is_admin_for(e.company_id)) THEN
  IF NOT (
   (NEW.method::text='admin' AND app.can_correct_attendance(NEW.employment_id))
   OR
   (NEW.direction='in' AND EXISTS(SELECT 1 FROM attendance a WHERE a.id=NEW.attendance_id AND a.check_in_at=NEW.punch_at AND NOT EXISTS(SELECT 1 FROM attendance_punch p WHERE p.attendance_id=a.id)) AND EXISTS(SELECT 1 FROM attendance_clock_capture c WHERE c.employment_id=NEW.employment_id AND c.attendance_date=NEW.attendance_date AND c.direction='out' AND c.server_recorded_at>=statement_timestamp()-interval '5 seconds'))
  ) THEN
   RAISE EXCEPTION 'Employee clocking requires a photo capture';
  END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
-- Keyless (owner decision D16, 29 October 2026): the server signs no context and holds no key for it. context_json is the
-- exact canonical context JSON the server handed out, stored verbatim as plaintext, and context_digest is SHA-256 of its
-- positional encoding, which each claim's hardware-key proof commits to. The record is the authority a claim is checked
-- against. Plaintext because a context holds only identifiers, instants, request/permit nonces (request_nonce and the
-- permit table already hold them in clear), policy facts and the company's own clocking-site configuration
-- (clocking_location is plaintext): no salary, medical, free text or home location. Byte bound = OFFLINE_CLOCK_CONTEXT_MAX_BYTES.
CREATE TABLE mobile_offline_context (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),actor_id uuid NOT NULL REFERENCES app_user(id),
 employment_id uuid NOT NULL REFERENCES employment(id),company_id uuid NOT NULL REFERENCES company(id),
 device_key_id uuid NOT NULL REFERENCES mobile_integrity_key(id),installation_id uuid NOT NULL REFERENCES mobile_integrity_installation(installation_id),
 app_installation_id uuid NOT NULL,request_id uuid NOT NULL,request_nonce text NOT NULL CHECK(request_nonce ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
 context_digest text NOT NULL CHECK(context_digest ~ '^[a-f0-9]{64}$'),
 policy_revision text NOT NULL CHECK(policy_revision ~ '^[a-f0-9]{64}$'),context_json text NOT NULL CHECK(octet_length(context_json) BETWEEN 2 AND 65536),
 issued_at timestamptz NOT NULL,expires_at timestamptz NOT NULL CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '72 hours'),
 permit_count integer NOT NULL CHECK(permit_count BETWEEN 1 AND 32),next_sequence integer NOT NULL DEFAULT 1,
 previous_digest text CHECK(previous_digest ~ '^[a-f0-9]{64}$'),
 closed_at timestamptz,close_reason text CHECK(close_reason IN ('exhausted','retired','revoked')),close_request_id uuid,
 CHECK(next_sequence BETWEEN 1 AND permit_count+1),CHECK((next_sequence=1)=(previous_digest IS NULL)),
 CHECK(num_nonnulls(closed_at,close_reason,close_request_id) IN (0,3)),CHECK(closed_at IS NULL OR closed_at>=issued_at),
 CHECK(close_reason IS DISTINCT FROM 'exhausted' OR next_sequence=permit_count+1),
 UNIQUE(id,tenant_id,actor_id),UNIQUE(id,tenant_id,actor_id,employment_id,device_key_id)
);
CREATE UNIQUE INDEX mobile_offline_context_request_uq ON mobile_offline_context(tenant_id,actor_id,request_id);
CREATE UNIQUE INDEX mobile_offline_context_nonce_uq ON mobile_offline_context(request_nonce);
CREATE UNIQUE INDEX mobile_offline_context_key_lease_uq ON mobile_offline_context(device_key_id) WHERE closed_at IS NULL;
CREATE TABLE mobile_offline_permit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,actor_id uuid NOT NULL,context_id uuid NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 32),nonce text NOT NULL CHECK(nonce ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
 FOREIGN KEY(context_id,tenant_id,actor_id) REFERENCES mobile_offline_context(id,tenant_id,actor_id),
 CONSTRAINT mobile_offline_permit_ordinal_uq UNIQUE(context_id,ordinal),CONSTRAINT mobile_offline_permit_nonce_uq UNIQUE(nonce),UNIQUE(id,context_id,tenant_id,actor_id,ordinal)
);
CREATE TABLE mobile_offline_claim (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,actor_id uuid NOT NULL,employment_id uuid NOT NULL,device_key_id uuid NOT NULL,
 context_id uuid NOT NULL,permit_id uuid NOT NULL,sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 32),request_id uuid NOT NULL,
 claim_digest text NOT NULL CHECK(claim_digest ~ '^[a-f0-9]{64}$'),previous_digest text CHECK(previous_digest ~ '^[a-f0-9]{64}$'),
 proof_digest text NOT NULL CHECK(proof_digest ~ '^[a-f0-9]{64}$'),assertion_counter bigint CHECK(assertion_counter BETWEEN 1 AND 4294967295),
 claim_ciphertext text NOT NULL CHECK(length(claim_ciphertext) BETWEEN 1 AND 131072),
 photo_digest text CHECK(photo_digest ~ '^[a-f0-9]{64}$'),photo_retained_until timestamptz,
 CHECK(num_nonnulls(photo_digest,photo_retained_until) IN (0,2)),
 UNIQUE(id,tenant_id,actor_id,employment_id,photo_digest,photo_retained_until),UNIQUE(id,tenant_id,actor_id,employment_id),
 claimed_at timestamptz NOT NULL,sampled_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 effective_minimum timestamptz,effective_maximum timestamptz,effective_at timestamptz,
 outcome text NOT NULL CHECK(outcome IN ('accepted','needs_review','refused')),reason text NOT NULL CHECK(reason ~ '^[a-z][a-z0-9_]{0,99}$'),
 capture_id uuid REFERENCES attendance_clock_capture(id),
 FOREIGN KEY(context_id,tenant_id,actor_id,employment_id,device_key_id) REFERENCES mobile_offline_context(id,tenant_id,actor_id,employment_id,device_key_id),
 FOREIGN KEY(permit_id,context_id,tenant_id,actor_id,sequence) REFERENCES mobile_offline_permit(id,context_id,tenant_id,actor_id,ordinal),
 CHECK((sequence=1)=(previous_digest IS NULL)),
 CHECK(num_nonnulls(effective_minimum,effective_maximum) IN (0,2)),CHECK(effective_maximum>=effective_minimum),
 CHECK((outcome='accepted')=(capture_id IS NOT NULL)),CHECK((outcome='accepted')=(effective_at IS NOT NULL)),
 CHECK(effective_at IS NULL OR effective_at BETWEEN effective_minimum AND effective_maximum AND effective_maximum IS NOT NULL),
 CONSTRAINT mobile_offline_claim_request_uq UNIQUE(tenant_id,actor_id,request_id),CONSTRAINT mobile_offline_claim_permit_uq UNIQUE(permit_id),
 CONSTRAINT mobile_offline_claim_sequence_uq UNIQUE(context_id,sequence),CONSTRAINT mobile_offline_claim_capture_uq UNIQUE(capture_id)
);
CREATE UNIQUE INDEX mobile_offline_claim_counter_uq ON mobile_offline_claim(device_key_id,assertion_counter) WHERE assertion_counter IS NOT NULL;
CREATE INDEX mobile_offline_claim_subject_idx ON mobile_offline_claim(tenant_id,employment_id,received_at);
--> statement-breakpoint
ALTER TABLE mobile_offline_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_offline_context FORCE ROW LEVEL SECURITY;
ALTER TABLE mobile_offline_permit ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_offline_permit FORCE ROW LEVEL SECURITY;
ALTER TABLE mobile_offline_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_offline_claim FORCE ROW LEVEL SECURITY;
REVOKE ALL ON mobile_offline_context,mobile_offline_permit,mobile_offline_claim FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT ON mobile_offline_context,mobile_offline_permit,mobile_offline_claim TO ai_hr_app;
GRANT UPDATE(next_sequence,previous_digest,closed_at,close_reason,close_request_id) ON mobile_offline_context TO ai_hr_app;
CREATE POLICY mobile_offline_context_own_read ON mobile_offline_context FOR SELECT USING
 (tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND app.mobile_integrity_subject(employment_id));
CREATE POLICY mobile_offline_context_own_insert ON mobile_offline_context FOR INSERT WITH CHECK
 (tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND app.mobile_integrity_subject(employment_id)
 AND installation_id=app.mobile_integrity_installation_id()
 AND EXISTS(SELECT 1 FROM company co WHERE co.id=company_id AND co.tenant_id=mobile_offline_context.tenant_id)
 AND EXISTS(SELECT 1 FROM mobile_integrity_key k WHERE k.id=device_key_id AND k.tenant_id=mobile_offline_context.tenant_id
  AND k.actor_id=mobile_offline_context.actor_id AND k.installation_id=mobile_offline_context.installation_id
  AND k.app_installation_id=mobile_offline_context.app_installation_id AND k.revoked_at IS NULL));
CREATE POLICY mobile_offline_context_own_update ON mobile_offline_context FOR UPDATE
 USING(tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND app.mobile_integrity_subject(employment_id))
 WITH CHECK(tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND app.mobile_integrity_subject(employment_id));
CREATE POLICY mobile_offline_permit_own ON mobile_offline_permit
 USING(tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id()
 AND EXISTS(SELECT 1 FROM mobile_offline_context c WHERE c.id=context_id AND c.tenant_id=mobile_offline_permit.tenant_id AND c.actor_id=mobile_offline_permit.actor_id))
 WITH CHECK(tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id()
 AND EXISTS(SELECT 1 FROM mobile_offline_context c WHERE c.id=context_id AND c.tenant_id=mobile_offline_permit.tenant_id AND c.actor_id=mobile_offline_permit.actor_id));
CREATE POLICY mobile_offline_claim_own ON mobile_offline_claim
 USING(tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND app.mobile_integrity_subject(employment_id))
 WITH CHECK(tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND app.mobile_integrity_subject(employment_id));
--> statement-breakpoint
CREATE FUNCTION app.mobile_offline_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Offline evidence is immutable'; END;
$$;
REVOKE ALL ON FUNCTION app.mobile_offline_immutable() FROM PUBLIC;
CREATE TRIGGER mobile_offline_permit_immutable BEFORE UPDATE OR DELETE ON mobile_offline_permit FOR EACH ROW EXECUTE FUNCTION app.mobile_offline_immutable();
CREATE TRIGGER mobile_offline_claim_immutable BEFORE UPDATE OR DELETE ON mobile_offline_claim FOR EACH ROW EXECUTE FUNCTION app.mobile_offline_immutable();
CREATE TRIGGER mobile_offline_context_no_delete BEFORE DELETE ON mobile_offline_context FOR EACH ROW EXECUTE FUNCTION app.mobile_offline_immutable();
CREATE FUNCTION app.mobile_offline_context_progress() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.closed_at IS NOT NULL OR
 (to_jsonb(NEW)-ARRAY['next_sequence','previous_digest','closed_at','close_reason','close_request_id']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['next_sequence','previous_digest','closed_at','close_reason','close_request_id']) THEN RAISE EXCEPTION 'Offline context is immutable'; END IF;
 IF NEW.next_sequence=OLD.next_sequence THEN
  IF NEW.previous_digest IS DISTINCT FROM OLD.previous_digest OR NEW.closed_at IS NULL THEN RAISE EXCEPTION 'Offline stream did not progress'; END IF;
 ELSIF NEW.next_sequence<>OLD.next_sequence+1 OR NOT EXISTS(SELECT 1 FROM public.mobile_offline_claim p WHERE p.context_id=OLD.id
 AND p.sequence=OLD.next_sequence AND p.claim_digest=NEW.previous_digest) THEN RAISE EXCEPTION 'Offline stream predecessor missing'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.mobile_offline_context_progress() FROM PUBLIC;
CREATE TRIGGER mobile_offline_context_progress BEFORE UPDATE ON mobile_offline_context FOR EACH ROW EXECUTE FUNCTION app.mobile_offline_context_progress();
CREATE FUNCTION app.mobile_offline_inventory_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.next_sequence<>1 OR NEW.previous_digest IS NOT NULL OR NEW.closed_at IS NOT NULL
 OR (SELECT count(*) FROM public.mobile_offline_permit p WHERE p.context_id=NEW.id)<>NEW.permit_count
 OR (SELECT max(ordinal) FROM public.mobile_offline_permit p WHERE p.context_id=NEW.id)<>NEW.permit_count THEN RAISE EXCEPTION 'Offline permit inventory incomplete'; END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.mobile_offline_inventory_complete() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER mobile_offline_inventory_complete AFTER INSERT ON mobile_offline_context
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.mobile_offline_inventory_complete();
CREATE FUNCTION app.mobile_offline_claim_ordered() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE c public.mobile_offline_context%ROWTYPE;k public.mobile_integrity_key%ROWTYPE;
BEGIN
 SELECT * INTO c FROM public.mobile_offline_context WHERE id=NEW.context_id FOR UPDATE;
 IF NOT FOUND OR c.closed_at IS NOT NULL OR NEW.sequence<>c.next_sequence OR NEW.previous_digest IS DISTINCT FROM c.previous_digest
 OR NEW.received_at<c.issued_at THEN RAISE EXCEPTION 'Offline claim out of order'; END IF;
 SELECT * INTO k FROM public.mobile_integrity_key WHERE id=c.device_key_id;
 IF NOT FOUND OR k.revoked_at IS NOT NULL OR (k.platform='ios' AND (NEW.assertion_counter IS NULL OR NEW.assertion_counter<=k.assertion_counter))
 OR (k.platform='android' AND NEW.assertion_counter IS NOT NULL) THEN RAISE EXCEPTION 'Offline proof counter unavailable'; END IF;
 -- The capture owns the accepted instant; the claim's effective_at is a checked copy, never a second truth.
 IF NEW.capture_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.attendance_clock_capture a WHERE a.id=NEW.capture_id
 AND a.tenant_id=NEW.tenant_id AND a.employment_id=NEW.employment_id AND a.request_id=NEW.request_id AND a.effective_at=NEW.effective_at)
 THEN RAISE EXCEPTION 'Offline capture binding mismatch'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.mobile_offline_claim_ordered() FROM PUBLIC;
CREATE TRIGGER mobile_offline_claim_ordered BEFORE INSERT ON mobile_offline_claim FOR EACH ROW EXECUTE FUNCTION app.mobile_offline_claim_ordered();
-- An installed lease also protects the key counter if a future online carrier forgets its service guard.
CREATE FUNCTION app.mobile_offline_key_counter() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.assertion_counter<>OLD.assertion_counter AND EXISTS(SELECT 1 FROM public.mobile_offline_context c WHERE c.device_key_id=OLD.id AND c.closed_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM public.mobile_offline_claim p JOIN public.mobile_offline_context c ON c.id=p.context_id
 WHERE c.device_key_id=OLD.id AND c.closed_at IS NULL AND p.assertion_counter=NEW.assertion_counter)
 THEN RAISE EXCEPTION 'Offline stream holds this key'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.mobile_offline_key_counter() FROM PUBLIC;
CREATE TRIGGER mobile_offline_key_counter BEFORE UPDATE ON mobile_integrity_key FOR EACH ROW EXECUTE FUNCTION app.mobile_offline_key_counter();

--> statement-breakpoint
-- Blind lease observation survives a former employment becoming unreadable; it exposes no capture.
CREATE FUNCTION app.mobile_offline_key_leased(wanted_app uuid,wanted_key uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT app.mobile_integrity_actor() AND EXISTS(SELECT 1 FROM public.mobile_offline_context c
 JOIN public.mobile_integrity_key k ON k.id=c.device_key_id
 WHERE c.tenant_id=app.current_tenant_id() AND c.actor_id=app.current_user_id()
 AND c.app_installation_id=wanted_app AND (wanted_key IS NULL OR c.device_key_id=wanted_key)
 AND c.closed_at IS NULL AND k.revoked_at IS NULL)
$$;
REVOKE ALL ON FUNCTION app.mobile_offline_key_leased(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mobile_offline_key_leased(uuid,uuid) TO ai_hr_app;
CREATE FUNCTION app.mobile_offline_claim_committed() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.mobile_offline_context c JOIN public.mobile_integrity_key k ON k.id=c.device_key_id
 WHERE c.id=NEW.context_id AND c.next_sequence>NEW.sequence
 AND (NEW.assertion_counter IS NULL OR k.assertion_counter>=NEW.assertion_counter))
 THEN RAISE EXCEPTION 'Offline claim cursor/counter not committed'; END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.mobile_offline_claim_committed() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER mobile_offline_claim_committed AFTER INSERT ON mobile_offline_claim
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.mobile_offline_claim_committed();
CREATE FUNCTION app.mobile_offline_permit_inventory() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.mobile_offline_context c WHERE c.id=NEW.context_id AND c.closed_at IS NULL
 AND c.next_sequence=1 AND NEW.ordinal<=c.permit_count) THEN RAISE EXCEPTION 'Offline permit inventory closed'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.mobile_offline_permit_inventory() FROM PUBLIC;
CREATE TRIGGER mobile_offline_permit_inventory BEFORE INSERT ON mobile_offline_permit FOR EACH ROW EXECUTE FUNCTION app.mobile_offline_permit_inventory();

--> statement-breakpoint
-- Original photo custody for processed claims; independent of a normalized accepted clock photo.
CREATE TABLE mobile_offline_photo (
 claim_id uuid PRIMARY KEY,tenant_id uuid NOT NULL,actor_id uuid NOT NULL,employment_id uuid NOT NULL,
 photo_digest text NOT NULL CHECK(photo_digest ~ '^[a-f0-9]{64}$'),retained_until timestamptz NOT NULL,
 byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 2097152),mime_type text NOT NULL CHECK(mime_type IN ('image/jpeg','image/png')),
 photo_ciphertext text NOT NULL CHECK(length(photo_ciphertext) BETWEEN 1 AND 4194304),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),CHECK(retained_until>created_at),
 FOREIGN KEY(claim_id,tenant_id,actor_id,employment_id,photo_digest,retained_until)
 REFERENCES mobile_offline_claim(id,tenant_id,actor_id,employment_id,photo_digest,photo_retained_until)
);
CREATE INDEX mobile_offline_photo_expiry_idx ON mobile_offline_photo(tenant_id,retained_until);
ALTER TABLE mobile_offline_photo ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_offline_photo FORCE ROW LEVEL SECURITY;
REVOKE ALL ON mobile_offline_photo FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT,DELETE ON mobile_offline_photo TO ai_hr_app;
-- Owner decision 2026-10-28: a group admin reads (and so can DELETE ... RETURNING) only expired rows, never
-- retained ciphertext. Same clock_timestamp() expiry test as the delete policy and trigger below.
CREATE POLICY mobile_offline_photo_read ON mobile_offline_photo FOR SELECT USING
 (tenant_id=app.current_tenant_id() AND ((actor_id=app.current_user_id() AND app.mobile_integrity_subject(employment_id))
 OR (retained_until<=clock_timestamp() AND app.is_group_admin())));
CREATE POLICY mobile_offline_photo_insert ON mobile_offline_photo FOR INSERT WITH CHECK
 (tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND app.mobile_integrity_subject(employment_id));
CREATE POLICY mobile_offline_photo_delete ON mobile_offline_photo FOR DELETE USING
 (tenant_id=app.current_tenant_id() AND retained_until<=clock_timestamp() AND app.is_group_admin());
CREATE TRIGGER mobile_offline_photo_immutable BEFORE UPDATE ON mobile_offline_photo FOR EACH ROW EXECUTE FUNCTION app.mobile_offline_immutable();
CREATE FUNCTION app.mobile_offline_photo_expired() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF clock_timestamp()<OLD.retained_until THEN RAISE EXCEPTION 'Offline photo retention has not elapsed'; END IF;
 RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION app.mobile_offline_photo_expired() FROM PUBLIC;
CREATE TRIGGER mobile_offline_photo_expired BEFORE DELETE ON mobile_offline_photo FOR EACH ROW EXECUTE FUNCTION app.mobile_offline_photo_expired();
CREATE FUNCTION app.mobile_offline_photo_committed() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.photo_digest IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.mobile_offline_photo p WHERE p.claim_id=NEW.id
 AND p.photo_digest=NEW.photo_digest AND p.retained_until=NEW.photo_retained_until) THEN RAISE EXCEPTION 'Offline photo custody not committed'; END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.mobile_offline_photo_committed() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER mobile_offline_photo_committed AFTER INSERT ON mobile_offline_claim
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.mobile_offline_photo_committed();
--> statement-breakpoint
-- Per-company offline clocking settings (owner decisions 2026-10-28). attendance_policy is one row per company
-- (attendance_policy_company_uq); no row is the engine default, read by readOfflineClockingPolicyTx
-- (packs/attendance/mobile-offline-adjudicator.ts): offline clocking OFF (ADR-0088) and a 900 s maximum width of
-- the server-proven interval before a claim goes to HR review. Bounds: 60 s to 86400 s (one day; the context window
-- itself is at most 72 h). Not declared in db/schema.ts while 0647 is unjournaled; read by name.
-- Writers of attendance_policy, none broken (each omits both columns, so the defaults apply; NOT NULL and the CHECK
-- hold for every existing row through the defaults): core/attendance.ts setAttendancePolicy (INSERT ... ON CONFLICT
-- (company_id) DO UPDATE of its own listed columns only, so an update keeps both settings), db/provision.ts
-- seedCompanyCatalogs (defaults-only insert; tenant provisioning there and db/seed.ts call it), the dev
-- fixtures scripts/dev-fixture-board{2-approved,-ten,15-holidays}.ts (through setAttendancePolicy), and test inserts
-- (attendance-rule, employee-home-greeting-message (also UPDATEs its own columns), leave-approval-escalation,
-- leave-rest-day-roster, partial-leave-cancellation, r301-schedule-general). db/seed.ts and the test harness TRUNCATE
-- it. No trigger reads or writes the table; no DELETE writer. ai_hr_app's table-level SELECT/INSERT/UPDATE/DELETE
-- (0008) covers both columns and RLS (0099) still requires can_admin_payroll_for(company_id) to write; no grant added.
-- Their one application writer is packs/attendance/mobile-offline-settings.ts setOfflineClockingPolicy (the Offline
-- clocking settings card), which names only these two columns and checks can_admin_payroll_for(company_id) first.
ALTER TABLE attendance_policy ADD COLUMN offline_clocking_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN offline_max_proven_window_seconds integer NOT NULL DEFAULT 900
  CONSTRAINT attendance_policy_offline_window_ck CHECK(offline_max_proven_window_seconds BETWEEN 60 AND 86400);
--> statement-breakpoint
-- HR review and resolution of held claims (owner decision 2026-10-28; protocol decision 6). Attendance-correction
-- authority over the claim's employment (app.can_correct_attendance, latest 0548) reads that employment's claims; a
-- holder that is NOT a group admin also reads its UNEXPIRED retained photos. A group admin still reads only expired
-- photos (mobile_offline_photo_read above), so its correction authority never widens photo custody. Only SELECT is
-- added: the actor's own policies, the expiry purge and every write policy above are unchanged. The photo row carries
-- its claim's employment (bound by its composite FK), so no join to the claim is needed.
CREATE POLICY mobile_offline_claim_review_read ON mobile_offline_claim FOR SELECT USING
 (tenant_id=app.current_tenant_id() AND app.can_correct_attendance(employment_id));
CREATE POLICY mobile_offline_photo_review_read ON mobile_offline_photo FOR SELECT USING
 (tenant_id=app.current_tenant_id() AND retained_until>clock_timestamp() AND NOT app.is_group_admin() AND app.can_correct_attendance(employment_id));
-- One human resolution per held claim. The claim row stays immutable (its outcome remains needs_review); this row is
-- the decision of record. An accept (owner decision 2026-10-28) is an HR punch correction: the existing correction
-- owner files it (attendance_correction, clock_changes) and the resolver decides its first level; the correction's
-- final approval inserts an 'admin' punch at the accepted instant, so later punches never block it and HR's
-- reasoned decision overrides the hold. Owner decision D-A (2026-10-28): when the day's workflow needs further
-- approvers the accept is still recorded here, with the correction pending, and the punch is written only when the
-- final approver approves, exactly as for any correction. This row links the correction and holds effective_at,
-- the accepted instant. It holds no state and no punch: whether the accept is pending, applied, rejected or
-- cancelled is the correction's status, and its punch is the one the correction's applied changes added
-- (attendance.punch.added naming that correction), both read through app.mobile_offline_claim_resolution_state
-- below. No capture is written for an accept, so attendance_clock_capture.effective_at stays the canonical offline
-- writer's alone. day_revision is the correction's baseline (clockFingerprint of the filed day's punches) the
-- resolver decided against. input_digest identifies the decision for idempotent retry. resolved_by and
-- resolved_at are server-stamped.
CREATE TABLE mobile_offline_claim_resolution (
 claim_id uuid PRIMARY KEY,tenant_id uuid NOT NULL,actor_id uuid NOT NULL,employment_id uuid NOT NULL,
 decision text NOT NULL CHECK(decision IN ('accepted','rejected')),effective_at timestamptz,
 correction_id uuid REFERENCES attendance_correction(id),
 day_revision text CHECK(day_revision ~ '^[a-f0-9]{64}$'),reason text NOT NULL CHECK(reason=btrim(reason) AND length(reason) BETWEEN 1 AND 500),
 input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),resolved_by uuid NOT NULL REFERENCES app_user(id),resolved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(claim_id,tenant_id,actor_id,employment_id) REFERENCES mobile_offline_claim(id,tenant_id,actor_id,employment_id),
 CHECK((decision='accepted')=(correction_id IS NOT NULL)),
 CHECK((decision='accepted')=(effective_at IS NOT NULL)),CHECK((decision='accepted')=(day_revision IS NOT NULL)),
 CHECK(effective_at IS NULL OR extract(epoch FROM effective_at)=trunc(extract(epoch FROM effective_at))),
 CONSTRAINT mobile_offline_claim_resolution_correction_uq UNIQUE(correction_id)
);
CREATE INDEX mobile_offline_claim_resolution_subject_idx ON mobile_offline_claim_resolution(tenant_id,employment_id,resolved_at);
ALTER TABLE mobile_offline_claim_resolution ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_offline_claim_resolution FORCE ROW LEVEL SECURITY;
REVOKE ALL ON mobile_offline_claim_resolution FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT ON mobile_offline_claim_resolution TO ai_hr_app;
-- The claim's actor reads its own resolution (the receipt); correction authority reads and writes it. Nobody resolves
-- their own employment's claim, as attendance_workflow_decision_insert (0533) refuses deciding one's own request.
CREATE POLICY mobile_offline_claim_resolution_read ON mobile_offline_claim_resolution FOR SELECT USING
 (tenant_id=app.current_tenant_id() AND ((actor_id=app.current_user_id() AND app.mobile_integrity_subject(employment_id)) OR app.can_correct_attendance(employment_id)));
CREATE POLICY mobile_offline_claim_resolution_insert ON mobile_offline_claim_resolution FOR INSERT WITH CHECK
 (tenant_id=app.current_tenant_id() AND resolved_by=app.current_user_id() AND app.can_correct_attendance(employment_id)
 AND NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=mobile_offline_claim_resolution.employment_id AND e.tenant_id=mobile_offline_claim_resolution.tenant_id AND app.is_self_person(e.person_id)));
CREATE TRIGGER mobile_offline_claim_resolution_immutable BEFORE UPDATE OR DELETE ON mobile_offline_claim_resolution FOR EACH ROW EXECUTE FUNCTION app.mobile_offline_immutable();
-- The instants a resolver needs and may not read directly: the held claim's proven interval and its context's issuance
-- and expiry (context rows stay actor-only). Rule, shared with the trigger below: an accepted instant is a whole second
-- in [effective_minimum, least(effective_maximum, expires_at)], and a claim whose interval starts before issuance has
-- none. No row without correction authority, for a claim not held for review, or one with no proven interval.
CREATE FUNCTION app.mobile_offline_claim_window(wanted uuid) RETURNS TABLE(issued_at timestamptz,expires_at timestamptz,minimum timestamptz,maximum timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT x.issued_at,x.expires_at,c.effective_minimum,c.effective_maximum FROM public.mobile_offline_claim c
 JOIN public.mobile_offline_context x ON x.id=c.context_id AND x.tenant_id=c.tenant_id
 WHERE c.id=wanted AND c.tenant_id=app.current_tenant_id() AND c.outcome='needs_review' AND c.effective_minimum IS NOT NULL AND app.can_correct_attendance(c.employment_id)
$$;
REVOKE ALL ON FUNCTION app.mobile_offline_claim_window(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mobile_offline_claim_window(uuid) TO ai_hr_app;
-- Binds a resolution to its held claim, and an accept to the correction that recorded it: a pending or approved
-- clock-data correction of the claim's employment whose submitted entries add exactly one punch (one entry with no
-- id), at the MYT wall time of effective_at on the correction's day (or the next day, for an overnight out filed to
-- its shift's start day); when that correction is already approved (a single-level workflow), the live 'admin' punch
-- with no capture it added exists. effective_at follows the window rule. Owner decision D-B (2026-10-28): while the
-- claim's photo is retained (custody row present and unexpired) only a session that may read it accepts, so a group
-- admin, which never reads retained photos (mobile_offline_photo_review_read), may reject but not accept; once the
-- photo has expired or been purged, or the claim has none, it may accept. Definer: the context and the photo are
-- not readable by the resolver. The claim's ordering trigger (mobile_offline_claim_ordered) is unchanged: it runs
-- only when a claim row is inserted, and a resolution never writes the claim.
CREATE FUNCTION app.mobile_offline_claim_resolution_bound() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.mobile_offline_claim%ROWTYPE;x public.mobile_offline_context%ROWTYPE;
BEGIN
 SELECT * INTO c FROM public.mobile_offline_claim WHERE id=NEW.claim_id;
 IF NOT FOUND OR c.tenant_id<>NEW.tenant_id OR c.outcome<>'needs_review' OR NEW.resolved_by IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'Offline claim resolution unavailable'; END IF;
 NEW.resolved_at:=clock_timestamp();
 IF NEW.decision='accepted' THEN
  IF app.is_group_admin() AND EXISTS(SELECT 1 FROM public.mobile_offline_photo p WHERE p.claim_id=c.id AND p.tenant_id=c.tenant_id AND p.retained_until>clock_timestamp())
  THEN RAISE EXCEPTION 'Offline claim photo review required'; END IF;
  SELECT * INTO x FROM public.mobile_offline_context WHERE id=c.context_id;
  IF NOT FOUND OR c.effective_minimum IS NULL OR c.effective_minimum<x.issued_at OR NEW.effective_at<c.effective_minimum OR NEW.effective_at>least(c.effective_maximum,x.expires_at)
  OR NOT EXISTS(SELECT 1 FROM public.attendance_correction r CROSS JOIN LATERAL jsonb_array_elements(r.clock_changes->'entries') e
   WHERE r.id=NEW.correction_id AND r.tenant_id=c.tenant_id AND r.employment_id=c.employment_id AND r.status::text IN ('pending','approved') AND e->'id' IS NULL
   AND (SELECT count(*) FROM jsonb_array_elements(r.clock_changes->'entries') n WHERE n->'id' IS NULL)=1
   AND (NEW.effective_at AT TIME ZONE 'Asia/Kuala_Lumpur') IN (r.attendance_date+(e->>'punchAt')::time,(r.attendance_date+1)+(e->>'punchAt')::time)
   AND (r.status::text='pending' OR EXISTS(SELECT 1 FROM public.attendance_punch p WHERE p.tenant_id=c.tenant_id AND p.employment_id=c.employment_id AND p.attendance_date=r.attendance_date
    AND p.punch_at=(e->>'punchAt')::time AND p.direction::text=e->>'direction' AND p.method::text='admin' AND p.voided_at IS NULL AND p.clock_capture_id IS NULL)))
  THEN RAISE EXCEPTION 'Offline claim resolution correction binding mismatch'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.mobile_offline_claim_resolution_bound() FROM PUBLIC;
CREATE TRIGGER mobile_offline_claim_resolution_bound BEFORE INSERT ON mobile_offline_claim_resolution FOR EACH ROW EXECUTE FUNCTION app.mobile_offline_claim_resolution_bound();
-- The state of a resolution, derived and never stored (owner decision D-A, 2026-10-28): a reject is 'rejected'; an
-- accept is its correction's status ('pending', 'approved' read as 'accepted', 'rejected' or 'cancelled'). A
-- correction rejected or withdrawn at any level ends the claim there, as a correction ends: the resolution stays the
-- claim's one decision and a further attempt is an ordinary correction of the day. punch_id is the punch the
-- approved correction's applied changes added (its attendance.punch.added event names the correction), voided or
-- not; null otherwise. Same visibility as mobile_offline_claim_resolution_read; definer only so that the claim's
-- actor need not read the correction and its events through their own policies.
CREATE FUNCTION app.mobile_offline_claim_resolution_state(wanted uuid[]) RETURNS TABLE(claim_id uuid,status text,punch_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT r.claim_id,CASE WHEN r.decision='rejected' THEN 'rejected' WHEN k.status::text='approved' THEN 'accepted' ELSE k.status::text END,
  CASE WHEN r.decision='accepted' AND k.status::text='approved' THEN (SELECT p.id FROM public.attendance_punch p WHERE p.tenant_id=r.tenant_id AND p.employment_id=r.employment_id
   AND p.attendance_date=k.attendance_date AND p.method::text='admin' AND p.clock_capture_id IS NULL
   AND EXISTS(SELECT 1 FROM public.domain_event e WHERE e.tenant_id=r.tenant_id AND e.aggregate_type='attendance-punch' AND e.aggregate_id=p.id
    AND e.event_type='attendance.punch.added' AND e.payload->>'correctionId'=k.id::text) ORDER BY p.id LIMIT 1) END
 FROM public.mobile_offline_claim_resolution r LEFT JOIN public.attendance_correction k ON k.id=r.correction_id AND k.tenant_id=r.tenant_id
 WHERE r.claim_id=ANY(wanted) AND r.tenant_id=app.current_tenant_id()
  AND ((r.actor_id=app.current_user_id() AND app.mobile_integrity_subject(r.employment_id)) OR app.can_correct_attendance(r.employment_id))
$$;
REVOKE ALL ON FUNCTION app.mobile_offline_claim_resolution_state(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mobile_offline_claim_resolution_state(uuid[]) TO ai_hr_app;
--> statement-breakpoint
-- The settings card's "phones offline now" (owner-approved design 2026-10-28): how many of a company's contexts are
-- open now (not closed, not yet expired) in the current tenant. Context rows stay actor-only, so an administrator's
-- own read would be a false zero; definer, returning one integer and no row data. The authority is the settings
-- card's own (setOfflineClockingPolicy, packs/attendance/mobile-offline-settings.ts): a company of this tenant whose
-- attendance policy the session may administer, app.can_admin_payroll_for (attendance_policy_rls, 0099). Anyone
-- else, and a company of another tenant, gets NULL, never a count. company_id is the context's own column, bound at
-- issuance to the enrollment's company.
CREATE FUNCTION app.mobile_offline_open_context_count(company uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM public.company co WHERE co.id=$1 AND co.tenant_id=app.current_tenant_id()) AND coalesce(app.can_admin_payroll_for($1),false)
  THEN (SELECT count(*)::integer FROM public.mobile_offline_context c WHERE c.tenant_id=app.current_tenant_id() AND c.company_id=$1
   AND c.closed_at IS NULL AND c.expires_at>clock_timestamp()) END
$$;
REVOKE ALL ON FUNCTION app.mobile_offline_open_context_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mobile_offline_open_context_count(uuid) TO ai_hr_app;
