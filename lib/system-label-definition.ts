/** The organisation label editors and Excel adapter share these identifiers and field mappings. */
export const ORGANISATION_LABEL_KINDS = ['department', 'position', 'cost_center', 'business_unit'] as const;
export type OrganisationLabelKind = typeof ORGANISATION_LABEL_KINDS[number];
export const EMPLOYMENT_LABEL_CATEGORIES = ['division', 'branch', 'region', 'line', 'section', 'team', 'base', 'category'] as const;
export const ORGANISATION_LABEL_COLUMNS = {
  department: [{ headerKey: 'code', field: 'name', required: true }, { headerKey: 'label', field: 'label' }, { headerKey: 'description', field: 'description' }],
  position: [{ headerKey: 'code', field: 'title', required: true }, { headerKey: 'label', field: 'label' }, { headerKey: 'description', field: 'description' }],
  cost_center: [{ headerKey: 'code', field: 'code', required: true }, { headerKey: 'label', field: 'label' }, { headerKey: 'description', field: 'name', required: true }],
  business_unit: [{ headerKey: 'code', field: 'code', required: true }, { headerKey: 'label', field: 'label' }, { headerKey: 'description', field: 'name', required: true }],
} as const;

export const LABEL_IMPORT_DEFINITIONS = [
  ...ORGANISATION_LABEL_KINDS.map(kind => ({ kind, scope: 'company' as const,
    columns: ['Company', 'Criteria', 'Criteria Companies', ...ORGANISATION_LABEL_COLUMNS[kind].map(c => ({code:'Code',label:'Label',description:'Description'}[c.headerKey])),
      ...(['department', 'business_unit'].includes(kind) ? ['Head Employee Code'] : [])] })),
  ...EMPLOYMENT_LABEL_CATEGORIES.map(kind => ({ kind, scope: 'tenant' as const, columns: ['Code', 'Label', 'Description', 'Sort Order'] })),
  { kind: 'grades', scope: 'tenant' as const, columns: ['Code', 'Label', 'Description', 'Rank'] },
  { kind: 'grade_groups', scope: 'tenant' as const, columns: ['Name', 'Grade Codes'] },
];
export type LabelImportKind = typeof LABEL_IMPORT_DEFINITIONS[number]['kind'];
export type LabelImportMode = 'add' | 'update' | 'merge';
export type LabelImportRow = { sheet: string; row: number; values: Record<string, string>; warnings?:string[] };
export type LabelImportPreviewRow = LabelImportRow & {
  outcome: 'add' | 'update' | 'skip' | 'error'; message: string;
  before: Record<string, string> | null; after: Record<string, string>;
  selected?: boolean; stale?: boolean;
};
export type LabelImportPreview = { token: string; rows: LabelImportPreviewRow[]; valid: boolean; mode?: LabelImportMode };
