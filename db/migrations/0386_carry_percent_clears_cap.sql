-- 7cd914b1 rev 2 — a percentage carry no longer carries a day cap beside it.
--
-- WHY. 0349 added leave_type.carry_forward_percent and deliberately kept carry_forward_max working as a
-- CEILING on top of it (core/leave-compute.ts resolveCarryAllowance takes the smaller of the two). The
-- editor rendered both inputs, so a type set to "carry 50%" while still holding an old cap of 5 days
-- carried 5 days, and nothing on screen said which number had won. The reporter asked for the cap to go
-- in percentage mode. This migration clears the caps that would otherwise keep trimming silently.
--
-- (0349's own header still describes the cap as an intentional ceiling. It is NOT corrected there:
--  drizzle records a hash of every applied migration's contents, so an applied file is never edited.
--  This file is the correction of record.)
--
-- MEASURED ON PRODUCTION 2026-08-04, twice, immediately before shipping:
--
--     select count(*) from leave_type
--      where carry_forward_percent is not null and carry_forward_percent > 0 and carry_forward_max > 0;
--     -- 0
--
-- ZERO rows. Exactly one leave type (ANNUAL) holds a cap at all — 10.00 days — and it carries no
-- percentage, so it is not matched and is not touched. THIS MIGRATION IS A NO-OP ON PRODUCTION TODAY and
-- the release note says so plainly. It ships anyway because it is the guarantee, not the cleanup: a row
-- can reach the both-set state between this measurement and the deploy (or in any other environment,
-- or from a restored dump), and the invariant "percentage mode has no cap" must hold on arrival.
--
-- DIRECTION, UNAMBIGUOUS. Clearing a ceiling can only let MORE days carry, never fewer. Employee carry-in
-- at the next year open goes UP or stays flat; it cannot go down. Nothing is recomputed retroactively:
-- openLeaveYear posts carry at year open, so no existing ledger row is rewritten, deleted or reset, and
-- no employee's balance moves on deploy day. What can change visibly today is the PROJECTION surface that
-- previews carry (core/read.ts and core/analytics.ts both read carryMax and carryPercent), which will
-- preview the larger figure.
--
-- carry_forward_max is NOT removed and keeps every one of its readers — Fixed Maximum mode still uses it.

UPDATE leave_type
   SET carry_forward_max = 0
 WHERE carry_forward_percent IS NOT NULL
   AND carry_forward_percent > 0
   AND carry_forward_max > 0;
