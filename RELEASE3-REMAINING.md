# 6e9a126e release three — what is done, and exactly what is left

Branch: `build/r163-g-release3`. **Not merged, not deployed.** `core/` compiles clean; the remainder is
enumerated below with the reasoning that is expensive to re-derive.

The owner authorised the drop by naming the four objects explicitly on 2026-08-06:
`leave_policy`, `benefit_scheme`, `scheme_leave_entitlement`, `employment.benefit_scheme_id`.

## The one thing to understand before touching this

**The drop is not separable from the code removal.** Release two made every engine resolve
`template ?? scheme ?? policy`. Release three removes the last two limbs, so the CLEARING happens the
moment this CODE deploys — not when the tables are dropped. There is no staging where the code ships
safely and the clearing waits for a better day. Deploying this is the irreversible act.

Measured on production 2026-08-06: **41 benefit schemes · 292 scheme entitlement tables · 67 policy
rows = the plan's 359 pieces to retype**, against **0** templates and **0** eligibility rules. After
deploy every entitlement figure is blank until HR retypes them from the archive listing.

## DONE

- `core/leave-compute.ts` — collapsed to the template layer; `templateOverPolicy` / `resolveGradePolicy`
  / `GradePolicyRow` / `previewEntitlement` gone.
- `core/leave.ts` — 1,076 lines lighter. `core/org.ts` — scheme resolution gone.
- `core/admin.ts` — `createLeavePolicy`, `updateLeavePolicy`, `deleteLeavePolicy` and
  `saveServiceEntitlement` removed (454 lines). Compiles clean.
- `app/admin/actions.ts` — the eight policy/scheme actions removed.
- **THE DATED READERS ARE REPOINTED, AND THIS IS THE PART THAT NEARLY SHIPPED A DEFECT.**
  `core/read.ts` (the /me breakdown) and `core/analytics.ts` (the carry-forward report) now call
  `policyForDatedReader(band, rules)` instead of `templateOverPolicy(resolveGradePolicy(...), band)`.

  Why that helper exists: `applyLeaveTypeRules(null, rules)` returns NULL at its first line. With
  `leave_policy` gone and nothing yet typed into the new screens, both readers would hand it `null`,
  `carryMax` would read 0, and **every CLOSED year would report every carried day as FORFEITED** — the
  exact defect the approved plan named as the one release three would otherwise cause. The helper
  materialises the leave TYPE's own carry cap / percentage / expiry at ZERO DAYS when there is no band.
  Days are the one thing that must never be invented; the carry rules live on `leave_type` and are as
  true after the drop as before. A type with no rules still resolves to null, which is what
  `noEntitlementOpinion` relies on to keep the recalc posting a delta of exactly 0.

## LEFT TO DO

1. **`app/admin/actions.ts`** — two leftover call sites (`createLeavePolicy` ~:591,
   `reprojectEntitlementForSchemeCohort` ~:1978) inside functions that survive. Read them: one is a
   leave-type seeding path, the other a scheme-cohort recalc.
2. **`app/admin/leave/entitlements/page.tsx`** — the policy + scheme wiring (imports at :43-55, the
   `listLeavePolicies` call, the `EntitlementPolicy` rows, the preview feed and the panel props).
3. **`components/benefit-scheme-config.tsx`** — deleted wholesale, and `components/leave-rule-preview.tsx`
   repointed off `previewEntitlement`.
4. **The approval-template picker** — `assignApprovalTemplate` (core/leave-approval-template.ts) uses
   `benefit_scheme` as a PICKER ONLY; it resolves a scheme to (gradeGroupId, employmentType) and writes
   those. **Rules already written survive untouched** — there is no `benefit_scheme_id` on
   `leave_approval_policy`. Repoint the picker at `entitlement_eligibility_rule`.
5. **`db/schema.ts`** — remove `leavePolicy`, `benefitScheme`, `schemeLeaveEntitlement` and
   `employment.benefitSchemeId`. Doing this FIRST surfaces every straggler as a compile error, which is
   the cheapest way to find the rest.
6. **`core/leave-type-refs.ts`** — remove the `leave_policy` entry. `test/leave-type-referrers.test.ts`
   compares the declaration against the LIVE foreign keys in BOTH directions and will fail until you do.
   That is deliberate: it is what stops the drop silently removing a limb of `deleteLeaveType`'s guard,
   and it SUPERSEDES the plan's note 5 (which says to repoint the guard by hand).
7. **`packs/leave/index.ts` `satelliteTables`** — drop the three tables, add
   `entitlement_template` / `entitlement_eligibility_rule` / `entitlement_reset_archive`, KEEP
   `grade_group` / `grade_group_member`, or the pack ratchet fails the build.
8. **Migration `0405`** — in this order, in one migration:
   - RE-CAPTURE both layers into `entitlement_reset_archive` with a FRESH capture tag. The existing
     capture is tagged `0398-release-one`, 361 rows, taken 2026-08-05 (pre-r160) and is STALE. The plan
     states the completeness of that record is the only promise the clearing makes.
   - `RAISE NOTICE` the counts so they land in the deploy log.
   - Then drop `scheme_leave_entitlement`, `benefit_scheme`, `employment.benefit_scheme_id`,
     `leave_policy`. **KEEP `grade_group` and `grade_group_member` — 205 live approval rules point at
     them and dropping them would silently unscope every one.**
9. **Tests — build the retirement list by GREP, not by filename.** ~97 type errors remain, all in
   `test/`. Some `entitlement-*.test.ts` files cover the ENGINE and must be repointed and KEPT, not
   retired (entitlement-resolver, leave-entitlement-recalc, leave-entitlement-rounding).
   **`test/leave-approval-grade-group.test.ts` is the TRIPWIRE: it must stay green UNEDITED. If it needs
   one character changed, the removal went too far into approval routing — stop.**
10. **Gate + upgrade rehearsal** (there is a migration), then deploy.

## Two things already proven, do not redo

- `employment.benefit_scheme_id` is at **0 rows** on production — the column is safe to drop.
- The `noOpinion` guard (`core/leave-compute.ts`) is shipped and is what keeps balances still during the
  blank window: an unconfigured type posts a delta of exactly 0 rather than a negative correction.
