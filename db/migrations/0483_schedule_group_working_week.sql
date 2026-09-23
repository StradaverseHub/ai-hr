-- 07ebd04d (r331) — THE WORKING WEEK MOVES ONTO THE SCHEDULE GROUP, and "Standard" splits into three.
--
-- ── WHAT THE REPORTER APPROVED ────────────────────────────────────────────────────────────────────────
-- Their group "Standard" holds five shifts with THREE different working weeks, and one Schedule Group
-- cannot hold three. Measured on production 2026-09-23 by scripts/report-schedule-group-split.ts
-- (read-only), confirmed by the reporter, and the split is:
--
--   Standard 5 Day                 Sat = rest   AM01, AM03, SF01   (weekly {1,2,3,4,5}  half {}   off {})
--   Standard 5.5 Day               Sat = half   AM02               (weekly {1,2,3,4,5}  half {6}  off {})
--   Standard 5 Day + Saturday Off  Sat = off    MB28               (weekly {1,2,3,4,5}  half {}   off {6})
--
-- Group "A02" holds one shift (AM4) with one working week and does NOT split; it keeps its name and is
-- given that shift's week, so that every group holding shifts states the week it schedules. NOT ONE
-- SHIFT'S OWN weekly_pattern / half_pattern / off_pattern IS EDITED HERE — the promise in the plan.
--
-- ── WHY THE COLUMNS EXIST AT ALL ──────────────────────────────────────────────────────────────────────
-- The group answers "WHICH DAYS are worked"; the shift answers "WHAT HOURS are worked". Until now only
-- the shift could answer the first, which is why three different weeks had to be modelled as three
-- different shifts inside one group. core/attendance.ts `weekPatternFor(group, shift)` (shipped r330) is
-- the ONE resolver that decides which of the two a reader gets.
--
-- ⚠️ A GROUP WITH NO WORKING DAY DELIBERATELY DOES NOT WIN. core/roster.ts assignEmployeeShift records
-- why: a pattern that is NULL or empty matches NOTHING, falls through to policyBranch('rest_day'), and
-- everyone under it silently books every working day as a REST day — rest-day overtime on ordinary work,
-- with no error anywhere. That is exactly what a group row created without its patterns would do to a
-- whole group at once, which is why THE PATTERNS ARE WRITTEN IN THE SAME INSERT THAT CREATES EACH GROUP
-- below and never in a follow-up UPDATE.
--
-- ⚠️ THE TENANT'S is_default "Standard" RULE KEEPS NULL PATTERNS, AND THAT IS LOAD-BEARING. It is the
-- fallback for every shift whose rule_id is NULL (core/attendance.ts resolveRuleTx with ruleId null), so
-- giving IT a week would silently impose that week on every ungrouped shift in the tenant. It is left
-- exactly as it is, holding no shifts and no employees once this migration has run, and `weekPatternFor`
-- therefore falls back to the shift for anything that resolves it — byte-identical to today.
--
-- ── BYTE-IDENTICAL ON THE DAY IT SHIPS, AND THAT IS THE POINT ─────────────────────────────────────────
-- Each new group is created carrying EXACTLY the week its own shifts already have, so
-- `weekPatternFor(group, shift)` returns the same triple whichever side answers. Nobody's working days,
-- rest days, overtime rate or pay moves. What changes is where the fact LIVES.
--
-- ── EVERY CALCULATION COLUMN IS COPIED FROM THE SOURCE GROUP, INCLUDING THE OT BANDS ──────────────────
-- attendance_rule is not only the Schedule Group: it is also the "Lateness, Early Out & Overtime
-- Settings" rule the time engine applies (core/attendance.ts ruleFor → resolveRuleTx), and
-- attendance_rule_ot_row holds its overtime bands, which decide OT ROUNDING and which rate column the
-- minutes land in. A new group created with default values would silently re-price every shift moved into
-- it. So every rule column and every OT band row is copied from the group the shifts are leaving.
--
-- ⚠️ INCLUDING deductions_effective_from, WHICH core/attendance-rule.ts copyAttendanceRule DELIBERATELY
-- DOES NOT CARRY. That function is right for its case (a brand-new pattern must not inherit a start date
-- in the past and reach a closed payroll period). This is the opposite case: these are the SAME rules
-- under a new name for a subset of their own shifts, and dropping the date would either change when
-- deductions start for those people or violate the 0394 CHECK ("on with no date" is unrepresentable).
-- On production every rule ships apply_deductions = false, so nothing is carried in practice.
--
-- ── NO GRANT, NO RLS CHANGE ───────────────────────────────────────────────────────────────────────────
-- Nothing is CREATEd: three columns on an existing table inherit attendance_rule's grants (0204, and see
-- 0439's note saying the same for this same table) and its row-scoped RLS policy (0319). The INSERTs
-- carry tenant_id explicitly and run as the migration owner, which is not subject to the policy.
--
-- ── THE DISJOINTNESS INVARIANT MOVES WITH THE COLUMNS ─────────────────────────────────────────────────
-- Migration 0429 put a pairwise-disjoint CHECK on `shift` because the three arrays are a partition of the
-- week and a row that puts Saturday in two of them has no answer. The same CHECK is added here, with the
-- same COALESCE over the nullable weekly_pattern (without it one NULL makes the whole predicate NULL and
-- the constraint silently stops constraining). core/attendance-rule.ts normalizeInput enforces it on the
-- write side as core/roster.ts normalizeShiftInput does for shifts.
--
-- A SECOND CHECK says a row that declares OFF days must declare at least one WORKING day. That is the
-- unwalkable-group shape above, made unrepresentable rather than only refused by the service. An
-- ALL-HALF-DAYS week is legal (core/attendance.ts weekPatternWorkingDayCount counts Full ∪ Half; an
-- all-half week is walkable and refusing it would be a new false rejection), and a row with all three
-- arrays empty is legal and means "this group declares no week" — the state every existing row is in,
-- including the tenant's Standard rule, so BOTH CHECKS ARE SATISFIED BY EVERY STORED ROW and neither is
-- NOT VALID. CLAUDE.md §6 asks for the writers to be listed before a CHECK on an existing table: the
-- writers of attendance_rule are createAttendanceRule, updateAttendanceRule, copyAttendanceRule,
-- ensureStandardRule and setAttendanceRuleStatus (all core/attendance-rule.ts) plus this migration; none
-- of the first five can produce a violating row, because only the migration and the validated service
-- input can set these columns at all.
--
-- ── WHAT IS NOT TOUCHED ───────────────────────────────────────────────────────────────────────────────
-- No roster_assignment row, no attendance row, no historical figure. `shift.day_type` and
-- `shift.category` do NOT move (db/schema.ts:4200 — "RECORDED ONLY in stage 1"; a grep for shift.dayType
-- and shift.category across core/ app/ lib/ packs/ returns zero). The rostered-off-day defect recorded in
-- the r331 brief (a rostered OFF day pays 2.0x because roster_assignment.is_rest_day is a boolean) is a
-- separate money-affecting item and nothing here changes a single historical row.
--
-- Journal entry: idx 483 (see meta/_journal.json). max(idx) was 482; the count of entries (395) has not
-- matched the numbering for a long time and a number taken from the count would be a SILENT SKIP.

ALTER TABLE "attendance_rule" ADD COLUMN "weekly_pattern" integer[];--> statement-breakpoint
ALTER TABLE "attendance_rule" ADD COLUMN "half_pattern" integer[] NOT NULL DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "attendance_rule" ADD COLUMN "off_pattern" integer[] NOT NULL DEFAULT '{}';--> statement-breakpoint

ALTER TABLE "attendance_rule" ADD CONSTRAINT "attendance_rule_day_kinds_disjoint" CHECK (
  NOT (COALESCE("weekly_pattern", '{}') && "half_pattern")
  AND NOT (COALESCE("weekly_pattern", '{}') && "off_pattern")
  AND NOT ("half_pattern" && "off_pattern")
);--> statement-breakpoint

ALTER TABLE "attendance_rule" ADD CONSTRAINT "attendance_rule_off_needs_working_day" CHECK (
  COALESCE("weekly_pattern", '{}') <> '{}' OR "half_pattern" <> '{}' OR "off_pattern" = '{}'
);--> statement-breakpoint

-- ── THE SPLIT ─────────────────────────────────────────────────────────────────────────────────────────
--
-- Driven off the DATA, not off hard-coded ids, so it is correct on production, on a restored copy and on
-- an empty database (where it does nothing at all). Every step is scoped to a group named "Standard"
-- that actually holds more than one working week; a tenant without one is untouched and says so.
--
-- Set equality is written as mutual containment (a <@ b AND b <@ a) rather than array `=` on purpose:
-- `=` on int[] is ORDER-SENSITIVE, and "{5,1,2,3,4}" is the same working week as "{1,2,3,4,5}".
DO $$
DECLARE
  src           record;
  spec          record;
  new_rule_id   uuid;
  week_count    int;
  unmatched     int;
  n_shifts      int;
  n_people      int;
  total_shifts  int;
  total_people  int;
  left_behind   int;
BEGIN
  FOR src IN
    SELECT r.* FROM attendance_rule r WHERE lower(trim(r.name)) = 'standard' ORDER BY r.tenant_id, r.id
  LOOP
    -- How many DISTINCT working weeks does this group hold? One (or none) ⇒ nothing to split.
    SELECT count(*) INTO week_count FROM (
      SELECT DISTINCT
        (SELECT array_agg(x ORDER BY x) FROM unnest(COALESCE(s.weekly_pattern, '{}')) AS x) AS w,
        (SELECT array_agg(x ORDER BY x) FROM unnest(s.half_pattern) AS x)                   AS h,
        (SELECT array_agg(x ORDER BY x) FROM unnest(s.off_pattern) AS x)                    AS o
      FROM shift s WHERE s.rule_id = src.id AND s.archived_at IS NULL
    ) q;

    IF week_count < 2 THEN
      RAISE NOTICE '0483: group "%" (tenant %) holds % distinct working week(s) — not split.', src.name, src.tenant_id, week_count;
      CONTINUE;
    END IF;

    -- ⚠️ REFUSE RATHER THAN STRAND. Every non-archived shift in the group must be one of the three weeks
    -- the reporter named and approved. A fourth week has no approved name, and leaving it behind in a
    -- group whose other shifts have left would put its employees in a group that no longer allows their
    -- shift (core/roster.ts assertShiftsAllowedForEmploymentsTx would refuse their next assignment).
    -- Aborting is loud and recoverable; stranding somebody is neither.
    SELECT count(*) INTO unmatched
    FROM shift s
    WHERE s.rule_id = src.id AND s.archived_at IS NULL
      AND NOT (
        COALESCE(s.weekly_pattern, '{}') <@ ARRAY[1,2,3,4,5] AND ARRAY[1,2,3,4,5] <@ COALESCE(s.weekly_pattern, '{}')
        AND (
             (s.half_pattern = '{}' AND s.off_pattern = '{}')
          OR (s.half_pattern <@ ARRAY[6] AND ARRAY[6] <@ s.half_pattern AND s.off_pattern = '{}')
          OR (s.off_pattern  <@ ARRAY[6] AND ARRAY[6] <@ s.off_pattern  AND s.half_pattern = '{}')
        )
      );
    IF unmatched > 0 THEN
      RAISE EXCEPTION '0483: group "%" (tenant %) holds % shift(s) whose working week is not one of the three the reporter approved (Mon-Fri full with Saturday rest / half / off, Sunday rest). Splitting would leave them in a group their employees are no longer allowed on. Re-run scripts/report-schedule-group-split.ts and get the extra week named before this migration is applied.', src.name, src.tenant_id, unmatched;
    END IF;

    total_shifts := 0;
    total_people := 0;

    FOR spec IN
      SELECT * FROM (VALUES
        ('Standard 5 Day',                ARRAY[1,2,3,4,5], ARRAY[]::int[], ARRAY[]::int[]),
        ('Standard 5.5 Day',              ARRAY[1,2,3,4,5], ARRAY[6],       ARRAY[]::int[]),
        ('Standard 5 Day + Saturday Off', ARRAY[1,2,3,4,5], ARRAY[]::int[], ARRAY[6])
      ) AS v(group_name, w, h, o)
    LOOP
      -- Does any shift in the source group actually have this week? A group nobody would be in is not
      -- created: three empty groups on a screen are three questions the reporter has to answer.
      SELECT count(*) INTO n_shifts
      FROM shift s
      WHERE s.rule_id = src.id AND s.archived_at IS NULL
        AND COALESCE(s.weekly_pattern, '{}') <@ spec.w AND spec.w <@ COALESCE(s.weekly_pattern, '{}')
        AND s.half_pattern <@ spec.h AND spec.h <@ s.half_pattern
        AND s.off_pattern  <@ spec.o AND spec.o <@ s.off_pattern;
      CONTINUE WHEN n_shifts = 0;

      IF EXISTS (SELECT 1 FROM attendance_rule r2 WHERE r2.tenant_id = src.tenant_id AND lower(trim(r2.name)) = lower(spec.group_name)) THEN
        RAISE EXCEPTION '0483: tenant % already has a Schedule Group named "%" — the split cannot create it and must not silently reuse a group it did not make.', src.tenant_id, spec.group_name;
      END IF;

      -- THE GROUP AND ITS WORKING WEEK IN ONE STATEMENT. A group row that exists for even one statement
      -- with a NULL pattern is a group that schedules nothing for everyone in it.
      INSERT INTO attendance_rule (
        tenant_id, company_id, name, description, is_default, status,
        late_grace_period_minutes, late_after_minutes, late_deduct_minutes, include_grace_in_lateness,
        early_grace_period_minutes, early_after_minutes, early_deduct_minutes, include_grace_in_early_out,
        apply_to_early_ot, apply_deductions, deductions_effective_from,
        weekly_pattern, half_pattern, off_pattern
      ) VALUES (
        src.tenant_id, src.company_id, spec.group_name, src.description,
        false,            -- exactly one is_default rule per tenant; the source keeps it
        src.status,
        src.late_grace_period_minutes, src.late_after_minutes, src.late_deduct_minutes, src.include_grace_in_lateness,
        src.early_grace_period_minutes, src.early_after_minutes, src.early_deduct_minutes, src.include_grace_in_early_out,
        src.apply_to_early_ot, src.apply_deductions, src.deductions_effective_from,
        spec.w, spec.h, spec.o
      )
      RETURNING id INTO new_rule_id;

      -- The overtime bands travel with the rule, or the shifts moved into this group lose their OT
      -- rounding and their rate columns.
      INSERT INTO attendance_rule_ot_row (
        tenant_id, rule_id, from_minutes, to_minutes, rate_pattern, rate, ph_rate, rounding_mode, round_to_minutes, sort_order
      )
      SELECT o.tenant_id, new_rule_id, o.from_minutes, o.to_minutes, o.rate_pattern, o.rate, o.ph_rate, o.rounding_mode, o.round_to_minutes, o.sort_order
      FROM attendance_rule_ot_row o
      WHERE o.rule_id = src.id;

      -- Each shift moves into the group that matches the week IT ALREADY HAS. Its own three arrays are
      -- not read from again and not written to.
      UPDATE shift s SET rule_id = new_rule_id, updated_at = now()
      WHERE s.rule_id = src.id AND s.archived_at IS NULL
        AND COALESCE(s.weekly_pattern, '{}') <@ spec.w AND spec.w <@ COALESCE(s.weekly_pattern, '{}')
        AND s.half_pattern <@ spec.h AND spec.h <@ s.half_pattern
        AND s.off_pattern  <@ spec.o AND spec.o <@ s.off_pattern;
      GET DIAGNOSTICS n_shifts = ROW_COUNT;
      total_shifts := total_shifts + n_shifts;

      -- ⚠️ AND THE PEOPLE MOVE IN THE SAME MIGRATION, which is the whole of "nobody is stranded".
      -- An employment whose OWN Schedule Group is the group being emptied must follow its shift, or
      -- core/roster.ts assertShiftsAllowedForEmploymentsTx refuses that person's next shift assignment:
      -- the group they are in would allow no shifts at all.
      --
      -- "Their shift" is resolved by the SAME precedence core/attendance.ts scheduleFor uses, and both
      -- legs are needed — the report under-counted by four people the first time it read only the first:
      --   1. the OPEN dated arrangement (superseded_at IS NULL AND valid_to IS NULL), else
      --   2. employment.default_shift_id, but ONLY when the employment has no LIVE arrangement row at
      --      all, which is the condition scheduleFor falls back on.
      UPDATE employment e SET attendance_rule_id = new_rule_id
      WHERE e.attendance_rule_id = src.id
        AND COALESCE(
              (SELECT a.shift_id FROM employment_shift_arrangement a
                WHERE a.employment_id = e.id AND a.superseded_at IS NULL AND a.valid_to IS NULL
                ORDER BY a.valid_from DESC, a.created_at DESC LIMIT 1),
              CASE WHEN EXISTS (SELECT 1 FROM employment_shift_arrangement a2
                                 WHERE a2.employment_id = e.id AND a2.superseded_at IS NULL)
                   THEN NULL ELSE e.default_shift_id END
            ) IN (SELECT s.id FROM shift s WHERE s.rule_id = new_rule_id);
      GET DIAGNOSTICS n_people = ROW_COUNT;
      total_people := total_people + n_people;

      RAISE NOTICE '0483: created group "%" (tenant %) week full=% half=% off=% — % shift(s) and % employee(s) moved into it.',
        spec.group_name, src.tenant_id, spec.w, spec.h, spec.o, n_shifts, n_people;
    END LOOP;

    -- Nobody may be left in the emptied group. If anyone is, the migration has not kept its promise.
    SELECT count(*) INTO left_behind FROM employment e WHERE e.attendance_rule_id = src.id;
    IF left_behind > 0 THEN
      RAISE EXCEPTION '0483: % employment(s) are still in group "%" (tenant %), which now holds no shifts, so their next shift assignment would be refused. They have no resolvable shift to follow; decide where they belong before applying this migration.', left_behind, src.name, src.tenant_id;
    END IF;

    RAISE NOTICE '0483: group "%" (tenant %) split into % week(s): % shift(s) and % employee(s) moved. The group itself is kept (it is the tenant default calculation rule) with NO working week, so every shift that resolves it keeps reading its own.',
      src.name, src.tenant_id, week_count, total_shifts, total_people;
  END LOOP;
END $$;--> statement-breakpoint

-- ── A GROUP THAT IS ALREADY CONSISTENT GETS ITS SHIFTS' WEEK, AND KEEPS ITS NAME ──────────────────────
--
-- Group "A02" (one shift, AM4, nobody on it) needs no split, and the plan says so. It is still a group
-- that holds shifts, and after this migration the group is where a working week is stated — so a group
-- holding shifts that all agree is given the week they already agree on. It is byte-identical by
-- construction: `weekPatternFor` returns the same triple whether the group or the shift answers.
--
-- Deliberately skipped: any group holding NO shifts (there is nothing to take a week from), any group
-- whose shifts DISAGREE (that is a split, and a split needs approved names), and — explicitly, by a
-- predicate and not by luck — THE TENANT'S is_default RULE. It is what every shift with NO rule_id
-- resolves, so a week on it would be imposed on every ungrouped shift in the tenant even though none of
-- them ever joined a group. On the measured production data it holds no shifts after the split above and
-- would have been skipped anyway; the predicate is there so that stays true on a tenant shaped otherwise.
DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    -- The signature is compared as TEXT of the SORTED arrays, not as the raw column: "{5,1,2,3,4}" is the
    -- same working week as "{1,2,3,4,5}", and a NULL weekly_pattern is the same week as '{}'. The row the
    -- week is taken FROM is then pinned by ORDER BY id, so two runs against the same data agree.
    WITH norm AS (
      SELECT s.rule_id AS rule_id, s.id AS sid,
             s.weekly_pattern AS w, s.half_pattern AS h, s.off_pattern AS o,
             COALESCE((SELECT array_agg(x ORDER BY x) FROM unnest(COALESCE(s.weekly_pattern, '{}')) AS x), '{}')::text
               || '|' || COALESCE((SELECT array_agg(x ORDER BY x) FROM unnest(s.half_pattern) AS x), '{}')::text
               || '|' || COALESCE((SELECT array_agg(x ORDER BY x) FROM unnest(s.off_pattern) AS x), '{}')::text AS sig
      FROM shift s
      JOIN attendance_rule ar ON ar.id = s.rule_id
      WHERE s.archived_at IS NULL
        AND ar.is_default = false
        AND COALESCE(ar.weekly_pattern, '{}') = '{}' AND ar.half_pattern = '{}' AND ar.off_pattern = '{}'
    ),
    consistent AS (SELECT rule_id FROM norm GROUP BY rule_id HAVING count(DISTINCT sig) = 1)
    SELECT DISTINCT ON (n0.rule_id) n0.rule_id, n0.w, n0.h, n0.o
    FROM norm n0 JOIN consistent c ON c.rule_id = n0.rule_id
    ORDER BY n0.rule_id, n0.sid
  LOOP
    -- An UNWALKABLE week is never written onto a group: a group whose Full ∪ Half is empty schedules
    -- nothing, and `weekPatternFor` would have to fall back to the shift anyway. Leave it NULL and honest.
    CONTINUE WHEN cardinality(COALESCE(r.w, '{}')) = 0 AND cardinality(COALESCE(r.h, '{}')) = 0;
    UPDATE attendance_rule SET weekly_pattern = r.w, half_pattern = COALESCE(r.h, '{}'), off_pattern = COALESCE(r.o, '{}'), updated_at = now()
    WHERE id = r.rule_id;
    n := n + 1;
    RAISE NOTICE '0483: group % already held one working week — full=% half=% off=% recorded on the group.', r.rule_id, r.w, r.h, r.o;
  END LOOP;
  RAISE NOTICE '0483: % already-consistent group(s) given their shifts'' working week.', n;
END $$;
