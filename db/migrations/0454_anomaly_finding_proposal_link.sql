-- ADR-0084 §2.6 — THE EDGE FROM A FINDING BACK TO THE PROPOSAL THAT PRODUCED IT.
--
-- r238 makes a model able to CREATE a payroll finding for the first time (a hypothesis, severity
-- `review`, never `block`). Every finding before it was produced by a pure detector, so "which finding
-- came from a model, and from which proposal" was not a question the schema had to answer. It is now,
-- and the answer has to be a column rather than a convention:
--
--  1. **IT IS HOW THE HUMAN'S VERDICT GETS STAMPED.** When an operator resolves a verdict carrying a
--     hypothesis, `resolveAnomalyVerdict` must find the ledger row that hypothesis came from and record
--     approved / declined against it. Without this link that lookup is a guess — most recent accepted
--     proposal for this employment, hope it is the right one — and ADR-0084 §2.3's agreement rate is
--     only worth having if the row it lands on is the right row.
--  2. **IT IS WHAT MAKES THE LEDGER RE-USABLE AS A CACHE.** The nightly sweep supersedes and rewrites
--     every verdict, so an un-cached hypothesis layer would re-ask a provider the same question about
--     the same unchanged figures every night forever. `agent_proposal.input_digest` already defines
--     when two questions are the same one; this column is what lets a re-materialised finding point at
--     the ORIGINAL proposal rather than manufacture a duplicate.
--
-- NULLABLE, AND THAT IS NOT SLOPPINESS. Every finding a deterministic detector writes has no proposal
-- and never will. And `recordProposal` is best-effort by design (core/agent-proposal.ts property 1: a
-- ledger outage must never break the thing it measures) — so a finding whose ledger write failed is a
-- finding with a null link, not a lost finding.
--
-- ON DELETE SET NULL rather than CASCADE: `agent_proposal` has DELETE revoked from ai_hr_app precisely
-- so an unflattering rate cannot be tidied away (0452), but if a row is ever removed by the owner in a
-- data-repair, that must not silently delete a payroll finding an operator is looking at.
--
-- NO GRANT AND NO POLICY CHANGE. `payroll_anomaly_finding` already carries both; adding a column to a
-- granted table inherits the table's privileges and its RLS. (The GRANT-every-time rule in 0451/0452/0453
-- is about CREATE TABLE, which this is not.)
ALTER TABLE "payroll_anomaly_finding"
  ADD COLUMN IF NOT EXISTS "proposal_id" uuid REFERENCES "agent_proposal"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- Partial: only hypothesis findings carry one, and they are a small minority of the table.
CREATE INDEX IF NOT EXISTS "payroll_anomaly_finding_proposal_idx"
  ON "payroll_anomaly_finding" ("proposal_id")
  WHERE "proposal_id" IS NOT NULL;
