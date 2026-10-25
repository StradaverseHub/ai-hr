/** Workbook values are identifiers; labels explain them on Reference and never enter a list cell. */
import { personnelImportFields, personnelFieldChoices, type PersonnelImportSheet } from './personnel-import-contract';
import { EMPLOYEE_ENUM_VALUES, type ReferenceList } from './import-template-xlsx';

export type PersonnelReferenceOption = { value: string; label: string };
export type PersonnelTemplateReferences = {
  catalogs?: Record<string, string[]>;
  catalogOptions?: Record<string, PersonnelReferenceOption[]>;
  nationalities: string[];
  familyRelationships: string[];
};
export type PersonnelTemplateReferenceList = ReferenceList & { column: string };

/** These rows must already be authorized, active and company-available by their catalogue owner. */
export function personnelReferenceOptions(rows: readonly { value: string; label?: string | null }[]): PersonnelReferenceOption[] {
  return rows.filter(row => row.value.trim() !== '').map(row => ({ value: row.value, label: row.label?.trim() || row.value }));
}

/** One mapping feeds both the list validation and its code/label explanation, for full and sections. */
export function personnelTemplateReferenceLists(
  sheet: PersonnelImportSheet,
  columns: readonly string[],
  reference: PersonnelTemplateReferences,
  caption: (column: string) => string,
  resolveLabel: (key: string, fallback: string) => string,
): PersonnelTemplateReferenceList[] {
  const fields = personnelImportFields(sheet);
  return columns.flatMap(column => {
    const field = fields.find(item => item.import.column === column);
    const category = sheet === 'family' && column === 'relationship' ? 'dependentRelationship'
      : sheet === 'employee' && column === 'passport_issuing_country' ? 'nationality' : field?.import.catalog;
    const catalog = category ? reference.catalogs?.[category]
      ?? (category === 'nationality' ? reference.nationalities : category === 'dependentRelationship' ? reference.familyRelationships : []) : undefined;
    const configured = category ? reference.catalogOptions?.[category] : undefined;
    const fixed = field ? personnelFieldChoices(field).map(choice => ({ value: choice.value, label: resolveLabel(choice.labelKey, choice.value) })) : [];
    const enums = EMPLOYEE_ENUM_VALUES[column as keyof typeof EMPLOYEE_ENUM_VALUES];
    const entries = category ? configured ?? (catalog ?? []).map(value => ({ value, label: value }))
      : fixed.length ? fixed : enums ? [...enums].map(value => ({ value, label: value })) : [];
    if (!entries.length) return [];
    return [{ column, label: caption(column), values: [...new Set(entries.map(entry => entry.value))], entries }];
  });
}
