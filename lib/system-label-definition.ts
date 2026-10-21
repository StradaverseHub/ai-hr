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
export const LABEL_TEMPLATE_NOTE = 'See the Sample sheet for examples. Existing codes will be skipped.';
/** Business worksheet names and headings are an adapter into the existing canonical create fields. */
export const LABEL_TEMPLATE_DEFINITIONS = [
  ...ORGANISATION_LABEL_KINDS.map(kind => ({
    kind, sheet: { department: 'Departments', position: 'Positions', cost_center: 'Cost Centres', business_unit: 'Business Units' }[kind],
    columns: [
      ['Code', 'Code'], ['Label', 'Label'], ['Description', 'Description'],
      ...(['department', 'business_unit'].includes(kind) ? [['Head (leave approver)', 'Head Employee Code']] : []),
      ['Company', 'Company'], ['Criteria', 'Criteria'], ['Criteria Companies', 'Criteria Companies'], ['Status', 'Status'],
    ],
  })),
  { kind: 'grades', sheet: 'Job Grade', columns: [['Code', 'Code'], ['Label', 'Label'], ['Description', 'Description'], ['Rank', 'Rank'], ['Status', 'Status']] },
  { kind: 'grade_groups', sheet: 'Grade Groups', columns: [['Group name', 'Name'], ['Grades in this group', 'Grade Codes']] },
  ...EMPLOYMENT_LABEL_CATEGORIES.map(kind => ({ kind, sheet: kind[0].toUpperCase() + kind.slice(1), columns: [['Code', 'Code'], ['Label', 'Label'], ['Description', 'Description'], ['Status', 'Status']] })),
] as const;
export type LabelImportMode = 'add' | 'update' | 'merge';
export type LabelImportRow = { sheet: string; row: number; values: Record<string, string>; warnings?:string[] };
export type LabelImportRowReason = 'existing'|'duplicate'|'conflicting'|'unsupportedCategory'|'required'|'invalidCompany'|'invalidCriteria'|'invalidCriteriaCompany'|'globalAdminRequired'|'criteriaCompaniesRequired'|'invalidHeadEmployee'|'invalidStatus'|'wholeNumber'|'invalidGradeCode'|'gradeLabelExists'|'invalidGradeReferences'|'gradeAlreadyGrouped'|'invalidRow'|'notSelected';
export type LabelImportRequiredField = 'Code'|'Company'|'Description'|'Label'|'Name';
export type LabelImportPreviewRow = LabelImportRow & {
  outcome: 'add' | 'update' | 'skip' | 'error'; message: string;
  before: Record<string, string> | null; after: Record<string, string>;
  selected?: boolean; stale?: boolean; reason?: LabelImportRowReason; reasonField?: LabelImportRequiredField;
};
export type LabelImportPreview = { token: string; rows: LabelImportPreviewRow[]; valid: boolean; mode?: LabelImportMode };
