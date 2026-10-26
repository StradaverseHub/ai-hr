-- Centrally reserved source-only: 0624_assistant_disclosure, journal idx 617, timestamp 1793023949847.
-- UNJOURNALED / UNAPPLIED. Supersedes surrendered AI0613-0620 reservations.
-- Preserve frozen0612 and human0620_onehr_panel_manager_anonymity (idx613/1793023949843).
-- Refresh canonical prefix and actual staging watermark before release-owner journal/application.
ALTER TABLE public.assistant_exchange ADD COLUMN disclosure_receipt text;
ALTER TABLE public.assistant_exchange ADD CONSTRAINT assistant_exchange_disclosure_size_ck
  CHECK (disclosure_receipt IS NULL OR octet_length(disclosure_receipt) <= 786432);
-- Existing RLS/current-user custody and append-only audit policy remain in force.
-- This encrypted receipt contains lookup inputs and fingerprints, never duplicate source result rows.
