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

const SUB_STEP_KEYS = ['details', 'yearType', 'earning', 'carry', 'workflow'] as const;

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
      "const GENERAL_SUB_STEP_KEYS = ['details', 'yearType', 'earning', 'carry', 'workflow'] as const",
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

  it('the TENANT-WIDE leave-year records stay in Custom Settings', () => {
    const seg = customSegment();
    expect(seg).toContain("t('leaveYearConfigTitle')");
    expect(seg).toContain('{leaveYearSection}');
    // The slot is declared as a server-composed ReactNode, like halfDaySection.
    expect(panelSrc).toContain('leaveYearSection?: ReactNode;');
  });
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
    expect(panelSrc).toContain("'by_month' ? 'earned_monthly'");
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

  it('renders Earn-Upon-Resignation DISABLED with the pending-engine note', () => {
    expect(panelSrc).toMatch(/value="resignation" disabled/);
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

describe('e1a51aea · Approval Workflow sub-step (scoped matrix embed)', () => {
  it('the panel renders the server-composed approvalWorkflowSection slot in the workflow sub-step', () => {
    const seg = generalSegment();
    expect(seg).toContain('{approvalWorkflowSection ??');
  });

  it('the page embeds WorkflowMatrix filtered + seeded to the hosting type', () => {
    expect(pageSrc).toContain('rows={approvalRuleRows.filter((r) => r.leaveTypeId === lt.id)}');
    expect(pageSrc).toContain('defaultLeaveTypeId={lt.id}');
    // 4e9a4d59 — the embedded matrix now posts the stay-on-this-type wrappers instead of the Approval
    // tab's actions, so a rule save/delete no longer throws HR out of the leave type they're setting up.
    // The PERSIST behaviour still cannot fork: both entry points run the same two persist helpers, and
    // only the post-save redirect differs (workspace → okEntitlements, standalone → the Approval page).
    expect(pageSrc).toContain('saveLeaveApprovalRuleFromEntitlementsAction');
    expect(pageSrc).toContain('archiveLeaveApprovalRuleFromEntitlementsAction');
    const approvalActionsSrc = readFileSync(
      resolve(here, '../app/admin/leave-approval/actions.ts'),
      'utf8',
    );
    for (const [action, helper] of [
      ['saveLeaveApprovalRuleAction', 'persistApprovalRule'],
      ['saveLeaveApprovalRuleFromEntitlementsAction', 'persistApprovalRule'],
      ['archiveLeaveApprovalRuleAction', 'persistArchiveApprovalRule'],
      ['archiveLeaveApprovalRuleFromEntitlementsAction', 'persistArchiveApprovalRule'],
    ] as const) {
      const start = approvalActionsSrc.indexOf(`export async function ${action}(`);
      expect(start, `${action} exists`).toBeGreaterThan(-1);
      const body = approvalActionsSrc.slice(start, approvalActionsSrc.indexOf('\n}', start));
      expect(body.includes(`${helper}(s, formData)`), `${action} reuses ${helper}`).toBe(true);
    }
    // Only the workspace pair returns through the shared stay-on-page contract; the standalone pair keeps
    // landing on the Approvals screen.
    expect(approvalActionsSrc).toContain("from '@/app/admin/_redirects'");
    // One label source shared with the Approval tab (matrix-labels.ts), so the two matrices cannot drift.
    expect(pageSrc).toContain('buildWorkflowMatrixLabels');
    expect(approvalPageSrc).toContain('buildWorkflowMatrixLabels');
  });

  it('wildcard any-type rules render read-only with the applies-to-all-types badge; default chain is summarised', () => {
    expect(pageSrc).toContain('r.leaveTypeId == null');
    expect(pageSrc).toContain("t('approvalStep.wildcardBadge')");
    expect(pageSrc).toContain("t('approvalStep.defaultChainTitle')");
    // One click to the company-wide config.
    expect(pageSrc).toContain('href="/admin/leave/approval"');
    // The company-default filter is the SHARED core helper (no local re-implementation).
    expect(pageSrc).toContain('isCompanyDefaultApprovalRule');
    expect(approvalPageSrc).toContain('isCompanyDefaultApprovalRule');
  });

  it('WorkflowMatrix seeds a NEW rule to the embed type but leaves existing rules + the Approval tab unchanged', () => {
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
      // 1e4eb8af — the Leave Year Configuration section title in Custom Settings, hosting the relocated
      // Leave Year Type sub-form and the leave-year records slot.
      expect(typeof leave.leaveYearConfigTitle, `${loc} leaveYearConfigTitle`).toBe('string');
      const sub = leave.subStep ?? {};
      for (const key of [
        'details',
        // 'yearType' (the sub-step TITLE) is back with the sub-step itself — 4d6eae7b returned the form to
        // the General walk. leaveYearConfigTitle above still names the Custom Settings section that keeps
        // the tenant-wide leave-year RECORDS.
        'yearType',
        'yearTypeStepHelp',
        'earning',
        'carry',
        'workflow',
        'yearTypeLabel',
        'yearTypeCompanyDefault',
        'yearTypeA2a',
        'yearTypeA2c',
        'yearTypeC2c',
        'yearTypeHelp',
        // f3a64d90 retired the shared pendingEngineNote (it also named the now-live Anniversary to
        // Calendar) for a dedicated key that speaks only about Earn Upon Resignation.
        'resignationPendingNote',
        'earningMethodLabel',
        'earningNone',
        'earningByMonth',
        'earningByYear',
        'earningResignation',
        'earningMappingHelp',
        'earningHelp',
        // Feedback b81d3c52 — Rounding Method, configured directly under Earning Method. This array is
        // HARDCODED (the loop only asserts the keys literally listed here), so every new sub-step key MUST
        // be appended or a locale that drops it still passes green.
        'roundingMethodLabel',
        'roundingNone',
        'roundingUp',
        'roundingDown',
        'roundingHelp',
        'carryPolicyLabel',
        'carryNone',
        'carryFixedMax',
        'carryHelp',
        'carryStepHelp',
        'carryAnnualOnly',
        'noActivePolicy',
        'frontDoorScopeLabel',
        'workflowUnavailable',
      ]) {
        expect(typeof sub[key], `${loc}.admin.leave.subStep.${key}`).toBe('string');
        expect((sub[key] as string).length, `${loc}.admin.leave.subStep.${key} non-empty`).toBeGreaterThan(0);
      }
      const ap = leave.approvalStep ?? {};
      for (const key of [
        'hint',
        'wildcardTitle',
        'wildcardBadge',
        'wildcardNone',
        'defaultChainTitle',
        // r79 0322 — 'defaultChainOff' is GONE with company.leave_multi_approval. It printed "Single
        // approver (multi-step approval off)" INSTEAD of the chain, i.e. the summary hid the very rule
        // that was about to run. A one-level chain now renders as itself and says the same thing truthfully.
        'openApprovalTab',
      ]) {
        expect(typeof ap[key], `${loc}.admin.leave.approvalStep.${key}`).toBe('string');
        expect((ap[key] as string).length, `${loc}.admin.leave.approvalStep.${key} non-empty`).toBeGreaterThan(0);
      }
    }
  });
});
