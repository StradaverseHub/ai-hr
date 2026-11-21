-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5080_access_administrator_coalesced_assert, idx 4480, when 1793330004780.
-- Draft name on its branch: 9990_access_administrator_coalesced_assert. Any draft note below describes that unallocated branch position.
-- Draft name 9990_access_administrator_coalesced_assert (idx 9990, when 1793330099990). The integrator allocates the
-- final number; it runs after the reader/writer Access lock migrations (5000-5006).
--
-- Last-administrator rule, asserted once per transaction instead of once per row.
--
-- Before: the deferred row triggers access_role_administrator (role_assignment), access_user_administrator
-- (app_user) and access_employment_administrator (employment) each called app.access_assert_administrator() for
-- every row a tenant session wrote (employment rows only when the old or new person has a login). The answer is
-- about the tenant's state at commit and is the same for every row, so a transaction writing N such rows paid the
-- 75-90 ms assertion N times.
--
-- Now: the same three triggers and the same function app.access_administrator_constraint() keep every early return
-- (other tenant or no tenant in session, employment without a login). Where the function used to assert, it records
-- "this transaction owes tenant t one assertion" as a row (xid,tenant_id) in the private queue
-- app.access_administrator_assert_pending, ON CONFLICT DO NOTHING. The queue's own deferred trigger
-- access_administrator_assert_run deletes that row and then runs app.access_assert_administrator_for(t), which is
-- what app.access_assert_administrator() ran for the session tenant t. The refusal is raised by that same unchanged
-- function, so SQLSTATE 23514 and the message 'access last administrator' are the same. This is the pending-table
-- and one-deferred-row shape of the audit-chain commit seal (5090).
--
-- Why the decision is identical. Call a firing of a row trigger that reaches the old assertion a relevant event.
-- 1. The assertion always runs after the last relevant event. PostgreSQL fires deferred events in queue order and an
--    event queued while they fire is fired after every event already queued. A relevant event either inserts the
--    queue row, whose run is therefore queued behind every row event then pending, or finds this transaction's row
--    still present, which means its run has not fired yet (the run deletes the row first). A relevant event that
--    fires after a run (a deferred trigger wrote one of the three tables at commit) finds no row and queues a new
--    run. So every relevant event is followed by a run, and the last run follows the last relevant event.
-- 2. Every evaluation gives the same answer. The assertion reads only the tenant's administrator inputs. While
--    deferred events fire, the transaction's own inputs are changed by no deferred trigger except
--    access_role_default_install, and app.access_install_defaults asserts the rule itself straight after it
--    initializes a tenant (before that the rule does not apply). Concurrent changes are excluded exactly as before:
--    this migration does not touch app.access_administrator_guard, app.access_administrator_set_lock or
--    app.access_lock_legacy_writer, the guard row and the Access lock are held to commit, and the run is a VOLATILE
--    function, so under READ COMMITTED it takes a fresh snapshot and sees a removal that committed while this
--    transaction waited on the guard, as the per-row check did (REPEATABLE READ still fails 40001 on the guard row).
--    Hence the N per-row evaluations and the one coalesced evaluation agree: both raise or both pass.
-- 3. Remove-then-restore still commits and restore-then-remove is still refused, because the one evaluation is made
--    on the final state. Should a later migration add a deferred trigger that changes those inputs while deferred
--    events fire, point 2 would need that trigger reviewed; the coalesced check would still judge a state no older
--    than the one the last per-row check judged, so the two could differ only in favour of the later state.
--
-- SET CONSTRAINTS ALL IMMEDIATE makes the queue trigger immediate as well, so each relevant event asserts at once,
-- exactly as before (no coalescing in that mode, same refusals at the same statements). Naming only the three row
-- triggers in SET CONSTRAINTS no longer forces the assertion early; name app.access_administrator_assert_run too.
-- No source names these triggers in SET CONSTRAINTS today.
--
-- Order against the audit-chain seal (5090). The run is queued one step behind the row events, as the seal is queued
-- one step behind its arm trigger. When a transaction wrote its first sealed audit event before its first relevant
-- row, its seal fires before the run and the audit-chain key is held across that one assertion; in the usual order
-- (row first, audit event after) the run fires first, as all the per-row assertions did.
--
-- Unchanged: owner and maintenance sessions (no tenant in session) queue nothing and assert nothing; direct callers
-- of app.access_assert_administrator() and app.access_assert_administrator_for(uuid) (the Access editor commit,
-- default installation, the employee import Revert release) keep their own call.
--
-- The queue is private: no grant, RLS enabled with no policy, written only by the two SECURITY DEFINER trigger
-- functions. Its rows never outlive their transaction (inserted and deleted while its deferred events fire) and are
-- keyed by transaction, so two transactions of one tenant never meet on it. No trigger is created on a populated
-- table and no populated table is locked: the three row triggers are untouched and only their function is replaced.
CREATE TABLE app.access_administrator_assert_pending (
 xid xid8 NOT NULL,
 tenant_id uuid NOT NULL,
 PRIMARY KEY (xid,tenant_id)
);
--> statement-breakpoint
ALTER TABLE app.access_administrator_assert_pending ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE app.access_administrator_assert_pending FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- One run per queued row. The row goes first, so a relevant write that arrives after this point queues a new run.
CREATE FUNCTION app.access_administrator_assert_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 DELETE FROM app.access_administrator_assert_pending q WHERE q.xid=NEW.xid AND q.tenant_id=NEW.tenant_id;
 PERFORM app.access_assert_administrator_for(NEW.tenant_id);
 RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_administrator_assert_run() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER access_administrator_assert_run AFTER INSERT ON app.access_administrator_assert_pending
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.access_administrator_assert_run();
--> statement-breakpoint
-- The 5000 body with one change: the assertion call becomes the queue insert. A NULL row tenant in a session without
-- a tenant used to assert for no tenant, which never refuses; it now returns with the other owner-session rows.
CREATE OR REPLACE FUNCTION app.access_administrator_constraint() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid; old_person uuid; new_person uuid;
BEGIN
 IF TG_OP='DELETE' THEN t:=OLD.tenant_id; ELSE t:=NEW.tenant_id; END IF;
 IF t IS NULL OR t IS DISTINCT FROM app.current_tenant_id() THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='employment' THEN
  IF TG_OP<>'INSERT' THEN old_person:=OLD.person_id; END IF;
  IF TG_OP<>'DELETE' THEN new_person:=NEW.person_id; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.tenant_id=t AND u.person_id IN (old_person,new_person)) THEN
   RETURN NULL;
  END IF;
 END IF;
 INSERT INTO app.access_administrator_assert_pending(xid,tenant_id) VALUES(pg_current_xact_id(),t)
  ON CONFLICT (xid,tenant_id) DO NOTHING;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
-- The row triggers' function writes the queue and the run calls the owner-only assertion, so the queue and the run
-- belong to the role that owns that function, whichever role runs this migration.
DO $assert_owner$
DECLARE native_owner name;
BEGIN
 SELECT r.rolname INTO STRICT native_owner FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
  WHERE p.oid='app.access_administrator_constraint()'::regprocedure;
 EXECUTE format('ALTER TABLE app.access_administrator_assert_pending OWNER TO %I',native_owner);
 EXECUTE format('ALTER FUNCTION app.access_administrator_assert_run() OWNER TO %I',native_owner);
END $assert_owner$;
