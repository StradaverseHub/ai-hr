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

  it('keeps the bulk AssignForm and its explicit multi-step-off warning untouched', () => {
    expect(manager).toContain('<AssignForm');
    expect(manager).toContain('assignAction={actions.assign}');
    expect(manager).toContain('multiApprovalAction={actions.setMultiApproval}');
    expect(manager).toContain('const offCompanies = selectedCompanies.filter((id) => !companyMultiApproval[id]);');
    expect(manager).toContain('{labels.enableMultiApproval}');
    // No auto-enable: the switch is only ever flipped by that explicit button's form.
    expect(manager).not.toMatch(/setMultiApproval\([^)]*\)\s*;/);
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

  it('heads section 2 Assignment Template with the assignment list, the scoped matrix and escalation', () => {
    const section2 = page.slice(page.indexOf("t('assignmentTemplateTitle')"));
    expect(section2).toContain('<ApprovalAssignmentManager');
    expect(section2).toContain('assign: assignApprovalTemplateAction');
    expect(section2).toContain('unassign: unassignApprovalTemplateAction');
    // 2.i condition (min/max days), 2.ii advanced scope, 2.iv grade group all live in the matrix.
    expect(section2).toContain('<WorkflowMatrix');
    expect(section2).toContain('gradeGroups={gradeGroupsAll');
    expect(section2).toContain('minDays: r.minDays');
    expect(section2).toContain('maxDays: r.maxDays');
    expect(section2).toContain('businessUnits={businessUnitsAll');
    // 2.iii escalation is inside the assignment section now.
    expect(section2).toContain('<LeaveEscalationEditor');
  });

  it('collapses the per-company block into one disclosure line per company (no Card stack)', () => {
    expect(page).toContain("<SectionHeader title={t('companyDefaultsTitle')} count={rows.length} />");
    expect(page).toContain("t('companyDefaultsHint')");
    const list = page.slice(page.indexOf("t('companyDefaultsTitle')"));
    expect(list).toMatch(/rows\.map\(\(\{ company, pol, esc \}\) => \(/);
    expect(list).toContain('<li key={company.id}>');
    expect(list).toMatch(/<details className="group">/);
    expect(list).toContain('[&::-webkit-details-marker]:hidden');
    // The old full-height "one Card per company" stack is gone.
    expect(page).not.toContain('<Card key={company.id}>');
  });

  it('keeps the base chain, the explicit multi-step switch and the escalation gate exactly as before', () => {
    const list = page.slice(page.indexOf("t('companyDefaultsTitle')"));
    expect(list).toContain('<LeaveApprovalEditor');
    expect(list).toContain('action={saveLeaveApprovalPolicyAction}');
    expect(list).toContain('initialEnabled={pol.enabled}');
    expect(list).toContain('action={saveLeaveEscalationPolicyAction}');
    // Escalation stays gated on pol.enabled, with the single-approver placeholder otherwise.
    expect(list).toMatch(/\{pol\.enabled \? \(/);
    expect(list).toContain("t('escalationUnavailableSingleApprover')");
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
    'companyDefaultsTitle',
    'companyDefaultsHint',
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
    for (const k of ['escalationTitle', 'escalationUnavailableSingleApprover', 'gradeGroup', 'advancedScope', 'conditions']) {
      expect(typeof ns[k], `en.${k}`).toBe('string');
    }
  });
});
