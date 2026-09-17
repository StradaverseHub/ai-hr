/**
 * Enhance Leave Type Configuration Flow Structure and Move Approval Workflow (feedback e1a51aea).
 *
 * The General step (step 1 of the c979aa8b workspace flow) becomes a guided sub-step walk —
 * 1 Details · 2 Earning Method · 3 Carry Forward Policy · 4 Approval Workflow —
 * switched by a REUSABLE sub-step control (components/leave-sub-step-bar.tsx, the R61 step-bar mechanism
 * generalized; the Condition/Entitlements secondary flows filed separately MUST reuse it). The active
 * sub-step persists per type ALONGSIDE activeStep in the leaveTypeCards:<id> localStorage shape
 * (backward-compatible: older payloads still hydrate, generalSubStep defaults to Details).
 *
 * Content contract:
 *  - Details keeps the EXACT existing General content (identity/rename, leave unit, per-date approval;
 *    the read-only statutory-floor row was removed by feedback 3c093c7a) — the
 *    leave-type-config-categories.test.ts anchors keep guarding it.
 *  - Leave Year Type: a per-type override select posting the `yearCycle=1` tri-state marker
 *    (leave_type.year_cycle_override, migration 0303). Item 1e4eb8af MOVED this sub-form out of the
 *    General walk into the Custom Settings step's Leave Year Configuration section, so every leave-year
 *    decision is made in one place beside the managed leave-year records the retired Application Rules
 *    tab used to host. The form itself is unchanged — the assertions below simply follow it there.
 *  - Earning Method + Carry Forward Policy are FRONT DOORS to the ACTIVE policy row: they post the SAME
 *    updatePolicyAction the Eligibility edit form posts (no new storage; the per-policy field stays the
 *    single source of truth), and the Earn-Upon-Resignation option renders DISABLED pending engine work.
 *  - Approval Workflow embeds the SAME WorkflowMatrix the Approval tab renders (server-composed slot),
 *    scoped + seeded to the hosting type, with wildcard any-type rules shown read-only under an
 *    "applies to all types" badge and the per-company default chain summarised read-only.
 *
 * Static source guard (the repo convention for this DOM-runner-less component; see
 * leave-type-config-categories.test.ts). Engine behaviour for year_cycle_override lives in
 * leave-year-cycle-override.test.ts. Browser verification covers the interactive switching.
 *
 * ══ a6fe37fc ROUND 5 (cutover) — THIS GUARD PINNED THE OLD ARRANGEMENT AND CAME DUE. ═════════════════
 *
 * `components/leave-type-panel.tsx` is DELETED. The four steps and six sub-steps it carried — the thing
 * IA §1.2 identifies as the actual subject of the reporter's complaint — are the FIVE TABS of
 * `/admin/leave-config/types`. AGENTS 18: each case's REASONING is carried onto the new screen, not
 * deleted, and the migration order's Round 2 table says where each half goes:
 *
 *   · Details and Leave Year Type answer "what is this leave type"      → TAB 1 `identity`
 *   · Earning Method and Carry Forward answer "how many days", which is the same question the day tables
 *     answer, so they join them                                          → TAB 3 `entitlement`
 *   · Per-date approval answers "who approves it"                        → TAB 5 `approvers`
 *   · the SubStepBar REUSE CONTRACT survives on the component itself, which is NOT deleted:
 *     components/leave/generate-form.tsx and components/leave/adjustment-form.tsx still mount it.
 *
 * WHAT IS DELIBERATELY NOT RE-CREATED: the General sub-step WALK. There is no `GENERAL_SUB_STEP_KEYS`,
 * no `generalSubStep === 'details'` gate and no second bar inside a tab, because the walk was the
 * mechanism being replaced. The invariants those gates protected — one home per sub-form, one marker per
 * form, one tab rendered at a time — are all still asserted below, against the tab that now holds each.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * a6fe37fc ROUND 5 (cutover) — RE-POINTED, NOT DELETED. `components/leave-type-panel.tsx` (3,367 lines)
 * was DELETED with the page that mounted it: the four steps and six sub-steps it carried are the FIVE
 * TABS of `/admin/leave-config/types` (IA §2), which is what this whole item was raised about. The panel
 * became three files, so what this guard scans is their concatenation — the property it pins is about the
 * leave TYPE screen, not about one filename, and pinning it to a file that no longer exists would have
 * taken the guard out rather than moved it.
 */
const LEAVE_TYPE_SCREEN = [
  'app/admin/leave-config/types/page.tsx',
  'app/admin/leave-config/types/leave-type-tabs.tsx',
  'app/admin/leave-config/types/leave-type-sub-forms.tsx',
];
const panelSrc = LEAVE_TYPE_SCREEN.map((f) => readFileSync(resolve(here, '..', f), 'utf8')).join('\n');
const tabsSrc = readFileSync(resolve(here, '../app/admin/leave-config/types/leave-type-tabs.tsx'), 'utf8');
const subStepBarSrc = readFileSync(resolve(here, '../components/leave-sub-step-bar.tsx'), 'utf8');
const generateFormSrc = readFileSync(resolve(here, '../components/leave/generate-form.tsx'), 'utf8');
const adjustmentFormSrc = readFileSync(resolve(here, '../components/leave/adjustment-form.tsx'), 'utf8');
const pageSrc = readFileSync(resolve(here, '../app/admin/leave-config/types/page.tsx'), 'utf8');
/**
 * a6fe37fc ROUND 5 (cutover) — RE-POINTED, NOT DELETED. e4238594's property is that the rows the deleted
 * embed used to maintain are STILL maintained, by the assignment section on the approval screen — the
 * "nothing is stranded" half of the removal. The approval screen is `/admin/leave-config/approval-chains`
 * now and the old address is a redirect stub that maintains nothing, so the assertion follows the screen.
 */
const approvalPageSrc = readFileSync(
  resolve(here, '../app/admin/leave-config/approval-chains/page.tsx'),
  'utf8',
);

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

/** The five tabs, in the order the decisions are made (IA §2). Kept here as a literal rather than
 *  imported, so a rename of a tab key is visible in the diff of a guard rather than absorbed silently. */
const TABS = ['identity', 'eligibility', 'entitlement', 'application', 'approvers'] as const;

/**
 * Slice ONE tab's rendered block out of leave-type-tabs.tsx: from its own `{activeTab === 'x' && (` gate
 * to the next tab's. This is the direct successor of the old `generalSegment()` / `customSegment()`
 * card-title slices — same technique, new container — and it is what lets every "…lives in THIS part of
 * the screen, and only there" assertion below survive the rewrite intact.
 */
function tabSegment(key: (typeof TABS)[number]): string {
  const start = tabsSrc.indexOf(`{activeTab === '${key}' && (`);
  expect(start, `tab '${key}' has no gated block`).toBeGreaterThan(-1);
  const next = TABS.slice(TABS.indexOf(key) + 1)
    .map((k) => tabsSrc.indexOf(`{activeTab === '${k}' && (`))
    .find((i) => i > start);
  return tabsSrc.slice(start, next ?? tabsSrc.length);
}

describe('e1a51aea · reusable sub-step control', () => {
  it('components/leave-sub-step-bar.tsx exports SubStepBar with the step-bar accent/active pattern', () => {
    expect(subStepBarSrc).toContain('export function SubStepBar');
    // Same active treatment as the main bar: accent wash + semibold label + aria-current="step" + 1-based badge.
    expect(subStepBarSrc).toContain('bg-accent');
    expect(subStepBarSrc).toContain('font-semibold');
    expect(subStepBarSrc).toMatch(/aria-current=\{stepActive \? 'step' : undefined\}/);
    expect(subStepBarSrc).toContain('{i + 1}');
    // Reuse contract: the component is generic (steps come in as data) — nothing leave-general-specific.
    expect(subStepBarSrc).toContain('steps: SubStep[]');
  });

  it('the SubStepBar SURVIVES the cutover, because two live screens still mount it', () => {
    // ⚠️ THE COMPONENT IS NOT DELETED WITH THE PANEL, and this is the case that says why. The General
    // sub-step WALK is gone — it is the mechanism a6fe37fc replaced with five tabs — but
    // `components/leave-sub-step-bar.tsx` is mounted by Generate entitlement and Adjustments, both of
    // which are untouched by this item. Deleting it as "the panel's bar" would have broken two screens
    // that have nothing to do with leave types.
    expect(generateFormSrc).toMatch(/from '@\/components\/leave-sub-step-bar'|from '\.\.\/leave-sub-step-bar'/);
    expect(adjustmentFormSrc).toMatch(/from '@\/components\/leave-sub-step-bar'|from '\.\.\/leave-sub-step-bar'/);
    // …and the reuse contract itself, which is what made the component worth generalising: steps in as
    // data, nothing leave-general-specific baked in.
    expect(subStepBarSrc).toContain('steps: SubStep[]');
  });

  it('the leave type screen renders ONE bar, of five tabs, and gates exactly one at a time', () => {
    // The successor of "the SubStepBar inside the General card with the sub-steps in walk order". What is
    // asserted is unchanged in substance — one navigation control, every destination gated on its own key,
    // no second bar nested inside a destination — and the destinations are the five tabs now.
    expect(tabsSrc).toContain(
      "export const TAB_KEYS = ['identity', 'eligibility', 'entitlement', 'application', 'approvers'] as const",
    );
    for (const key of TABS) {
      expect(tabsSrc.includes(`{activeTab === '${key}' && (`), `tab '${key}' gated`).toBe(true);
    }
    // NO nested bar: the sub-step walk is the thing being replaced, so re-creating one inside a tab would
    // reintroduce exactly the arrangement IA §1.2 names as the defect.
    expect(tabsSrc).not.toContain('<SubStepBar');
    expect(tabsSrc).not.toContain('GENERAL_SUB_STEP_KEYS');
  });

  it('a browser holding an OLD sub-step payload is remapped, never snapped back to tab 1', () => {
    // The compatible-migration promise, carried across verbatim in intent. The old writer persisted
    // `{ activeStep, generalSubStep, essSubStep }` under `leaveTypeCards:<id>`; the new screen reads its
    // own key first and then those, so an administrator who was standing on Earning Method reopens on the
    // tab that now holds it rather than being thrown back to the first tab.
    expect(tabsSrc).toContain('activeTab');
    expect(tabsSrc).toContain("typeof parsed.generalSubStep === 'string'");
    // …and every retired STEP key has a destination in the remap table, or a stored payload naming it
    // would fall through to tab 1 — the "snapped back" behaviour this case exists to forbid.
    const table = tabsSrc.slice(
      tabsSrc.indexOf('const RETIRED_STEP_TO_TAB'),
      tabsSrc.indexOf('const RETIRED_GENERAL_SUB_STEP_TO_TAB'),
    );
    for (const retired of ['general', 'ess', 'entitlement', 'custom', 'eligibility']) {
      expect(new RegExp(`\\b${retired}:`).test(table), `retired step key '${retired}' has no remap`).toBe(true);
    }
  });
});

describe('e1a51aea · Details keeps the existing General content — as tab 1', () => {
  it('the identity form and the leave unit live on tab 1, which is what "the leave type" means', () => {
    const identity = tabSegment('identity');
    for (const needle of ['name="identity"', 'name="leaveUnit"']) {
      expect(identity.includes(needle), `${needle} on tab 1`).toBe(true);
    }
  });

  it('per-date approval MOVED to tab 5, because it answers who approves it (IA §2)', () => {
    // ⚠️ RE-POINTED, NOT DROPPED, and the third field of the old Details sub-step is the one that moved.
    // The migration order names it explicitly: "Same form, same marker, same column — Tab 5". The
    // invariant is ONE HOME: the whole screen carries exactly one of this marker, so two editors cannot
    // write one column from two places.
    expect(tabSegment('approvers')).toContain('name="partialApproval"');
    expect(tabSegment('identity').includes('name="partialApproval"')).toBe(false);
    expect(panelSrc.match(/name="partialApproval" value="1"/g)).toHaveLength(1);
  });
});

/**
 * FEEDBACK 4d6eae7b REVERSES 1e4eb8af'S RELOCATION, and these assertions are INVERTED rather than deleted.
 *
 * 1e4eb8af moved the per-type Leave Year Type override out of the General walk into Custom Settings, on the
 * reasoning that every leave-year decision should be made in one place. The reporter has now asked for the
 * General section to read: Details, Leave Year Type, Earning Method, Carry Forward Policy, Approval
 * Workflow — and gave a better reason: "The Leave Year Type determines the leave cycle, while the Earning
 * Method and Rounding Method determine how leave is credited within that cycle." So the override goes back
 * to General, ahead of the rules it scopes.
 *
 * THE INVARIANT THESE TESTS PROTECT IS UNCHANGED, and it is the one that matters: the sub-form has exactly
 * ONE home. Two copies would be two tri-state markers writing one column from different screens, which is
 * how a saved override silently gets reset. Only WHICH home changed.
 *
 * The tenant-wide managed leave-year RECORDS stay in Custom Settings. They are not a property of a leave
 * type, they carry an applies-company-wide badge, and putting them inside a per-type walk would say
 * something untrue about their scope.
 */
describe('4d6eae7b · Leave Year Type (per-type cycle override) — on tab 1, with Details', () => {
  it('posts the yearCycle tri-state marker + the yearCycleValue select through updateTypeAction', () => {
    const seg = tabSegment('identity');
    expect(seg).toContain('<input type="hidden" name="yearCycle" value="1" />');
    expect(seg).toContain('name="yearCycleValue"');
    // The three cycle options + the company-default fallback.
    for (const v of ['value=""', 'value="a2a"', 'value="a2c"', 'value="c2c"']) {
      expect(seg.includes(v), `option ${v}`).toBe(true);
    }
  });

  // f3a64d90 switched Anniversary-to-Calendar ON (its engine semantics shipped with that item), so the
  // option is now SELECTABLE and its pending-engine note is gone — the inverse of the e1a51aea assertion.
  it('renders Anniversary-to-Calendar SELECTABLE with no pending-engine note (f3a64d90)', () => {
    const seg = tabSegment('identity');
    expect(seg).not.toMatch(/value="a2c" disabled/);
    expect(seg).toContain('<option value="a2c">');
    expect(seg).not.toContain("t('subStep.pendingEngineNote')");
    // The stored value must round-trip into the select's defaultValue, or the choice renders as lost.
    expect(seg).toContain("yearCycleOverride === 'a2c'");
  });

  // ONE HOME — the invariant 1e4eb8af introduced, kept verbatim and simply pointed the other way.
  it('lives ONLY on tab 1 — no other tab hosts a second copy', () => {
    // THE INVARIANT IS THE POINT AND IT IS UNCHANGED: this sub-form has exactly ONE home. Two copies
    // would be two tri-state markers writing one column from different places, which is how a saved
    // override silently gets reset. 1e4eb8af moved it, 4d6eae7b moved it back, a6fe37fc moved it onto a
    // tab — three relocations, one invariant, and this is the assertion that survived all three.
    for (const other of TABS.filter((k) => k !== 'identity')) {
      expect(tabSegment(other).includes('name="yearCycleValue"'), `${other} has a second copy`).toBe(false);
    }
    // The whole screen contains exactly ONE of each control, wherever it lives.
    expect(panelSrc.match(/name="yearCycleValue"/g)).toHaveLength(1);
    expect(panelSrc.match(/name="yearCycle" value="1"/g)).toHaveLength(1);
  });

  // 4b0e76ae REMOVED the block this case used to pin. The tenant-wide leave-year RECORDS no longer live in
  // Custom Settings — or anywhere else: the section, the leaveYearSection slot, both dialogs, the four
  // writing actions and the rows themselves are gone, and entitlement GENERATION moved to its own page at
  // /admin/leave/generate in the same release. test/leave-generate-page.test.ts pins the removal and the
  // new home; the 4d6eae7b assertions above are untouched, because the per-type CYCLE override is a
  // different control and this item did not touch it.
});

/**
 * SUPERSEDED BY 9816a5ad STEP 2, DELIBERATELY. This block used to pin the opposite contract: that both
 * sub-steps were "front doors" posting updatePolicyAction, with the per-company/grade policy row as the
 * single source of truth and NO new storage. The consolidation reverses exactly that — the engines now
 * read the five rules from the leave TYPE, so a policy write would save successfully and change nothing
 * the calculation reads. The old assertions are not weakened here, they are inverted, and the invariant
 * they protected (these forms write ONE known place, never a second parallel store) is what is re-pinned.
 */
describe('9816a5ad step 2 · Earning Method + Carry Forward write the leave TYPE — from tab 3', () => {
  // ⚠️ a6fe37fc ROUND 5 — THEY MOVED TO TAB 3, AND THE MOVE IS THE POINT OF THE REDESIGN.
  // Earning method and carry forward answer "how many days", which is the same question the entitlement
  // day tables answer; they sat in the General *step* only because that is where the code grew (IA §1.2).
  // Everything 9816a5ad pinned about them — one destination, per-half markers, no policy write — is
  // asserted unchanged below, against the tab that now holds them.
  it('both forms post setTypeRulesAction, and no longer post updatePolicyAction', () => {
    const seg = tabSegment('entitlement');
    expect((seg.match(/action=\{setTypeRulesAction\}/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // The regression that matters: if either sub-step goes back to writing a policy row, it becomes a
    // control that saves and does nothing, which is worse than an absent one.
    expect(seg).not.toContain('action={updatePolicyAction}');
    expect(panelSrc).toContain('function EarningMethodForm');
    expect(panelSrc).toContain('function CarryPolicyForm');
    const earningForm = panelSrc.slice(
      panelSrc.indexOf('function EarningMethodForm'),
      panelSrc.indexOf('function CarryPolicyForm'),
    );
    expect(earningForm).toContain('<form action={action}');
    // The reporter's vocabulary still maps onto the engine's method values; only the destination moved.
    expect(earningForm).toContain('name="method"');
    expect(earningForm).toContain('name="leaveTypeId"');
    // bc36c768 replaced the reporter's OLD vocabulary ('by_month' → 'earned_monthly') with the three
    // choices they actually asked for. The mapping assertion moves with it rather than being deleted:
    // what this test is really pinning is that the select speaks a UI vocabulary and something maps it to
    // an engine value, which is still true — the vocabulary changed, the invariant did not.
    expect(panelSrc).toContain("c === 'monthly'");
    expect(panelSrc).toContain("'earned_monthly'");
    expect(panelSrc).toContain("'earned_daily'");
  });

  it('the per-policy scope picker is gone, because there is no longer a scope', () => {
    // One leave type, one set of rules — a company/grade picker here would imply per-scope rules again,
    // which is the duplication the item exists to remove. Asserted over the WHOLE screen now rather than
    // one card: after the rewrite there is no card to hide it in.
    expect(panelSrc).not.toContain('<PolicyFrontDoor');
  });

  it('each form marks WHICH half of the rule row it rendered, so the other half survives', () => {
    const earningForm = panelSrc.slice(
      panelSrc.indexOf('function EarningMethodForm'),
      panelSrc.indexOf('function CarryPolicyForm'),
    );
    // `PolicyFrontDoor` was the old end-marker for this slice and went with the panel (there is no
    // per-policy front door any more — see the case above). The slice ends at the file's end instead,
    // which is where CarryPolicyForm's own body ends in leave-type-sub-forms.tsx.
    const carryForm = panelSrc.slice(panelSrc.indexOf('function CarryPolicyForm'));
    // Earning and Carry are two forms over ONE row. Without a marker naming the rendered half, an
    // earning-only save clears the carry configuration — the exact footgun the old front doors worked
    // around by re-posting the other half as hidden inputs.
    expect(earningForm).toContain('name="earningRendered"');
    expect(carryForm).toContain('name="carryBlockRendered"');
    // Neither may post the other half's fields any more; the tri-state replaces the hidden re-post.
    expect(earningForm.includes('name="carryForwardMax"')).toBe(false);
    expect(carryForm.includes('name="roundingMethodRendered"')).toBe(false);
  });

  // bc36c768 INVERTED THIS TEST. It used to assert that Earn Upon Resignation rendered DISABLED with an
  // apologetic note. The reporter's request was to remove the option outright — it had never calculated
  // anything and never would on this item's watch — so the assertion becomes its own negation, which is
  // the honest way to retire a pinned behaviour: the pin stays, the expectation flips, and nobody can
  // reintroduce the option without this failing.
  it('Earn-Upon-Resignation is GONE — not disabled, not hidden, removed', () => {
    expect(panelSrc).not.toMatch(/value="resignation"/);
    expect(panelSrc).not.toContain('earningResignation');
    // The unconditional amber paragraph that explained the disabled option goes with it.
    expect(panelSrc).not.toContain('resignationPendingNote');
  });

  // bc36c768 — the same treatment for By Year, the other choice that added up to no distinct behaviour:
  // it mapped to grant_on_hire_prorated, byte-identically to None.
  it('By Year is GONE — it was the same stored value and the same arithmetic as None', () => {
    expect(panelSrc).not.toContain('earningByYear');
    expect(panelSrc).not.toMatch(/value="by_year"/);
  });

  it('the earning method list is exactly three choices', () => {
    const earningForm = panelSrc.slice(
      panelSrc.indexOf('function EarningMethodForm'),
      panelSrc.indexOf('function CarryPolicyForm'),
    );
    expect(earningForm).toContain("<option value=\"none\">{t('subStep.earningNone')}</option>");
    // r299 (3de1453a) — UPDATED, NOT LOOSENED: Monthly and Daily are still two of the three choices, and now
    // carry `disabled={!annualOn}` because only Annual Leave may earn ("This is our Annual Leave").
    expect(earningForm).toMatch(
      /<option value="monthly" disabled=\{!annualOn\}>\s*\{t\('subStep\.earningByMonth'\)\}\s*<\/option>/,
    );
    expect(earningForm).toMatch(/<option value="daily" disabled=\{!annualOn\}>\s*\{t\('subStep\.earningDaily'\)\}\s*<\/option>/);
    // Exactly three real choices (the Not configured placeholder is value ""), counted in the earning select
    // only — the Rounding select below it has its own "none".
    const earningSelect = earningForm.slice(0, earningForm.indexOf('name="roundingMethodRendered"'));
    expect([...earningSelect.matchAll(/<option value="(none|monthly|daily)"/g)].map((m) => m[1])).toEqual([
      'none',
      'monthly',
      'daily',
    ]);
    // The quarterly round-trip option is gone from the dropdown. It survives as a READ-ONLY re-post for a
    // type that still stores it (see the unknown-method branch), which is what lets the option go without
    // recreating the eee43966 silent-downgrade class.
    expect(earningForm).not.toMatch(/value="by_quarter"/);
    expect(earningForm).toContain('unknownStoredMethod');
  });

  it('the accrual-day field is revealed by Monthly Accrual only, and is required there', () => {
    const earningForm = panelSrc.slice(
      panelSrc.indexOf('function EarningMethodForm'),
      panelSrc.indexOf('function CarryPolicyForm'),
    );
    expect(earningForm).toContain("choice === 'monthly' && (");
    expect(earningForm).toContain('name="accrualDay"');
    expect(earningForm).toContain('required');
    expect(earningForm).toContain('max={31}');
  });

  it('the carry front door reuses CarryExpiryFields (the existing days/months expiry switch)', () => {
    // `PolicyFrontDoor` was the old end-marker for this slice and went with the panel (there is no
    // per-policy front door any more — see the case above). The slice ends at the file's end instead,
    // which is where CarryPolicyForm's own body ends in leave-type-sub-forms.tsx.
    const carryForm = panelSrc.slice(panelSrc.indexOf('function CarryPolicyForm'));
    expect(carryForm).toContain('<CarryExpiryFields');
    expect(carryForm).toContain("t('subStep.carryNone')");
    expect(carryForm).toContain("t('subStep.carryFixedMax')");
  });
});

describe('e4238594 · the Approval Workflow sub-step is GONE, and nothing is stranded', () => {
  // e1a51aea embedded the Approval tab's own WorkflowMatrix inside every leave type, scoped to that type.
  // The reporter's complaint was that the same approval configuration appeared twice; the tab is the real
  // home (templates are built and assigned there, and the full rule list is maintained there). These
  // assertions replace the embed's contract with its removal, and — more importantly — pin the reason the
  // removal is SAFE, which is the part a future reader will need.
  it('no tab renders an approval EDITOR slot, and the retired sub-step key is nowhere', () => {
    // a6fe37fc kept e4238594's removal and did not re-create it in the rewrite. Asserted over the whole
    // screen rather than one card: after the rewrite there is no card for it to hide in.
    expect(panelSrc).not.toContain('approvalWorkflowSection');
    expect(panelSrc).not.toContain("generalSubStep === 'workflow'");
  });

  it('what tab 5 DOES carry is a READ-OUT, not the editor e4238594 removed', () => {
    // ⚠️ THE DISTINCTION THIS CASE EXISTS FOR. Round 4 gave tab 5 a read-only view of which chain reaches
    // this type, its ordered steps and its escalation — columns that route live requests and were shown
    // NOWHERE after 706d34e8 (IA §4.1). That is a read-out over rows the assignment section maintains,
    // not a second editor over them, and saying so here is what stops the next reader deleting it as a
    // regression against e4238594.
    const approvers = tabSegment('approvers');
    // The read-out is server-composed and handed in as a slot (the page loads it; this file renders it),
    // which is the same shape every other server-composed section on this screen uses.
    expect(approvers).toContain('{approvalReadoutSection}');
    expect(pageSrc).toContain('LeaveTypeApprovalReadout');
    expect(approvers).not.toContain('WorkflowMatrix');
    // A read-out has no write path: no form bound to an approval-rule action anywhere on the screen.
    expect(panelSrc).not.toContain('saveLeaveApprovalRuleAction');
    expect(panelSrc).not.toContain('archiveLeaveApprovalRuleAction');
  });

  it('NO LINK OR PLACEHOLDER stands in its place — the reporter rejected that explicitly', () => {
    // rev 1 offered to leave a pointer to the Approval tab; the reporter said no. A stub step would keep
    // the duplication complaint alive while adding a step that does nothing. (Tab 5's read-out DOES link
    // to Approval chains to change anything — that is a different thing: a read-out saying where the
    // editor is, not a placeholder standing in for a deleted step.)
    expect(panelSrc).not.toContain("t('subStep.workflowUnavailable')");
    // And never a LITERAL address: r259's one-direction rule — every cross-screen link resolves through
    // the map, so a link and the menu entry beside it cannot give two answers.
    expect(panelSrc).not.toContain("href=\"/admin/leave/approval\"");
    expect(panelSrc).not.toContain("href=\"/admin/leave-config/approval-chains\"");
  });

  it('the leave TYPE screen prepares no approval EDITOR data', () => {
    // The embed cost a fan of reads on every render of this page (departments, positions, business units,
    // templates, and one policy + rule list PER COMPANY). All of it went with the sub-step.
    //
    // Asserted STRUCTURALLY — against imports and JSX, not bare identifiers — because the comments that
    // record WHY the block was removed necessarily name the things it used. A bare-substring assertion here
    // would forbid explaining the removal, which is the opposite of what this file is for.
    expect(pageSrc).not.toContain('<WorkflowMatrix');
    expect(pageSrc).not.toMatch(/^import .*workflow-matrix'/m);
    expect(pageSrc).not.toMatch(/^import .*matrix-labels'/m);
    expect(pageSrc).not.toMatch(/^import .*leave-approval-template'/m);
    expect(pageSrc).not.toMatch(/^import .*leave-approval-policy'/m);
    expect(pageSrc).not.toMatch(/^import \{[^}]*FromEntitlementsAction/m);
    // The derived data is gone too, not merely unrendered.
    expect(pageSrc).not.toMatch(/const approvalRuleRows =/);
    expect(pageSrc).not.toMatch(/const approvalMatrixShared =/);
  });

  /**
   * 706d34e8 (r155) OVERTOOK THIS ASSERTION, and the honest thing is to say so rather than delete it.
   *
   * It read: "the STANDALONE Approval tab still renders the matrix over non-default rules — the real home
   * survives", and that was e4238594's whole safety argument — the embed could only edit type-scoped,
   * non-default rules, and the tab showed a strict superset. The tab has since dropped the matrix too, so
   * the superset claim moved DOWN a layer rather than evaporating: the Assignment Template section on that
   * same tab creates these rows (`assignApprovalTemplate` stamps `template_id` onto
   * `leave_approval_policy`) and lists every active row that carries one, so nothing e4238594's embed
   * maintained became unreachable. What DID go is the ability to author a template-less rule at all — and
   * that is the property that makes both removals compose instead of stranding rows between them.
   */
  it('the rows the embed maintained are still maintained — by ASSIGNMENT, on the same tab', () => {
    // Commentary stripped first: the page's own header explains the removal and therefore NAMES the matrix.
    // Forbidding that would forbid explaining the change, which is the r134 mistake.
    const approvalCode = approvalPageSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '');
    expect(approvalCode).not.toContain('WorkflowMatrix');
    expect(approvalPageSrc).toContain('<ApprovalAssignmentManager');
    expect(approvalPageSrc).toContain('listTemplateAssignments');
    const template = readFileSync(resolve(here, '../core/leave-approval-template.ts'), 'utf8');
    // The assignment service writes the same table the embed's matrix edited — that is the load-bearing fact.
    expect(template).toContain('leaveApprovalPolicy');
    expect(template).toContain('export async function assignApprovalTemplate');
    expect(template).toContain('export async function listTemplateAssignments');
  });

  it('no per-rule write path survives its screen — the wrappers went at e4238594, the rest at 706d34e8', () => {
    const approvalActionsSrc = readFileSync(resolve(here, '../app/admin/leave-approval/actions.ts'), 'utf8');
    // The 4e9a4d59 stay-on-this-type wrappers had no caller once the embed went (the r100 precedent)…
    expect(approvalActionsSrc).not.toContain('export async function saveLeaveApprovalRuleFromEntitlementsAction');
    expect(approvalActionsSrc).not.toContain('export async function archiveLeaveApprovalRuleFromEntitlementsAction');
    // …and 706d34e8 removed the matrix those wrappers' standalone twins served, so the twins and their
    // shared persist helpers went the same way. This used to assert the twins still existed and reused the
    // helpers; it is inverted rather than deleted so re-introducing an unreachable writer is a visible
    // decision. The DOMAIN operations in core/leave-approval-policy.ts are untouched and still exercised.
    expect(approvalActionsSrc).not.toContain('saveLeaveApprovalRuleAction');
    expect(approvalActionsSrc).not.toContain('archiveLeaveApprovalRuleAction');
    expect(approvalActionsSrc).not.toContain('persistApprovalRule');
  });
});

describe('e1a51aea · i18n — all six locales', () => {
  it('renames the step-1 title to General (en) and carries every sub-step key in each locale', () => {
    const en = JSON.parse(readFileSync(resolve(here, '../messages/en.json'), 'utf8'));
    expect(en.admin.leave.categoryGeneral).toBe('General');
    for (const loc of LOCALES) {
      const msgs = JSON.parse(readFileSync(resolve(here, `../messages/${loc}.json`), 'utf8'));
      const leave = msgs?.admin?.leave ?? {};
      expect(typeof leave.workspaceSubStepsLabel, `${loc} workspaceSubStepsLabel`).toBe('string');
      const sub = leave.subStep ?? {};
      for (const key of [
        'details',
        // 'yearType' (the sub-step TITLE) is back with the sub-step itself — 4d6eae7b returned the form to
        // the General walk. The leaveYearConfigTitle assertion that used to sit above went with 4b0e76ae:
        // the Custom Settings leave-year section it named no longer exists, and neither does the key.
        'yearType',
        'yearTypeStepHelp',
        'earning',
        'carry',
        'yearTypeLabel',
        'yearTypeCompanyDefault',
        'yearTypeA2a',
        'yearTypeA2c',
        'yearTypeC2c',
        'yearTypeHelp',
        // bc36c768 retired 'resignationPendingNote', 'earningByYear' and 'earningResignation' with the two
        // options and the amber note they named. 'methodEarnedQuarterly' (admin.leave, not subStep) is
        // deliberately KEPT — the entitlement-timeline badge can still meet a legacy stored value.
        'earningMethodLabel',
        'earningNone',
        'earningByMonth',
        // bc36c768 — the third choice, the required credit day, and the three states the form can be in
        // that the reporter has to be able to read: not configured, a legacy method it cannot render, and
        // the daily+rounding pairing we warn about rather than block.
        'earningDaily',
        'earningNotConfigured',
        'earningNotConfiguredNote',
        'earningLegacyMethodNote',
        'accrualDayLabel',
        'accrualDayHelp',
        'dailyRoundingWarning',
        'earningMappingHelp',
        'earningHelp',
        // Feedback b81d3c52 — Rounding Method, configured directly under Earning Method. This array is
        // HARDCODED (the loop only asserts the keys literally listed here), so every new sub-step key MUST
        // be appended or a locale that drops it still passes green.
        // 8fec719e reduced the choice to two and retired 'roundingUp' / 'roundingDown' with the options
        // they named; 'roundingCustom' is the second choice and the band-table keys live in
        // leave-config-ui-r86a.test.ts, which owns that surface.
        'roundingMethodLabel',
        'roundingNone',
        'roundingCustom',
        'roundingHelp',
        'carryPolicyLabel',
        'carryNone',
        'carryFixedMax',
        'carryHelp',
        'carryStepHelp',
        'carryAnnualOnly',
        // 6e9a126e RELEASE THREE — 'noActivePolicy' labelled the EMPTY STATE of the leave_policy
        // timeline. 0410 drops the table and the timeline went with it, so the key has zero
        // callers and was retired from all six catalogs. Every other key in this list is still
        // rendered and still asserted.
        'frontDoorScopeLabel',
      ]) {
        expect(typeof sub[key], `${loc}.admin.leave.subStep.${key}`).toBe('string');
        expect((sub[key] as string).length, `${loc}.admin.leave.subStep.${key} non-empty`).toBeGreaterThan(0);
      }
      // e4238594 — subStep.workflow, subStep.workflowUnavailable and the whole approvalStep block are
      // RETIRED with the sub-step they described. Asserted absent in every locale: i18n-coverage only
      // enforces en -> other-locale parity, so it cannot see an orphaned key that survives in all six, and
      // dead copy is copy translators keep maintaining.
      expect(leave.approvalStep, `${loc}.admin.leave.approvalStep should be retired`).toBeUndefined();
      for (const key of ['workflow', 'workflowUnavailable']) {
        expect(sub[key], `${loc}.admin.leave.subStep.${key} should be retired`).toBeUndefined();
      }
    }
  });
});
