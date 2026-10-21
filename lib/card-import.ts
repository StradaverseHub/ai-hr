/** Shared upload/result vocabulary. Card IDs are literal strings, never numbers or employee names. */
export const CARD_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const CARD_IMPORT_MAX_ROWS = 500;
export const CARD_IMPORT_VERSION = 'AIHR Card Assignments v1';
export const CARD_IMPORT_HEADERS = ['Employee ID', 'Card ID', 'Operation'] as const;
export type CardImportOperation = 'assign' | 'replace' | 'reset';
export type CardImportInput = { row: number; employeeCode: string; cardId: string; operation: string; invalidCell?: boolean };
export type CardImportIssue = 'requiredEmployee' | 'duplicateEmployee' | 'duplicateCard' | 'invalidOperation' | 'invalidCard' | 'literalText' | 'unavailableEmployee' | 'ambiguousEmployee' | 'existingCard' | 'cardConflict' | 'resetHasCard' | 'stale' | 'confirmationRequired' | 'notSelected' | 'saveFailed';
export type CardImportRow = CardImportInput & {
  employmentId?: string; companyId?: string; employee?: string; matchedEmployeeCode?: string; previousCard?: string | null;
  nextCard?: string | null; fingerprint?: string; issues: CardImportIssue[];
  effect: 'assign' | 'replace' | 'reset' | 'unchanged' | 'failed';
};
export type CardImportPreview = { rows: CardImportRow[]; fileHash: string; receipt: string; fileName: string };
export type CardImportResultRow = CardImportRow & { result: 'imported' | 'updated' | 'unchanged' | 'failed' | 'skipped' };
export type CardImportResult = { rows: CardImportResultRow[]; total: number; imported: number; updated: number; unchanged: number; failed: number; skipped: number };
export class CardImportError extends Error {
  constructor(readonly code: 'invalidWorkbook' | 'tooLarge' | 'tooManyRows' | 'emptyWorkbook' | 'invalidReview' | 'scope' | 'catalogueLimit') { super(`card-import:${code}`); this.name = 'CardImportError'; }
}
export const cardImportKey = (value: string) => value.trim().toLowerCase();
export function validateCardImportRows(inputs: readonly CardImportInput[]): CardImportRow[] {
  if (!inputs.length) throw new CardImportError('emptyWorkbook');
  if (inputs.length > CARD_IMPORT_MAX_ROWS) throw new CardImportError('tooManyRows');
  const employees = new Map<string, number>(), cards = new Map<string, number>();
  for (const input of inputs) {
    const code = cardImportKey(input.employeeCode), card = cardImportKey(input.cardId);
    if (code) employees.set(code, (employees.get(code) ?? 0) + 1);
    if (card) cards.set(card, (cards.get(card) ?? 0) + 1);
  }
  return inputs.map(input => {
    const row = { ...input, employeeCode: input.employeeCode.trim(), cardId: input.cardId.trim(), operation: input.operation.trim().toLowerCase() };
    const issues: CardImportIssue[] = [];
    if (!row.employeeCode) issues.push('requiredEmployee');
    if ((employees.get(cardImportKey(row.employeeCode)) ?? 0) > 1) issues.push('duplicateEmployee');
    if ((cards.get(cardImportKey(row.cardId)) ?? 0) > 1) issues.push('duplicateCard');
    if (!['assign', 'replace', 'reset'].includes(row.operation)) issues.push('invalidOperation');
    if (row.invalidCell) issues.push('literalText');
    if (row.employeeCode.length > 1000 || row.cardId.length > 1000 || /[\u0000-\u001f\u007f]/.test(row.employeeCode + row.cardId)) issues.push('invalidCard');
    if (row.operation === 'reset' && row.cardId) issues.push('resetHasCard');
    return { ...row, issues, effect: issues.length ? 'failed' : 'unchanged' };
  });
}
export function cardImportFileName(name: string): string {
  return Array.from(name.replace(/\\/g, '/').split('/').pop() ?? 'card-assignments.xlsx').slice(0, 160).join('').replace(/[\u0000-\u001f\u007f]/g, '_');
}
