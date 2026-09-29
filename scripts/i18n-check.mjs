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

/**
 * ICU argument names, by walking the message rather than by regex.
 *
 * THE REGEX THIS REPLACES COULD NOT TELL AN ARGUMENT FROM A ONE-WORD BRANCH BODY, and it made this
 * whole gate useless: /\{\s*([a-zA-Z0-9_]+)\s*[,}]/g matched `{applies}` in
 * `…{hasDays, select, yes {gives …} other {applies}}` and reported `applies` as a placeholder. It is
 * not one — it is English prose, and the translations say `terpakai`, `适用`, `பொருந்துகிறது`. So
 * admin.entitlementTemplates.explainSentence was reported as placeholder drift in ALL FIVE non-English
 * locales, on every run, and `node scripts/i18n-check.mjs` has therefore printed FAIL on a clean tree.
 * A gate that always fails is worse than no gate: a REAL drift arrives as one more line in noise
 * everybody has learned to ignore.
 *
 * Verified before changing: `applies` was the ONLY difference, in every one of the five locales, and
 * every genuine argument (facts, employee, grade, years, rule, hasClause, clause, table, hasDays, days,
 * band, from, to) is present in all six.
 *
 * A single-word branch body and an argument are spelled identically — `{applies}` and `{employee}` —
 * so no regex can separate them. Position is what distinguishes them, so this tracks position: `{`
 * opens an ARGUMENT in message context, and the `{…}` groups following a select/plural selector are
 * BRANCH BODIES, whose contents are messages in their own right.
 */
function placeholders(s) {
  const names = new Set();
  let i = 0;

  const isNameChar = (c) => c !== undefined && /[^,{}\s]/.test(c);
  const skipWs = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };

  // Reads message text up to the end of the string or an unmatched '}' (the close of the branch body
  // or argument that contains it). Leaves `i` ON that '}'.
  function message() {
    while (i < s.length) {
      const c = s[i];
      if (c === '}') return;
      // ICU apostrophe escaping: '{' and '}' are literal, and '' is a literal apostrophe.
      if (c === "'" && (s[i + 1] === '{' || s[i + 1] === '}' || s[i + 1] === "'")) {
        i += 2;
        if (s[i - 1] !== "'") {
          const end = s.indexOf("'", i);
          i = end === -1 ? s.length : end + 1;
        }
        continue;
      }
      if (c === '{') {
        i++;
        argument();
        continue;
      }
      i++;
    }
  }

  // Called with `i` just past the '{' that opens an argument.
  function argument() {
    skipWs();
    let name = '';
    while (isNameChar(s[i])) name += s[i++];
    if (name) names.add(name);
    skipWs();
    if (s[i] === ',') {
      i++;
      skipWs();
      let type = '';
      while (isNameChar(s[i])) type += s[i++];
      skipWs();
      if (s[i] === ',') {
        i++;
        if (type === 'select' || type === 'plural' || type === 'selectordinal') {
          // `selector {message}` pairs until the argument closes.
          while (i < s.length && s[i] !== '}') {
            skipWs();
            if (s[i] === '}' || i >= s.length) break;
            if (s[i] === '{') {
              i++;
              message();
              if (s[i] === '}') i++;
            } else {
              i++; // part of a selector such as `=1`, `other`, `yes`
            }
          }
        } else {
          // A format style (number/date/time). It holds no arguments — skip to this argument's close.
          let depth = 1;
          while (i < s.length && depth > 0) {
            if (s[i] === '{') depth++;
            else if (s[i] === '}') depth--;
            if (depth > 0) i++;
          }
        }
      }
    }
    if (s[i] === '}') i++;
  }

  message();
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
