/**
 * Shared helpers for the i18n export/import round-trip (ADR-0016).
 *
 * English (messages/en.json) is the canonical source: it defines which keys exist and the column
 * order. Export flattens every catalog into one CSV (key, en, <locale>…) so a translator can fill
 * the gaps with the English source in view. Import reads that CSV back, rebuilds each locale catalog
 * in English's shape, and writes only non-blank cells — blanks stay blank so runtime English
 * fallback (i18n/request.ts) keeps rendering. The matrix is lossless and order-stable.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { locales, defaultLocale, type Locale } from '../i18n/config';

export const MESSAGES_DIR = join(process.cwd(), 'messages');
/** Non-English locales, in config order — the translatable columns. */
export const targetLocales = locales.filter((l) => l !== defaultLocale) as Exclude<Locale, 'en'>[];

type Dict = Record<string, unknown>;

export function catalogPath(locale: Locale): string {
  return join(MESSAGES_DIR, `${locale}.json`);
}

export function readCatalog(locale: Locale): Dict {
  try {
    return JSON.parse(readFileSync(catalogPath(locale), 'utf8')) as Dict;
  } catch {
    return {};
  }
}

/** Flatten a nested catalog to an ordered map of dot-path → string. Order follows the source object. */
export function flatten(obj: Dict, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [ck, cv] of flatten(v as Dict, path)) out.set(ck, cv);
    } else if (v != null) {
      out.set(path, String(v));
    }
  }
  return out;
}

/** Rebuild a nested object from dot-path → string entries. */
export function unflatten(entries: Iterable<[string, string]>): Dict {
  const root: Dict = {};
  for (const [path, value] of entries) {
    const parts = path.split('.');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (typeof node[seg] !== 'object' || node[seg] == null) node[seg] = {};
      node = node[seg] as Dict;
    }
    node[parts[parts.length - 1]] = value;
  }
  return root;
}

// ── Minimal RFC-4180 CSV (quote on comma/quote/newline; double internal quotes) ──

export function csvStringify(rows: string[][]): string {
  const esc = (s: string) =>
    /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  return rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

export function csvParse(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  // flush trailing field/row if the file didn't end on a newline
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** Stable-pretty JSON write mirroring English key order, 2-space indent, trailing newline. */
export function writeCatalog(locale: Locale, obj: Dict): void {
  writeFileSync(catalogPath(locale), JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
