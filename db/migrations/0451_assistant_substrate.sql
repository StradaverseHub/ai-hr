-- ADR-0082 slice 2 — the AI assistant's substrate: who may ask, what was asked, what it cost.
--
-- WHY FOUR TABLES AND NOT ONE. The assistant does not retrieve. It calls the reads the SCREENS already
-- call, inside the caller's own SessionContext, so Postgres enforces scope for it (ADR-0082 §1). That
-- means none of these tables holds tenant business data, and none of them is a derived index of any.
-- What they hold is the three things RLS cannot answer on its own: an ADMIN'S DECISION about who may
-- use the feature, a USER'S OWN HISTORY, and a TENANT'S SPEND.
--
-- THERE IS NO app.is_self_user(). ADR-0082 §2.7 and §3 both name one; it does not exist and never has
-- (none of the functions in the `app` schema is keyed on app_user.id). The precedent for "this row is
-- mine" is a BARE COLUMN COMPARISON against app.current_user_id(), used twice already — kb_document
-- (0039:24,31,40) and custom_report (0165:48). This migration follows it and defines no fifth helper:
-- app.current_user_id() already returns the app_user.id, and a one-call wrapper would add a SECURITY
-- DEFINER function to the attack surface to save eight characters. It fails closed on a system
-- transaction: db/client.ts:184 passes `ctx.userId ?? ''`, so current_user_id() is NULL there and
-- `app_user_id = NULL` is NULL, not true — the policy matches NO rows rather than all of them.
--
-- assistant_grant HAS NO `allowed` COLUMN, and that is a deliberate departure from the ADR §3 sketch.
-- `allowed boolean` and `revoked_at timestamptz` are two mechanisms for one fact, and the partial
-- unique index below treats (allowed = false, revoked_at IS NULL) as a LIVE row — so the grant read
-- would need a special case that a reviewer will eventually drop. A live row IS the grant. There are no
-- group grants for an explicit DENY to override.
--
-- at_ceiling ADMITS ONLY 'refuse'. §8 decision 3 settled the behaviour as refuse-and-say-so, and
-- nothing implements 'degrade'. A CHECK that admits a value the code ignores lets an operator set a
-- ceiling behaviour that silently does nothing. Widening it when degrade is built is one ALTER.
--
-- NO FORCE ROW LEVEL SECURITY on any of these. The only FORCE'd table in the repo is
-- ai_provider_config (0059), because it holds a key ciphertext the app role must not read. Nothing
-- here is a cross-tenant secret, and FORCE would make every seed/backfill written as ai_hr_owner match
-- zero rows with no error.

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- TABLES
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "assistant_grant" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "app_user_id" uuid NOT NULL REFERENCES "app_user"("id"),
  "granted_by_user_id" uuid REFERENCES "app_user"("id"),
  "granted_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_by_user_id" uuid REFERENCES "app_user"("id"),
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "assistant_exchange" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "app_user_id" uuid NOT NULL REFERENCES "app_user"("id"),
  "asked_at" timestamptz NOT NULL DEFAULT now(),
  "question" text NOT NULL,
  "answer" text,
  -- [{ name, input, rowCount }] — the tool INPUTS and the row counts, never the rows themselves.
  "tool_calls" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "turn_count" integer NOT NULL DEFAULT 0,
  "hit_turn_cap" boolean NOT NULL DEFAULT false,
  "stop" text,
  "provider" text,
  "model" text,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "cached_input_tokens" integer NOT NULL DEFAULT 0,
  -- GENERIC. A provider body may carry a key fragment or another tenant's request id.
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "assistant_exchange_stop_ck"
    CHECK ("stop" IS NULL OR "stop" IN ('end', 'tool_use', 'max_tokens', 'refusal', 'other'))
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "assistant_budget" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "monthly_token_ceiling" bigint NOT NULL,
  "per_user_daily_questions" integer NOT NULL,
  "at_ceiling" text NOT NULL DEFAULT 'refuse',
  "effective_from" date NOT NULL DEFAULT CURRENT_DATE,
  "created_by_user_id" uuid REFERENCES "app_user"("id"),
  "archived_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "assistant_budget_at_ceiling_ck" CHECK ("at_ceiling" IN ('refuse')),
  CONSTRAINT "assistant_budget_nonneg_ck"
    CHECK ("monthly_token_ceiling" >= 0 AND "per_user_daily_questions" >= 0)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "assistant_usage" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "period" text NOT NULL,
  "input_tokens" bigint NOT NULL DEFAULT 0,
  "output_tokens" bigint NOT NULL DEFAULT 0,
  "cached_input_tokens" bigint NOT NULL DEFAULT 0,
  "exchange_count" integer NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "assistant_usage_period_ck" CHECK ("period" ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT "assistant_usage_nonneg_ck"
    CHECK ("input_tokens" >= 0 AND "output_tokens" >= 0
           AND "cached_input_tokens" >= 0 AND "exchange_count" >= 0)
);
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- At most ONE live grant per user. Revoked rows accumulate on purpose (the audit answer).
CREATE UNIQUE INDEX IF NOT EXISTS "assistant_grant_live_uq"
  ON "assistant_grant" ("tenant_id", "app_user_id")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assistant_grant_tenant_granted_idx"
  ON "assistant_grant" ("tenant_id", "granted_at");
--> statement-breakpoint

-- Serves BOTH the user's own history list AND the per-user daily-question cap, which has no other
-- counter: assistant_usage is per-tenant-per-month and cannot answer a per-user-per-day question.
CREATE INDEX IF NOT EXISTS "assistant_exchange_user_asked_idx"
  ON "assistant_exchange" ("tenant_id", "app_user_id", "asked_at" DESC);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "assistant_budget_live_uq"
  ON "assistant_budget" ("tenant_id", "effective_from")
  WHERE "archived_at" IS NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "assistant_usage_period_uq"
  ON "assistant_usage" ("tenant_id", "period");
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- GRANTS — and three REVOKEs that are the load-bearing half.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- The GRANTs look redundant and are not: production's ALTER DEFAULT PRIVILEGES (deploy/bootstrap-db.sql
-- :72-75) hands ai_hr_app full CRUD on every owner-created table, so an omission is invisible on every
-- cluster bootstrapped that way and surfaces as "permission denied for table assistant_grant" on a
-- RESTORED developer cluster, after the deploy. Same reasoning as 0418 / 0419 / 0420 / 0421 / 0425.
--
-- THE REVOKES ARE THE PART NOTHING ELSE CATCHES. Because the default privileges already granted DELETE,
-- "revocation is a stamp, not a delete" and "the usage counter cannot be reset" are only true if DELETE
-- is taken away here. Neither the cleanroom nor the suite can catch a missing REVOKE (0280:45-50,
-- 0313:14) — test/assistant-grant-rls.test.ts asserts has_table_privilege(...,'DELETE') is FALSE.
GRANT SELECT, INSERT, UPDATE ON "assistant_grant" TO ai_hr_app;
--> statement-breakpoint
REVOKE DELETE ON "assistant_grant" FROM ai_hr_app;
--> statement-breakpoint

-- The transcript keeps DELETE: a user erasing their OWN history is the PDPA right, and RLS below scopes
-- it to their own rows. (Retention length is ADR-0082 §8 decision 4, still open.)
GRANT SELECT, INSERT, UPDATE, DELETE ON "assistant_exchange" TO ai_hr_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "assistant_budget" TO ai_hr_app;
--> statement-breakpoint
REVOKE DELETE ON "assistant_budget" FROM ai_hr_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "assistant_usage" TO ai_hr_app;
--> statement-breakpoint
REVOKE DELETE ON "assistant_usage" FROM ai_hr_app;
--> statement-breakpoint

-- ai_hr_platform is deliberately NOT granted anything here: it is not covered by ALTER DEFAULT
-- PRIVILEGES (bootstrap-db.sql:64-68) and these are ordinary tenant tables. Granting it would widen
-- the control plane's cross-tenant view past what ADR-0077 D5 authorises — and for assistant_exchange
-- it would recreate, at the platform level, exactly the surveillance surface §2.7 refuses to build
-- at the tenant level.

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- GRANT: read is self-OR-admin, write is admin-only. Two policies, not one, because they have different
-- predicates — and note that the FOR ALL write policy ALSO matches SELECT and Postgres OR-combines
-- permissive policies (0059:34-35), so the effective read is (self OR admin) OR admin = self OR admin.
-- Reading is NOT tenant-wide: ADR §3 says "a user may see whether they hold it", which is satisfied by
-- the self branch. Tenant-wide would let any employee enumerate who has the assistant.
ALTER TABLE "assistant_grant" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "assistant_grant_read" ON "assistant_grant";
--> statement-breakpoint
CREATE POLICY "assistant_grant_read" ON "assistant_grant" FOR SELECT
  USING (
    "tenant_id" = app.current_tenant_id()
    AND ("app_user_id" = app.current_user_id() OR app.is_admin())
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "assistant_grant_write" ON "assistant_grant";
--> statement-breakpoint
CREATE POLICY "assistant_grant_write" ON "assistant_grant" FOR ALL
  USING ("tenant_id" = app.current_tenant_id() AND app.is_admin())
  WITH CHECK ("tenant_id" = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint

-- EXCHANGE: self only, with NO ADMIN BRANCH ANYWHERE. This is the one policy in the migration whose
-- absence of a clause is the design (ADR-0082 §2.7). app.is_admin() must never appear here.
ALTER TABLE "assistant_exchange" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "assistant_exchange_rls" ON "assistant_exchange";
--> statement-breakpoint
CREATE POLICY "assistant_exchange_rls" ON "assistant_exchange" FOR ALL
  USING ("tenant_id" = app.current_tenant_id() AND "app_user_id" = app.current_user_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id() AND "app_user_id" = app.current_user_id());
--> statement-breakpoint

-- BUDGET: tenant-wide read (an employee's own budget check runs in the EMPLOYEE'S session and must be
-- able to read the ceiling — a monthly token allowance is not personal data), admin-only write.
ALTER TABLE "assistant_budget" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "assistant_budget_read" ON "assistant_budget";
--> statement-breakpoint
CREATE POLICY "assistant_budget_read" ON "assistant_budget" FOR SELECT
  USING ("tenant_id" = app.current_tenant_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "assistant_budget_write" ON "assistant_budget";
--> statement-breakpoint
CREATE POLICY "assistant_budget_write" ON "assistant_budget" FOR ALL
  USING ("tenant_id" = app.current_tenant_id() AND app.is_admin())
  WITH CHECK ("tenant_id" = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint

-- USAGE: tenant-wide FOR ALL, AND THAT IS NOT AN OVERSIGHT. Every exchange is an ORDINARY EMPLOYEE'S
-- transaction, and it is that transaction which must advance the counter the ceiling is checked
-- against. An admin-only write policy here would make every employee's usage write match zero rows —
-- silently, with no error — so the monthly counter would never move and the ceiling would never fire.
-- A budget that cannot be reached is worse than no budget, because it reports as configured.
-- What keeps it honest instead: the counter is only ever advanced by an ON CONFLICT DO UPDATE that ADDS
-- to the stored value (monotonic by construction in the only code path), the CHECK forbids negatives,
-- and DELETE is revoked above so the period row cannot be dropped to start over.
ALTER TABLE "assistant_usage" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "assistant_usage_rls" ON "assistant_usage";
--> statement-breakpoint
CREATE POLICY "assistant_usage_rls" ON "assistant_usage" FOR ALL
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());
