-- UNNUMBERED REVIEW DRAFT. NOT A MIGRATION, INSTALLER OR QUALIFIED IMPLEMENTATION.
-- All roles/schema/API names are proposed vocabulary; the controller allocates real SQL.
-- Deliberately abort one transaction before any DDL. Even psql without ON_ERROR_STOP leaves
-- the entire transaction aborted until the final ROLLBACK. Do not source this file in deployment.
BEGIN;
DO $$ BEGIN RAISE EXCEPTION 'REVIEW PROPOSAL ONLY: controller implementation/qualification required'; END $$;

-- DBA prerequisite, NOT performed by this proposal:
-- ai_hr_notification_worker LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB
-- NOCREATEROLE NOREPLICATION; zero role memberships; CONNECT on exact database only.
-- No app/owner/platform SET edge. No app/identity_email/private schema USAGE.
-- No source table/column/sequence grant, even SELECT. No shared schema CREATE.
-- Inspect inherited PUBLIC privileges; a per-role REVOKE does not override PUBLIC.

CREATE SCHEMA notification_worker AUTHORIZATION ai_hr_owner;
CREATE SCHEMA notification_worker_private AUTHORIZATION ai_hr_owner;
REVOKE ALL ON SCHEMA notification_worker,notification_worker_private FROM PUBLIC,ai_hr_app,ai_hr_platform;

CREATE TABLE notification_worker_private.authority (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 enabled boolean NOT NULL DEFAULT false,
 login_oid oid NOT NULL,
 api_version integer NOT NULL CHECK (api_version>0),
 max_batch_events integer NOT NULL CHECK (max_batch_events BETWEEN 1 AND 5000),
 max_run_batches integer NOT NULL CHECK (max_run_batches BETWEEN 1 AND 10000),
 max_run_seconds integer NOT NULL CHECK (max_run_seconds BETWEEN 1 AND 3600)
);

CREATE TABLE notification_worker_private.run (
 run_id uuid PRIMARY KEY REFERENCES public.job_run(id),
 login_oid oid NOT NULL,
 backend_pid integer NOT NULL,
 backend_started_at timestamptz NOT NULL,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 state text NOT NULL DEFAULT 'running' CHECK (state IN ('running','completed','failed')),
 committed_batches integer NOT NULL DEFAULT 0 CHECK (committed_batches>=0),
 processed_events bigint NOT NULL DEFAULT 0 CHECK (processed_events>=0),
 created_notifications bigint NOT NULL DEFAULT 0 CHECK (created_notifications>=0)
);

CREATE TABLE notification_worker_private.run_scope (
 run_id uuid NOT NULL REFERENCES notification_worker_private.run(run_id),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 standing text NOT NULL,
 consumer text CHECK (consumer IN ('notifications','assessment-reminders')),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','completed','skipped','capped','blocked','failed')),
 backlog_pending bigint CHECK (backlog_pending>=0),
 backlog_oldest_seconds double precision CHECK (backlog_oldest_seconds>=0),
 backlog_observed_at timestamptz,
 PRIMARY KEY (run_id,tenant_id)
);

CREATE TABLE notification_worker_private.batch (
 batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 run_id uuid NOT NULL,
 tenant_id uuid NOT NULL,
 consumer text NOT NULL CHECK (consumer IN ('notifications','assessment-reminders')),
 login_oid oid NOT NULL,
 backend_pid integer NOT NULL,
 backend_started_at timestamptz NOT NULL,
 admitted_xid xid8 NOT NULL,
 opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 event_count integer NOT NULL CHECK (event_count BETWEEN 0 AND 5000),
 FOREIGN KEY (run_id,tenant_id) REFERENCES notification_worker_private.run_scope(run_id,tenant_id),
 UNIQUE (login_oid,backend_pid,backend_started_at,admitted_xid)
);

CREATE TABLE notification_worker_private.batch_event (
 batch_id uuid NOT NULL REFERENCES notification_worker_private.batch(batch_id) ON DELETE CASCADE,
 event_id uuid NOT NULL REFERENCES public.domain_event(id),
 event_sequence bigint NOT NULL,
 disposition text CHECK (disposition IN ('processed','ignored')),
 finished boolean NOT NULL DEFAULT false,
 PRIMARY KEY (batch_id,event_id),
 CHECK (finished=(disposition IS NOT NULL))
);

CREATE TABLE notification_worker_private.batch_effect (
 batch_id uuid NOT NULL,
 event_id uuid NOT NULL,
 effect_key text NOT NULL,
 notification_id uuid REFERENCES public.notification(id),
 effect_kind text NOT NULL CHECK (effect_kind IN ('employment-notification','account-notification','reminder-preparation')),
 created boolean NOT NULL,
 FOREIGN KEY (batch_id,event_id) REFERENCES notification_worker_private.batch_event(batch_id,event_id) ON DELETE CASCADE,
 PRIMARY KEY (batch_id,event_id,effect_key)
);

-- New private-schema tables must not inherit the public-schema app CRUD defaults.
-- RLS is additional protection, not a substitute for absence of caller grants.
ALTER TABLE notification_worker_private.authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_worker_private.run ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_worker_private.run_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_worker_private.batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_worker_private.batch_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_worker_private.batch_effect ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA notification_worker_private FROM PUBLIC,ai_hr_app,ai_hr_platform;

-- Exact public API SIGNATURE contract follows. Bodies are intentionally NOT stubbed as working
-- functions: this file is not an implementation and cannot be adopted as qualified source.
-- All are SECURITY DEFINER owned by ai_hr_owner, SET search_path=pg_catalog,pg_temp;
-- schema-qualify EVERY application/private relation and helper, with no dynamic caller SQL.
-- Each function checks SESSION_USER's pg_roles OID against enabled authority; current_user in
-- SECURITY DEFINER is insufficient. Validate native role/profile and no forbidden memberships.
-- Batch APIs additionally join protected run/batch/event state, checking backend PID/start and
-- pg_current_xact_id(), not a caller GUC, temp row, JSON flag or guessed UUID.
--
-- notification_worker.open_run() RETURNS uuid
-- notification_worker.scope_page(uuid,uuid,integer)
--   RETURNS TABLE(tenant_id uuid,standing text,consumer text,entitlement_facts jsonb)
-- notification_worker.open_batch(uuid,uuid,integer) RETURNS uuid
-- notification_worker.events(uuid)
--   RETURNS TABLE(event_id uuid,aggregate_type text,aggregate_id uuid,event_type text,
--                 subject_employment_id uuid,payload jsonb,event_sequence bigint)
-- notification_worker.facts(uuid,uuid,text) RETURNS jsonb
-- notification_worker.prepare_assessment(uuid,uuid,jsonb) RETURNS uuid[]
-- notification_worker.project(uuid,uuid,text,uuid,jsonb,text)
--   RETURNS TABLE(notification_id uuid,created boolean)
-- notification_worker.project_reward_account(uuid,uuid) RETURNS integer
-- notification_worker.finish_event(uuid,uuid,text) RETURNS void
-- notification_worker.finish_batch(uuid) RETURNS TABLE(processed integer,created integer)
-- notification_worker.settle_scope(uuid,uuid,text)
--   RETURNS TABLE(pending bigint,oldest_seconds double precision,observed_at timestamptz)
-- notification_worker.finish_run(uuid) RETURNS void
-- notification_worker.fail_run(uuid,text) RETURNS void
--
-- BODY-LEVEL REQUIRED INVARIANTS:
-- open_run: fixed job key notifications.project, native clock and counters; session singleton
-- try-lock plus real physical backend identity. No caller key/source/status/counters.
-- Scope: server tenant enumeration excluding zero UUID, native standing/purchase checks;
-- actual caller cannot select consumer or invent entitlements. Relevant snapshot only.
-- open_batch: same pg_advisory_xact_lock(hashtextextended('notification-cursor:'||tenant,0))
-- as current projection. Select pending receipt/source rows ORDER BY event_sequence bounded;
-- no sequence>cursor gate; verify/fix lock ordering against legacy before allocation.
-- Store exact admitted rows tied to session/backend/start/xid before returning IDs/payload.
-- facts: closed event-compatible family enumeration from companion design; derive all object
-- IDs and internal maintenance context from native admitted source. No generic query port.
-- prepare_assessment: exact event->reminder->run/cycle/user linkage; bounded existing outcome,
-- tasks/mail_words/deadline fields, second epoch CAS and existing clearing semantics only.
-- project: same-tenant admitted event/recipient and closed canonical kind/category contract;
-- existing duplicate/existence behavior under tenant transaction lock; INSERT notification then
-- internal canonical conditional enqueue. Never lease/deliver/send or modify recipient grants.
-- project_reward_account: only admitted native reward-access.suspended; reuse existing internal
-- account notification projector, not any Rewards authority/role mutation.
-- finish_event: exact admitted event, processed/ignored only, matching bounded effects.
-- finish_batch: require all admitted events finished; update only still-pending exact receipt
-- rows and assert affected count; greatest-cursor update for correct consumer; aggregate ACTUAL
-- inserts/preparations, delete batch (cascade protected child rows), all before caller COMMIT.
-- settle_scope: own native pending/oldest query, no supplied counts; enum reason cannot improve
-- health; standing/module changes skip/refuse honestly. Empty backlog is a sampled observation.
-- finish_run: derive scope/counter/outcome solely from private state and native observations;
-- exact still-running job_run CAS; no incomplete scope/batch/pending/failed work called success.
-- fail_run: safe closed failure code only; preserve commits; cannot reopen or alter other job.
-- Commit failure is uncertain, not permission to replay business work.
--
-- Mutations by fixed owner API bodies ONLY (zero login table grants):
-- notification INSERT canonical employment/account-addressed projection fields;
-- notification_delivery INSERT via canonical enqueue ONLY;
-- notification_event_processing UPDATE(disposition,processed_at) admitted exact pending rows;
-- notification_cursor INSERT/UPDATE correct monotonic consumer cursor and updated_at;
-- performance_assessment_reminder_recipient UPDATE(outcome,tasks,mail_words,prepared_at,
-- prepared_until,tenant_epoch,cycle_epoch) event-derived reminder row ONLY;
-- job_run fixed notifications.project start / native aggregate terminal CAS;
-- private protected state above. Audit permitted-write trigger effects before implementation.
--
-- Once bodies are implemented in a controller-owned migration, REVOKE ALL on EACH EXACT
-- signature FROM PUBLIC,ai_hr_app,ai_hr_platform and grant EXECUTE only to the dedicated login.
-- Grant USAGE on notification_worker only. Never grant ALL FUNCTIONS, schema CREATE, private
-- schema access, app USAGE, direct source SELECT/CRUD, sequence privileges or app-role SET.
-- Authenticate/revalidate inherited PUBLIC schema/function/table privileges on installation.
-- No broad revocation of unrelated application privileges is prescribed by this draft.

ROLLBACK;
