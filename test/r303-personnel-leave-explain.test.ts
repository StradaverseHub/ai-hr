/** 39306a9e supersedes the Personnel balance mount. Pin its removal and every retained capability. */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { PersonnelTabKey } from '../components/personnel-tabs';
import { RETIRED_PERSONNEL_TABS } from '../lib/personnel-tab-sections';
const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const source = read('app/(app)/admin/personnel/[employmentId]/page.tsx');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name: string) {
  let found: ts.VariableDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(ast); return found;
}
function panel(name: string) {
  const panels = declaration('panels')?.initializer;
  expect(panels && ts.isObjectLiteralExpression(panels)).toBe(true);
  if (!panels || !ts.isObjectLiteralExpression(panels)) throw Error('Panel map missing');
  return panels.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(ast) === name)?.getText(ast);
}
const selfServiceHistoryTab: PersonnelTabKey = 'others';
describe('Personnel retains the Others capabilities at their new homes', () => {
  it('removes only duplicated balance/history data loading and the Others tab', () => {
    for (const name of ['leaveBalanceCard', 'recalcHistoryCard']) expect(declaration(name)).toBeUndefined();
    expect(source).not.toContain('leaveBalances('); expect(source).not.toContain('listEntitlementRecalcAudit(');
    expect(source).not.toContain('personnelLeaveBreakdowns'); expect(source).not.toContain('<EntitlementBreakdown');
    expect(source).not.toContain("t('tabs.others')"); expect(panel('others')).toBeUndefined();
    expect(source).not.toContain('leaveRequestsFor(s, employmentId)');
    expect(source).not.toContain('benefitSchemeView(');
  });
  it('keeps Grade and privacy while retiring the duplicated history and Employment review panels', () => {
    expect(panel('profile')).toContain('{profilePanel}{dataPrivacyCard}');
    expect(declaration('profilePanel')?.getText(ast)).not.toMatch(/changeHistoryCard|dataPrivacyCard/);
    expect(panel('leave')).toContain('{gradeCard}');
    for (const name of ['benefitSchemeCard','leaveRequestsCard']) {
      expect(declaration(name)).toBeUndefined();
      expect(panel('leave')).not.toContain(name);
    }
    expect(declaration('changeHistoryCard')).toBeUndefined();
    expect(declaration('reviewCard')).toBeUndefined();
    expect(panel('job')).not.toContain('reviewCard');
    expect(declaration('dataPrivacyCard')?.getText(ast)).toMatch(/admin\s*\?/);
    expect(source).toContain('/admin/audit?employment=');
    expect(source).toContain('saveProfileTabAction'); expect(source).toContain('saveJobTabAction');
  });
  it('preserves the shared self-service history tab while retiring only the admin tab', () => {
    expect(selfServiceHistoryTab).toBe('others');
    const selfService = read('app/(app)/me/profile-editor.tsx');
    expect(selfService).toContain("key==='others'");
    expect(selfService).toContain("t('requestHistory')");
  });
  it('retains saved links and stable report/permission field IDs after relabelling their tab', () => {
    expect(RETIRED_PERSONNEL_TABS.others).toBe('profile');
    expect(source).toContain("rawSearchParams.tab === 'others'");
    expect(source).toContain("query.set('tab', retiredDestination)");
    expect(source).toContain('redirect(`/admin/personnel/${encodeURIComponent(employmentId)}?${query}`)');
    const registry = read('lib/personnel-field-registry.ts');
    const rows = registry.split('\n').filter(line => line.includes('"id":"others.'));
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) {
      if (row.includes('"id":"others.change_history.')) expect(row).toContain('"tab":"Profile"');
      if (row.includes('"id":"others.leave_requests.')) expect(row).toContain('"tab":"Leave"');
      if (row.includes('"id":"others.probation_contract_internship_review.')) expect(row).toContain('"tab":"Employment"');
      expect(row).not.toContain('"tab":"Others"');
    }
    expect(read('app/(app)/leave/employee-balances/page.tsx')).toContain('hrExplanation={r.hrExplanation}');
  });
});
