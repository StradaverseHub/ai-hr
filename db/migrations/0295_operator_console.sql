-- Operator console (part 2 of 2): the operator predicate, the role_assignment tightening, and the
-- tenant_provision_request REQUEST QUEUE that click-to-provision is built on.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- THE ARCHITECTURAL DECISION, STATED ONCE
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Migration 0001's `tenant_isolation` policy means ai_hr_app CAN NEVER SELECT OR INSERT A TENANT. That
-- is the strongest isolation guarantee in this system and this feature DOES NOT TOUCH IT. There is no
-- SECURITY DEFINER "create tenant" function reachable from the web tier, and no grant that would let
-- one exist.
--
-- Instead the console is a REQUEST QUEUE:
--   web tier  → INSERTs an INTENT row here (customer name + admin email). That is all it can do.
--   runner    → scripts/provision-runner.ts, holding MIGRATION_DATABASE_URL (the table OWNER, which
--               bypasses RLS), does the actual provisioning and writes the terminal status back.
--   web tier  → polls this table and renders progress.
--
-- The owner credentials never reach the application. The application never learns how to make a tenant.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. app.is_operator() — the operator predicate ────────────────────────────────────────────────
--
-- Modelled exactly on app.is_group_admin() (0016 lines 38-44): STABLE, plain SQL, no SECURITY DEFINER,
-- reading the CURRENT SESSION's grants out of the app.grants GUC via app.current_grants().
--
-- current_grants() returns `role` AS TEXT (0016 line 8-14: `SELECT g->>'role', ...`), so the comparison
-- below is text-to-text. No ::role cast appears anywhere in this file. That is what makes it safe to
-- reference 'operator' here at all — see 0294's header.
--
-- LIKE is_group_admin(), THIS HAS NO TENANT DIMENSION, and unlike is_group_admin() that is not a
-- compromise: an operator is an installation-level identity, and tenant_provision_request is a
-- tenant-free table. There is exactly one operator population and it spans the installation.
CREATE OR REPLACE FUNCTION app.is_operator() RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM app.current_grants() g WHERE g.role = 'operator');
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.is_operator() TO ai_hr_app;
--> statement-breakpoint

-- ── 2. Tighten role_assignment_write: nobody mints an operator from the web tier ──────────────────
--
-- This is a TIGHTENING of the 0099 policy (which itself tightened 0023), and it is the reason the
-- operator tier cannot be self-granted. Without it, the group-admin branch (app.is_group_admin())
-- grants ANY role — so any customer's top HR admin could grant themselves 'operator' and reach the
-- provisioning console of the whole installation. That is a privilege-escalation path to the highest
-- tier in the system, opened by the mere existence of the enum value.
--
-- The new leading conjunct `role::text <> 'operator'` applies to BOTH branches, so:
--   • a group admin may still grant every customer role, but NOT operator;
--   • a delegated company admin is unchanged (still only subtree hr_admin);
--   • an operator grant can be created ONLY by ai_hr_owner, which bypasses RLS entirely.
--
-- TEXT LITERALS ONLY, per 0099's precedent and 0294's header: the enum COLUMN is cast to text and
-- compared with a text literal. The literal is never cast to ::role. `role::text = 'hr_admin'` in the
-- delegated branch replaces 0099's `role = 'hr_admin'` for exactly the same reason — the old form
-- relies on Postgres coercing the unknown literal to the enum type, which is precisely the operation
-- that is unsafe in the transaction that added a label. It is safe HERE (0294 has committed), but the
-- codified rule is "this policy never casts a literal to ::role", so it holds for whoever edits next.
--
-- USING is unaffected for existing rows (no existing row is 'operator'); WITH CHECK is what blocks the
-- new grant. Both carry the conjunct so an UPDATE cannot walk an existing grant up to operator either.
DROP POLICY role_assignment_write ON role_assignment;
--> statement-breakpoint
CREATE POLICY role_assignment_write ON role_assignment FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND role::text <> 'operator'
    AND (
      app.is_group_admin()
      OR (role::text = 'hr_admin' AND company_id IS NOT NULL AND app.is_admin_for(company_id))
    )
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND role::text <> 'operator'
    AND (
      app.is_group_admin()
      OR (role::text = 'hr_admin' AND company_id IS NOT NULL AND app.is_admin_for(company_id))
    )
  );
--> statement-breakpoint

-- ── 3. tenant_provision_request — the queue ───────────────────────────────────────────────────────
--
-- GLOBAL, NO tenant_id COLUMN (the job_run 0280 precedent). A provisioning request exists BEFORE the
-- tenant it creates, so it cannot be scoped by one; and it belongs to the installation, not to a
-- customer. `tenant_id` below is the RESULT (which tenant got made), not a scope key — it is null until
-- provisioning succeeds, and RLS never reads it.
--
-- `status` is PLAIN TEXT, not a pgEnum — the 0275 lesson: widening a pgEnum later needs a migration and
-- a lock, and this value set ('pending' | 'running' | 'failed' | 'done') is owned in code.
--
-- DELIBERATELY ABSENT (each was considered and cut):
--   • NO `steps jsonb` / mid-flight progress writes. Provisioning completes in seconds inside a
--     one-minute tick, so a 5s poll would never observe an intermediate step; and a step written on a
--     second connection would describe rows that may still roll back. `current_step` is written ONLY on
--     failure, from the code-side descriptor array, so it never claims more than it knows.
--   • NO unique index on customer_name. Real company names collide, the operator is one trusted human,
--     and an index here would permanently forbid re-using a legal name. With no index there is no 23505
--     path to handle anywhere.
--   • NO retry function. Provisioning is all-or-nothing, so a failed row is inert; "Retry" is simply a
--     new INSERT with the fields prefilled — a write path the operator already has.
CREATE TABLE tenant_provision_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_name text NOT NULL,
  admin_email text NOT NULL,
  -- pending → running → (done | failed). Terminal states are written by the runner only.
  status text NOT NULL DEFAULT 'pending',
  -- Written ONLY on failure, from the code-side step descriptors (core/operator.ts PROVISION_STEPS).
  current_step text,
  error text,
  -- The tenant this request CREATED (result, not scope). FK so a dangling pointer is impossible; the
  -- reference is intentional — a request row whose tenant vanished would be an unreadable audit record.
  tenant_id uuid REFERENCES tenant(id),
  -- The one-time /invite/<token> URL. READ IT ONLY THROUGH app.claim_activation_url() — see the grant
  -- block below, which withholds this column from ai_hr_app entirely.
  activation_url text,
  -- The RUNNER's claim stamp (set when status flips to 'running'), used by the stale-reclaim sweep.
  -- NOT the "operator revealed the URL" stamp — that event is recorded by activation_url becoming null.
  claimed_at timestamptz,
  -- Operator asked for a fresh activation link; the runner's reissue pass clears it.
  reissue_requested_at timestamptz,
  -- The operator's app_user id. Deliberately NO FK: this global row must not acquire a dependency on a
  -- per-tenant table, and the audit value is the id itself even if that login is later archived.
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Maintained by the runner (owner). The app's only UPDATE grant is reissue_requested_at, so an
  -- operator-initiated reissue does not move this column — that is accepted, not an oversight.
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- The runner's claim query: oldest pending first.
CREATE INDEX tenant_provision_request_status_idx ON tenant_provision_request (status, created_at);
--> statement-breakpoint

-- ── 4. RLS + grants — copying the 0280 recipe, INCLUDING THE EXPLICIT REVOKE ──────────────────────
--
-- The REVOKE is mandatory, not belt-and-braces. deploy/bootstrap-db.sql line 51 runs
--   ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_hr_app
-- so every new public table is auto-granted FULL CRUD to the app role. "Grant only what we need by
-- omission" does NOT make a table restricted here. And cleanroom-verify.sh reproduces that same ALTER
-- DEFAULT PRIVILEGES, so the cleanroom MASKS a missing GRANT and can NEVER catch a missing REVOKE —
-- test/operator-rls.test.ts is the only thing standing between a deleted line here and a leaked URL.
--
-- ENABLE, deliberately NOT FORCE — exactly as 0280. ENABLE subjects the non-owner app role to RLS while
-- the table OWNER bypasses it, which is precisely what lets the owner-role runner write while ai_hr_app
-- cannot. FORCE would also block the owner and break the only provisioning path there is.
ALTER TABLE tenant_provision_request ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

REVOKE ALL ON tenant_provision_request FROM ai_hr_app;
--> statement-breakpoint

-- COLUMN-LIMITED SELECT — every column EXCEPT activation_url.
--
-- THIS IS THE LOAD-BEARING LINE OF THE WHOLE FEATURE. "The activation link is shown exactly once" is
-- not app-layer discipline that a future refactor could forget; it is a privilege the app role does not
-- hold. No session — not an operator's, not anyone's — can read activation_url with a SELECT. The only
-- way to obtain it is app.claim_activation_url() below, which nulls it in the same statement that
-- returns it. A leaked query, an over-broad `select()`, a debug endpoint: none of them can surface it.
--
-- Practical consequence for callers, documented so it is not rediscovered as a bug: an unqualified
-- drizzle `.select()` on this table FAILS (it expands to every column, including the withheld one).
-- core/operator.ts listProvisionRequests therefore names its columns explicitly.
GRANT SELECT (
  id, customer_name, admin_email, status, current_step, error, tenant_id,
  claimed_at, reissue_requested_at, requested_by, created_at, updated_at
) ON tenant_provision_request TO ai_hr_app;
--> statement-breakpoint

-- TABLE-LEVEL INSERT, unlike the SELECT and UPDATE grants either side of it. This is deliberate and the
-- asymmetry is worth explaining, because "column-limited everywhere" is the tempting-but-wrong answer:
--
--   • It is FORCED. Drizzle emits every column in an INSERT's column list, filling unset ones with the
--     literal DEFAULT keyword. Postgres checks INSERT privilege against every column NAMED, so a
--     column-limited grant rejects the ORM's own statement — verified, not assumed.
--   • It COSTS NOTHING. The insert-side columns an operator could reach are inert: activation_url can be
--     written but never SELECTed back (see the grant above), so writing one is self-deception rather
--     than disclosure; status/tenant_id only affect how that operator's own console renders, and the
--     runner claims strictly on status = 'pending'. Nothing here crosses a customer boundary.
--   • The gate that MATTERS is still on: the INSERT policy below calls app.is_operator(), so a customer
--     admin cannot insert at all, with or without column limits.
--
-- The UPDATE grant is column-limited because there the asymmetry does pay — see below.
GRANT INSERT ON tenant_provision_request TO ai_hr_app;
--> statement-breakpoint

-- Column-limited UPDATE: the Reissue button, and nothing else. Unlike INSERT this one is both possible
-- (drizzle's UPDATE names only the columns actually being set) and worth having — it stops the app from
-- forging a terminal 'done' state, blanking a recorded error, re-pointing a tenant_id at another
-- customer, or clearing the runner's in-flight claim.
GRANT UPDATE (reissue_requested_at) ON tenant_provision_request TO ai_hr_app;
--> statement-breakpoint

-- No DELETE grant and no delete policy: requests are the durable record of every provisioning attempt.
CREATE POLICY tenant_provision_request_read ON tenant_provision_request
  FOR SELECT USING (app.is_operator());
--> statement-breakpoint
CREATE POLICY tenant_provision_request_insert ON tenant_provision_request
  FOR INSERT WITH CHECK (app.is_operator());
--> statement-breakpoint
CREATE POLICY tenant_provision_request_update ON tenant_provision_request
  FOR UPDATE USING (app.is_operator()) WITH CHECK (app.is_operator());
--> statement-breakpoint

-- ── 5. app.claim_activation_url — the ONLY read path to the activation URL ────────────────────────
--
-- SECURITY DEFINER (owner-owned, so it bypasses both the column grant and RLS) with an EXPLICIT
-- app.is_operator() gate as its first act — the definer rights are what make it able to read the
-- column, so the gate must be in the body, not in a policy.
--
-- Reveal-once is enforced by the STATEMENT, not by the caller: the UPDATE nulls the column and returns
-- the pre-update value in one shot. A second call finds activation_url already null, matches zero rows
-- and returns NULL.
--
-- WHY THE `FROM (SELECT ... FOR UPDATE) old` SHAPE: `UPDATE ... SET activation_url = NULL RETURNING
-- activation_url` would return the NEW value (i.e. NULL) — RETURNING sees the post-update row. Reading
-- the old value therefore requires a self-join against a snapshot taken before the write. FOR UPDATE on
-- that subquery is what makes two concurrent claims safe: the second claimant blocks on the row lock,
-- then (READ COMMITTED re-evaluation) re-reads the COMMITTED row with activation_url already null, so
-- `old.activation_url IS NOT NULL` is false, zero rows update, and it returns NULL. Exactly one caller
-- ever receives the URL. test/operator-rls.test.ts pins this with two concurrent claims.
--
-- claimed_at is deliberately NOT touched here — it is the runner's claim stamp (see the column comment).
CREATE OR REPLACE FUNCTION app.claim_activation_url(p_request_id uuid)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_url text;
BEGIN
  IF NOT app.is_operator() THEN
    RAISE EXCEPTION 'Only an operator can reveal an activation link.';
  END IF;

  UPDATE tenant_provision_request t
     SET activation_url = NULL,
         updated_at = now()
    FROM (
      SELECT r.id, r.activation_url
        FROM tenant_provision_request r
       WHERE r.id = p_request_id
         FOR UPDATE
    ) old
   WHERE t.id = old.id
     AND old.activation_url IS NOT NULL
  RETURNING old.activation_url INTO v_url;

  RETURN v_url;
END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.claim_activation_url(uuid) TO ai_hr_app;
