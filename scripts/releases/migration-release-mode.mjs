#!/usr/bin/env node
/**
 * Decide whether a release's pending migrations can run while the PREVIOUS release is still serving
 * traffic (zero-downtime mode), or whether the release needs a stopped-service maintenance window.
 *
 * Owner decision, 15 Nov 2026 (docs/adr/0181-zero-downtime-web-release.md):
 *   - rollback is a code rollback to the retained previous release, then fix forward;
 *   - a release whose migrations break the previous release's code may take an announced window.
 *
 * So the question this answers is narrow and mechanical: after these migrations, can the code that
 * is running right now keep working, and do the migrations avoid long exclusive locks on populated
 * tables? Anything that removes, renames or retypes an object the old code may use, or rewrites or
 * fully scans a populated table under an exclusive lock, makes the release `maintenance`.
 *
 * Objects created by the same pending set are new; nothing the old code runs can depend on them, so
 * changes to them are always online.
 *
 * A reviewed exception is written in the migration itself, on the line(s) directly before the
 * statement:
 *
 *     -- zero-downtime: compatible -- <why the previous release cannot observe this>
 *
 * The annotation is recorded in the report; it never hides the finding. A migration already applied
 * on staging cannot be edited (applied bytes are immutable), so the release coordinator records the
 * same review in a release acceptance file instead:
 *
 *     {"accepted": [{"tag": "5162_x", "statement": 2, "rule": "validating-constraint", "reason": "..."}]}
 *
 * Each entry must match a finding exactly (tag, statement number and rule) and give a reason; an entry
 * that matches nothing refuses, so a stale file cannot silently accept a different statement.
 *
 * This is a conservative text classifier, not a SQL parser. It fails toward `maintenance`: a
 * statement it cannot read safely is not given a free pass. It reads journals, not a database.
 *
 * Usage:
 *   node scripts/releases/migration-release-mode.mjs --base <running-release-dir> --candidate <dir> [--accept <file>] [--json]
 * Exit status: 0 online, 3 maintenance, 2 refusal (bad input or diverged history).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ANNOTATION = /^--\s*zero-downtime:\s*compatible\b\s*(?:--\s*)?(.*)$/i;

/**
 * Split SQL into statements. String literals, quoted identifiers, dollar-quoted bodies and comments
 * are handled so that a `;` or a keyword inside a function body never becomes a statement. Bodies are
 * replaced with a placeholder: rules look only at the outer DDL. Annotation comments that appear
 * since the previous statement are attached to the next one.
 */
export function splitStatements(sql) {
  const statements = [];
  let text = '';
  let annotations = [];
  let literals = [];
  let i = 0;
  const n = sql.length;
  const push = () => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t) statements.push({ text: t, annotations, literals });
    text = '';
    annotations = [];
    literals = [];
  };
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const line = sql.slice(i, end === -1 ? n : end).trim();
      const m = ANNOTATION.exec(line);
      if (m) annotations.push(m[1].trim() || '(no reason given)');
      if (/^-->\s*statement-breakpoint/.test(line)) push();
      i = end === -1 ? n : end + 1;
      text += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      text += ' ';
      continue;
    }
    if (c === "'") {
      // E'..' escapes are handled by treating backslash-quote as escaped only after an E prefix.
      const escaped = /[eE]$/.test(text);
      let lit = '';
      i++;
      while (i < n) {
        if (escaped && sql[i] === '\\') { lit += sql[i + 1] ?? ''; i += 2; continue; }
        if (sql[i] === "'" && sql[i + 1] === "'") { lit += "'"; i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        lit += sql[i++];
      }
      literals.push(lit);
      text += `'?${literals.length - 1}'`;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let ident = '';
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') { ident += '"'; j += 2; continue; }
        if (sql[j] === '"') break;
        ident += sql[j++];
      }
      text += `"${ident.toLowerCase()}"`;
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        i = close === -1 ? n : close + tag.length;
        text += ' $body$ ';
        continue;
      }
    }
    if (c === ';') { push(); i++; continue; }
    text += c;
    i++;
  }
  push();
  return statements;
}

/**
 * Normalised shape of a CHECK expression and the literals it allows. `fragment` is the masked text
 * starting at `check`; `literals` is the owning statement's literal table. IN-lists collapse to one
 * marker so a list that gains values keeps its shape.
 */
export function checkShape(fragment, literals) {
  const m = /\bcheck\s*\(/.exec(fragment);
  if (!m) return null;
  let depth = 0;
  let end = -1;
  for (let i = m.index + m[0].length - 1; i < fragment.length; i++) {
    if (fragment[i] === '(') depth++;
    if (fragment[i] === ')' && --depth === 0) { end = i + 1; break; }
  }
  if (end === -1) return null;
  const expr = fragment.slice(m.index, end).toLowerCase();
  const used = [...expr.matchAll(/'\?(\d+)'/g)].map((x) => literals[Number(x[1])]);
  const body = expr.replace(/\s+/g, '').replace(/::[a-z_]+(\[\])?/g, '').replace(/'\?\d+'(?:,'\?\d+')*/g, "'*'");
  return { body, literals: used };
}

/** A CHECK that keeps the old expression's shape and still allows every old literal is a widening. */
export function isWidening(prev, next) {
  if (!prev || !next || prev.body !== next.body) return false;
  const allowed = new Set(next.literals);
  return prev.literals.every((l) => allowed.has(l));
}

/** Normalise an identifier path: drop quotes, lowercase, drop a leading public. schema. */
export function normName(raw) {
  if (!raw) return '';
  const s = raw.replace(/"/g, '').toLowerCase().trim();
  return s.startsWith('public.') ? s.slice('public.'.length) : s;
}

const IDENT = String.raw`(?:"[^"]+"|[a-z_][a-z0-9_$]*)(?:\s*\.\s*(?:"[^"]+"|[a-z_][a-z0-9_$]*))?`;

/** Split on commas that are not inside parentheses (literals are already masked). */
function topLevelCommaSplit(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const VOLATILE_DEFAULT = /\bdefault\b[^,]*\b(gen_random_uuid|uuid_generate_v[14]|random|clock_timestamp|nextval|timeofday|txid_current)\s*\(/;

/**
 * Classify one ALTER TABLE action on an EXISTING table. Returns a finding or null.
 */
const EXPR_WORDS = new Set(('is null not and or in between true false check constraint any all some array case when then else end cast as '
  + 'like ilike similar to escape distinct from foreign key references on delete update cascade set restrict no action deferrable '
  + 'initially deferred immediate match full simple partial interval current_date current_timestamp localtimestamp unique primary '
  + 'exclude using with where include nulls text varchar character integer int bigint smallint numeric decimal boolean bool date '
  + 'time timestamp timestamptz zone jsonb json uuid bytea real double precision inet citext interval collate value').split(' '));

/** Column-like identifiers an ADD CONSTRAINT body refers to (function names, keywords, casts and literals removed). */
export function constraintColumns(body) {
  let b = body.replace(/^add\s+(constraint\s+(?:"[^"]+"|\S+)\s+)?/, '');
  const fk = /^foreign\s+key\s*\(([^)]*)\)/.exec(b);
  if (fk) return fk[1].split(',').map((c) => normName(c));
  b = b.replace(/'\?\d+'/g, ' ').replace(/::\s*[a-z_][a-z0-9_]*(\s*\[\])?/g, ' ').replace(/\bnot\s+valid\b/g, ' ');
  const out = new Set();
  const re = /"([^"]+)"|([a-z_][a-z0-9_]*)(\s*\()?/g;
  let m;
  while ((m = re.exec(b))) {
    if (m[1]) { out.add(m[1]); continue; }
    if (m[3] || EXPR_WORDS.has(m[2])) continue;
    out.add(m[2]);
  }
  return [...out];
}

/** Split a parenthesised boolean expression on top-level OR. */
function topLevelOr(expr) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && /\sor\s/.test(expr.slice(i, i + 4)) && /^\sor\s$/.test(expr.slice(i, i + 4))) { parts.push(cur); cur = ''; i += 2; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim());
}

function stripParens(x) {
  let t = x.trim();
  while (t.startsWith('(') && t.endsWith(')')) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++;
      if (t[i] === ')') depth--;
      if (depth === 0 && i < t.length - 1) { wraps = false; break; }
    }
    if (!wraps) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

/**
 * True when every row the running release can write satisfies the new constraint, because the
 * constraint only bites on columns this release adds (all NULL in existing rows, never written by the
 * old code). Relies on PostgreSQL NULL semantics:
 *   - FOREIGN KEY (MATCH SIMPLE, the default) is not checked when any referencing column is NULL;
 *   - UNIQUE / EXCLUDE never conflict on NULL (unless NULLS NOT DISTINCT);
 *   - UNIQUE over a set that includes `id` (the primary key throughout this schema) cannot be violated;
 *   - a CHECK is satisfied when one top-level OR branch is "these new columns are NULL", or when it
 *     references only new columns.
 */
export function constraintOnlyConstrainsNewRows(action, addedColumns = new Set()) {
  const a = action.toLowerCase().replace(/^add\s+(constraint\s+(?:"[^"]+"|\S+)\s+)?/, '');
  const isNew = (c) => addedColumns.has(normName(c));
  let r;
  if ((r = /^foreign\s+key\s*\(([^)]*)\)/.exec(a))) {
    if (/\bmatch\s+full\b/.test(a)) return r[1].split(',').every(isNew);
    return r[1].split(',').some(isNew);
  }
  if ((r = /^(unique|primary\s+key)\s*(?:nulls\s+distinct\s*)?\(([^)]*)\)/.exec(a)) && !/nulls\s+not\s+distinct/.test(a)) {
    const cols = r[2].split(',').map(normName);
    return cols.includes('id') || (r[1] === 'unique' && cols.some(isNew));
  }
  if (/^exclude\b/.test(a)) {
    const cols = [...a.matchAll(/([a-z_][a-z0-9_]*)\s+with\s+[=&<>@-]+/g)].map((m) => m[1]);
    return cols.some((c) => isNew(c) && /\swith\s+=/.test(a));
  }
  if (/^check\b/.test(a)) {
    const cols = constraintColumns(a);
    if (cols.length && cols.every(isNew)) return true;
    const body = checkShape(a, [])?.body ?? null;
    const open = a.indexOf('(');
    let depth = 0;
    let end = -1;
    for (let i = open; i < a.length; i++) {
      if (a[i] === '(') depth++;
      if (a[i] === ')' && --depth === 0) { end = i; break; }
    }
    if (!body || end === -1) return false;
    const expr = stripParens(a.slice(open + 1, end));
    return topLevelOr(expr).some((branch) => {
      const terms = stripParens(branch).split(/\s+and\s+/).map((x) => stripParens(x));
      return terms.length > 0 && terms.every((x) => {
        const m = /^("[^"]+"|[a-z_][a-z0-9_]*)\s+is\s+null$/.exec(x);
        return m && isNew(m[1]);
      });
    });
  }
  return false;
}

function classifyAlterAction(action, table, addedColumns = new Set()) {
  const a = action.toLowerCase();
  if (/^drop\s+(column\s+)?(if\s+exists\s+)?(?!constraint\b)/.test(a) && !/^drop\s+(constraint|default|not\s+null|identity|expression)\b/.test(a))
    return { rule: 'drop-column', reason: `removes a column of ${table} that the running release may read or write` };
  if (/^rename\b/.test(a))
    return { rule: 'rename', reason: `renames ${table} or one of its columns while the running release uses the old name` };
  if (/^alter\s+(column\s+)?\S+\s+(set\s+data\s+)?type\b/.test(a))
    return { rule: 'change-type', reason: `changes a column type on ${table}: rewrites the table under an exclusive lock and may break the running release` };
  if (/^alter\s+(column\s+)?\S+\s+set\s+not\s+null\b/.test(a))
    return { rule: 'set-not-null', reason: `makes a column of ${table} NOT NULL: scans the table under an exclusive lock and refuses the running release's inserts that omit it` };
  if (/^add\s+(column\s+)?(if\s+not\s+exists\s+)?/.test(a) && !/^add\s+(constraint|check|foreign\s+key|unique|primary\s+key|exclude)\b/.test(a)) {
    if (/\bnot\s+null\b/.test(a) && !/\bdefault\b/.test(a) && !/\bgenerated\b/.test(a))
      return { rule: 'add-required-column', reason: `adds a NOT NULL column without a default to ${table}: the running release's inserts will fail` };
    if (VOLATILE_DEFAULT.test(a))
      return { rule: 'table-rewrite', reason: `adds a column with a volatile default to ${table}: rewrites the table under an exclusive lock` };
    if (/\bgenerated\s+always\s+as\s*\(.*\)\s*stored\b/.test(a))
      return { rule: 'table-rewrite', reason: `adds a stored generated column to ${table}: rewrites the table under an exclusive lock` };
    return null;
  }
  if (/^add\s+(constraint\s+\S+\s+)?(check|foreign\s+key|unique|primary\s+key|exclude)\b/.test(a)) {
    if (/\bnot\s+valid\b/.test(a)) return null;
    if (/\bunique\b.*\busing\s+index\b|\bprimary\s+key\b.*\busing\s+index\b/.test(a)) return null;
    // A CHECK or FOREIGN KEY over columns this release adds: every existing row holds NULL there and
    // the running release never writes them, so validation is trivial and cannot refuse old writes.
    if (constraintOnlyConstrainsNewRows(a, addedColumns)) return null;
    return { rule: 'validating-constraint', reason: `adds a validated constraint to ${table}: scans it under lock and refuses any running-release write that violates it (use NOT VALID then VALIDATE CONSTRAINT)` };
  }
  if (/^set\s+(logged|unlogged|tablespace|without\s+oids|access\s+method)\b/.test(a))
    return { rule: 'table-rewrite', reason: `rewrites ${table} under an exclusive lock` };
  return null;
}

/**
 * Classify a list of pending migrations. `migrations` is [{tag, sql}] in journal order.
 * Returns {mode, findings, notices}.
 */
/** table -> [{body, literals}] of every CHECK the history defined, inline in CREATE TABLE or added later. */
function checkDefinitions(parsedList) {
  const defs = new Map();
  const put = (table, shape) => {
    if (!shape) return;
    if (!defs.has(table)) defs.set(table, []);
    defs.get(table).push(shape);
  };
  for (const m of parsedList) for (const s of m.statements) {
    const t = s.text.toLowerCase();
    let r;
    if ((r = new RegExp(String.raw`^create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(${IDENT})\s*\((.*)\)[^)]*$`).exec(t))) {
      const table = normName(r[1]);
      for (const el of topLevelCommaSplit(r[2])) if (/\bcheck\s*\(/.test(el)) put(table, checkShape(el, s.literals));
      continue;
    }
    if ((r = new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${IDENT})\s*(.*)$`).exec(t))) {
      const table = normName(r[1]);
      for (const a of topLevelCommaSplit(r[2])) if (/^add\b.*\bcheck\s*\(/.test(a)) put(table, checkShape(a, s.literals));
    }
  }
  return defs;
}

export function classifyMigrations(migrations, history = []) {
  const previousChecks = checkDefinitions(history.map((m) => ({ tag: m.tag, statements: splitStatements(m.sql) })));
  const newTables = new Set();
  const addedColumns = new Map();
  const created = { function: new Set(), view: new Set(), type: new Set(), sequence: new Set(), schema: new Set() };
  const parsed = migrations.map((m) => ({ tag: m.tag, statements: splitStatements(m.sql) }));

  // Pass 1: what the pending set creates. A later DROP of something created earlier in the set,
  // or a DROP followed by a re-CREATE of the same name, is not a removal the old code can observe
  // (migrations apply in one transaction).
  for (const m of parsed) {
    for (const s of m.statements) {
      const t = s.text.toLowerCase();
      let r;
      if ((r = new RegExp(String.raw`^create\s+(?:unlogged\s+|temp(?:orary)?\s+)?table\s+(?:if\s+not\s+exists\s+)?(${IDENT})`).exec(t))) newTables.add(normName(r[1]));
      if ((r = new RegExp(String.raw`^create\s+(?:or\s+replace\s+)?(function|procedure)\s+(${IDENT})`).exec(t))) created.function.add(normName(r[2]));
      if ((r = new RegExp(String.raw`^create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?(${IDENT})`).exec(t))) created.view.add(normName(r[1]));
      if ((r = new RegExp(String.raw`^create\s+type\s+(${IDENT})`).exec(t))) created.type.add(normName(r[1]));
      if ((r = new RegExp(String.raw`^create\s+sequence\s+(?:if\s+not\s+exists\s+)?(${IDENT})`).exec(t))) created.sequence.add(normName(r[1]));
      if ((r = new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${IDENT})\s*(.*)$`).exec(t))) {
        const table = normName(r[1]);
        for (const action of topLevelCommaSplit(r[2])) {
          const c = new RegExp(String.raw`^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?("[^"]+"|[a-z_][a-z0-9_]*)`).exec(action);
          if (c && !/^(constraint|check|foreign|unique|primary|exclude)$/.test(c[1])) {
            if (!addedColumns.has(table)) addedColumns.set(table, new Set());
            addedColumns.get(table).add(normName(c[1]));
          }
        }
      }
      if ((r = new RegExp(String.raw`^create\s+schema\s+(?:if\s+not\s+exists\s+)?(${IDENT})`).exec(t))) created.schema.add(normName(r[1]));
    }
  }

  const findings = [];
  const notices = [];
  const add = (list, m, idx, s, rule, object, reason) =>
    list.push({ tag: m.tag, statement: idx + 1, rule, object, reason, annotation: s.annotations.length ? s.annotations.join(' / ') : null, sql: s.text.slice(0, 240) });

  for (const m of parsed) {
    m.statements.forEach((s, idx) => {
      const t = s.text.toLowerCase();
      let r;
      if ((r = /^drop\s+table\s+(?:if\s+exists\s+)?(.+?)(?:\s+(?:cascade|restrict))?$/.exec(t))) {
        for (const name of topLevelCommaSplit(r[1]).map(normName)) {
          if (!newTables.has(name) && !name.startsWith('pg_temp.')) add(findings, m, idx, s, 'drop-table', name, `drops table ${name}, which the running release may use`);
        }
        return;
      }
      if ((r = new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${IDENT})\s*(.*)$`).exec(t))) {
        const table = normName(r[1]);
        if (newTables.has(table)) return;
        for (const action of topLevelCommaSplit(r[2])) {
          const f = classifyAlterAction(action, table, addedColumns.get(table));
          if (f && f.rule === 'validating-constraint' && /\bcheck\s*\(/.test(action)) {
            // A CHECK the running release already lived under, re-added with a list that only grew.
            const next = checkShape(action, s.literals);
            const prior = (previousChecks.get(table) ?? []).filter((d) => next && d.body === next.body);
            if (prior.length && isWidening(prior[prior.length - 1], next)) {
              add(notices, m, idx, s, 'widened-check', table, `re-adds a CHECK on ${table} that still allows every value the running release's definition allowed; scans ${table} under lock`);
              continue;
            }
          }
          if (f) add(findings, m, idx, s, f.rule, table, f.reason);
        }
        return;
      }
      if ((r = new RegExp(String.raw`^drop\s+(function|procedure|view|materialized\s+view|type|sequence|schema)\s+(?:if\s+exists\s+)?(${IDENT})`).exec(t))) {
        const kind = r[1].replace(/\s+/g, ' ');
        const bucket = kind === 'procedure' ? 'function' : kind === 'materialized view' ? 'view' : kind;
        const name = normName(r[2]);
        if (!created[bucket].has(name)) add(findings, m, idx, s, `drop-${bucket}`, name, `drops ${kind} ${name} without re-creating it; the running release may call it`);
        return;
      }
      if ((r = new RegExp(String.raw`^alter\s+(function|procedure|view|materialized\s+view|type|sequence|schema)\s+(?:if\s+exists\s+)?(${IDENT}).*\brename\s+to\b`).exec(t))) {
        // Rename-and-wrap: the old name is re-created in the same set, so the running release still
        // finds an object of that name (in the same transaction).
        const kind = r[1].replace(/\s+/g, ' ');
        const bucket = kind === 'procedure' ? 'function' : kind === 'materialized view' ? 'view' : kind;
        if (created[bucket].has(normName(r[2]))) return;
        add(findings, m, idx, s, 'rename', normName(r[2]), `renames ${r[1]} ${normName(r[2])} while the running release uses the old name`);
        return;
      }
      if ((r = new RegExp(String.raw`^alter\s+type\s+(${IDENT})\s+drop\b`).exec(t))) {
        add(findings, m, idx, s, 'change-type', normName(r[1]), `removes part of type ${normName(r[1])}`);
        return;
      }
      if (/^(vacuum\s+full|cluster)\b/.test(t)) {
        add(findings, m, idx, s, 'table-rewrite', t.split(' ').slice(2).join(' ') || '(all)', 'rewrites tables under an exclusive lock');
        return;
      }
      if ((r = new RegExp(String.raw`^create\s+(?:unique\s+)?index\s+(?!concurrently\b)(?:if\s+not\s+exists\s+)?(?:${IDENT}\s+)?on\s+(?:only\s+)?(${IDENT})`).exec(t))) {
        const table = normName(r[1]);
        if (!newTables.has(table)) add(notices, m, idx, s, 'index-blocks-writes', table, `builds an index on ${table} while blocking its writes; fine for small tables, measure on the rehearsal for large ones`);
        return;
      }
      if ((r = new RegExp(String.raw`^(?:truncate|lock)\s+(?:table\s+)?(?:only\s+)?(${IDENT})`).exec(t))) {
        const table = normName(r[1]);
        if (!newTables.has(table)) add(notices, m, idx, s, t.startsWith('lock') ? 'explicit-lock' : 'truncate', table, `${t.split(' ')[0]} on populated table ${table}`);
      }
    });
  }

  const blocking = findings.filter((f) => !f.annotation);
  return { mode: blocking.length ? 'maintenance' : 'online', findings, notices, newTables: [...newTables].sort() };
}

/** Read a journal and return entries [{tag, when}]. */
export function readJournal(dir) {
  const file = path.join(dir, 'db', 'migrations', 'meta', '_journal.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(j.entries)) throw new Error(`${file}: no entries`);
  return j.entries.map((e) => ({ tag: e.tag, when: e.when }));
}

/** Pending = candidate entries after the base journal. The base must be an exact prefix. */
export function pendingEntries(base, candidate) {
  if (candidate.length < base.length) throw new Error(`candidate journal (${candidate.length}) is shorter than the running release's (${base.length})`);
  base.forEach((e, i) => {
    if (candidate[i].tag !== e.tag || candidate[i].when !== e.when)
      throw new Error(`journal diverges at entry ${i}: running ${e.tag} vs candidate ${candidate[i].tag}`);
  });
  return candidate.slice(base.length);
}

/** Apply a release acceptance file. Throws on an entry that matches no finding or has no reason. */
export function applyAcceptances(report, accepted = []) {
  for (const a of accepted) {
    if (!a || typeof a.reason !== 'string' || a.reason.trim().length < 10) throw new Error(`acceptance ${JSON.stringify(a)} needs a reason of at least 10 characters`);
    const f = report.findings.find((x) => x.tag === a.tag && x.statement === a.statement && x.rule === a.rule);
    if (!f) throw new Error(`acceptance ${a.tag}#${a.statement} ${a.rule} matches no finding`);
    f.annotation = f.annotation ? `${f.annotation} / release: ${a.reason.trim()}` : `release: ${a.reason.trim()}`;
  }
  report.mode = report.findings.some((f) => !f.annotation) ? 'maintenance' : 'online';
  return report;
}

export function classifyRelease(baseDir, candidateDir) {
  const pending = pendingEntries(readJournal(baseDir), readJournal(candidateDir));
  const read = (dir, tag) => ({ tag, sql: fs.readFileSync(path.join(dir, 'db', 'migrations', `${tag}.sql`), 'utf8') });
  const migrations = pending.map((e) => read(candidateDir, e.tag));
  const history = readJournal(baseDir).map((e) => read(baseDir, e.tag));
  return { pending: pending.map((e) => e.tag), ...classifyMigrations(migrations, history) };
}

function main(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') args.base = argv[++i];
    else if (argv[i] === '--candidate') args.candidate = argv[++i];
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--accept') args.accept = argv[++i];
    else { console.error(`unknown argument ${argv[i]}`); return 2; }
  }
  if (!args.base || !args.candidate) { console.error('usage: migration-release-mode.mjs --base <dir> --candidate <dir> [--accept <file>] [--json]'); return 2; }
  let report;
  try {
    report = classifyRelease(args.base, args.candidate);
    if (args.accept) applyAcceptances(report, JSON.parse(fs.readFileSync(args.accept, 'utf8')).accepted);
  }
  catch (e) { console.error(`REFUSE: ${e.message}`); return 2; }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`pending=${report.pending.length} mode=${report.mode}`);
    for (const f of report.findings) console.log(`${f.annotation ? 'ANNOTATED' : 'BLOCKS'} ${f.tag}#${f.statement} ${f.rule} ${f.object}: ${f.reason}${f.annotation ? ` [${f.annotation}]` : ''}`);
    for (const f of report.notices) console.log(`NOTICE ${f.tag}#${f.statement} ${f.rule} ${f.object}: ${f.reason}`);
  }
  return report.mode === 'online' ? 0 : 3;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
