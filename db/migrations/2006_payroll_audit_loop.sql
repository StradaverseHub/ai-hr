-- AI v2 Phase 2, P2-2b: the payroll Audit loop (owner decision 9, 3 November 2026: "the audit loop should capture and audit as
-- much and as detailed as possible"). Source allocation 2006 / when1793330001406 in the AI Centre block 2000-2019
-- (docs/MIGRATION-ALLOCATION.md), renumbered from the never-applied 0965 / when1793330000365 at the AI v2 Phase 2
-- integration (4 November 2026); no installation is granted by this file.
--
-- What it holds. Nothing here is an HR value of record: every figure stays in its native owner (payroll, attendance, leave,
-- claims, statutory reporting). The Audit loop copies, per company and pay month, the evidence of how each payroll run
-- came about, hashes every copy and links the copies into a chain, so a later change to any captured row is detectable.
--  1. payroll_audit_capture: one append-only row per captured artefact version (a run's inputs snapshot, each change from
--     draft to final with who, when, what and why, each manual adjustment, the rule versions, each exception and its
--     disposition, the approval and close trail, bank and statutory file hashes and totals, filing receipts, payslip release
--     and opens, post-run corrections, who viewed or exported payroll data, and pay-affecting configuration changes).
--     The database, not the writer, computes content_hash (sha256 of the canonical jsonb text) and links the row to the
--     previous one of the same company and month (seq, prev_hash, chain_hash). An AFTER INSERT trigger appends a
--     `payroll-audit.captured` domain event carrying both hashes, so every capture is also inside the existing tenant audit
--     hash chain (0074, armed by AUDIT_HASH_CHAIN_ENABLED / audit.hash_chain_enabled). Verifying recomputes all three.
--  2. payroll_audit_finding: one append-only row per control finding (bank details changed shortly before pay day, one bank
--     account on two or more people, pay after the last working day, pay without attendance, one person both preparing and
--     closing a run, a large manual adjustment without a reason, a formula changed while a run was open). A finding is
--     evidence for a person; it never acts. Anchored in the audit chain like a capture.
--  3. payroll_audit_disposition: a payroll administrator's disposition of a finding, with a note. Append-only; the latest
--     disposition is the finding's state. Anchored.
--  4. payroll_audit_correction_cause: the root cause, from a fixed list, and a note, for a post-run correction (a closed
--     run reopened, or a processed run reset). Append-only; the latest statement wins. Anchored.
--  5. payroll_audit_control_setting: per company, the bank-change window (default 7 days) and the manual-adjustment amount
--     above which a reason is required (default 1000.00). No row means the defaults.
--  6. payroll_audit_reader: the optional auditor grant. A company administrator lets a named login read that company's
--     Audit loop and audit pack, read-only, until revoked.
--  7. The Audit loop joins the closed worker list of teras_worker_control (0895/0960) as `loop_payroll_audit`, off by
--     default, with the per-company pause and the run record of 0960. Like the other loops it runs as the tenant's agent
--     principal behind its own switch and reads under its sponsor's current authority. No model is called.
-- Who reads (FORCE row-level security on every new table):
--  - the tenant's agent principal: the rows of its tenant (it writes captures and findings while its switch allows);
--  - payroll administrators of the company (app.can_admin_payroll_for, which includes HR administrators of the company
--    and payroll partners), and an auditor with a current grant for that company;
--  - nobody else. Employees never read these tables.
-- Writers reviewed before each constraint: core/payroll-audit/capture.ts is the only writer of payroll_audit_capture,
-- core/payroll-audit/controls.ts of payroll_audit_finding and payroll_audit_disposition, core/payroll-audit/corrections.ts of
-- payroll_audit_correction_cause, core/payroll-audit/settings.ts of payroll_audit_control_setting and payroll_audit_reader.
-- All six tables are new. The three widened CHECKs of 0960 only add a value. Grants: every privilege a table must not have is
-- revoked, not merely left ungranted.
-- Phase 2 hardening (4 November 2026, while unapplied):
--  - A capture is deduplicated only against the LATEST capture of its source key, in the chain trigger under the company
--    and month lock: an artefact that changes and then changes back is captured again, so a revert is never hidden. The
--    unique (source key, content hash) index is gone; an ordinary index serves the latest-of-key lookup.
--  - A finding records the logins it is about (subject_user_ids: who processed and closed the run, who changed the bank
--    details or the formula, who keyed the adjustment), derived by the database from the evidence. Nobody disposes of a
--    finding about themselves (a subject login, or the person the finding's employment belongs to): another payroll
--    administrator of the company, or a group administrator, does.
--  - The control settings have bounds (a bank-change window of 3 to 30 days; an adjustment amount of 100.00 to 50000.00)
--    and a third setting, whether "one login both processed and closed a run" opens a finding (`finding`) or is recorded
--    as information only (`info`, the default: owner decision 2 has no second approver). A change that loosens a control
--    (a shorter window, a higher amount, `finding` to `info`) needs a group administrator; the database refuses anyone
--    else. Every change stays a `payroll-audit.settings-changed` event, which the capture lists in the month's pack.
-- Wave 1 integration (3 November 2026, while unapplied): 0964 (now 2005) runs first and adds 'loop_salary_payroll' to the same
-- lists, so each list rebuilt here carries it too; otherwise this migration would drop it again. 0964's teras_loop_case list
-- is not rebuilt here (the Audit loop opens no loop case), so it stands as 0964 left it.

-- 1. The Audit loop's switch, pause and run record.
ALTER TABLE public.teras_worker_control DROP CONSTRAINT teras_worker_control_worker_id_check;
--> statement-breakpoint
ALTER TABLE public.teras_worker_control ADD CONSTRAINT teras_worker_control_worker_id_check
 CHECK (worker_id IN ('approver_recommendation','explainers','conversation',
  'loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data','loop_missed_clock_outs','loop_document_expiry',
  'loop_salary_payroll','loop_payroll_audit'));
--> statement-breakpoint
ALTER TABLE public.teras_loop_pause DROP CONSTRAINT teras_loop_pause_worker_id_check;
--> statement-breakpoint
ALTER TABLE public.teras_loop_pause ADD CONSTRAINT teras_loop_pause_worker_id_check
 CHECK (worker_id IN ('loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data','loop_missed_clock_outs','loop_document_expiry',
  'loop_salary_payroll','loop_payroll_audit'));
--> statement-breakpoint
ALTER TABLE public.teras_loop_run DROP CONSTRAINT teras_loop_run_worker_id_check;
--> statement-breakpoint
ALTER TABLE public.teras_loop_run ADD CONSTRAINT teras_loop_run_worker_id_check
 CHECK (worker_id IN ('loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data','loop_missed_clock_outs','loop_document_expiry',
  'loop_salary_payroll','loop_payroll_audit'));
--> statement-breakpoint
-- 2. Hashing. One definition, used by the triggers that store hashes and by the verifier that recomputes them, so the two
--    can never diverge (the 0074 pattern). jsonb::text is Postgres-canonical, and the instant is rendered in UTC so the
--    session time zone cannot change a hash.
CREATE FUNCTION app.payroll_audit_hash(p text) RETURNS text
 LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
 SELECT encode(sha256(convert_to(p,'UTF8')),'hex')
$$;
--> statement-breakpoint
CREATE FUNCTION app.payroll_audit_chain_hash(p_prev text,p_tenant uuid,p_company uuid,p_period text,p_seq integer,p_kind text,
 p_source text,p_content_hash text,p_at timestamptz,p_writer text,p_writer_id uuid) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT encode(sha256(convert_to(p_prev||'|'||p_tenant::text||'|'||p_company::text||'|'||p_period||'|'||p_seq::text||'|'||p_kind||'|'
  ||p_source||'|'||p_content_hash||'|'||to_char(p_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')||'|'||p_writer||'|'||p_writer_id::text,'UTF8')),'hex')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_audit_hash(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_audit_chain_hash(text,uuid,uuid,text,integer,text,text,text,timestamptz,text,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_audit_hash(text) TO ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_audit_chain_hash(text,uuid,uuid,text,integer,text,text,text,timestamptz,text,uuid) TO ai_hr_app;
--> statement-breakpoint
-- 3. The auditor grant first: the read predicate below consults it.
CREATE TABLE public.payroll_audit_reader (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 app_user_id uuid NOT NULL REFERENCES public.app_user(id),
 granted_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 granted_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 revoked_by_user_id uuid REFERENCES public.app_user(id),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 CHECK ((revoked_at IS NULL)=(revoked_by_user_id IS NULL)),
 CHECK (revoked_at IS NULL OR revoked_at>=granted_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX payroll_audit_reader_current_uq ON public.payroll_audit_reader(tenant_id,company_id,app_user_id) WHERE revoked_at IS NULL;
--> statement-breakpoint
-- A grant row is never rewritten: only its revocation is added, once.
CREATE FUNCTION app.payroll_audit_reader_revoke_only() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'An auditor grant is only ever revoked, never deleted' USING ERRCODE='42501';
 END IF;
 IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
  OR (NEW.id,NEW.tenant_id,NEW.company_id,NEW.app_user_id,NEW.granted_by_user_id,NEW.granted_at)
   IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.company_id,OLD.app_user_id,OLD.granted_by_user_id,OLD.granted_at) THEN
  RAISE EXCEPTION 'An auditor grant is only ever revoked, once' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_audit_reader_revoke_only BEFORE UPDATE OR DELETE ON public.payroll_audit_reader
 FOR EACH ROW EXECUTE FUNCTION app.payroll_audit_reader_revoke_only();
--> statement-breakpoint
-- Who may read a company's Audit loop: its payroll administrators, or an auditor with a current grant. Invoker rights: the
-- grant is read under the caller's own policy below (an auditor sees their own grants).
CREATE FUNCTION app.payroll_audit_can_read(p_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_agent_principal() IS NULL AND app.current_user_id() IS NOT NULL
  AND (app.can_admin_payroll_for(p_company) IS TRUE
   OR EXISTS (SELECT 1 FROM public.payroll_audit_reader r WHERE r.tenant_id=app.current_tenant_id() AND r.company_id=p_company
    AND r.app_user_id=app.current_user_id() AND r.revoked_at IS NULL))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_audit_can_read(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_audit_can_read(uuid) TO ai_hr_app;
--> statement-breakpoint
-- 4. Captures.
CREATE TABLE public.payroll_audit_capture (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 pay_period text NOT NULL CHECK (pay_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 -- The run, where the artefact belongs to one. Not a foreign key: deleting a draft run must not delete its evidence.
 batch_id uuid,
 seq integer NOT NULL DEFAULT 0,
 kind text NOT NULL CHECK (kind IN ('run','inputs_snapshot','payslip','change','adjustment','rule_version','exception','approval',
  'bank_file','statutory_file','filing','payslip_release','correction','access','config_change','control_finding')),
 source_key text NOT NULL CHECK (source_key ~ '^[a-z_]+:[0-9A-Za-z:._-]{1,160}$'),
 content jsonb NOT NULL CHECK (jsonb_typeof(content)='object' AND octet_length(content::text)<=1048576),
 content_hash text NOT NULL DEFAULT '',
 prev_hash text NOT NULL DEFAULT '',
 chain_hash text NOT NULL DEFAULT '',
 captured_at timestamptz NOT NULL DEFAULT now(),
 writer text NOT NULL CHECK (writer IN ('agent','user')),
 writer_id uuid NOT NULL,
 run_id uuid,
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 CHECK (seq>=1),
 CHECK (content_hash ~ '^[0-9a-f]{64}$' AND chain_hash ~ '^[0-9a-f]{64}$' AND (prev_hash='GENESIS' OR prev_hash ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX payroll_audit_capture_seq_uq ON public.payroll_audit_capture(tenant_id,company_id,pay_period,seq);
--> statement-breakpoint
-- The latest capture of each source key, for the trigger's deduplication: an unchanged artefact is not captured again,
-- and a changed one (including one changed back to an earlier version) is a new row.
CREATE INDEX payroll_audit_capture_key_idx ON public.payroll_audit_capture(tenant_id,company_id,pay_period,source_key,seq DESC);
--> statement-breakpoint
CREATE INDEX payroll_audit_capture_batch_idx ON public.payroll_audit_capture(tenant_id,batch_id) WHERE batch_id IS NOT NULL;
--> statement-breakpoint
-- The database computes the hashes and the link; whatever the writer sent for them is replaced. Serialised per company and
-- month, so two writers cannot fork a chain. An artefact whose content equals the LATEST capture of its own source key is
-- skipped (the row is not inserted); any other content, an earlier version included, is a new link. Invoker rights: every
-- writer may read the whole chain it writes to.
CREATE FUNCTION app.payroll_audit_capture_chain_tg() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE v_seq integer; v_prev text; v_latest text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('payroll-audit:'||NEW.tenant_id::text||':'||NEW.company_id::text||':'||NEW.pay_period,0));
 NEW.content_hash:=app.payroll_audit_hash(NEW.content::text);
 SELECT c.content_hash INTO v_latest FROM public.payroll_audit_capture c
  WHERE c.tenant_id=NEW.tenant_id AND c.company_id=NEW.company_id AND c.pay_period=NEW.pay_period AND c.source_key=NEW.source_key
  ORDER BY c.seq DESC LIMIT 1;
 IF v_latest IS NOT DISTINCT FROM NEW.content_hash THEN RETURN NULL; END IF;
 SELECT c.seq,c.chain_hash INTO v_seq,v_prev FROM public.payroll_audit_capture c
  WHERE c.tenant_id=NEW.tenant_id AND c.company_id=NEW.company_id AND c.pay_period=NEW.pay_period ORDER BY c.seq DESC LIMIT 1;
 NEW.seq:=coalesce(v_seq,0)+1;
 NEW.prev_hash:=coalesce(v_prev,'GENESIS');
 NEW.chain_hash:=app.payroll_audit_chain_hash(NEW.prev_hash,NEW.tenant_id,NEW.company_id,NEW.pay_period,NEW.seq,NEW.kind,NEW.source_key,
  NEW.content_hash,NEW.captured_at,NEW.writer,NEW.writer_id);
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_audit_capture_chain BEFORE INSERT ON public.payroll_audit_capture
 FOR EACH ROW EXECUTE FUNCTION app.payroll_audit_capture_chain_tg();
--> statement-breakpoint
CREATE TRIGGER payroll_audit_capture_append_only BEFORE UPDATE OR DELETE ON public.payroll_audit_capture
 FOR EACH ROW EXECUTE FUNCTION app.teras_outcome_append_only();
--> statement-breakpoint
-- The anchor: every inserted capture, finding, disposition and root cause appends one domain event with its hashes, attributed
-- to the row's own writer (which the insert policies pin to the actual login or agent principal). SECURITY DEFINER because the
-- agent principal's own domain_event inserts are restricted to closed shapes (0819); this function writes only this one shape,
-- from the row just inserted, and nothing a caller supplies.
CREATE FUNCTION app.payroll_audit_anchor_tg() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_payload jsonb; v_type text; v_actor text; v_actor_id uuid;
BEGIN
 IF TG_TABLE_NAME='payroll_audit_capture' THEN
  v_type:='payroll-audit.captured'; v_actor:=NEW.writer; v_actor_id:=NEW.writer_id;
  v_payload:=jsonb_build_object('companyId',NEW.company_id,'payPeriod',NEW.pay_period,'batchId',NEW.batch_id,'seq',NEW.seq,'kind',NEW.kind,
   'sourceKey',NEW.source_key,'contentHash',NEW.content_hash,'prevHash',NEW.prev_hash,'chainHash',NEW.chain_hash);
 ELSIF TG_TABLE_NAME='payroll_audit_finding' THEN
  v_type:='payroll-audit.finding-opened'; v_actor:=NEW.writer; v_actor_id:=NEW.writer_id;
  v_payload:=jsonb_build_object('companyId',NEW.company_id,'payPeriod',NEW.pay_period,'batchId',NEW.batch_id,'controlId',NEW.control_id,
   'subjectKey',NEW.subject_key,'evidenceHash',NEW.evidence_hash);
 ELSIF TG_TABLE_NAME='payroll_audit_disposition' THEN
  v_type:='payroll-audit.finding-disposed'; v_actor:='user'; v_actor_id:=NEW.disposed_by_user_id;
  v_payload:=jsonb_build_object('companyId',NEW.company_id,'findingId',NEW.finding_id,'disposition',NEW.disposition,
   'noteHash',app.payroll_audit_hash(NEW.note));
 ELSE
  v_type:='payroll-audit.correction-cause-recorded'; v_actor:='user'; v_actor_id:=NEW.recorded_by_user_id;
  v_payload:=jsonb_build_object('companyId',NEW.company_id,'payPeriod',NEW.pay_period,'batchId',NEW.batch_id,'correctionKey',NEW.correction_key,
   'rootCause',NEW.root_cause,'noteHash',app.payroll_audit_hash(NEW.note));
 END IF;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
  VALUES (NEW.tenant_id,'payroll-audit',NEW.id,v_type,v_actor::public.actor_type,v_actor_id,NULL,v_payload);
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_audit_anchor_tg() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER payroll_audit_capture_anchor AFTER INSERT ON public.payroll_audit_capture
 FOR EACH ROW EXECUTE FUNCTION app.payroll_audit_anchor_tg();
--> statement-breakpoint
-- 5. Control findings and their dispositions.
CREATE TABLE public.payroll_audit_finding (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 pay_period text NOT NULL CHECK (pay_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 batch_id uuid,
 -- The employment the finding is about, where it is about one. Not a foreign key, so evidence outlives the record.
 employment_id uuid,
 control_id text NOT NULL CHECK (control_id IN ('bank_change_before_pay_day','shared_bank_account','pay_after_last_day',
  'pay_without_attendance','preparer_closed_run','adjustment_without_reason','formula_changed_open_period')),
 subject_key text NOT NULL CHECK (subject_key ~ '^[a-z_]+:[0-9A-Za-z:._-]{1,160}$'),
 evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=16384),
 evidence_hash text NOT NULL DEFAULT '',
 -- The logins the finding is about, derived by the hash trigger from the evidence; none of them may dispose of it.
 subject_user_ids uuid[] NOT NULL DEFAULT '{}',
 detected_at timestamptz NOT NULL DEFAULT now(),
 writer text NOT NULL CHECK (writer IN ('agent','user')),
 writer_id uuid NOT NULL,
 run_id uuid,
 UNIQUE (tenant_id,control_id,subject_key),
 UNIQUE (id,tenant_id),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 CHECK (evidence_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX payroll_audit_finding_company_idx ON public.payroll_audit_finding(tenant_id,company_id,pay_period);
--> statement-breakpoint
CREATE FUNCTION app.payroll_audit_finding_hash_tg() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 NEW.evidence_hash:=app.payroll_audit_hash(NEW.evidence::text);
 NEW.subject_user_ids:=ARRAY(SELECT DISTINCT v.id::uuid FROM (VALUES (NEW.evidence->>'userId'),(NEW.evidence->>'changedBy'),(NEW.evidence->>'createdBy'))
  v(id) WHERE v.id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ORDER BY 1);
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_audit_finding_hash BEFORE INSERT ON public.payroll_audit_finding
 FOR EACH ROW EXECUTE FUNCTION app.payroll_audit_finding_hash_tg();
--> statement-breakpoint
CREATE TRIGGER payroll_audit_finding_append_only BEFORE UPDATE OR DELETE ON public.payroll_audit_finding
 FOR EACH ROW EXECUTE FUNCTION app.teras_outcome_append_only();
--> statement-breakpoint
CREATE TRIGGER payroll_audit_finding_anchor AFTER INSERT ON public.payroll_audit_finding
 FOR EACH ROW EXECUTE FUNCTION app.payroll_audit_anchor_tg();
--> statement-breakpoint
CREATE TABLE public.payroll_audit_disposition (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 finding_id uuid NOT NULL,
 company_id uuid NOT NULL,
 disposition text NOT NULL CHECK (disposition IN ('expected','corrected','false_positive','escalated')),
 note text NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 1000),
 disposed_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 disposed_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (finding_id,tenant_id) REFERENCES public.payroll_audit_finding(id,tenant_id),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id)
);
--> statement-breakpoint
CREATE INDEX payroll_audit_disposition_finding_idx ON public.payroll_audit_disposition(tenant_id,finding_id,disposed_at DESC);
--> statement-breakpoint
CREATE TRIGGER payroll_audit_disposition_append_only BEFORE UPDATE OR DELETE ON public.payroll_audit_disposition
 FOR EACH ROW EXECUTE FUNCTION app.teras_outcome_append_only();
--> statement-breakpoint
CREATE TRIGGER payroll_audit_disposition_anchor AFTER INSERT ON public.payroll_audit_disposition
 FOR EACH ROW EXECUTE FUNCTION app.payroll_audit_anchor_tg();
--> statement-breakpoint
-- 6. Root causes of post-run corrections. correction_key names the correction: `status:<payroll_status_history id>`.
CREATE TABLE public.payroll_audit_correction_cause (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 pay_period text NOT NULL CHECK (pay_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 batch_id uuid NOT NULL,
 correction_key text NOT NULL CHECK (correction_key ~ '^status:[0-9a-f-]{36}$'),
 root_cause text NOT NULL CHECK (root_cause IN ('late_input','input_error','employee_data','configuration','rule_or_formula',
  'missed_exception','statutory_change','other')),
 note text NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 1000),
 recorded_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id)
);
--> statement-breakpoint
CREATE INDEX payroll_audit_correction_cause_idx ON public.payroll_audit_correction_cause(tenant_id,company_id,pay_period,correction_key);
--> statement-breakpoint
CREATE TRIGGER payroll_audit_correction_cause_append_only BEFORE UPDATE OR DELETE ON public.payroll_audit_correction_cause
 FOR EACH ROW EXECUTE FUNCTION app.teras_outcome_append_only();
--> statement-breakpoint
CREATE TRIGGER payroll_audit_correction_cause_anchor AFTER INSERT ON public.payroll_audit_correction_cause
 FOR EACH ROW EXECUTE FUNCTION app.payroll_audit_anchor_tg();
--> statement-breakpoint
-- 7. Control settings per company.
CREATE TABLE public.payroll_audit_control_setting (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 bank_change_days integer NOT NULL DEFAULT 7 CHECK (bank_change_days BETWEEN 3 AND 30),
 adjustment_threshold numeric(12,2) NOT NULL DEFAULT 1000.00 CHECK (adjustment_threshold BETWEEN 100.00 AND 50000.00),
 preparer_closed_mode text NOT NULL DEFAULT 'info' CHECK (preparer_closed_mode IN ('info','finding')),
 version integer NOT NULL DEFAULT 1 CHECK (version>=1),
 changed_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 changed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,company_id),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id)
);
--> statement-breakpoint
CREATE TRIGGER payroll_audit_control_setting_version BEFORE UPDATE ON public.payroll_audit_control_setting
 FOR EACH ROW EXECUTE FUNCTION app.teras_bump_version('version');
--> statement-breakpoint
-- Loosening a control needs a group administrator: a shorter bank-change window, a higher adjustment amount, or the
-- preparer-closed check turned from a finding into information. Compared with the row before, or with the defaults.
CREATE FUNCTION app.payroll_audit_control_setting_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE v_days integer:=7; v_amount numeric:=1000.00; v_mode text:='info';
BEGIN
 IF TG_OP='UPDATE' THEN v_days:=OLD.bank_change_days; v_amount:=OLD.adjustment_threshold; v_mode:=OLD.preparer_closed_mode; END IF;
 IF (NEW.bank_change_days<v_days OR NEW.adjustment_threshold>v_amount OR (v_mode='finding' AND NEW.preparer_closed_mode='info'))
  AND app.is_group_admin() IS NOT TRUE THEN
  RAISE EXCEPTION 'Only a group administrator may loosen a payroll audit control' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_audit_control_setting_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER payroll_audit_control_setting_guard BEFORE INSERT OR UPDATE ON public.payroll_audit_control_setting
 FOR EACH ROW EXECUTE FUNCTION app.payroll_audit_control_setting_guard();
--> statement-breakpoint
-- ── RLS: forced on every new table ──
ALTER TABLE public.payroll_audit_reader ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_audit_reader FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_audit_capture ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_audit_capture FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_audit_finding ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_audit_finding FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_audit_disposition ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_audit_disposition FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_audit_correction_cause ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_audit_correction_cause FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_audit_control_setting ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_audit_control_setting FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Auditor grants: the auditor reads their own; administrators of the company read, grant and revoke them, under their own
-- current login, attributed to them. An administrator never grants themselves.
CREATE POLICY payroll_audit_reader_own_read ON public.payroll_audit_reader FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app_user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY payroll_audit_reader_admin_read ON public.payroll_audit_reader FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.current_user_id() IS NOT NULL AND app.is_admin_for(company_id));
--> statement-breakpoint
CREATE POLICY payroll_audit_reader_admin_insert ON public.payroll_audit_reader FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.is_admin_for(company_id) AND granted_by_user_id=app.current_user_id() AND app_user_id<>app.current_user_id()
  AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM public.app_user u WHERE u.id=payroll_audit_reader.app_user_id AND u.tenant_id=app.current_tenant_id()));
--> statement-breakpoint
CREATE POLICY payroll_audit_reader_admin_revoke ON public.payroll_audit_reader FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE AND app.is_admin_for(company_id))
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id) AND revoked_by_user_id=app.current_user_id());
--> statement-breakpoint
-- Captures: the agent principal writes while the loop may write for the company (switched on, tenant not stopped, company not
-- paused); a payroll administrator writes under their own current login (a capture before an audit pack is built). Readers:
-- the agent principal, and the people app.payroll_audit_can_read admits.
CREATE POLICY payroll_audit_capture_agent_insert ON public.payroll_audit_capture FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND writer='agent' AND writer_id=app.current_agent_principal()
  AND app.teras_loop_may_write('loop_payroll_audit',company_id) IS TRUE);
--> statement-breakpoint
CREATE POLICY payroll_audit_capture_user_insert ON public.payroll_audit_capture FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND writer='user' AND writer_id=app.current_user_id()
  AND app.principal_snapshot_current() IS TRUE AND app.can_admin_payroll_for(company_id) IS TRUE AND run_id IS NULL);
--> statement-breakpoint
CREATE POLICY payroll_audit_capture_agent_read ON public.payroll_audit_capture FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY payroll_audit_capture_read ON public.payroll_audit_capture FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.payroll_audit_can_read(company_id) IS TRUE);
--> statement-breakpoint
-- Findings: written by the agent principal (the daily loop) or by a payroll administrator running the checks under their own
-- login; read like captures.
CREATE POLICY payroll_audit_finding_agent_insert ON public.payroll_audit_finding FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND writer='agent' AND writer_id=app.current_agent_principal()
  AND app.teras_loop_may_write('loop_payroll_audit',company_id) IS TRUE);
--> statement-breakpoint
CREATE POLICY payroll_audit_finding_user_insert ON public.payroll_audit_finding FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND writer='user' AND writer_id=app.current_user_id()
  AND app.principal_snapshot_current() IS TRUE AND app.can_admin_payroll_for(company_id) IS TRUE AND run_id IS NULL);
--> statement-breakpoint
CREATE POLICY payroll_audit_finding_agent_read ON public.payroll_audit_finding FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY payroll_audit_finding_read ON public.payroll_audit_finding FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.payroll_audit_can_read(company_id) IS TRUE);
--> statement-breakpoint
-- Dispositions: only a payroll administrator of the finding's company, under their own current login, who is not what the
-- finding is about (none of its subject logins, and not the person its employment belongs to). An auditor reads them.
CREATE POLICY payroll_audit_disposition_insert ON public.payroll_audit_disposition FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND disposed_by_user_id=app.current_user_id() AND app.can_admin_payroll_for(company_id) IS TRUE
  AND EXISTS (SELECT 1 FROM public.payroll_audit_finding f WHERE f.id=payroll_audit_disposition.finding_id AND f.tenant_id=app.current_tenant_id()
   AND f.company_id=payroll_audit_disposition.company_id AND NOT (app.current_user_id()=ANY(f.subject_user_ids))
   AND NOT EXISTS (SELECT 1 FROM public.employment e WHERE e.id=f.employment_id AND app.is_self_person(e.person_id) IS TRUE)));
--> statement-breakpoint
CREATE POLICY payroll_audit_disposition_agent_read ON public.payroll_audit_disposition FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY payroll_audit_disposition_read ON public.payroll_audit_disposition FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.payroll_audit_can_read(company_id) IS TRUE);
--> statement-breakpoint
-- Root causes: a payroll administrator of the company, for a run of that company, under their own current login.
CREATE POLICY payroll_audit_correction_cause_insert ON public.payroll_audit_correction_cause FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND recorded_by_user_id=app.current_user_id() AND app.can_admin_payroll_for(company_id) IS TRUE
  AND EXISTS (SELECT 1 FROM public.payroll_batch b WHERE b.id=payroll_audit_correction_cause.batch_id AND b.tenant_id=app.current_tenant_id()
   AND b.company_id=payroll_audit_correction_cause.company_id AND b.pay_period=payroll_audit_correction_cause.pay_period));
--> statement-breakpoint
CREATE POLICY payroll_audit_correction_cause_agent_read ON public.payroll_audit_correction_cause FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY payroll_audit_correction_cause_read ON public.payroll_audit_correction_cause FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.payroll_audit_can_read(company_id) IS TRUE);
--> statement-breakpoint
-- Settings: read by the agent principal and the company's readers; written by a payroll administrator of the company.
CREATE POLICY payroll_audit_control_setting_agent_read ON public.payroll_audit_control_setting FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY payroll_audit_control_setting_read ON public.payroll_audit_control_setting FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.payroll_audit_can_read(company_id) IS TRUE);
--> statement-breakpoint
CREATE POLICY payroll_audit_control_setting_insert ON public.payroll_audit_control_setting FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.can_admin_payroll_for(company_id) IS TRUE AND changed_by_user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY payroll_audit_control_setting_update ON public.payroll_audit_control_setting FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.can_admin_payroll_for(company_id) IS TRUE)
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.can_admin_payroll_for(company_id) IS TRUE AND changed_by_user_id=app.current_user_id());
--> statement-breakpoint
-- ── Grants: exactly what each table needs, everything else revoked ──
REVOKE ALL ON public.payroll_audit_reader,public.payroll_audit_capture,public.payroll_audit_finding,public.payroll_audit_disposition,
 public.payroll_audit_correction_cause,public.payroll_audit_control_setting FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.payroll_audit_capture,public.payroll_audit_finding,public.payroll_audit_disposition,
 public.payroll_audit_correction_cause TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON public.payroll_audit_reader,public.payroll_audit_control_setting TO ai_hr_app;
