import { matches, matchChecklist, specificity, type Checklist, type Config, type Facts, type Module, type Rules } from './lifecycle-v9-model';
import { canonicalV9EmploymentRule } from './lifecycle-v9-employment';
export type ChecklistCandidate = { id: string; module: Module; facts: Facts; selectedChecklistId?: string | null };
function overlap(left: Rules, right: Rules): boolean {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].every(key => {
    const dimension = key as keyof Rules;
    const normalize = (value: string) => dimension === 'employmentType' ? canonicalV9EmploymentRule(value) ?? value : value;
    const a = (left[dimension] ?? []).map(normalize), b = (right[dimension] ?? []).map(normalize);
    return !a.length || !b.length || a.some(value => b.includes(value));
  });
}
export function checklistPopulation(config: Config, current: Checklist, candidates: ChecklistCandidate[]) {
  const rows = candidates.filter(candidate => candidate.module === current.module).map(candidate => {
    const automatic = matchChecklist(config, { module: candidate.module, facts: candidate.facts, override: 'automatic' });
    const selectedId = candidate.selectedChecklistId === undefined ? automatic.checklist?.id ?? null : candidate.selectedChecklistId;
    return { id: candidate.id, name: candidate.facts.name, matches: matches(current.rules, candidate.facts), selected: selectedId === current.id, fixed: candidate.selectedChecklistId !== undefined, tie: automatic.tie, selectedName: config.checklists.find(checklist => checklist.id === selectedId)?.name ?? (selectedId ? 'Retained case snapshot' : 'No checklist') };
  });
  const conflicts = config.checklists.filter(checklist => checklist.id !== current.id && checklist.module === current.module && specificity(checklist.rules) === specificity(current.rules) && overlap(checklist.rules, current.rules));
  return { rows, matching: rows.filter(row => row.matches).length, selected: rows.filter(row => row.selected).length, conflicts };
}
