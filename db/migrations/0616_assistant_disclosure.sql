-- Centrally reserved source-only: 0616_assistant_disclosure, journal idx 616, timestamp 1792997586568.
-- UNJOURNALED / UNAPPLIED. Earlier unjournaled 0602-0604 reservations are surrendered.
-- Prerequisite order: Operator 0601, then frozen Standalone 0612 (idx612/1792997586564).
-- Refresh canonical overlap and actual staging watermark before journal/application; never skip 0612.
-- Existing historical answers have no canonical disclosure proof and are never backfilled as trusted.
ALTER TABLE public.assistant_exchange ADD COLUMN disclosure_receipt text;
ALTER TABLE public.assistant_exchange ADD CONSTRAINT assistant_exchange_disclosure_size_ck
  CHECK (disclosure_receipt IS NULL OR octet_length(disclosure_receipt) <= 786432);
-- Existing RLS/current-user custody and append-only audit policy remain in force.
-- This encrypted receipt contains lookup inputs and fingerprints, never duplicate source result rows.
