-- UNALLOCATED / UNJOURNALED / UNAPPLIED. Coordinate ordering before assigning a migration number.
-- Existing historical answers have no canonical disclosure proof and are never backfilled as trusted.
ALTER TABLE public.assistant_exchange ADD COLUMN disclosure_receipt text;
ALTER TABLE public.assistant_exchange ADD CONSTRAINT assistant_exchange_disclosure_size_ck
  CHECK (disclosure_receipt IS NULL OR octet_length(disclosure_receipt) <= 786432);
-- Existing RLS/current-user custody and append-only audit policy remain in force.
-- This encrypted receipt contains lookup inputs and fingerprints, never duplicate source result rows.
