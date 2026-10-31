'use client';
import { canonicalV9EmploymentRule, v9EmploymentRuleLabel } from '@/lib/lifecycle-v9-employment';
import type { LifecycleV9Workspace } from '@/packs/lifecycle/service';
import type { RuleField, Rules } from '@/lib/lifecycle-v9-model';
export function MatchingRules({ rules, labels = {}, disabled, change, dimensions = ['businessGroup', 'company', 'department', 'grade', 'employmentType', 'caseType'] }: { rules: Rules; labels?: LifecycleV9Workspace['options']['labels']; disabled: boolean; change: (next: Rules) => void; dimensions?: RuleField[] }) {
  const names: Record<RuleField, string> = { businessGroup: 'Business Group', company: 'Company', department: 'Department', grade: 'Grade', employmentType: 'Employment type', caseType: 'Case type', title: 'Position' };
  return <div className="v9-stack"><p className="v9-muted">Empty dimensions match everyone. Values in one dimension are alternatives; populated dimensions must all match.</p><div className="v9-fields">{dimensions.map(key => {
    const values = [...new Set((rules[key] ?? []).map(value => key === 'employmentType' ? canonicalV9EmploymentRule(value) ?? value : value))];
    const options = { ...labels[key] }; for (const id of values) if (!options[id]) options[id] = key === 'employmentType' ? v9EmploymentRuleLabel(id) : `Unmapped reference: ${id}`;
    return <details className="v9-rule-picker" key={key}><summary>{names[key]} · {values.length ? `${values.length} selected` : 'Any'}</summary><div className="v9-stack">{Object.entries(options).map(([id, name]) => <label className="v9-actions" key={id}><input type="checkbox" disabled={disabled} checked={values.includes(id)} onChange={e => change({ ...rules, [key]: e.target.checked ? [...values, id] : values.filter(value => value !== id) })}/>{name}</label>)}{!Object.keys(options).length && <p className="v9-muted">No master records available.</p>}</div></details>;
  })}</div></div>;
}
