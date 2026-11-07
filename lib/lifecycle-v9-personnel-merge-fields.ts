type MergeField = { key: string; label: string; type?: 'phone' | 'email' | 'date' };

export const personnelMergeGroups: { label: string; fields: MergeField[] }[] = [
  { label: 'Profile › Personal details', fields: [
    { key: 'employee.empNo', label: 'Employee ID' }, { key: 'employee.name', label: 'Full name' },
    { key: 'employee.icNo', label: 'IC number' }, { key: 'race', label: 'Race' },
    { key: 'religion', label: 'Religion' }, { key: 'nationality', label: 'Nationality' },
    { key: 'gender', label: 'Gender' }, { key: 'marital', label: 'Marital status' },
  ] },
  { label: 'Profile › Passport', fields: [{ key: 'employee.passportNo', label: 'Passport number' }] },
  { label: 'Profile › Contact & address', fields: [
    { key: 'email', label: 'Work email', type: 'email' }, { key: 'mobile', label: 'Mobile phone number', type: 'phone' },
    { key: 'homePhone', label: 'Home phone number', type: 'phone' }, { key: 'personalEmail', label: 'Personal email', type: 'email' },
    { key: 'address', label: 'Address' },
  ] },
  { label: 'Employment › Organisation', fields: [
    { key: 'company.name', label: 'Company' }, { key: 'employee.department', label: 'Department' },
    { key: 'employee.position', label: 'Position' }, { key: 'employee.supervisor', label: 'Direct superior' },
  ] },
  { label: 'Employment › Dates', fields: [
    { key: 'joiner.joinDate', label: 'Join date', type: 'date' }, { key: 'leaver.lastDay', label: 'Last working date', type: 'date' },
  ] },
];

export const personnelMergeLabels = new Map(personnelMergeGroups.flatMap(group => group.fields.map(field => [field.key, field.label] as const)));
