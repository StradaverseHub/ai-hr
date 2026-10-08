-- f6819e19 (r429) — THE WHOLE-SHIFT FLEXIBLE BREAK MOVES ONTO ITS BREAK ROWS, EXACTLY, OR NOT AT ALL.
--
-- ── WHAT THE REPORTER APPROVED ────────────────────────────────────────────────────────────────────────
-- Breaks are redesigned as per-row rows only (D4 of the approved plan): the whole-shift "Flexible break"
-- switch (migration 0457, flexible_break_enabled/flexible_break_minutes) is removed from the Shift page.
-- A shift still using it must keep deducting IDENTICAL minutes on every day after this ships — "no
-- attendance, overtime or pay figure changes because of this release" is the plan's own sentence — so its
-- whole-shift allowance (N minutes) is converted onto its UNPAID break rows as per-row allowances, in
-- place of the switch, wherever that conversion is EXACT. Measured on production 2026-10-08
-- (before-building counts, read-only as MIGRATION_DATABASE_URL): 2 shifts have the switch on; 1 (MB28,
-- allowance 60, one unpaid row 12:00-13:00 of length 60) converts exactly; 1 (AM4, allowance 60, NO break
-- rows at all) does not and is left untouched — its Breaks section shows the allowance and an explicit
-- "Stop using it" opt-out (components/shift-time-fields.tsx) rather than silently changing what it
-- deducts.
--
-- ── THE CONVERSION TEST, AND WHY EACH HALF OF IT IS THERE ────────────────────────────────────────────
-- Let U = the shift's UNPAID break_periods rows (paid rows are never deducted either way), in ARRAY
-- ORDER, and N = flexible_break_minutes (today's whole-shift allowance). Convert ONLY when:
--   count(U) >= 1            — there is at least one row to put the allowance ON;
--   N >= count(U)             — every row can get at least its required 1-minute floor;
--   N <= sum(len(U))          — the allowance fits inside the rows' own combined length, so no row is
--                               asked to carry more minutes than its own window is long (the per-row
--                               allowance bound core/roster.ts already enforces on every save).
-- When all three hold, each row in U gets: flexible = true, flexibleMinutes = 1 + a GREEDY share of
-- (N - count(U)) up to (len - 1) per row, walked in array order. That is the plan's own distribution rule,
-- and it is the one that keeps the per-row sum EXACTLY N while never exceeding any row's own length — see
-- the proof below. flexible_break_enabled is then set false and flexible_break_minutes NULL (the one
-- representation "off" has — core/roster.ts already drops a stored allowance whenever the switch is off).
-- break_minutes is NOT touched: it already equals N (core/roster.ts has always written
-- flexible_break_minutes into break_minutes while the switch is on), and it is what the new per-row sum
-- must still equal for the day to compute the same.
--
-- ── PROOF OF IDENTITY (why the day computes the same minute) ─────────────────────────────────────────
-- BEFORE: core/attendance.ts deriveAttendance picks `flexibleBreak ?? perRowBreak ?? spannedBreakMinutes`.
-- The switch is on, so flexibleBreak = min(flexible_break_minutes, span) = min(N, span) wins outright —
-- no row is even read.
-- AFTER: the switch is off, so the engine falls to perRowBreakMinutes, which fires because at least one
-- unpaid row now carries flexible=true + flexibleMinutes (every row in U does): it SUMS every unpaid
-- row's contribution — a row with flexibleMinutes contributes exactly that number, unconditionally — and
-- every row in U now has one, summing to exactly N (1*count(U) + the greedy remainder (N - count(U)) =
-- N). The result is capped at `min(total, breakMinutes, span)` = min(N, N, span) = min(N, span) — THE
-- IDENTICAL EXPRESSION. Paid rows contribute 0 in both readings (flexibleBreak replaced the whole
-- computation before; perRowBreakMinutes filters paid rows out after), so a paid row changes nothing
-- either way.
-- The per-row bound (flexibleMinutes in 1..len) is satisfied BY CONSTRUCTION: the greedy walk gives row i
-- `1 + least(remaining, len_i - 1)`, so 1 <= flexibleMinutes_i <= len_i always, and the N <= sum(len(U))
-- precondition guarantees the remaining pool (N - count(U)) can always be fully placed (its ceiling,
-- sum(len_i - 1) = sum(len_i) - count(U), is >= N - count(U) exactly when N <= sum(len_i)).
--
-- ── WHAT IS LEFT UNTOUCHED, AND WHY THAT IS SAFE ──────────────────────────────────────────────────────
-- Any shift with flexible_break_enabled = true that fails the test above (no unpaid rows at all — AM4 on
-- production; or an allowance that cannot be placed without exceeding a row's own length) is NOT
-- written. Its switch stays ON, so core/attendance.ts keeps taking the flexibleBreak branch and every
-- figure it produces stays byte-identical — nothing about this migration can change its pay. The Shift
-- page surfaces it with the explicit "Stop using it" opt-out; only a human tick, never this migration,
-- turns that switch off.
--
-- ── NO DDL, NOTHING ELSE TOUCHED ──────────────────────────────────────────────────────────────────────
-- Every column this migration writes (break_periods, flexible_break_enabled, flexible_break_minutes)
-- already exists (migrations 0197/0457). No RLS change: the UPDATE runs as the migration owner, which is
-- not subject to shift's row-scoped policy, exactly as 0483's DO block runs as owner. No roster_assignment
-- row, no attendance row, no historical figure, and not one OTHER shift's break_periods is edited —
-- CLAUDE.md §6's "list the writers before a CHECK" does not apply here (no CHECK is added), but the same
-- discipline applies to the UPDATE's WHERE clause: it only ever touches a row it is about to convert.
--
-- Journal entry: idx 519 (see meta/_journal.json). Journal max idx was 518; entries.length (426) does not
-- match the numbering and a number taken from it would be a SILENT SKIP (CLAUDE.md §"migration numbering").

DO $$
DECLARE
  sh            record;
  elem          jsonb;
  i             int;
  n_elems       int;
  is_paid       boolean;
  bstart        text;
  bend          text;
  len_min       int;
  unpaid_idxs   int[];
  unpaid_lens   int[];
  u_count       int;
  sum_len       int;
  remaining     int;
  give          int;
  new_periods   jsonb;
  total_shifts  int := 0;
  converted     int := 0;
  left_count    int := 0;
BEGIN
  FOR sh IN
    SELECT id, break_periods, flexible_break_minutes, break_minutes
    FROM shift
    WHERE flexible_break_enabled = true
    ORDER BY id
  LOOP
    total_shifts := total_shifts + 1;

    -- The unpaid rows, their ARRAY-ORDER indices and their own (positive, pre-this-release) lengths. No
    -- wrap-aware arithmetic is needed here: every row in this journal entry's data predates D6's wrapped
    -- breaks, so start < end always and plain time subtraction is exact.
    unpaid_idxs := ARRAY[]::int[];
    unpaid_lens := ARRAY[]::int[];
    n_elems := COALESCE(jsonb_array_length(sh.break_periods), 0);
    FOR i IN 0 .. n_elems - 1 LOOP
      elem := sh.break_periods -> i;
      is_paid := COALESCE((elem->>'paid')::boolean, false);
      IF NOT is_paid THEN
        bstart := elem->>'start';
        bend := elem->>'end';
        len_min := (EXTRACT(EPOCH FROM (bend::time - bstart::time)) / 60)::int;
        unpaid_idxs := unpaid_idxs || i;
        unpaid_lens := unpaid_lens || len_min;
      END IF;
    END LOOP;

    u_count := COALESCE(array_length(unpaid_idxs, 1), 0);
    SELECT COALESCE(sum(x), 0) INTO sum_len FROM unnest(unpaid_lens) x;

    IF u_count >= 1
       AND sh.flexible_break_minutes IS NOT NULL
       AND sh.flexible_break_minutes >= u_count
       AND sh.flexible_break_minutes <= sum_len
    THEN
      -- THE GREEDY DISTRIBUTION: 1 minute floor per row, then share the remainder up to (len - 1) per
      -- row, walked in ARRAY ORDER — the plan's own rule, proved exact above.
      new_periods := sh.break_periods;
      remaining := sh.flexible_break_minutes - u_count;
      FOR i IN 1 .. u_count LOOP
        give := 1 + LEAST(remaining, unpaid_lens[i] - 1);
        remaining := remaining - (give - 1);
        new_periods := jsonb_set(
          jsonb_set(new_periods, ARRAY[unpaid_idxs[i]::text, 'flexible'], 'true'::jsonb, true),
          ARRAY[unpaid_idxs[i]::text, 'flexibleMinutes'], to_jsonb(give), true
        );
      END LOOP;

      UPDATE shift
      SET break_periods = new_periods,
          flexible_break_enabled = false,
          flexible_break_minutes = NULL,
          updated_at = now()
      WHERE id = sh.id;
      converted := converted + 1;
      RAISE NOTICE '0519: shift % — converted % min across % unpaid break row(s) (sum of their lengths %).',
        sh.id, sh.flexible_break_minutes, u_count, sum_len;
    ELSE
      left_count := left_count + 1;
      RAISE NOTICE '0519: shift % — LEFT UNCHANGED (unpaid rows=%, allowance=%, sum of unpaid lengths=%). Needs the Shift page''s "Stop using it".',
        sh.id, u_count, sh.flexible_break_minutes, sum_len;
    END IF;
  END LOOP;

  RAISE NOTICE '0519: % shift(s) carried the whole-shift Flexible break; % converted onto their break rows, % left unchanged (switch still on).',
    total_shifts, converted, left_count;
END $$;
