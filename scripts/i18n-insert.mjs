#!/usr/bin/env node
/**
 * Insert i18n keys into messages/<locale>.json, positioned AFTER a named anchor key in their namespace.
 *
 * Why a script and not hand edits: every new key has to land in all SIX catalogs (en, ms, ta, th, vi, zh)
 * or test/i18n-coverage.test.ts check A fails CI — and tsc cannot see a missing translation key at all.
 * Doing that by hand is 6x the edits and 6x the chance of a typo'd key that ships as a raw key on screen.
 *
 * All six catalogs round-trip byte-exact through `JSON.stringify(x, null, 2) + '\n'` (verified before
 * first use), so rewriting the whole file introduces no formatting diff — the only lines that move are
 * the ones being added.
 *
 * Usage: node scripts/i18n-insert.mjs <spec.json>
 * Spec shape: [{ path: 'payroll.batch', after: 'someExistingKey', keys: { en: {...}, ms: {...}, ... } }]
 * `after` may be null to append at the end of the namespace object.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'];
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));

for (const locale of LOCALES) {
  const file = `messages/${locale}.json`;
  const root = JSON.parse(readFileSync(file, 'utf8'));
  let added = 0;

  for (const block of spec) {
    const segments = block.path.split('.');
    let parent = root;
    for (const seg of segments) {
      if (parent[seg] == null || typeof parent[seg] !== 'object') {
        // `create` is opt-in per block so a TYPO in an existing namespace path still throws loudly
        // instead of silently conjuring a second, parallel namespace that renders as raw keys.
        if (!block.create) throw new Error(`${file}: namespace ${block.path} missing at segment "${seg}"`);
        parent[seg] = {};
      }
      parent = parent[seg];
    }

    const incoming = block.keys[locale];
    if (!incoming) throw new Error(`${file}: spec block ${block.path} has no "${locale}" translations`);

    for (const [k, v] of Object.entries(incoming)) {
      if (typeof v !== 'string' || v.trim() === '') {
        throw new Error(`${file}: ${block.path}.${k} is blank — i18n-coverage check A treats blank as missing`);
      }
    }

    if (block.after != null && !(block.after in parent)) {
      throw new Error(`${file}: anchor ${block.path}.${block.after} not found`);
    }

    // Idempotent: a key already present keeps its existing value AND its existing position. Without this
    // a re-run would silently relocate keys an earlier pass had already placed, producing a diff that
    // looks like churn and reviews like a mistake.
    for (const k of Object.keys(incoming)) {
      if (k in parent) delete incoming[k];
    }
    if (Object.keys(incoming).length === 0) continue;

    // Rebuild the namespace so the new keys sit immediately after the anchor rather than at the end.
    // JS objects preserve string-key insertion order, so this is the whole mechanism.
    const rebuilt = {};
    if (block.after == null) {
      Object.assign(rebuilt, parent, incoming);
    } else {
      for (const [k, v] of Object.entries(parent)) {
        rebuilt[k] = v;
        if (k === block.after) Object.assign(rebuilt, incoming);
      }
    }
    for (const k of Object.keys(parent)) delete parent[k];
    Object.assign(parent, rebuilt);
    added += Object.keys(incoming).length;
  }

  writeFileSync(file, JSON.stringify(root, null, 2) + '\n');
  console.log(`${file}: +${added} key(s)`);
}
