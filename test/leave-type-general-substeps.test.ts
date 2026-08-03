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
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const panelSrc = readFileSync(resolve(here, '../components/leave-type-panel.tsx'), 'utf8');
const subStepBarSrc = readFileSync(resolve(here, '../components/leave-sub-step-bar.tsx'), 'utf8');
const pageSrc = readFileSync(resolve(here, '../app/admin/leave/entitlements/page.tsx'), 'utf8');
const matrixSrc = readFileSync(resolve(here, '../app/admin/leave-approval/workflow-matrix.tsx'), 'utf8');
const approvalPageSrc = readFileSync(resolve(here, '../app/admin/leave/approval/page.tsx'), 'utf8');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

// e4238594 removed 'workflow' — the General walk ends at Carry Forward Policy.
const SUB_STEP_KEYS = ['details', 'yearType', 'earning', 'carry'] as const;

/** Slice the General card's segment (its CardTitle to the next card's CardTitle — the Entitlement card
 *  since b8fcae73 removed the Eligibility card that used to sit between them). */
function generalSegment(): string {
  const start = panelSrc.indexOf("<CardTitle>{t('categoryGeneral')}</CardTitle>");
  const end = panelSrc.indexOf("<CardTitle>{t('categoryEntitlement')}</CardTitle>");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return panelSrc.slice(start, end);
}

/** 1e4eb8af — the Custom Settings card's segment (its CardTitle to the end of the panel: it is the last
 *  step card). The Leave Year Type sub-form now lives in here. */
function customSegment(): string {
  const start = panelSrc.indexOf("<CardTitle>{t('categoryCustom')}</CardTitle>");
  expect(start).toBeGreaterThan(-1);
  return panelSrc.slice(start);
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

  it('the panel renders the SubStepBar inside the General card with the sub-steps in walk order', () => {
    expect(panelSrc).toMatch(/import \{ SubStepBar \} from '\.\/leave-sub-step-bar'/);
    // 1e4eb8af dropped 'yearType' (moved to Custom Settings); feedback 4d6eae7b puts it BACK as sub-step 2,
    // the reporter's stated order — the cycle is chosen before the rules that operate inside it.
    expect(panelSrc).toContain(
      "const GENERAL_SUB_STEP_KEYS = ['details', 'yearType', 'earning', 'carry'] as const",
    );
    const seg = generalSegment();
    expect(seg).toContain('<SubStepBar');
    // Exactly one sub-step's content renders at a time — each gates its own block.
    for (const key of SUB_STEP_KEYS) {
      expect(seg.includes(`{generalSubStep === '${key}' && (`), `sub-step '${key}' gated`).toBe(true);
    }
  });

  it('persists the sub-step alongside activeStep in the leaveTypeCards shape (compatible migration)', () => {
    // The ONE writer persists the keys together (08bc6841 extended the e1a51aea shape with essSubStep,
    // 7b945408 with entitlementSubStep — the secondary flows ride the same persistence, see
    // leave-condition-substeps.test.ts / leave-entitlement-substeps.test.ts)…
    expect(panelSrc).toContain(
      "JSON.stringify({ activeStep: step, generalSubStep: sub, essSubStep: ess, entitlementSubStep: ent })",
    );
    // …and hydration tolerates an older payload: activeStep-only and the accordion { key: boolean } shape
    // both still restore (the categories test separately pins parsed[k] === true).
    expect(panelSrc).toContain("typeof parsed.generalSubStep === 'string'");
  });
});

describe('e1a51aea · Details keeps the existing General content', () => {
  it('the identity form, leave unit and per-date approval live in the details sub-step', () => {
    const seg = generalSegment();
    const details = seg.slice(seg.indexOf("generalSubStep === 'details'"), seg.indexOf("generalSubStep === 'yearType'"));
    for (const needle of ['name="identity"', 'name="leaveUnit"', 'name="partialApproval"']) {
      expect(details.includes(needle), `${needle} inside details`).toBe(true);
    }
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
describe('4d6eae7b · Leave Year Type (per-type cycle override) — back in the General walk', () => {
  it('posts the yearCycle tri-state marker + the yearCycleValue select through updateTypeAction', () => {
    const seg = generalSegment();
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
    const seg = generalSegment();
    expect(seg).not.toMatch(/value="a2c" disabled/);
    expect(seg).toContain('<option value="a2c">');
    expect(seg).not.toContain("t('subStep.pendingEngineNote')");
    // The stored value must round-trip into the select's defaultValue, or the choice renders as lost.
    expect(seg).toContain("yearCycleOverride === 'a2c'");
  });

  // ONE HOME — the invariant 1e4eb8af introduced, kept verbatim and simply pointed the other way.
  it('lives ONLY in the General walk — Custom Settings no longer hosts a second copy', () => {
    const custom = customSegment();
    expect(custom.includes('name="yearCycleValue"')).toBe(false);
    expect(custom.includes('name="yearCycle" value="1"')).toBe(false);
    // The whole panel contains exactly ONE of each control, wherever it lives.
    expect(panelSrc.match(/name="yearCycleValue"/g)).toHaveLength(1);
    expect(panelSrc.match(/name="yearCycle" value="1"/g)).toHaveLength(1);
    // …and it is gated by its own sub-step, so exactly one sub-step's content renders at a time.
    expect(generalSegment()).toContain("{generalSubStep === 'yearType' && (");
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
describe('9816a5ad step 2 · Earning Method + Carry Forward write the leave TYPE', () => {
  it('both sub-steps post setTypeRulesAction, and no longer post updatePolicyAction', () => {
    const seg = generalSegment();
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
    const seg = generalSegment();
    // One leave type, one set of rules — a company/grade picker here would imply per-scope rules again,
    // which is the duplication the item exists to remove.
    expect(seg).not.toContain('<PolicyFrontDoor');
  });

  it('each form marks WHICH half of the rule row it rendered, so the other half survives', () => {
    const earningForm = panelSrc.slice(
      panelSrc.indexOf('function EarningMethodForm'),
      panelSrc.indexOf('function CarryPolicyForm'),
    );
    const carryForm = panelSrc.slice(
      panelSrc.indexOf('function CarryPolicyForm'),
      panelSrc.indexOf('function PolicyFrontDoor'),
    );
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
    expect(earningForm).toContain("<option value=\"monthly\">{t('subStep.earningByMonth')}</option>");
    expect(earningForm).toContain("<option value=\"daily\">{t('subStep.earningDaily')}</option>");
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
    const carryForm = panelSrc.slice(
      panelSrc.indexOf('function CarryPolicyForm'),
      panelSrc.indexOf('function PolicyFrontDoor'),
    );
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
  it('the panel no longer renders an approval slot, and the sub-step key is gone', () => {
    const seg = generalSegment();
    expect(seg).not.toContain('approvalWorkflowSection');
    expect(seg).not.toContain("{generalSubStep === 'workflow' && (");
    expect(panelSrc).not.toContain('approvalWorkflowSection?: ReactNode');
  });

  it('NO LINK OR PLACEHOLDER stands in its place — the reporter rejected that explicitly', () => {
    // rev 1 offered to leave a pointer to the Approval tab; the reporter said no. A stub step would keep
    // the duplication complaint alive while adding a step that does nothing.
    const seg = generalSegment();
    expect(seg).not.toContain("t('subStep.workflowUnavailable')");
    expect(seg).not.toContain('href="/admin/leave/approval"');
  });

  it('the Entitlements page stopped preparing approval data entirely', () => {
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

  it('the STANDALONE Approval tab still renders the matrix over non-default rules — the real home survives', () => {
    // This is what makes the removal safe rather than merely tidy: every rule the embed could edit was
    // type-scoped and non-default, and the tab renders a strict superset of them.
    expect(approvalPageSrc).toContain('WorkflowMatrix');
    expect(approvalPageSrc).toContain('buildWorkflowMatrixLabels');
    expect(approvalPageSrc).toContain('isCompanyDefaultApprovalRule');
  });

  it('the standalone actions still reuse the shared persist helpers — only the wrappers retired', () => {
    const approvalActionsSrc = readFileSync(resolve(here, '../app/admin/leave-approval/actions.ts'), 'utf8');
    for (const [action, helper] of [
      ['saveLeaveApprovalRuleAction', 'persistApprovalRule'],
      ['archiveLeaveApprovalRuleAction', 'persistArchiveApprovalRule'],
    ] as const) {
      const start = approvalActionsSrc.indexOf(`export async function ${action}(`);
      expect(start, `${action} exists`).toBeGreaterThan(-1);
      const body = approvalActionsSrc.slice(start, approvalActionsSrc.indexOf('\n}', start));
      expect(body.includes(`${helper}(s, formData)`), `${action} reuses ${helper}`).toBe(true);
    }
    // The 4e9a4d59 stay-on-this-type wrappers had no caller once the embed went (the r100 precedent).
    expect(approvalActionsSrc).not.toContain('export async function saveLeaveApprovalRuleFromEntitlementsAction');
    expect(approvalActionsSrc).not.toContain('export async function archiveLeaveApprovalRuleFromEntitlementsAction');
  });

  it('WorkflowMatrix keeps its defaultLeaveTypeId seeding for the tab that still uses it', () => {
    expect(matrixSrc).toContain('defaultLeaveTypeId');
    expect(matrixSrc).toContain('initial={row ? row.leaveTypeId : defaultLeaveTypeId}');
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
        'noActivePolicy',
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
