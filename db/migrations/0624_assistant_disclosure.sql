-- Centrally reserved source-only filename tag: 0624_assistant_disclosure; journal index/timestamp DEFERRED.
-- UNJOURNALED / UNAPPLIED. Supersedes surrendered AI0613-0620 reservations.
-- Preserve actual human journal prerequisites; final index/when allocated centrally at source freeze.
-- Refresh canonical prefix and actual staging watermark before release-owner journal/application.
ALTER TABLE public.assistant_exchange ADD COLUMN disclosure_receipt text;
ALTER TABLE public.assistant_exchange ADD CONSTRAINT assistant_exchange_disclosure_size_ck
  CHECK (disclosure_receipt IS NULL OR octet_length(disclosure_receipt) <= 786432);
-- Existing RLS/current-user custody and append-only audit policy remain in force.
-- This encrypted receipt contains lookup inputs and fingerprints, never duplicate source result rows.
