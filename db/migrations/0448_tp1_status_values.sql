-- 7ad37961 — TP1 GETS A REAL LIFECYCLE: the tp1_status vocabulary becomes
-- Draft → Submitted → Approved / Rejected → Cancelled, and NOTHING ELSE happens in this file.
--
-- `approved` is the status that gates the payroll feed from this round on (core/payroll.ts
-- prefillTp1FromSelfRelief), so the value has to exist before 0449 can stamp anything with it.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- ⚠️ WHY THIS IS A TYPE SWAP AND NOT `ALTER TYPE … ADD VALUE`. READ THIS BEFORE "SIMPLIFYING" IT.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
--
-- The obvious three-liner is `ALTER TYPE "tp1_status" ADD VALUE 'approved'` etc. It was written first,
-- and it FAILED — with `55P04: unsafe use of new value "approved" of enum type tp1_status`, thrown by
-- 0449's backfill UPDATE.
--
-- THE REASON IS A FACT ABOUT DRIZZLE THAT THIS REPO HAD WRITTEN DOWN WRONG. 0392's header says "drizzle
-- wraps each migration file in ONE transaction", and the standing note in AGENTS.md repeats the same
-- assumption when it says to split enum additions into their own migration AHEAD of the one that uses
-- them. Both are mistaken about the mechanism. drizzle-orm 0.45's `PgDialect.migrate` opens ONE
-- `session.transaction(...)` and replays EVERY PENDING FILE inside it
-- (node_modules/drizzle-orm/pg-core/dialect.js, the `for await (const migration of migrations)` loop).
--
-- So splitting into two files buys nothing WHEN BOTH FILES SHIP IN THE SAME RUN, which is exactly this
-- case. The split only ever worked for 0294/0295 and 0392 because those either landed in separate
-- deploys or, like 0392, never cast a literal to the enum at all (`status::text` against a text
-- constant is legal, which is the narrow exception 0392 documents correctly).
--
-- The fix that works inside one transaction is to not ADD a value to an existing type at all. Postgres
-- forbids USING a value ADDED to a pre-existing type in the same transaction; it has no such rule for a
-- type CREATED in that transaction. So the old type is renamed out of the way, a NEW `tp1_status` is
-- created with the full five-label vocabulary, the column is moved onto it through text, and the old
-- type is dropped. 0449 then stamps rows with a label belonging to a type this transaction created,
-- which is legal.
--
-- THE TWO FILES ARE STILL TWO FILES, and the numbers were allocated as a pair: 0448 owns the TYPE and
-- 0449 owns the TABLE. That separation is worth keeping for a reader even though it is no longer what
-- makes the pair legal — what makes it legal is the swap below.
--
-- SAFE TO DROP THE OLD TYPE: `tp1_status` is used by exactly one column in the whole schema,
-- `tp1_relief.status` (0102 created both; nothing since references the type). A DROP TYPE would fail
-- loudly rather than silently if that were ever untrue.
--
-- THE DEFAULT IS DROPPED AND RESTORED around the type change: a column default is stored as an
-- expression typed against the OLD type, and `ALTER COLUMN … TYPE` refuses to rewrite it. Dropping and
-- re-adding 'draft' is the standard dance, and 'draft' is the same default 0102 set.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- ⚠️ THIS FILE WAS 0444 AND IS NOW 0448 (r209). READ THIS BEFORE "TIDYING" THE NUMBERS BACK.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
--
-- The pair was written for r201, HELD unmerged, and by the time it was reworked 0446 and 0447 had
-- SHIPPED. drizzle's watermark is the last applied `when`, so a migration numbered below it never runs
-- and reports nothing at all — the columns simply would not exist and the first payroll run would read
-- them as absent. 0442 was the same trap and was caught by reissuing it as 0446. So the pair was
-- reissued at 0448 / 0449, .sql files AND journal entries; the journal is append-only and was appended
-- to, never re-sorted. Everything the header above says about the type swap is unchanged by that — and
-- it is the part worth carrying, not the number.
--
-- NO GRANT and NO RLS CHANGE: this alters a type and one column's type. `tp1_relief`'s policy stays
-- `app.can_see_person(person_id)` for USING and WITH CHECK (self + admin), untouched and un-widened —
-- it is column-blind and does not mention `status`.

ALTER TYPE "tp1_status" RENAME TO "tp1_status_pre_0448";
--> statement-breakpoint

CREATE TYPE "tp1_status" AS ENUM('draft', 'submitted', 'approved', 'rejected', 'cancelled');
--> statement-breakpoint

ALTER TABLE "tp1_relief" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint

ALTER TABLE "tp1_relief"
  ALTER COLUMN "status" TYPE "tp1_status" USING "status"::text::"tp1_status";
--> statement-breakpoint

ALTER TABLE "tp1_relief" ALTER COLUMN "status" SET DEFAULT 'draft';
--> statement-breakpoint

DROP TYPE "tp1_status_pre_0448";
