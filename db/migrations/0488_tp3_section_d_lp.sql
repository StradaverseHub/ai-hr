-- r339 · 20837372 — TP3 SECTION D REACHES ∑LP. The previous employer's reliefs finally lower PCB.
--
-- ══ THE DEFECT, IN THE SPECIFICATION'S OWN WORDS ════════════════════════════════════════════════════
--
-- `spesifikasi-kaedah-pengiraan-berkomputer-pcb-2026.pdf`, PRINTED PAGE 22, item 10, verbatim:
--
--     "The information amount from the TP3 Form shall be treated in the formula as variable (Y–K*), X, Z
--      and ∑LP."
--
-- Four variables. Item 1bb09a73 wired THREE of them — `employee_statutory_my.tp3_net_remuneration` is
-- ∑(Y−K*), `.tp3_pcb_paid` is X, `.tp3_zakat_paid` is Z — and ∑LP was never wired at all. There is no
-- column for it, `core/tp3.ts`'s `deriveAccumulatorSeed` reads `payload.sectionC` only, and
-- `core/payroll.ts` opens every accumulator with a hard `lpAccumulated: 0` and then sums THIS employer's
-- prior payslips into it. Section D of the form — seventeen relief lines, captured, validated against
-- their annual limits, stored and printed since item df35d60d — reached nothing.
--
-- The same specification defines the variable, PRINTED PAGE 11, and the clause that matters is the one
-- naming where the figure may come from:
--
--     "∑LP  Accumulated allowable deductions in the current year, INCLUDING FROM PREVIOUS EMPLOYMENT,
--           if any"
--
-- ⚠️ WHO IT HURT, AND IN WHICH DIRECTION. ∑LP is SUBTRACTED inside P (`localization/my/payroll.ts`:
-- `P1 = ∑(Y−K) + (Y1−K1) + (Y1−K2)n − reliefs − lp`). A ∑LP seeded at zero makes P too HIGH, so the tax
-- on P is too high, so the monthly deduction is too high. A new joiner who handed in a correctly filled
-- TP3 was OVER-DEDUCTED every month for the rest of the year, and got it back only at assessment. The
-- form told us, we stored it, and we did not read it.
--
-- ══ A COLUMN, BESIDE THE FOUR THAT ARE ALREADY THERE ════════════════════════════════════════════════
--
-- ALTER, not CREATE: `employee_statutory_my` already carries its grants, and CLAUDE.md §6 requires a
-- GRANT only for a table the migration itself creates. Adding one here would be noise.
--
-- NULLABLE, no default. Null is "no previous-employment ∑LP recorded", which is what every existing row
-- means and is read as zero — identical to today's behaviour for everyone without a Section D. A NOT
-- NULL DEFAULT 0 would assert, on 60-odd columns' worth of rows, that somebody checked. Nobody did.
--
-- IT JOINS THE FOUR AS A PEER, GOVERNED BY THE SAME `tp3_year`. `core/payroll.ts` applies all five on
-- one test, `tp3Applies = e.tp3Year === pYear`, so a form for a year the run is not paying seeds
-- nothing; and the `tp3YearMismatch` pre-processing blocker item 1bb09a73 added now also fires for a
-- form whose ONLY money is in Section D, which before this round could not have been noticed at all.
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "tp3_lp" numeric(12, 2);

COMMENT ON COLUMN "employee_statutory_my"."tp3_lp" IS
  'LHDN ∑LP carried in from previous employment — the total of Form TP3 Section D (D1–D17) for the year in tp3_year. Seeded by core/tp3.ts saveTp3; read by core/payroll.ts into acc.lpAccumulated. Null = none recorded, read as zero.';

-- ══ THE BACKFILL, AND WHY IT IS RIGHT TO RUN IT ════════════════════════════════════════════════════
--
-- Without it the fix does nothing until somebody happens to re-open and re-save each form, and a
-- declared relief that is sitting in the database unread is the whole defect. The figure is DERIVED, not
-- invented: it is the same sum `deriveAccumulatorSeed` computes from the same `payload.sectionD`, whose
-- per-item amounts were already capped at their annual limits by `readGroup` when the form was saved.
--
-- ⚠️ THE CONDITION IS `tp3_year = assessment_year`, NOT merely "this person has a form". That equality
-- is what `deleteTp3`'s header already established as meaning "these four columns ARE this form's
-- projection". Where it does not hold, the other four columns came from somewhere else (a hand-keyed
-- opening balance, or a different year's form) and seeding a fifth from an unrelated payload would
-- assemble one accumulator out of two sources. Those rows are left null and the next `saveTp3` sets
-- them, reporting `applied` exactly as it does for the other four.
--
-- ⚠️ IT DOES NOT TOUCH ONE PAYSLIP. This writes an opening balance that FUTURE runs read; no payslip,
-- batch or statutory snapshot is read or written here. `core/payslip-recompute.ts`'s header already
-- records the standing rule that revising month N legitimately moves month N+1, and that is the whole of
-- the effect: the next unfiled run for an affected employee deducts LESS, correctly. A month that has
-- been FILED is protected where it has always been protected, in `refuseIfPeriodFiled` (item 23e7dac3) —
-- nothing here reopens one, and nothing here restates one.
UPDATE "employee_statutory_my" AS s
SET "tp3_lp" = d.lp,
    "updated_at" = now()
FROM (
  SELECT t."tenant_id",
         t."person_id",
         t."assessment_year",
         round(coalesce(sum((item.value ->> 'amount')::numeric), 0), 2) AS lp
    FROM "employee_tp3" AS t
    CROSS JOIN LATERAL jsonb_each(coalesce(t."payload" -> 'sectionD', '{}'::jsonb)) AS item(key, value)
   WHERE jsonb_typeof(t."payload" -> 'sectionD') = 'object'
   GROUP BY t."tenant_id", t."person_id", t."assessment_year"
) AS d
WHERE s."tenant_id" = d."tenant_id"
  AND s."person_id" = d."person_id"
  AND s."tp3_year" = d."assessment_year"
  AND d.lp <> 0
  AND s."tp3_lp" IS DISTINCT FROM d.lp;
