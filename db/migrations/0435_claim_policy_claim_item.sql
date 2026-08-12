-- e7eb5d83 rev 5 · SUB-CLAIM LIMITS — claim_policy gains the second level it was always missing.
--
-- THE SHAPE OF THE PROBLEM, and why revision 4 got it wrong. Rev 4 deflected the reporter's third point
-- as a request for "a third group/claim/sub-claim level" and scoped it out. It is not a third level. On
-- their own data MEDICAL 001 is the claim TYPE and MEDICAL 002 / MEDICAL 003 (Outpatient / Inpatient) are
-- its `claim_item` rows — the SECOND level, which has existed since the module shipped. It simply had
-- nowhere to hold a limit: claim_item has no limit columns and claim_policy had no claim_item_id. The
-- screen could list Outpatient under Medical and say "shares Medical's limit", and that was all it could
-- ever say. This column is the whole storage change the feature needs.
--
-- ONE NULLABLE COLUMN, NO BACKFILL, NO DEFAULT CHANGE. Every existing row keeps claim_item_id NULL, which
-- is exactly what it means today: a limit on the claim TYPE, applying to the type and to every item under
-- it. Nothing re-prices, nothing re-resolves, and the column is inert until a reader asks for it.
--
-- ⚠️ THE RESOLUTION HAZARD THIS COLUMN CREATES, recorded here because the column is where it starts.
-- Every existing type-level read filters on (claim_type_id, grade_id) and nothing else. The moment an
-- item row exists, those reads see it as just another version of the type's policy — and since resolution
-- picks the latest valid_from, a sub-claim limit saved today would OUTRANK and replace the claim type's
-- own limit for every employee. The three readers that had to gain `claim_item_id IS NULL` in the same
-- change are getActiveClaimPolicy, listClaimLimits, and — the one that actually destroys data —
-- setClaimPolicy's close-and-insert predicate, which becomes a three-way null-safe compare on
-- (type, grade, item). Without that third arm, saving a limit for Outpatient CLOSES Medical's own open
-- version: the type limit does not change value, it stops existing. Pinned by
-- test/claims-limits.test.ts ("setting a sub-claim limit does not close the type's policy version").
--
-- NO GRANT IS OWED. This is an ALTER on a table that already exists; claim_policy's grants and its RLS
-- policy (migration 0031) are column-agnostic and already cover every column on the table. A GRANT is
-- owed by a CREATE TABLE, and this is not one.
--
-- NO DATA PRECONDITION. `gate:shadow` dumps schema only and cannot verify a migration whose correctness
-- depends on rows; this one has no such dependency. ADD COLUMN ... NULL is valid against an empty table
-- and against production's 6 claim_policy rows alike, the FK targets claim_item which has existed since
-- 0032, and there is nothing to backfill because NULL is already the correct value for every row.

-- ── the column ──────────────────────────────────────────────────────────────────────────────────────
-- NULL = a limit on the claim TYPE (every row today). Non-null = a limit on that one sub-claim, which
-- is checked IN ADDITION to its type's limit, never instead of it.
ALTER TABLE "claim_policy"
  ADD COLUMN IF NOT EXISTS "claim_item_id" uuid;
--> statement-breakpoint

ALTER TABLE "claim_policy"
  DROP CONSTRAINT IF EXISTS "claim_policy_claim_item_id_claim_item_id_fk";
--> statement-breakpoint
ALTER TABLE "claim_policy"
  ADD CONSTRAINT "claim_policy_claim_item_id_claim_item_id_fk"
  FOREIGN KEY ("claim_item_id") REFERENCES "public"."claim_item"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- ── the lookup index ────────────────────────────────────────────────────────────────────────────────
-- claim_policy_type_grade_idx stops being sufficient the moment item rows share the table: the type-level
-- read now carries a fourth predicate (claim_item_id IS NULL) and the item-level read a fifth (= the id),
-- and both sort on valid_from. Column order matches the predicate order the resolver actually issues.
CREATE INDEX IF NOT EXISTS "claim_policy_type_grade_item_idx"
  ON "claim_policy" USING btree ("claim_type_id", "grade_id", "claim_item_id", "valid_from");
