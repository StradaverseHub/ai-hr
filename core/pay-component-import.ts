import { createHash } from 'node:crypto';
import type { SessionContext } from '../db/client';
import { countryPacks } from '../localization/registry';
import { PAY_RULE_KINDS, PAY_DISPLAY_CATEGORIES, PCB_REMUNERATION_TYPES, ROUNDING_METHODS, pcbExemptionCodesFor, listPayComponents,
  validatePayComponentCreateSettings, createPayComponentsFromImport } from '../packs/payroll/service';
import { normalizePayItemRow, type PayItemVocabulary, type PayItemPreview, type PayItemField } from '../lib/pay-component-import';
import { readPayItemWorkbook } from '../lib/pay-component-workbook';
import { isAdmin } from '../lib/authz-model';

/** Label dictionaries come from the maintenance form's exact translators, while values come from its
 * actual enum/country-pack owners. English labels remain accepted on a later locale switch. */
export function payItemVocabulary(t: (key: string) => string, english: (key: string) => string): PayItemVocabulary {
  const entry = (value: string, key: string, aliases: string[] = []) => ({ value, label: t(key), aliases: [english(key), ...aliases] });
  const yn = [{ value: 'Y', label: 'Y' }, { value: 'N', label: 'N' }];
  const vocabulary: PayItemVocabulary = {
    kind: ['allowance', 'deduction', 'contribution', 'non_payable'].map(value => entry(value, `kind_${value}`)),
    displayCategory: [entry('', 'displayCategory_auto'), ...PAY_DISPLAY_CATEGORIES.map(value => entry(value, `displayCategory_${value}`))],
    archived: [entry('active', 'statusActive'), entry('inactive', 'statusInactive')],
    roundingMethod: ROUNDING_METHODS.map(value => entry(value, `rounding_${value}`, value === 'none' ? ['Exact (no rounding)'] : [])),
    inputKind: PAY_RULE_KINDS.filter(value=>value!=='formula_builder').map(value => entry(value, `inputType_${value}`, value === 'fixed' ? ['Fixed Value'] : value === 'per_hour' ? ['Hourly Rate x Hours'] : [])),
    pcbRemunerationType: PCB_REMUNERATION_TYPES.map(value => entry(value, `remType_${value}`)),
    pcbExemptionCode: [...new Map(PCB_REMUNERATION_TYPES.flatMap(type => Object.entries(pcbExemptionCodesFor(type)).map(([value, cap]) => [value, { value, label: `${value} (${cap})` }] as const))).values()],
    eaFormLine: [entry('', 'eaLineNone'), ...countryPacks().flatMap(pack => (pack.eaReporting ?? []).filter(row => row.active).map(row => ({ value: row.code, label: row.label, aliases: row.aliases })))],
  };
  for (const field of ['orpUnpaidLeave', 'orpOvertime', 'prorates', 'includedInEpf', 'epfBonus2012', 'includedInPcb', 'includedInSocsoEis', 'includedInHrdfBase'] as PayItemField[]) vocabulary[field] = yn;
  return vocabulary;
}

export async function previewPayItemImport(ctx: SessionContext, bytes: Buffer, vocabulary: PayItemVocabulary): Promise<PayItemPreview> {
  if (!isAdmin(ctx)) throw new Error('Pay component administration required.');
  const rows = readPayItemWorkbook(bytes).map(row => normalizePayItemRow(row, vocabulary));
  const catalog = await listPayComponents(ctx, { includeArchived: true });
  const existing = new Set(catalog.map(row => row.code.trim().toUpperCase()));
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.input.code, (counts.get(row.input.code) ?? 0) + 1);
  for (const row of rows) {
    row.errors.push(...validatePayComponentCreateSettings(row.input));
    if (existing.has(row.input.code)) row.errors.push({ field: 'code', code: 'existingCode' });
    if ((counts.get(row.input.code) ?? 0) > 1) row.errors.push({ field: 'code', code: 'duplicateCode' });
    row.errors = row.errors.filter((issue, index, all) => all.findIndex(other => other.field === issue.field && other.code === issue.code) === index);
  }
  const errors = rows.filter(row => row.errors.length > 0).length;
  return { rows, total: rows.length, valid: rows.length - errors, errors, fileSha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Never trust a browser's preview/settings. Re-read the same bytes and today's catalogs before commit. */
export async function commitPayItemImport(ctx: SessionContext, bytes: Buffer, fileName: string, expectedFileSha256: string, vocabulary: PayItemVocabulary) {
  const preview = await previewPayItemImport(ctx, bytes, vocabulary);
  if (preview.fileSha256 !== expectedFileSha256 || preview.errors) throw new Error('Pay item import requires a current error-free preview.');
  return createPayComponentsFromImport(ctx, preview.rows, fileName);
}
