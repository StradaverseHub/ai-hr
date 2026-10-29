import type { CaseField } from './lifecycle-v9-case-form';
import type { Checklist as V9Checklist } from './lifecycle-v9-model';
import type { Checklist } from './onboarding-model';
export type V9ChecklistProjection = { revision: number; caseFields?: CaseField[]; owner: string | null; at: string; checklists: (V9Checklist & { ownerUserId?: string })[] };
/** Definitions have one owner. Native onboarding retains identity, instantiated tasks and history. */
export function onboardingV9Checklists(projection: V9ChecklistProjection): Checklist[] {
  return projection.checklists.map(checklist => {
    const owner = checklist.ownerUserId ?? projection.owner;
    if (!owner) throw Error('The V9 checklist owner is unavailable. Review these settings as a Master Admin.');
    if (checklist.rules.caseType?.length) throw Error('Case type matching is only available for offboarding.');
    const { caseType: _caseType, ...rules } = checklist.rules;
    return { id: checklist.id, name: checklist.name, owner, createdAt: checklist.createdAt ?? new Date(projection.at).toISOString(), rules: structuredClone(rules), tasks: checklist.tasks.map(task => ({
      id: task.id, name: task.name, by: task.by === 'employee' ? 'joiner' : task.by, group: task.group ?? '', method: task.mode, opens: task.opens, due: task.due,
      gate: false, required: task.required, documentTemplate: task.documentTemplate, documentAction: task.documentAction,
    })) };
  });
}
