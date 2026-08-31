-- ADR-0084 §2.3 — THE PROPOSAL LEDGER. One table, written by every automated proposer in the product.
--
-- WHY THIS EXISTS. Before it, there was no edge anywhere in this codebase from an AI output back to an
-- AI input. Nothing a model produced was ever recorded against what happened to it, so nothing could
-- improve without a developer editing a prompt, and nobody could say whether any of it helped. This is
-- the table that closes that loop, and it is the precondition for ADR-0083 §2.5's per-action autonomy
-- (r235 shipped `AutonomyLevel` as a one-member union precisely because there was nothing to measure).
--
-- ⚠️ THE THREE VERDICT COLUMN GROUPS ARE SEPARATE ON PURPOSE AND THE CHECKS BELOW MAKE THAT STRUCTURAL.
-- `adjudication` is THE MACHINE'S verdict, `decision` is A HUMAN'S, and `reversed_at` is LATER REALITY.
-- Their combinations are three DIFFERENT failures — the dangerous one being a high agreement rate
-- alongside a high reversal rate, which means the humans are rubber-stamping and looks like success in
-- every other metric. A single "was it good?" column cannot tell "the model was wrong" from "the model
-- was right and the human disagreed" from "everyone was wrong and reality corrected them a month later".
-- The CHECKs enforce the ordering so the distinction cannot be lost by a careless write:
--   · a REJECTED proposal was never shown to anybody, so it can carry no human decision;
--   · a reversal only means something for a proposal that was APPROVED;
--   · a rejection must say which check refused it, or the adjudication-pass rate is unactionable.
--
-- `proposal_type` DELIBERATELY HAS NO CHECK CONSTRAINT, which departs from 0451's precedent and is not an
-- oversight. There, `at_ceiling` was OPERATOR-SETTABLE and a CHECK stopped somebody configuring a
-- behaviour the code ignores. Here the column is written only by code, against a closed TypeScript union
-- at the single call site, and a CHECK would mean a MIGRATION FOR EVERY NEW AI SURFACE — friction that
-- would discourage exactly the adoption this table needs to be worth having.
--
-- NO `FORCE ROW LEVEL SECURITY`, per 0451: the only FORCE'd table in the repo is ai_provider_config
-- (0059), which holds a key ciphertext. Nothing here is a cross-tenant secret, and FORCE would make
-- every backfill written as ai_hr_owner match zero rows with no error.

CREATE TABLE IF NOT EXISTS "agent_proposal" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),

  -- Closed vocabulary, enforced in TypeScript at the only writer. See the note above on why not here.
  "proposal_type" text NOT NULL,

  -- What the proposal is ABOUT, when it is about an existing record (a verdict, an employment, a claim).
  -- BOTH NULL for authoring proposals — a drafted pay rule or report spec has no subject row yet,
  -- because nothing is written until the admin saves it.
  "subject_type" text,
  "subject_id" uuid,

  -- Hash of the facts the model saw. Makes identical inputs comparable across time AND across model
  -- versions, which is the only way to tell a prompt regression from a harder month.
  "input_digest" text NOT NULL,

  -- The structured output itself. Never free prose that matters, never a number that matters (§2.1).
  "proposal" jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- ── THE MACHINE'S VERDICT ──
  "adjudication" text NOT NULL,
  "adjudication_reason" text,

  -- ── THE HUMAN'S VERDICT ──
  "decision" text,
  "decided_by_user_id" uuid REFERENCES "app_user"("id"),
  "decided_at" timestamptz,

  -- ── LATER REALITY ──
  "reversed_at" timestamptz,
  "reversal_reason" text,

  -- NULL for a deterministic proposer, which is why these are nullable and why the table is called
  -- agent_proposal rather than ai_proposal (ADR-0084 §2.3 as-built note).
  "provider" text,
  "model" text,

  "proposed_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "agent_proposal_adjudication_ck"
    CHECK ("adjudication" IN ('accepted', 'rejected')),
  CONSTRAINT "agent_proposal_decision_ck"
    CHECK ("decision" IS NULL OR "decision" IN ('approved', 'declined')),
  -- A rejected proposal never reached a human, so it cannot carry a human decision.
  CONSTRAINT "agent_proposal_rejected_undecided_ck"
    CHECK ("adjudication" = 'accepted' OR "decision" IS NULL),
  -- A rejection that does not say which check refused it makes the pass rate unactionable.
  CONSTRAINT "agent_proposal_reject_reason_ck"
    CHECK ("adjudication" = 'accepted' OR "adjudication_reason" IS NOT NULL),
  -- Reversal is only meaningful for something that was approved.
  --
  -- ⚠️ `IS NOT DISTINCT FROM`, NOT `=`, AND THE DIFFERENCE IS THE ENTIRE CONSTRAINT. With a plain `=`,
  -- an undecided row (`decision` NULL) makes the right branch evaluate to NULL, so the whole expression
  -- is `false OR NULL` = NULL — and **a CHECK only rejects on FALSE, never on NULL.** The constraint
  -- would have accepted exactly the row it exists to forbid, while reading as if it worked.
  -- `IS NOT DISTINCT FROM` is NULL-safe and always yields true or false.
  CONSTRAINT "agent_proposal_reversal_ck"
    CHECK ("reversed_at" IS NULL OR "decision" IS NOT DISTINCT FROM 'approved'),
  -- The decision and its timestamp travel together, both ways.
  CONSTRAINT "agent_proposal_decided_together_ck"
    CHECK (("decision" IS NULL) = ("decided_at" IS NULL))
);
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- The three rates (§2.3) are all per-type over a window. This is the query they all make.
CREATE INDEX IF NOT EXISTS "agent_proposal_type_time_idx"
  ON "agent_proposal" ("tenant_id", "proposal_type", "proposed_at" DESC);
--> statement-breakpoint

-- "What has been proposed about this record?" — needed to stamp a decision against the right row, and
-- the substrate for §2.4's recurrence signal (a finding that re-fires after a fix was approved).
CREATE INDEX IF NOT EXISTS "agent_proposal_subject_idx"
  ON "agent_proposal" ("tenant_id", "subject_type", "subject_id")
  WHERE "subject_id" IS NOT NULL;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- GRANTS
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- The GRANT looks redundant and is not: production's ALTER DEFAULT PRIVILEGES (deploy/bootstrap-db.sql
-- :72-75) hands ai_hr_app full CRUD on every owner-created table, so an omission is invisible on every
-- cluster bootstrapped that way and surfaces as "permission denied" on a RESTORED developer cluster,
-- after the deploy. Same reasoning as 0418/0419/0420/0421/0425/0451.
--
-- REVOKE DELETE IS THE LOAD-BEARING HALF, and neither the cleanroom nor the suite catches its absence.
-- This is a MEASUREMENT ledger: a deletable row means an unflattering rate can be tidied away, and an
-- accuracy figure that can be edited is not an accuracy figure. Rejections especially — they are the
-- denominator of the adjudication-pass rate and the least comfortable rows in the table.
GRANT SELECT, INSERT, UPDATE ON "agent_proposal" TO ai_hr_app;
--> statement-breakpoint
REVOKE DELETE ON "agent_proposal" FROM ai_hr_app;
--> statement-breakpoint

-- ai_hr_platform is deliberately NOT granted: it is not covered by ALTER DEFAULT PRIVILEGES
-- (bootstrap-db.sql:64-68) and this is an ordinary tenant table. Granting it would widen the control
-- plane's cross-tenant view past what ADR-0077 D5 authorises.

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- RLS — THREE POLICIES, AND THE SPLIT BETWEEN THEM IS THE WHOLE DESIGN
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- READ IS ADMIN-ONLY. The rows reference employments and carry proposals about named people; a
-- tenant-wide read would let any employee enumerate what the system has been proposing about their
-- colleagues. That is the surveillance surface ADR-0082 §2.7 refuses to build, and it must not arrive
-- here by accident.
--
-- INSERT IS TENANT-WIDE, AND THAT IS NOT AN OVERSIGHT — it is 0451's assistant_usage lesson applied
-- before it bites. Today every proposer runs in an admin session. Tomorrow ADR-0084 §2.5's nudge sweep
-- runs in a SYSTEM context and §2.7's input triage runs in the EMPLOYEE'S OWN session as they submit a
-- claim. An admin-only insert policy would make those writes match ZERO ROWS — silently, with no error —
-- so the ledger would quietly stop recording exactly the surfaces it was built to measure. A ledger that
-- cannot be written is worse than no ledger, because it reports as configured.
--
-- What keeps that honest instead: DELETE is revoked above, the CHECKs make the verdict ordering
-- structural, and UPDATE (stamping a human decision or a reversal) stays admin-only below.
--
-- ⚠️ `FOR INSERT` HAS NO `USING` CLAUSE AND SO DOES NOT WIDEN SELECT. This is the reason it is written as
-- FOR INSERT rather than FOR ALL: a FOR ALL write policy ALSO matches SELECT and Postgres OR-combines
-- permissive policies (0059:34-35, 0451), which would silently turn the admin-only read above into a
-- tenant-wide one. Consequently a non-admin session CANNOT use INSERT ... RETURNING here (RETURNING
-- needs SELECT), which is why core/agent-proposal.ts generates the row id in TypeScript instead.
ALTER TABLE "agent_proposal" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_proposal_read" ON "agent_proposal";
--> statement-breakpoint
CREATE POLICY "agent_proposal_read" ON "agent_proposal" FOR SELECT
  USING ("tenant_id" = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_proposal_insert" ON "agent_proposal";
--> statement-breakpoint
CREATE POLICY "agent_proposal_insert" ON "agent_proposal" FOR INSERT
  WITH CHECK ("tenant_id" = app.current_tenant_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_proposal_decide" ON "agent_proposal";
--> statement-breakpoint
CREATE POLICY "agent_proposal_decide" ON "agent_proposal" FOR UPDATE
  USING ("tenant_id" = app.current_tenant_id() AND app.is_admin())
  WITH CHECK ("tenant_id" = app.current_tenant_id() AND app.is_admin());
