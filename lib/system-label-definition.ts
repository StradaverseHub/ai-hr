/** The organisation label editors and Excel adapter share these identifiers and field mappings. */
export const ORGANISATION_LABEL_KINDS = ['department', 'position', 'cost_center', 'business_unit'] as const;
export type OrganisationLabelKind = typeof ORGANISATION_LABEL_KINDS[number];
export const EMPLOYMENT_LABEL_CATEGORIES = ['division', 'branch', 'region', 'line', 'section', 'team', 'base', 'category'] as const;
export const PERSON_LABEL_CATEGORIES = ['religion','race','nationality','state','country','relationship','salutation','dependentRelationship','qualificationLevel'] as const;
export const PROFILE_LABEL_CATEGORIES = [...EMPLOYMENT_LABEL_CATEGORIES,...PERSON_LABEL_CATEGORIES] as const;
export const LABEL_SCOPE_COLUMNS = ['Criteria','Criteria Companies','Company'];
export const ORGANISATION_LABEL_COLUMNS = {
  department: [{ headerKey: 'code', field: 'name', required: true }, { headerKey: 'label', field: 'label' }, { headerKey: 'description', field: 'description' }],
  position: [{ headerKey: 'code', field: 'title', required: true }, { headerKey: 'label', field: 'label' }, { headerKey: 'description', field: 'description' }],
  cost_center: [{ headerKey: 'code', field: 'code', required: true }, { headerKey: 'label', field: 'label' }, { headerKey: 'description', field: 'name', required: true }],
  business_unit: [{ headerKey: 'code', field: 'code', required: true }, { headerKey: 'label', field: 'label' }, { headerKey: 'description', field: 'name', required: true }],
} as const;

/** scope denotes the storage family, not availability; every category resolves explicit company intent. */
export const LABEL_IMPORT_DEFINITIONS = [
  ...ORGANISATION_LABEL_KINDS.map(kind => ({ kind, scope: 'company' as const,
    columns: ['Company', 'Criteria', 'Criteria Companies', ...ORGANISATION_LABEL_COLUMNS[kind].map(c => ({code:'Code',label:'Label',description:'Description'}[c.headerKey])),
      ...(['department', 'business_unit'].includes(kind) ? ['Head Employee Code'] : [])] })),
  ...PROFILE_LABEL_CATEGORIES.map(kind => ({ kind, scope: 'tenant' as const, columns: ['Code', 'Label', 'Description', 'Sort Order',...LABEL_SCOPE_COLUMNS] })),
  { kind: 'grades', scope: 'tenant' as const, columns: ['Code', 'Label', 'Description', 'Rank',...LABEL_SCOPE_COLUMNS] },
  { kind: 'grade_groups', scope: 'tenant' as const, columns: ['Code','Label','Description','Name', 'Grade Codes',...LABEL_SCOPE_COLUMNS] },
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
  { kind: 'grades', sheet: 'Job Grade', columns: [['Code', 'Code'], ['Label', 'Label'], ['Description', 'Description'], ['Rank', 'Rank'], ['Status', 'Status'],...LABEL_SCOPE_COLUMNS.map(c=>[c,c])] },
  { kind: 'grade_groups', sheet: 'Grade Groups', columns: [['Group name', 'Name'], ['Grades in this group', 'Grade Codes'],...LABEL_SCOPE_COLUMNS.map(c=>[c,c])] },
  ...PROFILE_LABEL_CATEGORIES.map(kind => ({ kind, sheet: ({dependentRelationship:'Family Relationship',qualificationLevel:'Qualification Level'} as Record<string,string>)[kind]??kind[0].toUpperCase() + kind.slice(1), columns: [['Code', 'Code'], ['Label', 'Label'], ['Description', 'Description'], ['Status', 'Status'],...LABEL_SCOPE_COLUMNS.map(c=>[c,c])] })),
] as const;
export type LabelImportMode = 'add' | 'update' | 'merge';
export type LabelImportRow = { sheet: string; row: number; values: Record<string, string>; warnings?:string[] };
export type LabelImportRowReason = 'existing'|'duplicate'|'conflicting'|'unsupportedCategory'|'required'|'invalidCompany'|'invalidCriteria'|'invalidCriteriaCompany'|'globalAdminRequired'|'criteriaCompaniesRequired'|'invalidHeadEmployee'|'invalidStatus'|'wholeNumber'|'invalidGradeCode'|'gradeLabelExists'|'invalidGradeReferences'|'gradeAlreadyGrouped'|'invalidRow'|'notSelected';
export type LabelImportRequiredField = 'Code'|'Company'|'Description'|'Label'|'Name';
/** Board c074c6b8: every template column a row problem can point at (internal header keys, not display captions). */
export type LabelImportColumn = LabelImportRequiredField|'Criteria'|'Criteria Companies'|'Status'|'Rank'|'Sort Order'|'Head Employee Code'|'Grade Codes';
/** Board c074c6b8: the exact check that refused or skipped a row, one per distinct server sentence. `reason` stays the
 * coarse category existing callers and history rows rely on; the screen and the Error Log read this. */
export const LABEL_IMPORT_REASON_DETAILS = [
  'unsupportedCategory','existing','duplicate','conflicting','invalidStatus','required','invalidCriteria','companyNotPermitted',
  'companyUnknown','companyOutOfScope','globalWithCompanies','globalAdminRequired','noOwnerCompany','companyNotInCriteria',
  'criteriaCompaniesRequired','invalidHeadEmployee','wholeNumber','invalidGradeCode','gradeLabelExists','invalidGradeReferences',
  'gradeAlreadyGrouped','gradeScope','invalidRow','notSelected',
] as const;
export type LabelImportReasonDetail = typeof LABEL_IMPORT_REASON_DETAILS[number];
export type LabelImportPreviewRow = LabelImportRow & {
  outcome: 'add' | 'update' | 'skip' | 'error'; message: string;
  before: Record<string, string> | null; after: Record<string, string>;
  selected?: boolean; stale?: boolean; reason?: LabelImportRowReason; reasonField?: LabelImportRequiredField;
  /** Board c074c6b8: the precise check and the column it found the problem in (absent on rows stored before it). */
  reasonDetail?: LabelImportReasonDetail; reasonColumn?: LabelImportColumn;
};
export type LabelImportPreview = { token: string; rows: LabelImportPreviewRow[]; valid: boolean; mode?: LabelImportMode };
/** The one reader warning: a previous header generation was converted. Shown translated on the row's problem. */
export const LABEL_LEGACY_HEADERS_WARNING = 'Older Criteria headers were converted. Download the current template for the next upload.';
/** Board c074c6b8: the column a reason points at when its throw site names none. No rule depends on this. */
export function labelReasonColumn(reason: LabelImportRowReason, sheet: string, field?: LabelImportRequiredField): LabelImportColumn | undefined {
  if (reason === 'existing' || reason === 'duplicate' || reason === 'conflicting' || reason === 'notSelected') return sheet === 'grade_groups' ? 'Name' : 'Code';
  return ({ required: field, invalidStatus: 'Status', invalidGradeCode: 'Code', gradeLabelExists: 'Label', invalidGradeReferences: 'Grade Codes',
    gradeAlreadyGrouped: 'Grade Codes', invalidHeadEmployee: 'Head Employee Code' } as Partial<Record<LabelImportRowReason, LabelImportColumn | undefined>>)[reason];
}
/** The precise check for a reason that has only one server sentence; the two shared reasons need their throw site. */
export function labelReasonDetail(reason: LabelImportRowReason | undefined): LabelImportReasonDetail {
  if (!reason || reason === 'invalidCriteriaCompany') return 'invalidRow';
  return reason === 'invalidCompany' ? 'companyNotPermitted' : reason;
}
