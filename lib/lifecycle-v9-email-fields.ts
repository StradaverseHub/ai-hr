import { personnelMergeGroups } from './lifecycle-v9-personnel-merge-fields';

const allowed = new Set([
  'employee.empNo', 'employee.name', 'nationality', 'gender', 'marital',
  'email', 'mobile', 'homePhone', 'personalEmail', 'address',
  'company.name', 'employee.department', 'employee.position', 'employee.supervisor',
  'joiner.joinDate', 'leaver.lastDay',
]);

export const lifecycleEmailFieldGroups = personnelMergeGroups.flatMap(group => {
  const fields = group.fields.filter(field => allowed.has(field.key));
  if (group.label === 'Employment › Organisation') {
    fields.splice(1, 0, { key: 'employee.businessUnit', label: 'Business unit' });
  }
  return fields.length ? [{ label: group.label, fields }] : [];
});
