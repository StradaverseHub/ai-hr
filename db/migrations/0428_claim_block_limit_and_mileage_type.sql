-- e7eb5d83 rev 4 — the two structural halves of the Claim Module round: PER BLOCK limits (point 3c) and
-- the mileage claim type flag (point 4 step 1). One migration because point 4's step order is only safe
-- if the column exists before anything is repointed at it.
--
-- NOTHING HERE CHANGES AN EXISTING ROW'S BEHAVIOUR. Every claim_policy row already reads as "no per-block
-- rule" (all four columns NULL), and is_mileage defaults false for every claim type except the one the
-- backfill below identifies from the tenant's own live mileage_flat policy.
--
-- ⚠️ THERE IS STILL NO reserved_amount COLUMN AND THERE MUST NOT BE ONE. The reservation is DERIVED from
-- RESERVING_STATUSES (core/claims.ts) — a stored counter is what gets decremented twice and silently
-- frees limit that is still consumed. Per block is a new SCOPE over the same derived sum, nothing more.

-- ── 1. claim_policy: per-block limits ────────────────────────────────────────────────────────────────
-- "RM2,000 every 2 years", "RM300 every 6 months". The existing vocabulary (per claim / calendar month /
-- calendar year / lifetime / count per year) has no way to express a period that is N units long, so this
-- is four new columns rather than a reinterpretation of an old one.
--
-- block_start_on is the ANCHOR, and it is deliberately policy-level: one company-wide cycle, the way the
-- monthly and yearly limits already behave. Anchoring per employee (hire date, first claim) would put
-- every employee on a different cycle and make "when does the pot refill" unanswerable.
ALTER TABLE "claim_policy" ADD COLUMN IF NOT EXISTS "block_length" integer;
--> statement-breakpoint
ALTER TABLE "claim_policy" ADD COLUMN IF NOT EXISTS "block_unit" text;
--> statement-breakpoint
ALTER TABLE "claim_policy" ADD COLUMN IF NOT EXISTS "block_limit" numeric(12, 2);
--> statement-breakpoint
ALTER TABLE "claim_policy" ADD COLUMN IF NOT EXISTS "block_start_on" date;
--> statement-breakpoint

-- ALL FOUR OR NONE. A half-filled rule is not a weaker rule, it is an unanswerable one: a length with no
-- anchor cannot say which window a claim falls in, and an amount with no length cannot say for how long.
-- setClaimPolicy refuses the partial case with a readable message first; this CHECK is the backstop for
-- anything that reaches the table another way.
ALTER TABLE "claim_policy" DROP CONSTRAINT IF EXISTS "claim_policy_block_ck";
--> statement-breakpoint
ALTER TABLE "claim_policy" ADD CONSTRAINT "claim_policy_block_ck" CHECK (
  (
    "block_length" IS NULL AND "block_unit" IS NULL
    AND "block_limit" IS NULL AND "block_start_on" IS NULL
  ) OR (
    "block_length" IS NOT NULL AND "block_length" > 0
    AND "block_unit" IN ('month', 'year')
    AND "block_limit" IS NOT NULL AND "block_limit" >= 0
    AND "block_start_on" IS NOT NULL
  )
);
--> statement-breakpoint

-- ── 2. claim_type.is_mileage ─────────────────────────────────────────────────────────────────────────
-- Which claim type IS the mileage claim. Until now the only thing that made a claim a mileage claim was
-- its resolved claim_policy carrying rate_config = {kind:'mileage_flat'} — an effective-dated, PER-GRADE
-- row. So whether the employee saw a distance box depended on which grade's limit resolved, and the
-- banded Mileage Rates table could only be reached through a legacy scalar the limits screen had to keep
-- asking for. Being the mileage type is a property of the TYPE.
ALTER TABLE "claim_type" ADD COLUMN IF NOT EXISTS "is_mileage" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- ── 3. BACKFILL, before the unique index ─────────────────────────────────────────────────────────────
-- Marks the claim type each tenant is already treating as its mileage type: the one with an OPEN policy
-- version whose rate_config kind is mileage_flat. Production (tenant 1111…): MILEAGE 001, ratePerKm 0.70.
--
-- DISTINCT ON (tenant_id) is not tidiness — it is what keeps this migration from failing on a tenant that
-- somehow has two mileage_flat types, which the unique index created next would refuse. Ordered by
-- created_at so the pick is the oldest one and therefore deterministic on a re-run.
WITH "mileage_pick" AS (
  SELECT DISTINCT ON (ct."tenant_id") ct."id"
  FROM "claim_type" ct
  JOIN "claim_policy" cp ON cp."claim_type_id" = ct."id"
  WHERE ct."archived_at" IS NULL
    AND cp."valid_to" IS NULL
    AND cp."rate_config" ->> 'kind' = 'mileage_flat'
  ORDER BY ct."tenant_id", ct."created_at", ct."id"
)
UPDATE "claim_type" SET "is_mileage" = true
WHERE "id" IN (SELECT "id" FROM "mileage_pick");
--> statement-breakpoint

-- ── 4. One live mileage type per tenant ──────────────────────────────────────────────────────────────
-- Enforced in the DB, not only in the service: "which type is the mileage one" is read by the employee
-- form, the submit pricing path and the Mileage Rates screen, and two answers means three readers
-- disagreeing about what an employee is filing. Archived rows are excluded so retiring a mileage type
-- does not block naming a new one.
CREATE UNIQUE INDEX IF NOT EXISTS "claim_type_tenant_mileage_uq"
  ON "claim_type" ("tenant_id")
  WHERE "is_mileage" AND "archived_at" IS NULL;
--> statement-breakpoint

-- ── GRANTS / RLS ─────────────────────────────────────────────────────────────────────────────────────
-- No new TABLE is created here, so there is nothing to GRANT and no policy to write: claim_policy and
-- claim_type already carry their grants and their RLS, and both apply column-blind. (Stated rather than
-- silently omitted — a CREATE TABLE without a GRANT is the omission production's ALTER DEFAULT PRIVILEGES
-- hides until a dev cluster restored from a dump throws permission denied on the first render.)
SELECT 1;
