/**
 * i18n import (ADR-0016): read a filled translation matrix CSV and rebuild each locale catalog.
 *
 *   pnpm i18n:import [in.csv]      (default: messages/i18n.csv)
 *
 * For every non-English column, rebuild messages/<locale>.json in English's key order, writing only
 * non-blank cells (blanks stay blank so runtime English fallback still renders). Keys absent from
 * English are ignored, and the `en` column is never written back. Prints what changed per locale.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultLocale, isLocale, type Locale } from '../i18n/config';
import {
  MESSAGES_DIR,
  targetLocales,
  readCatalog,
  flatten,
  unflatten,
  csvParse,
  writeCatalog,
} from './i18n-lib';

const inPath = process.argv[2] ?? join(MESSAGES_DIR, 'i18n.csv');

const rows = csvParse(readFileSync(inPath, 'utf8'));
if (rows.length < 2) {
  console.error(`No data rows in ${inPath}`);
  process.exit(1);
}

const [header, ...dataRows] = rows;
if (header[0] !== 'key') {
  console.error(`Unexpected header — expected first column "key", got "${header[0]}"`);
  process.exit(1);
}

// Map each CSV column index to a known target locale (skip "key", "en", and any stray columns).
const colLocale = new Map<number, Locale>();
header.forEach((name, idx) => {
  if (idx === 0 || name === defaultLocale) return;
  if (isLocale(name) && targetLocales.includes(name as never)) colLocale.set(idx, name);
  else if (name) console.error(`Ignoring unknown column "${name}"`);
});

// English defines the legal key set; cells for unknown keys are dropped.
const enKeys = new Set(flatten(readCatalog(defaultLocale)).keys());

for (const [idx, locale] of colLocale) {
  const before = flatten(readCatalog(locale));
  const entries: [string, string][] = [];
  for (const row of dataRows) {
    const key = row[0];
    const value = (row[idx] ?? '').trim();
    if (!key || !enKeys.has(key) || value === '') continue;
    entries.push([key, value]);
  }
  writeCatalog(locale, unflatten(entries));

  const added = entries.filter(([k]) => (before.get(k) ?? '') === '').length;
  const changed = entries.filter(([k, v]) => before.has(k) && before.get(k) !== v).length;
  console.error(
    `  ${locale}: wrote ${entries.length} keys (${added} new, ${changed} changed)`,
  );
}

console.error(`Imported from ${inPath}`);
