import * as XLSX from 'xlsx';

/**
 * Board 2026-11-14 (production): the range Excel records for a worksheet (`<dimension>`, SheetJS `!ref`) covers every
 * cell that carries formatting, not only cells with values. Formatting a block of cells as Text to keep leading
 * zeros, or clearing rows instead of deleting them, leaves that range hundreds or thousands of rows deep while the
 * sheet holds a handful of entries. Row limits measured against it refused a six-employee file as "more than 200
 * rows" and could not tell HR why.
 *
 * This is the range that actually holds content: from the recorded origin to the last row and column with a
 * non-blank value, a formula or an error cell. Formulas and errors count as content so the callers' own refusals of
 * them still fire wherever they sit. Blank, formatting-only cells beyond it are ignored. Cell iteration is bounded by
 * the callers' archive limits (expanded-size and entry caps), never by the recorded range.
 *
 * Returns null when the sheet holds no content at all.
 */
export function worksheetDataRange(sheet: XLSX.WorkSheet): XLSX.Range | null {
  const recorded = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
  let lastRow = -1, lastCol = -1;
  for (const key of Object.keys(sheet)) {
    if (key.startsWith('!')) continue;
    const cell = sheet[key] as XLSX.CellObject | undefined;
    if (!cell) continue;
    const content = !!cell.f || cell.t === 'e' || (cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== '');
    if (!content) continue;
    const at = XLSX.utils.decode_cell(key);
    if (at.r > lastRow) lastRow = at.r;
    if (at.c > lastCol) lastCol = at.c;
  }
  if (lastRow < 0) return null;
  return { s: { r: recorded?.s.r ?? 0, c: recorded?.s.c ?? 0 }, e: { r: lastRow, c: lastCol } };
}

/** Narrows the worksheet's recorded range to its content, so later reads never walk formatting-only rows. */
export function trimWorksheetToData(sheet: XLSX.WorkSheet): XLSX.Range | null {
  const range = worksheetDataRange(sheet);
  if (range) sheet['!ref'] = XLSX.utils.encode_range(range);
  delete sheet['!fullref'];
  return range;
}
