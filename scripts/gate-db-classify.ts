/**
 * r417 — WHICH TEST FILES TOUCH THE DATABASE. Computed, never a hand list (ADR-0094).
 *
 * The full gate runs in two parts (scripts/gate-chunked.sh): every file that does NOT touch Postgres in
 * ONE vitest invocation with no cluster rebuild, and the rest chunked with a rebuild per chunk exactly as
 * before. This module decides which side of that line a file is on, and it is deliberately one-sided:
 * a no-DB file wrongly sent to the DB side costs a few seconds; a DB file wrongly sent to the no-DB side
 * runs against a cluster nobody rebuilt, which is the r374 "8 failed, zero AssertionErrors" shape. So
 * EVERY doubt resolves to DB.
 *
 * A test file is DB-touching when IT, or any module under test/ it imports (helpers, fixtures, other test
 * files — followed transitively):
 *   • imports test/harness, test/global-setup, db/client, db/schema, or a Postgres driver
 *     (`pg`, `postgres`, `drizzle-orm/postgres-js`, `drizzle-orm/node-postgres`, `drizzle-orm/pg-core`);
 *   • calls migrateTestDb( / resetDb( / withTenant( — anywhere in its text, strings included;
 *   • mentions DATABASE_URL (any of the TEST_/MIGRATION_ spellings), `inject('workerDbPrefix')`, or psql —
 *     a test that spawns a script against the database imports nothing from db/ at all;
 *   • has a relative or `@/` import this resolver cannot find on disk, or a dynamic import()/require()
 *     whose argument is not a string literal — it cannot be followed, so it is not proven clean.
 *
 * What this does NOT follow: imports into app/, core/, lib/ and the rest of the product. A test that
 * imports core/x.ts, which imports db/client, is no-DB here as long as it never calls a query — importing
 * db/client opens no connection (postgres-js connects on first query). That is the gap the closed-port
 * proof (test/r417-nodb-closed-port.test.ts, and `GATE_NODB_PROOF=1`) exists to close: every file this
 * module calls no-DB is RUN with every database URL pointing at a closed port, and must be green.
 *
 * Pure and lib-free on purpose: the caller hands in `read`, so the unit test drives it with an in-memory
 * tree. The CLI at the bottom is the only part that touches the filesystem.
 */

export type Reader = (repoPath: string) => string | null;

export interface DbVerdict {
  db: boolean;
  /** Why — the first rule that fired, naming the file it fired in (may be a helper, not the test). */
  reason: string;
}

/** Repo paths (extension-less) whose import makes a file DB-touching. */
export const DB_MODULES = ['test/harness', 'test/global-setup', 'db/client', 'db/schema'] as const;

/** Bare specifiers (exact, or as a `pkg/...` prefix) that are a Postgres driver. */
export const DB_PACKAGES = [
  'pg',
  'postgres',
  'drizzle-orm/postgres-js',
  'drizzle-orm/node-postgres',
  'drizzle-orm/pg-core',
] as const;

/** Text that marks a file DB-touching wherever it appears. */
export const DB_TEXT: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\bmigrateTestDb\s*\(/, label: 'calls migrateTestDb(' },
  { re: /\bresetDb\s*\(/, label: 'calls resetDb(' },
  { re: /\bwithTenant\s*\(/, label: 'calls withTenant(' },
  { re: /DATABASE_URL/, label: 'mentions a DATABASE_URL' },
  { re: /\binject\s*\(\s*['"`]workerDbPrefix/, label: "inject('workerDbPrefix')" },
  { re: /\bpsql\b/, label: 'mentions psql' },
];

const EXTS = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '/index.ts', '/index.tsx', '/index.js'];

/** Every module specifier in a source text. `dynamic` marks an import()/require() that is not a literal. */
export function importSpecifiers(src: string): { specs: string[]; opaqueDynamic: boolean } {
  const specs: string[] = [];
  // static `import … from 'x'`, `export … from 'x'`, and bare `import 'x'`
  for (const m of src.matchAll(/(?:^|[;\s}])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
    specs.push(m[1]);
  }
  // import('x') / require('x') / vi.importActual('x') with a literal
  for (const m of src.matchAll(/\b(?:import|require|importActual|importMock)\s*(?:<[^>]*>)?\s*\(\s*['"]([^'"]+)['"]\s*[,)]/g)) {
    specs.push(m[1]);
  }
  // import(…) / require(…) whose first argument is NOT a plain string literal: cannot be followed.
  const opaqueDynamic = /(?<![\w.])(?:import|require)\s*\(\s*(?![\s)'"])/.test(src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''));
  return { specs, opaqueDynamic };
}

function normalise(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

function stripExt(p: string): string {
  return p.replace(/(\/index)?\.(ts|tsx|js|mjs|cjs|mts|json)$/, '');
}

/**
 * Resolve a relative or `@/` specifier from `fromFile` to a repo path that exists, or null when it does
 * not resolve. Bare package specifiers return undefined (they are not repo files).
 */
export function resolveSpecifier(spec: string, fromFile: string, read: Reader): string | null | undefined {
  let base: string;
  if (spec.startsWith('@/')) base = normalise(spec.slice(2));
  else if (spec.startsWith('.')) base = normalise(`${dirname(fromFile)}/${spec}`);
  else return undefined;
  // `./x.js` written for a `.ts` source (ESM style) — try the bare stem too.
  const stems = [base, base.replace(/\.(js|mjs|cjs)$/, '')];
  for (const stem of stems) {
    for (const ext of EXTS) {
      const cand = stem + ext;
      if (read(cand) !== null) return cand;
    }
  }
  return null;
}

function isDbPackage(spec: string): boolean {
  return DB_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`));
}

/**
 * Classify ONE test file. `cache` is shared across calls so a helper imported by 300 files is read once.
 */
export function classifyTestFile(file: string, read: Reader, cache = new Map<string, DbVerdict>()): DbVerdict {
  const visiting = new Set<string>();

  const visit = (f: string): DbVerdict => {
    const hit = cache.get(f);
    if (hit) return hit;
    if (visiting.has(f)) return { db: false, reason: 'cycle' }; // the cycle's root decides
    visiting.add(f);
    const verdict = inspect(f);
    visiting.delete(f);
    cache.set(f, verdict);
    return verdict;
  };

  const inspect = (f: string): DbVerdict => {
    const src = read(f);
    if (src === null) return { db: true, reason: `${f}: cannot be read` };
    for (const { re, label } of DB_TEXT) if (re.test(src)) return { db: true, reason: `${f}: ${label}` };
    const { specs, opaqueDynamic } = importSpecifiers(src);
    if (opaqueDynamic) return { db: true, reason: `${f}: a dynamic import()/require() that is not a string literal` };
    for (const spec of specs) {
      if (isDbPackage(spec)) return { db: true, reason: `${f}: imports ${spec}` };
      const r = resolveSpecifier(spec, f, read);
      if (r === undefined) continue; // some other package
      if (r === null) return { db: true, reason: `${f}: import '${spec}' does not resolve` };
      const stem = stripExt(r);
      const named = DB_MODULES.find((m) => stem === m || stem.startsWith(`${m}/`));
      if (named) return { db: true, reason: `${f}: imports ${named}` };
      if (r.startsWith('test/')) {
        const v = visit(r);
        if (v.db) return { db: true, reason: v.reason };
      }
    }
    return { db: false, reason: 'no database import, call or URL in it or its test/ helpers' };
  };

  return visit(file);
}

export function classifyTestFiles(files: string[], read: Reader): { db: string[]; nodb: string[]; why: Map<string, string> } {
  const cache = new Map<string, DbVerdict>();
  const db: string[] = [];
  const nodb: string[] = [];
  const why = new Map<string, string>();
  for (const f of files) {
    const v = classifyTestFile(f, read, cache);
    (v.db ? db : nodb).push(f);
    why.set(f, v.reason);
  }
  return { db, nodb, why };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// CLI:  node --import tsx scripts/gate-db-classify.ts <db|nodb|explain> < file-list
//   Reads repo-relative test paths (one per line) on stdin, prints the requested subset, one per line.
//   `explain` prints `DB|NODB<TAB>path<TAB>reason` for every file.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { readFileSync, statSync } = await import('node:fs');
  const mode = process.argv[2];
  if (!['db', 'nodb', 'explain'].includes(mode ?? '')) {
    console.error('usage: gate-db-classify.ts <db|nodb|explain> < list-of-test-files');
    process.exit(2);
  }
  const files = readFileSync(0, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  const read: Reader = (p) => {
    try {
      if (!statSync(p).isFile()) return null;
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };
  const { db, nodb, why } = classifyTestFiles(files, read);
  if (mode === 'db') for (const f of db) console.log(f);
  else if (mode === 'nodb') for (const f of nodb) console.log(f);
  else for (const f of files) console.log(`${db.includes(f) ? 'DB' : 'NODB'}\t${f}\t${why.get(f)}`);
}

if (process.argv[1] && /gate-db-classify\.ts$/.test(process.argv[1])) {
  void main();
}
