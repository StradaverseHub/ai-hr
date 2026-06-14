/**
 * i18n export (ADR-0016): flatten every message catalog into one translation matrix CSV.
 *
 *   pnpm i18n:export [out.csv]     (default: messages/i18n.csv)
 *
 * Columns: key, en, <locale…>. English is the canonical key set; each locale column carries its
 * current translation (blank where missing). Hand the CSV to translators, then `pnpm i18n:import`
 * the filled copy back. Prints per-locale coverage to stderr.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultLocale } from '../i18n/config';
import { MESSAGES_DIR, targetLocales, readCatalog, flatten, csvStringify } from './i18n-lib';

const outPath = process.argv[2] ?? join(MESSAGES_DIR, 'i18n.csv');

const enFlat = flatten(readCatalog(defaultLocale));
const localeFlat = new Map(targetLocales.map((l) => [l, flatten(readCatalog(l))] as const));

const header = ['key', defaultLocale, ...targetLocales];
const rows: string[][] = [header];

for (const [key, enValue] of enFlat) {
  rows.push([key, enValue, ...targetLocales.map((l) => localeFlat.get(l)!.get(key) ?? '')]);
}

writeFileSync(outPath, csvStringify(rows), 'utf8');

const total = enFlat.size;
console.error(`Exported ${total} keys → ${outPath}`);
for (const l of targetLocales) {
  const map = localeFlat.get(l)!;
  const done = [...enFlat.keys()].filter((k) => (map.get(k) ?? '') !== '').length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  console.error(`  ${l}: ${done}/${total} (${pct}%)`);
}
