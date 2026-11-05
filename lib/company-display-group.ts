import { EMPLOYMENT_LABEL_CATEGORIES } from './system-label-definition';

export const companyDisplayGroupFields = ['business_unit', 'department', ...EMPLOYMENT_LABEL_CATEGORIES] as const;
export type CompanyDisplayGroupField = (typeof companyDisplayGroupFields)[number];
export type CompanyDisplayGroupOption = {
  field: CompanyDisplayGroupField;
  id: string;
  code: string;
  label: string;
};
export type CompanyDisplayGroup = Pick<CompanyDisplayGroupOption, 'field' | 'id'>;
