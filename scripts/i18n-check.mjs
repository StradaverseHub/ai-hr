// Deterministic i18n gate: every locale must have key parity with en.json and matching ICU placeholders.
//   node scripts/i18n-check.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MESSAGES = join(process.cwd(), 'messages');
const LOCALES = ['zh', 'ms', 'ta', 'th', 'vi'];

function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, p, out);
    else out.set(p, String(v));
  }
  return out;
}

// ICU argument names: matches {name}, {d, plural, ...}, {x, select, ...} → captures the arg name.
function placeholders(s) {
  const names = new Set();
  const re = /\{\s*([a-zA-Z0-9_]+)\s*[,}]/g;
  let m;
  while ((m = re.exec(s))) names.add(m[1]);
  return names;
}
const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

const read = (f) => JSON.parse(readFileSync(join(MESSAGES, f), 'utf8'));
const en = flatten(read('en.json'));

let failed = false;
console.error(`en.json: ${en.size} leaf keys\n`);

for (const loc of LOCALES) {
  let locFlat;
  try {
    locFlat = flatten(read(`${loc}.json`));
  } catch (e) {
    console.error(`${loc}: ✗ cannot read/parse — ${e.message}`);
    failed = true;
    continue;
  }
  const missing = [...en.keys()].filter((k) => !locFlat.has(k));
  const extra = [...locFlat.keys()].filter((k) => !en.has(k));
  const phMismatch = [];
  for (const [k, v] of en) {
    if (!locFlat.has(k)) continue;
    if (!setEq(placeholders(v), placeholders(locFlat.get(k)))) phMismatch.push(k);
  }
  // count values identical to English (rough "untranslated" signal; proper nouns legitimately match)
  const identical = [...en.keys()].filter((k) => locFlat.has(k) && locFlat.get(k) === en.get(k)).length;

  const okParity = missing.length === 0 && extra.length === 0;
  const okPh = phMismatch.length === 0;
  if (!okParity || !okPh) failed = true;

  console.error(`${loc}: ${locFlat.size} keys · parity ${okParity ? '✓' : '✗'} · placeholders ${okPh ? '✓' : '✗'} · ${identical} identical-to-EN`);
  if (missing.length) console.error(`   missing ${missing.length}: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}`);
  if (extra.length) console.error(`   extra ${extra.length}: ${extra.slice(0, 6).join(', ')}${extra.length > 6 ? '…' : ''}`);
  if (phMismatch.length) console.error(`   placeholder drift ${phMismatch.length}: ${phMismatch.slice(0, 6).join(', ')}${phMismatch.length > 6 ? '…' : ''}`);
}

console.error(`\n${failed ? 'FAIL — fix the issues above' : 'PASS — all locales parity + placeholder clean'}`);
process.exit(failed ? 1 : 0);
