/**
 * Feedback 9816a5ad — "Move Benefit Scheme Entitlement Maintenance into Service Based Entitlements":
 * the LEAVE TYPE owns the RULES, the entitlement layer owns the DAYS.
 *
 * ── WHAT THIS FILE USED TO BE, AND WHY MOST OF IT IS GONE ────────────────────────────────────────────
 * It was the safety net for migration 0325 — the step that added ten rule columns to `leave_type` and
 * BACKFILLED them from the single distinct value each type carried across all of its `leave_policy` rows.
 * Three of its four describe blocks re-executed 0325 FROM THE ACTUAL FILE against a fully-migrated schema:
 *
 *   `0325 — the backfill` (9 tests)             — every rule lands on every type, numeric spellings
 *                                                 collapse, an orphan type stays untouched, legacy JSONB
 *                                                 garbage reads as absence, 'none' rounding stores NULL,
 *                                                 29-Feb is accepted, maxBalanceDays collapses across
 *                                                 bands, the migration is idempotent, tenants stay apart.
 *   `0325 — the distinctness assertion` (12)    — it refuses BY NAME to collapse a type whose rows
 *                                                 disagree, on each of ten rules, and does not fire on
 *                                                 silence.
 *   `step 2 — …the BACKFILLED figures are unchanged` (3) — the same scenario in three worlds (columns
 *                                                 NULL / backfilled / contradicting) with the ledger
 *                                                 pinned in each.
 *
 * ALL 24 ARE RETIRED. Migration 0405 dropped `leave_policy`, which is the table 0325 reads FROM — so the
 * replay has no source table, and the fixtures have nowhere to put the rows the backfill is supposed to
 * collapse. 0325 remains valid IN THE MIGRATION CHAIN, where it still runs in order on a fresh database
 * while `leave_policy` is alive; what is gone is the ability to re-run it afterwards.
 *
 * NAME THE LOSS HONESTLY: what is no longer tested is a ONE-OFF DATA MIGRATION THAT HAS ALREADY RUN ON
 * EVERY DATABASE, whose source table has since been deleted. There is no future execution left for those
 * assertions to protect. What DOES still have a future — that every engine reads its rules from the type,
 * through one shared composition, and that the composition really applies them — is the block below, which
 * is kept and REPOINTED rather than deleted.
 *
 * ── WHAT SURVIVES ───────────────────────────────────────────────────────────────────────────────────
 * The static structural guard. It is a source-text test on purpose: a behavioural test can only prove that
 * the sites it happens to call are wired up, while a half-repointed system is worse than an unrepointed
 * one — the granting engines (hire grant / year-open / earned accrual) and the projection kernel must
 * agree to the DAY or the recalc posts a permanent oscillating delta against a ledger written under a
 * different rule. That is the failure this file has always existed to prevent, and it is unchanged by
 * where the days are stored.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** The ten step-1 `leave_type` rule columns, in the shape drizzle selects them. */
const RULE_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['accrualMethod', 'accrual_method'],
  ['carryForwardMax', 'carry_forward_max'],
  ['carryForwardEnabled', 'carry_forward_enabled'],
  ['carryForwardExpiryMode', 'carry_forward_expiry_mode'],
  ['carryForwardExpiryMonths', 'carry_forward_expiry_months'],
  ['carryForwardExpiryMonth', 'carry_forward_expiry_month'],
  ['carryForwardExpiryDay', 'carry_forward_expiry_day'],
  ['carryForwardIncludeEarned', 'carry_forward_include_earned'],
  ['roundingMethod', 'rounding_method'],
  ['maxBalanceDays', 'max_balance_days'],
];

describe('the call sites resolve their rules from the LEAVE TYPE (static)', () => {
  const leaveSrc = readFileSync(resolve(root, 'core/leave.ts'), 'utf8');

  /** The body of a top-level exported function in core/leave.ts, from its signature to the next one. */
  function bodyOf(name: string): string {
    const start = leaveSrc.indexOf(`export async function ${name}(`);
    const startSync = leaveSrc.indexOf(`export function ${name}(`);
    const from = start >= 0 ? start : startSync;
    expect(from, `${name} not found in core/leave.ts`).toBeGreaterThanOrEqual(0);
    const rest = leaveSrc.slice(from + 1);
    const next = rest.search(/\nexport (async )?function /);
    return next >= 0 ? rest.slice(0, next) : rest;
  }

  // The four call sites the plan names. Each still selects the type's rule columns through the ONE shared
  // shape, and each resolves through the ONE shared composition.
  //
  // ⚠️ TWO THINGS CHANGED HERE AND BOTH ARE UPDATES, NOT RELAXATIONS.
  //
  // 1. `reprojectEntitlementForPolicy` is gone — it was the leave-policy recalc, deleted with the table it
  //    recalculated against. Its place in this list is taken by `reprojectEntitlementForEmployment`, which
  //    is the reprojection the surviving triggers actually call (profile saves, movement apply, the
  //    leave-type cohort catch-up). Dropping the row rather than replacing it would have quietly shrunk the
  //    list of engines that must agree, which is the one thing this test exists to stop.
  //
  // 2. The `.from(leavePolicy)` assertion is REMOVED, and it is the only assertion in this file removed for
  //    a reason other than "the table is gone". It read: "the DAYS still come from leave_policy — this is
  //    the invariant step 3 will change, not step 2." This IS step 3. The invariant was written to be
  //    retired here, and the thing it guarded — that no engine resolves DAYS from a rule column — is
  //    re-asserted directly at the composition, below.
  it.each([
    ['openLeaveYear', 'composeEntitlement('],
    ['accrueEarnedLeave', 'composeEntitlement('],
    ['reprojectEntitlementForEmployment', 'projectExpectedEntitlement('],
    ['reprojectA2cEntitlement', 'projectExpectedEntitlement('],
  ])('%s resolves its rules from leave_type', (fn, resolver) => {
    const body = bodyOf(String(fn));
    expect(body, `${fn} no longer resolves through ${resolver}`).toContain(String(resolver));
    // ...and it selects the type's rule columns, through the ONE shared shape (a hand-copied column list
    // is how the granting engines and the recalc kernel would drift apart).
    expect(body, `${fn} does not select the type's rule columns`).toContain('...leaveTypeRuleColumns');
    // 6e9a126e — and it resolves the DAYS through the template layer, which is what replaced the
    // `.from(leavePolicy)` half of this assertion. An engine that stopped building the resolver would fall
    // back to no band at all, i.e. "nothing configured", i.e. it would silently grant nobody anything.
    expect(body, `${fn} does not resolve an entitlement template`).toContain('buildTemplateEntitlementResolver');
  });

  it('projectExpectedEntitlement overlays the type rules onto BOTH of its resolutions', () => {
    // The kernel re-resolves on the anniversary/upfront branch. An overlay applied by the CALLER would only
    // ever cover the first resolution and the second would silently revert to un-ruled figures — a bug that
    // would show up as a recalc oscillating against the ledger forever.
    //
    // ⚠️ RELEASE TWO MADE THIS STRUCTURAL RATHER THAN COUNTED, and release three only renamed the closure.
    // The two resolutions used to be two hand-written copies of the same expression, and this test counted
    // them. They are ONE closure INVOKED twice — a stronger guarantee of the same property, because two
    // copies can drift apart and one definition cannot. The closure is now `resolveEntitlement` (it was
    // `resolvePolicy`) and it resolves a BAND rather than a policy row; the assertion follows the
    // mechanism, unchanged in shape: exactly one definition, which must overlay, and exactly two
    // invocations. Each number is load-bearing:
    //  - a second `applyLeaveTypeRules(policyFromTemplateBand(` would be the hand-written copy this replaced;
    //  - zero would mean the overlay is applied somewhere else, or not at all;
    //  - fewer than two invocations would mean the anniversary re-resolution stopped happening.
    const body = bodyOf('projectExpectedEntitlement');
    expect(body.match(/const resolveEntitlement = \(/g) ?? [], 'exactly one entitlement resolution').toHaveLength(1);
    expect(
      body.match(/applyLeaveTypeRules\(policyFromTemplateBand\(/g) ?? [],
      'that one resolution must be overlaid with the type rules',
    ).toHaveLength(1);
    expect(body.match(/\bresolveEntitlement\(/g) ?? [], 'and it must be invoked twice').toHaveLength(2);
  });

  it('every engine that resolves a leave RULE has been repointed — none left un-overlaid', () => {
    // The four above are the named sites, but they are not all of them, and a half-repointed system is
    // worse than an unrepointed one: the granting engines (hire grant / year-open / earned accrual) and
    // the projection kernel must agree to the DAY or the recalc posts a permanent oscillating delta
    // against a ledger written under a different rule.
    const sites: ReadonlyArray<readonly [string, string]> = [
      ['core/leave.ts', 'openLeaveYear'],
      ['core/leave.ts', 'accrueEarnedLeave'],
      ['core/leave.ts', 'projectExpectedEntitlement'],
      ['core/leave.ts', 'expireCarriedLeave'],
      ['core/org.ts', 'hireEmployee (the hire grant)'],
      ['core/read.ts', 'the leave entitlement breakdown'],
      ['core/analytics.ts', 'the carry-forward report'],
    ];
    // Both spellings are accepted HERE and nowhere else, and the acceptance is closed immediately below by
    // asserting that `composeEntitlement` is not an empty shell — without that second assertion this list
    // could be satisfied by a composition that had quietly stopped overlaying, which is the exact defect it
    // exists to catch.
    const OVERLAY_MECHANISMS = ['applyLeaveTypeRules', 'composeEntitlement'];
    const offenders: string[] = [];
    for (const [file, label] of sites) {
      const src = readFileSync(resolve(root, file), 'utf8');
      if (!OVERLAY_MECHANISMS.some((m) => src.includes(m))) offenders.push(`${file} (${label})`);
    }
    expect(offenders, `these rule readers were not repointed:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the shared composition IS the overlay — the second accepted mechanism is not an empty shell', () => {
    // The guard above accepts `composeEntitlement` as evidence that a file applies the leave type's rules.
    // That is only true while composeEntitlement actually applies them, so it is asserted rather than
    // assumed: the day this stops holding, every engine silently drops the type's rules and the list above
    // would still be empty.
    //
    // REPOINTED, not loosened. The expected expression was
    // `applyLeaveTypeRules(templateOverPolicy(p.gradePolicy, p.templateBand), p.rules)`; release three
    // removed the `gradePolicy` parameter (and `templateOverPolicy` with it) because a parameter that is
    // always null is an invitation to re-point something at it. The overlay is the same call on the same
    // two arguments, one layer shorter.
    const computeSrc = readFileSync(resolve(root, 'core/leave-compute.ts'), 'utf8');
    const start = computeSrc.indexOf('export function composeEntitlement(');
    expect(start, 'composeEntitlement not found in core/leave-compute.ts').toBeGreaterThanOrEqual(0);
    const body = computeSrc.slice(start, start + 2000);
    expect(body, 'composeEntitlement must apply the leave type rules').toContain(
      'applyLeaveTypeRules(policyFromTemplateBand(p.templateBand), p.rules)',
    );
  });

  it('the days half is still untouched — no engine resolves DAYS from a leave-type rule column', () => {
    // 9816a5ad's whole safety argument is that only the RULES moved to the type. The composition that
    // decides days is `composeEntitlement`, and its day figure must come from the entitlement template's
    // band and from nothing else.
    //
    // REPOINTED from `entitledDays(floor, scheme, policy)`, which was the old three-layer composition and
    // is deleted. The assertion is now made at the one surviving composition and is STRONGER for it: it
    // pins the actual expression that produces the number, rather than checking that ten column names are
    // absent from one call's argument list.
    const computeSrc = readFileSync(resolve(root, 'core/leave-compute.ts'), 'utf8');
    const start = computeSrc.indexOf('export function composeEntitlement(');
    const body = computeSrc.slice(start, start + 2000);
    expect(body, 'the day figure must be read off the template band').toContain(
      'const templateDays = p.templateBand ? p.templateBand.days : null;',
    );
    expect(body, 'and it must be the composed figure, not a derived one').toContain('days: templateDays ?? 0,');
    // ...and not one rule column may appear in the composition at all — a rule that started deciding days
    // is exactly the smuggled behaviour change this guard has always been for.
    for (const [field] of RULE_COLUMNS) {
      expect(body.includes(field), `composeEntitlement must not read leaveType.${field}`).toBe(false);
    }
  });
});
