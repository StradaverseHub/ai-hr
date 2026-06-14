// One-off: merge the extraction workflow's flat key map into messages/en.json.
//   node scripts/merge-i18n-keys.mjs <workflow-output.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outPath = process.argv[2];
if (!outPath) {
  console.error('usage: node scripts/merge-i18n-keys.mjs <workflow-output.json>');
  process.exit(1);
}

const raw = JSON.parse(readFileSync(outPath, 'utf8'));
const flat = raw?.result?.keys ?? raw?.keys;
if (!flat || typeof flat !== 'object') {
  console.error('No keys found in workflow output (looked for .result.keys / .keys)');
  process.exit(1);
}

const enPath = join(process.cwd(), 'messages', 'en.json');
const en = JSON.parse(readFileSync(enPath, 'utf8'));

function setDeep(root, dottedKey, value) {
  const parts = dottedKey.split('.');
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    if (typeof node[seg] !== 'object' || node[seg] == null) node[seg] = {};
    node = node[seg];
  }
  node[parts[parts.length - 1]] = value;
}

let added = 0;
let changed = 0;
for (const [k, v] of Object.entries(flat)) {
  // detect prior value
  const parts = k.split('.');
  let node = en;
  let prior;
  let ok = true;
  for (let i = 0; i < parts.length; i++) {
    if (node && typeof node === 'object' && parts[i] in node) {
      node = node[parts[i]];
    } else {
      ok = false;
      break;
    }
  }
  prior = ok ? node : undefined;
  if (prior === undefined) added++;
  else if (prior !== v) changed++;
  setDeep(en, k, v);
}

writeFileSync(enPath, JSON.stringify(en, null, 2) + '\n', 'utf8');

const countLeaves = (o) =>
  Object.values(o).reduce((n, v) => n + (v && typeof v === 'object' ? countLeaves(v) : 1), 0);
console.error(`Merged ${Object.keys(flat).length} keys into en.json (${added} new, ${changed} changed).`);
console.error(`en.json now has ${countLeaves(en)} total leaf keys across ${Object.keys(en).length} namespaces.`);
console.error(`Top-level namespaces: ${Object.keys(en).join(', ')}`);
