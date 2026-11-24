import type {WorkBook} from 'xlsx';

/** Worksheet names are workbook identifiers. Preserve case and whitespace when matching them. */
export function validImportWorksheet(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 31 && !/[\u0000-\u001f]/.test(value);
}

export function isVisibleImportWorksheet(book: WorkBook, name: string): boolean {
  const index = book.SheetNames.indexOf(name);
  return index >= 0 && !book.Workbook?.Sheets?.[index]?.Hidden;
}
