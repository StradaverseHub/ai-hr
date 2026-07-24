/**
 * Enhance Leave Type Configuration Flow Structure and Move Approval Workflow (feedback e1a51aea).
 *
 * The General step (step 1 of the c979aa8b workspace flow) becomes a guided FIVE-SUB-STEP walk —
 * 1 Details · 2 Leave Year Type · 3 Earning Method · 4 Carry Forward Policy · 5 Approval Workflow —
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
 *    (leave_type.year_cycle_override, migration 0303); the Anniversary-to-Calendar option renders
 *    DISABLED pending engine work (no hybrid-year semantics ship in this restructure).
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

/** Slice the General card's segment (its CardTitle to the next card's CardTitle). */
function generalSegment(): string {
  const start = panelSrc.indexOf("<CardTitle>{t('categoryGeneral')}</CardTitle>");
  const end = panelSrc.indexOf("<CardTitle>{t('categoryEligibilityEntitlement')}</CardTitle>");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return panelSrc.slice(start, end);
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

  it('the panel renders the SubStepBar inside the General card with the five sub-steps in walk order', () => {
    expect(panelSrc).toMatch(/import \{ SubStepBar \} from '\.\/leave-sub-step-bar'/);
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

describe('e1a51aea · Leave Year Type sub-step (per-type cycle override)', () => {
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
});

describe('e1a51aea · Earning Method + Carry Forward front doors (no new storage)', () => {
  it('both front-door forms post the SAME updatePolicyAction as the Eligibility policy edit form', () => {
    const seg = generalSegment();
    // The sub-steps hand updatePolicyAction to the front-door forms…
    expect((seg.match(/action=\{updatePolicyAction\}/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // …whose <form>s post it directly (the front-door components).
    expect(panelSrc).toContain('function EarningMethodForm');
    expect(panelSrc).toContain('function CarryPolicyForm');
    const earningForm = panelSrc.slice(
      panelSrc.indexOf('function EarningMethodForm'),
      panelSrc.indexOf('function CarryPolicyForm'),
    );
    expect(earningForm).toContain('<form action={action}');
    // The reporter's vocabulary maps onto the EXISTING per-policy methods — a hidden `method` field posts
    // the engine value, so the storage contract is byte-identical to the Eligibility select.
    expect(earningForm).toContain('name="method"');
    expect(panelSrc).toContain("'by_month' ? 'earned_monthly'");
  });

  it('preserves the non-edited policy fields (identity + carry block) so a front-door save cannot wipe them', () => {
    expect(panelSrc).toContain('function FrontDoorIdentityFields');
    expect(panelSrc).toContain('function FrontDoorPreservedCarry');
    const preserved = panelSrc.slice(
      panelSrc.indexOf('function FrontDoorIdentityFields'),
      panelSrc.indexOf('function EarningMethodForm'),
    );
    for (const field of ['name="annualDays"', 'name="validFrom"', 'name="gradeId"', 'name="companyId"', 'name="carryBlockRendered"']) {
      expect(preserved.includes(field), `${field} preserved`).toBe(true);
    }
    // Service bands are preserved by OMISSION (no serviceBandsRendered marker in the front doors) — the
    // tri-state in app/admin/actions.ts serviceBandsField. The band editor stays Eligibility-only.
    const frontDoors = panelSrc.slice(
      panelSrc.indexOf('function FrontDoorIdentityFields'),
      panelSrc.indexOf('function PolicyFrontDoor'),
    );
    expect(frontDoors.includes('serviceBandsRendered')).toBe(false);
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
      const sub = leave.subStep ?? {};
      for (const key of [
        'details',
        'yearType',
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
        'defaultChainOff',
        'openApprovalTab',
      ]) {
        expect(typeof ap[key], `${loc}.admin.leave.approvalStep.${key}`).toBe('string');
        expect((ap[key] as string).length, `${loc}.admin.leave.approvalStep.${key} non-empty`).toBeGreaterThan(0);
      }
    }
  });
});
