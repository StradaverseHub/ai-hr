/**
 * Feedback 9b0d99f3 — Approval Workflow Refactoring & Assignment Simplification.
 *
 * The Approval Workflow tab used to stack template CRUD, an assignments table with ONE ROW PER LEAVE
 * TYPE, the scoped workflow matrix and then a full-height Card per company on one very long page.
 * This change is presentation-only: two headed sections (Approval Template Creation / Assignment
 * Template), an assignment list collapsed to one line per (company × template) with a "+N more"
 * disclosure, and the per-company base chain + escalation folded into a compact one-line-per-company
 * list. NOTHING about routing, resolution or gating moves — core/leave-approval-policy.ts,
 * core/leave-approval-template.ts, core/leave.ts and the actions file are untouched, which is why the
 * existing approval suites (policy, rule matrix, grade group, escalation, multi-approval, template,
 * partial approval) need no edits.
 *
 * These are structural guards: the grouping helper is unit-tested directly, the rest is asserted
 * against the page/component source and the 6 locale dictionaries.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { groupTemplateAssignments } from '../app/admin/leave-approval/assignment-groups';

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'app/admin/leave/approval/page.tsx');
const MANAGER = path.join(ROOT, 'app/admin/leave-approval/template-manager.tsx');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

const page = fs.readFileSync(PAGE, 'utf8');
const manager = fs.readFileSync(MANAGER, 'utf8');
/**
 * COMMENTS ARE NOT CODE — the r134 rule, learned the hard way and re-learned at 706d34e8.
 *
 * A removal has to be able to explain itself, and an honest explanation NAMES the thing it removed
 * (`WorkflowMatrix`, `isCompanyDefaultApprovalRule`, the reads that fed them). A bare-substring absence
 * check over the raw file would then report correct code as wrong, which is worse than no guard — so the
 * absence assertions below run against the source with commentary stripped, and the structural ones
 * (imports, JSX tags) are anchored so a comment cannot satisfy them either.
 */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '');
const pageCode = stripComments(page);
const dict = (loc: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8'));

describe('assignment grouping helper (one line per company × workflow)', () => {
  it('collapses N leave types of one (company, template) into a single line: first + "+N-1 more"', () => {
    const rows = ['annual', 'sick', 'unpaid', 'hosp', 'marriage', 'study', 'compassionate', 'exam'].map((lt, i) => ({
      ruleId: `rule-${i}`,
      templateId: 'tpl-standard',
      companyId: 'fiamma',
      leaveTypeId: lt,
    }));
    const groups = groupTemplateAssignments(rows);

    expect(groups).toHaveLength(1);
    expect(groups[0].companyId).toBe('fiamma');
    expect(groups[0].templateId).toBe('tpl-standard');
    // "Annual Leave (+7 more)" — the reported shape.
    expect(groups[0].firstLeaveTypeId).toBe('annual');
    expect(groups[0].overflowCount).toBe(7);
    // Nothing hidden: the expanded set still carries every rule, each individually unassignable.
    expect(groups[0].rows).toHaveLength(8);
    expect(groups[0].rows.map((r) => r.ruleId)).toEqual(rows.map((r) => r.ruleId));
  });

  it('keeps a scoped rule that shares a leave type with the wildcard-bucket rule separately listed', () => {
    // createLeaveApprovalRule also stamps template_id, so a scoped rule shows up in
    // listTemplateAssignments next to the bulk-assigned one. Grouping is keyed by ruleId, never by
    // leave-type name, so BOTH rows survive and each keeps its own unassign.
    const groups = groupTemplateAssignments([
      { ruleId: 'bulk-1', templateId: 'tpl-standard', companyId: 'fiamma', leaveTypeId: 'annual' },
      { ruleId: 'scoped-1', templateId: 'tpl-standard', companyId: 'fiamma', leaveTypeId: 'annual' },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].overflowCount).toBe(1);
    expect(groups[0].rows.map((r) => r.ruleId)).toEqual(['bulk-1', 'scoped-1']);
  });

  it('splits by company and by template, and never drops a null (all leave types) row', () => {
    const groups = groupTemplateAssignments([
      { ruleId: 'a', templateId: 'tpl-1', companyId: 'c1', leaveTypeId: null },
      { ruleId: 'b', templateId: 'tpl-2', companyId: 'c1', leaveTypeId: 'annual' },
      { ruleId: 'c', templateId: 'tpl-1', companyId: 'c2', leaveTypeId: 'annual' },
      { ruleId: 'd', templateId: 'tpl-1', companyId: 'c1', leaveTypeId: 'sick' },
    ]);

    expect(groups.map((g) => g.key)).toEqual(['c1::tpl-1', 'c1::tpl-2', 'c2::tpl-1']);
    expect(groups[0].firstLeaveTypeId).toBeNull();
    expect(groups[0].rows.map((r) => r.ruleId)).toEqual(['a', 'd']);
    expect(groups[1].overflowCount).toBe(0);
    expect(groups.flatMap((g) => g.rows)).toHaveLength(4);
  });

  it('returns nothing for no assignments (the empty-state branch)', () => {
    expect(groupTemplateAssignments([])).toEqual([]);
  });
});

describe('assignment list rendering (template-manager)', () => {
  it('renders the grouped list, not one row per leave type', () => {
    expect(manager).toContain("import { groupTemplateAssignments } from './assignment-groups'");
    expect(manager).toContain('const groups = groupTemplateAssignments(assignments);');
    expect(manager).toMatch(/groups\.map\(\(g\) =>/);
    // The old per-assignment table body is gone.
    expect(manager).not.toMatch(/assignments\.map\(\(a\) => \(\s*<tr/);
  });

  it('folds the extra leave types behind a plain details/summary disclosure (no new dependency)', () => {
    const assignSection = manager.slice(manager.indexOf('export function ApprovalAssignmentManager'));
    expect(assignSection).toMatch(/<details\b/);
    expect(assignSection).toMatch(/<summary\b/);
    expect(assignSection).toContain('[&::-webkit-details-marker]:hidden');
    expect(assignSection).toContain('g.overflowCount > 0');
    expect(assignSection).toContain("t('leaveTypesMore', { n: g.overflowCount })");
  });

  it('keeps every row individually unassignable inside the disclosure, keyed by ruleId', () => {
    const assignSection = manager.slice(manager.indexOf('export function ApprovalAssignmentManager'));
    expect(assignSection).toMatch(/g\.rows\.map\(\(a\) => \(/);
    expect(assignSection).toContain('<li key={a.ruleId}');
    expect(assignSection).toContain('<form action={actions.unassign}>');
    expect(assignSection).toContain('name="ruleId" value={a.ruleId}');
  });

  it('keeps the bulk AssignForm', () => {
    expect(manager).toContain('<AssignForm');
    expect(manager).toContain('assignAction={actions.assign}');
  });

  /**
   * r79 0322 — the multi-step-off warning and its "Enable multi-step approval" button are GONE. They
   * existed because an assignment did nothing until company.leave_multi_approval was on; the assigned
   * template now decides on its own, so the warning would be false and the button would flip a flag
   * nothing reads. Asserted as ABSENCE because a leftover here is a control that lies.
   */
  it('no longer carries the per-company multi-step switch, its warning or its button', () => {
    expect(manager).not.toContain('companyMultiApproval');
    expect(manager).not.toContain('setMultiApproval');
    expect(manager).not.toContain('enableMultiApproval');
    expect(manager).not.toContain('multiApprovalOff');
    expect(manager).not.toContain('offCompanies');
  });

  it('slots the relocated escalation editor into the assignment card', () => {
    const assignSection = manager.slice(manager.indexOf('export function ApprovalAssignmentManager'));
    expect(assignSection).toContain('escalation?: React.ReactNode');
    expect(assignSection).toContain('{escalation}');
  });
});

describe('Approval Workflow page — two headed sections', () => {
  it('heads section 1 Approval Template Creation and puts the template CRUD there', () => {
    const s1 = page.indexOf("t('templateCreationTitle')");
    const s2 = page.indexOf("t('assignmentTemplateTitle')");
    expect(s1).toBeGreaterThan(-1);
    expect(s2).toBeGreaterThan(s1);
    const section1 = page.slice(s1, s2);
    expect(section1).toContain('<ApprovalTemplateManager');
    expect(section1).toContain('saveTemplate: saveApprovalTemplateAction');
    expect(section1).toContain('setDefault: setTenantDefaultTemplateAction');
    // Item 3 — the multi-step framing lives with template creation.
    expect(section1).toContain("t('multiStepNote')");
  });

  it('heads section 2 Assignment Template with the assignment list and escalation', () => {
    const section2 = page.slice(page.indexOf("t('assignmentTemplateTitle')"));
    expect(section2).toContain('<ApprovalAssignmentManager');
    expect(section2).toContain('assign: assignApprovalTemplateAction');
    expect(section2).toContain('unassign: unassignApprovalTemplateAction');
    // 2.iii escalation is inside the assignment section now.
    expect(section2).toContain('<LeaveEscalationEditor');
    // The assignment form still carries the 2.i condition (min/max days) and the 22de47c4 employee scope.
    // 6e9a126e release three renamed that scope's feed with the layer it reads (benefit schemes →
    // entitlement eligibility rules); what is asserted is that the section still HAS one.
    expect(section2).toContain('eligibilityRules={eligibilityRulesAll');
  });

  /**
   * 706d34e8 (r155) — THE SCOPED WORKFLOW MATRIX IS GONE, and this block used to assert it was here.
   *
   * It was a second editor over the same `leave_approval_policy` rows the Assignment Template section
   * above creates: `assignApprovalTemplate` inserts and archives those rows with a `template_id` stamped
   * on them, and `listTemplateAssignments` lists every active row that carries one — including the
   * all-wildcard company-default row — each still individually unassignable by ruleId. So removing the
   * matrix removed an editor, not a home: the only rows it could show and the assignment list cannot are
   * the ones with `template_id IS NULL`, which core/leave-approval-consolidation.ts calls LEGACY and which
   * 241817ef step 2 converted on production before this surface was allowed to go.
   *
   * Asserted as ABSENCE because a leftover here is the duplication the item exists to remove — and asserted
   * STRUCTURALLY (imports and JSX), because the page comment that records WHY necessarily names the thing.
   */
  it('no longer renders the per-rule Approval Workflows matrix, and stopped reading for it', () => {
    expect(pageCode).not.toContain('<WorkflowMatrix');
    expect(page).not.toMatch(/^import .*workflow-matrix'/m);
    expect(page).not.toMatch(/^import .*matrix-labels'/m);
    // The derived data is gone too, not merely unrendered — the matrix cost a rule list PER COMPANY plus
    // the department / position / business-unit / grade-group catalogues, and nothing else on the page
    // used any of them.
    for (const gone of [
      'listLeaveApprovalRules',
      'isCompanyDefaultApprovalRule',
      'buildWorkflowMatrixLabels',
      'gradeGroupsAll',
      'businessUnitsAll',
      'departmentsAll',
      'positionsAll',
    ]) {
      expect(pageCode, `${gone} must be gone from the page's CODE`).not.toContain(gone);
    }
  });

  it('the matrix component and its label builder are DELETED, not left orphaned', () => {
    // Its only importer was this page, and its `actions` prop has no supplier left. A component that
    // cannot be wired is worse than no component — it reads as a second way in that merely is not mounted
    // yet (the 645e67c4 "the strip is actually gone" rule, applied to a component instead of a nav strip).
    expect(fs.existsSync(path.join(ROOT, 'app/admin/leave-approval/workflow-matrix.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'app/admin/leave-approval/matrix-labels.ts'))).toBe(false);
  });

  it('KEEPS the templates section, the assignment section, escalation, and the route itself', () => {
    // The item removed one section, not the screen. Stated positively so a later over-eager cleanup that
    // takes the rest of the page with it fails here rather than in production.
    expect(page).toContain('<ApprovalTemplateManager');
    expect(page).toContain('<ApprovalAssignmentManager');
    expect(page).toContain('<LeaveEscalationEditor');
    expect(fs.existsSync(path.join(ROOT, 'app/admin/leave/approval/page.tsx'))).toBe(true);
    // …and the nav entry that reaches it.
    expect(fs.readFileSync(path.join(ROOT, 'packs/leave/index.ts'), 'utf8')).toContain("href: '/admin/leave/approval'");
  });

  /**
   * 241817ef step 2 (r94) — THE COMPANY BASE CHAIN SECTION IS GONE. This test used to assert the
   * opposite: that the per-company block collapsed into one disclosure line per company. It was correct
   * until the wildcard rules it edited had somewhere else to live, which is what
   * scripts/convert-approval-rules.ts gave them (51 assignments converted on production, routing proven
   * identical before and after in one transaction). The assignment template is now the single place
   * approvals are configured, which is what the item asked for.
   */
  it('no longer renders a company base approval chain section', () => {
    expect(page).not.toContain("t('companyDefaultsTitle')");
    expect(page).not.toContain("t('companyDefaultsHint')");
    expect(page).not.toContain('<LeaveApprovalEditor');
    expect(page).not.toContain('saveLeaveApprovalPolicyAction');
    // The read that fed only that card is gone too, rather than left fetching for nobody.
    expect(page).not.toContain('getLeaveApprovalPolicy');
    expect(page).not.toContain('pol.levels');
  });

  /**
   * Removing a surface must not leave its WRITER reachable. A caller-less server action is still an
   * addressable endpoint, so the company base chain would have stayed rewritable with no screen showing
   * it — the exact silent-configuration problem this item exists to end. core setLeaveApprovalPolicy is
   * deliberately KEPT: it is the domain operation and the policy suite drives it directly.
   */
  it('removes the base-chain server action, not just its screen', () => {
    const actions = fs.readFileSync(path.join(ROOT, 'app/admin/leave-approval/actions.ts'), 'utf8');
    expect(actions).not.toContain('saveLeaveApprovalPolicyAction');
    expect(actions).not.toContain('setLeaveApprovalPolicy');
    // The neighbouring actions are untouched — this was a removal, not a rewrite.
    expect(actions).toContain('saveLeaveEscalationPolicyAction');
  });

  /**
   * 706d34e8 (r155) applies THE SAME RULE to the per-rule actions, and the line above it used to assert
   * they survived. They were the writers behind the matrix; with the matrix gone they had no screen, and a
   * caller-less server action is still an addressable endpoint into `leave_approval_policy` that nothing
   * displays. Third time this file has recorded the rule: e4238594 (the workspace wrappers), 241817ef step
   * 2 (the base chain), now this.
   */
  it('the per-rule actions retire with their matrix — no unreachable write path into approval rules', () => {
    const actions = fs.readFileSync(path.join(ROOT, 'app/admin/leave-approval/actions.ts'), 'utf8');
    expect(actions).not.toContain('saveLeaveApprovalRuleAction');
    expect(actions).not.toContain('archiveLeaveApprovalRuleAction');
    // …and the parse/persist helpers that had no other caller.
    expect(actions).not.toContain('persistApprovalRule');
    expect(actions).not.toContain('persistArchiveApprovalRule');
    // ASSIGNMENT is now the only screen-reachable writer of these rows, and it must still be here.
    expect(actions).toContain('assignApprovalTemplateAction');
    expect(actions).toContain('unassignApprovalTemplateAction');
  });

  it('the SERVICES survive — removing a screen is not removing a service', () => {
    // resolveApprovalChain routes on these rows and core/leave-approval-consolidation.ts rewrites them.
    // Deleting the domain operations along with their screen is the failure mode this pins against.
    const policy = fs.readFileSync(path.join(ROOT, 'core/leave-approval-policy.ts'), 'utf8');
    for (const fn of ['createLeaveApprovalRule', 'updateLeaveApprovalRule', 'archiveLeaveApprovalRule', 'listLeaveApprovalRules']) {
      expect(policy, `core must keep ${fn}`).toContain(`export async function ${fn}(`);
    }
    expect(policy).toContain('export function isCompanyDefaultApprovalRule(');
  });

  it('relocates the escalation editor into the Assignment Template card, action and all', () => {
    const s2 = page.indexOf("t('assignmentTemplateTitle')");
    const escalationAt = page.indexOf('<LeaveEscalationEditor');
    // Inside section 2. The upper bound used to be the company section; that section is gone (241817ef
    // step 2), so the remaining fact is that escalation sits in the assignment card and appears ONCE.
    expect(escalationAt).toBeGreaterThan(s2);
    expect(page.split('<LeaveEscalationEditor').length - 1).toBe(1);
    expect(page).toContain('action={saveLeaveEscalationPolicyAction}');
    // Same editor, same action, same company columns: nothing was dropped and recreated.
    expect(page).toContain('escalateAfterDays: esc.escalateAfterDays');
    expect(page).toContain('targetRole: esc.targetRole');
    // Every company gets one now — the old "multi-step only" condition went with the switch.
    expect(page).not.toContain("t('escalationUnavailableSingleApprover')");
  });
});

describe('i18n — new labels ship in all 6 locales', () => {
  const KEYS = [
    'templateCreationTitle',
    'templateCreationHint',
    'multiStepNote',
    'assignmentTemplateTitle',
    'assignmentTemplateHint',
    'leaveTypesMore',
  ] as const;

  for (const loc of LOCALES) {
    it(`${loc} has every new leaveApproval key`, () => {
      const ns = dict(loc).leaveApproval ?? {};
      for (const k of KEYS) expect(typeof ns[k], `${loc}.${k}`).toBe('string');
      for (const k of KEYS) expect(ns[k].length, `${loc}.${k}`).toBeGreaterThan(0);
    });

    it(`${loc} states the "+N more" marker as an ICU plural`, () => {
      const v = dict(loc).leaveApproval.leaveTypesMore as string;
      expect(v, `${loc}.leaveTypesMore`).toMatch(/\{n,\s*plural,/);
      expect(v, `${loc}.leaveTypesMore`).toContain('other {');
      expect(v, `${loc}.leaveTypesMore`).toContain('#');
    });
  }

  it('reuses the existing escalation / scope / condition vocabulary rather than duplicating it', () => {
    const ns = dict('en').leaveApproval;
    for (const k of ['escalationTitle', 'escalationSectionHint', 'gradeGroup', 'advancedScope', 'conditions']) {
      expect(typeof ns[k], `en.${k}`).toBe('string');
    }
  });
});
