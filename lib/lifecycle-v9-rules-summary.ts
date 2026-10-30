import type { RuleField, Rules } from './lifecycle-v9-model';
const names: Record<RuleField, string> = { businessGroup: 'Business Group', company: 'Company', department: 'Department', grade: 'Grade', employmentType: 'Employment type', title: 'Role', caseType: 'Case type' };
export function v9RulesSummary(rules: Rules, labels: Partial<Record<RuleField, Record<string, string>>> = {}): string {
  const parts = (Object.keys(names) as RuleField[]).flatMap(key => rules[key]?.length ? [`${names[key]}: ${rules[key]!.map(value => labels[key]?.[value] ?? value).join(', ')}`] : []);
  return parts.join(' · ') || 'Everyone · no matching rules';
}
