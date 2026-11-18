// Type-only facade imports keep this workbook/client contract free of server initialization.
import type { PayComponentInput, PayRuleKind } from '../packs/payroll/service';
import { PAY_COMPONENT_DEFAULTS as defaults, payComponentEaDefault, payComponentOvertimeDefault } from './pay-component-contract';

export const PAY_ITEM_MAX_BYTES = 5 * 1024 * 1024;
export const PAY_ITEM_MAX_ROWS = 1000;
export const PAY_ITEM_COLUMNS = [
  ['code', 'Pay Code *'], ['label', 'Label *'], ['description', 'Description'], ['kind', 'Category *'],
  ['displayCategory', 'Payroll Category'], ['archived', 'Status'], ['orpUnpaidLeave', 'Add to Unpaid Leave ORP (Y/N)'],
  ['orpOvertime', 'Add to Overtime ORP (Y/N)'], ['roundingMethod', 'Rounding'], ['inputKind', 'Input Type'],
  ['prorates', 'Prorates (Y/N)'], ['includedInEpf', 'EPF (Y/N)'], ['epfBonus2012', 'EPF Bonus 2012 (Y/N)'],
  ['includedInPcb', 'PCB (Y/N)'], ['pcbRemunerationType', 'Remuneration Type'], ['pcbExemptionCode', 'Exemption Type'],
  ['includedInSocsoEis', 'SOCSO/EIS (Y/N)'], ['includedInHrdfBase', 'HRDF (Y/N)'], ['eaFormLine', 'EA Form Line'],
] as const;
export type PayItemField = typeof PAY_ITEM_COLUMNS[number][0];
export const PAY_ITEM_SYSTEM_KEYS = ['pay_code', 'label', 'description', 'category', 'payroll_category', 'status', 'orp_unpaid_leave', 'orp_overtime', 'rounding', 'input_type', 'prorates', 'epf', 'epf_bonus_2012', 'pcb', 'remuneration_type', 'exemption_type', 'socso_eis', 'hrdf', 'ea_form_line'] as const;
export type PayItemChoice = { value: string; label: string; aliases?: readonly string[] };
export type PayItemVocabulary = Partial<Record<PayItemField, PayItemChoice[]>>;
export type PayItemIssue = { field: string; code: string };
export type PayItemUploadRow = { row: number; values: Record<PayItemField, string>; formulaFields: PayItemField[] };
export type PayItemPreviewRow = {
  row: number; values: Record<PayItemField, string>; input: PayComponentInput; archived: boolean;
  errors: PayItemIssue[]; warnings: string[];
};
export type PayItemPreview = { rows: PayItemPreviewRow[]; total: number; valid: number; errors: number; fileSha256: string };
export const normalizePayItemHeader = (value: string) => value.replace(/\*/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
const normalizeChoice = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
export function matchPayItemChoice(value: string, choices: readonly PayItemChoice[]): string | undefined {
  const needle = normalizeChoice(value);
  const matches = new Set(choices.filter(c => [c.value, c.label, ...(c.aliases ?? [])].some(v => normalizeChoice(v) === needle)).map(c => c.value));
  return matches.size === 1 ? [...matches][0] : undefined;
}

/** Workbook normalization is deterministic. The service adds canonical statutory/rule/catalog checks. */
export function normalizePayItemRow(row: PayItemUploadRow, vocabulary: PayItemVocabulary): PayItemPreviewRow {
  const errors: PayItemIssue[] = row.formulaFields.map(field => ({ field, code: 'formulaNotAllowed' }));
  function choice(field: PayItemField, fallback: string): string {
    const raw = row.values[field];
    if (!raw) return fallback;
    const value = matchPayItemChoice(raw, vocabulary[field] ?? []);
    if (value === undefined) { errors.push({ field, code: 'invalidChoice' }); return fallback; }
    return value;
  }
  const yn = (field: PayItemField, fallback: boolean) => choice(field, fallback ? 'Y' : 'N') === 'Y';
  if (!row.values.kind) errors.push({ field: 'kind', code: 'required' });
  const kind = choice('kind', defaults.kind) as PayComponentInput['kind'];
  const inputKind = choice('inputKind', defaults.inputKind) as PayRuleKind;
  // Workbook has no Formula ID/test evidence columns; reusable formulas are linked in native maintenance.
  if(inputKind==='formula_builder')errors.push({field:'inputKind',code:'invalidChoice'});
  const input: PayComponentInput = {
    code: row.values.code.trim().toUpperCase(), name: row.values.label.trim(), label: row.values.label.trim(),
    description: row.values.description.trim() || null, kind, isNonPayable: kind === 'non_payable',
    displayCategory: choice('displayCategory', '') || null,
    roundingMethod: choice('roundingMethod', defaults.roundingMethod),
    orpUnpaidLeave: yn('orpUnpaidLeave', defaults.orpUnpaidLeave), orpOvertime: yn('orpOvertime', payComponentOvertimeDefault(kind)),
    prorates: yn('prorates', defaults.prorates), includedInEpf: yn('includedInEpf', defaults.includedInEpf),
    includedInSocsoEis: yn('includedInSocsoEis', defaults.includedInSocsoEis), includedInPcb: yn('includedInPcb', defaults.includedInPcb),
    epfBonus2012: yn('epfBonus2012', defaults.epfBonus2012), includedInHrdfBase: yn('includedInHrdfBase', defaults.includedInHrdfBase),
    pcbRemunerationType: (choice('pcbRemunerationType', '') || null) as PayComponentInput['pcbRemunerationType'],
    pcbExemptionCode: choice('pcbExemptionCode', '') || null,
    eaFormLine: choice('eaFormLine', payComponentEaDefault(kind) ?? '') || null,
    rule: null, pendingInputKind: inputKind === 'fixed'||inputKind==='formula_builder' ? null : inputKind,
  };
  const archived = choice('archived', defaults.archived ? 'inactive' : 'active') === 'inactive';
  const warnings: string[] = [];
  if ((input.displayCategory === 'bik' || input.displayCategory === 'vola') && (input.includedInEpf || input.includedInSocsoEis || input.includedInHrdfBase)) warnings.push('nonCashContributionFlags');
  if (kind === 'deduction' && (input.orpOvertime || input.orpUnpaidLeave)) warnings.push('deductionOrp');
  if (input.prorates && inputKind !== 'fixed') warnings.push('calculationProrates');
  if (kind === 'allowance' && input.eaFormLine == null) warnings.push('unmappedEarning');
  return { row: row.row, values: row.values, input, archived, errors, warnings };
}

/** File name is provenance, not a path. Never retain control characters, directories or workbook data. */
export function payItemImportFileName(name: string): string {
  return Array.from(name.replace(/\\/g, '/').split('/').pop() ?? 'pay-items.xlsx').slice(0, 160).join('').replace(/[\u0000-\u001f\u007f]/g, '_');
}
