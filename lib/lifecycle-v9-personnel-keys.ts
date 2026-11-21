/** Personnel mappings for the reviewed Lifecycle handoff. No database or server runtime imports. */
export const v9PersonnelProfileKeys = { mobile: 'phone', homePhone: 'homePhone', personalEmail: 'personalEmail', race: 'race', religion: 'religion', nationality: 'nationality', emName: 'emergencyContactName', emRel: 'emergencyContactRelationship', emPhone: 'emergencyContactPhone' } as const;
export const v9PersonnelStatutoryKeys = { bankName: 'bank_name', bankAcc: 'bank_account_no', epfNo: 'epf_number', taxNo: 'tax_number' } as const;
export const v9PersonnelWritableKeys = [...Object.keys(v9PersonnelProfileKeys), ...Object.keys(v9PersonnelStatutoryKeys), 'gender', 'marital'];
