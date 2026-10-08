/**
 * r424 — how a mapping's layout reads in a list or a picker. One function so the File Structure Mapping
 * list, the mapping view and the Import Clocking Data picker can never describe the same mapping two ways.
 */
type T = (key: string, values?: Record<string, string | number>) => string;

export function layoutLabel(t: T, m: { layout: 'delimited' | 'fixed_width'; delimiter: string | null }): string {
  if (m.layout === 'fixed_width') return t('layoutName.fixedWidth');
  if (m.delimiter === ',') return t('layoutName.comma');
  if (m.delimiter === '\t') return t('layoutName.tab');
  if (m.delimiter === ';') return t('layoutName.semicolon');
  return t('layoutName.other', { char: m.delimiter ?? '' });
}
