import definitions from './lifecycle-v9-defaults.json';
import type { Config } from './lifecycle-v9-model';
import { parseV9Config } from './lifecycle-v9-validation';
import { defaultSettlementPolicy } from './lifecycle-v9-calculator';

/** Imported content only. There are no fixture users, cases, source records or simulated dates. */
export function v9Defaults(existingGroups: Config['groups'] = []): Config {
  const value = structuredClone(definitions);
  const mapping = new Map<string, string>();
  value.groups = value.groups.map(group => {
    const existing = existingGroups.find(g => g.id === group.id || g.name.toLocaleLowerCase() === group.name.toLocaleLowerCase());
    mapping.set(group.id, existing?.id ?? group.id);
    return { ...group, id: existing?.id ?? group.id, members: existing?.members.slice() ?? [], limit: existing?.limit ?? group.limit };
  }) as typeof value.groups;
  for (const cl of value.checklists) for (const task of cl.tasks) if (task.group) task.group = mapping.get(task.group) ?? task.group;
  if (value.peopleOpsGroup) value.peopleOpsGroup = mapping.get(value.peopleOpsGroup) ?? value.peopleOpsGroup;
  return parseV9Config({ ...value, settlementPolicy: defaultSettlementPolicy(), companies: [] });
}
