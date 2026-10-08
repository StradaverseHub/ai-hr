/**
 * r417 (ADR-0094) — MAY THIS DIFF BE GATED BY THE AFFECTED TIER, OR DOES IT NEED THE FULL GATE?
 *
 * Pure and lib-free: it is handed the changed files (path, git status, the added/removed diff lines, the
 * text on each side) and returns a verdict. scripts/gate-tier-git.ts collects those from git;
 * scripts/gate-affected.sh and scripts/improve/release.ts both decide through THIS function, so the gate
 * and the release cannot disagree about what "presentational" means.
 *
 * THE RULE IS AN ALLOW-LIST. A diff qualifies for the affected tier only when EVERY changed file is
 * presentational or documentation. Anything not explicitly allowed forces the full tier — a new top-level
 * directory, a config file nobody thought of, a rename into lib/ — and the named categories below exist
 * only to make the printed reason specific. Note what that means for lib/: the affected tier cannot see
 * repo-wide behaviour reached only through a changed lib module, and it does not have to, because any
 * change to lib/ is FULL by construction.
 *
 * Renames arrive as a delete plus an add (the collector passes --no-renames), so both paths are judged.
 */

export interface ChangedFile {
  /** Repo-relative path, forward slashes. */
  path: string;
  /** git name-status letter: A, M, D, T … (renames are pre-split into D + A). */
  status: string;
  /** The content of every added or removed diff line, without its leading '+' / '-'. */
  diffLines: string[];
  /** The file at HEAD, or null when deleted / binary / unreadable. */
  headText: string | null;
  /** The file at the merge base, or null when added / binary / unreadable. */
  baseText: string | null;
}

export type FileVerdict = { file: string; allowed: true; rule: string } | { file: string; allowed: false; reason: string };

export interface TierVerdict {
  tier: 'affected' | 'full';
  files: FileVerdict[];
  /** Every refusal, `<file>: <reason>`. Empty exactly when tier === 'affected'. */
  reasons: string[];
}

/**
 * An app/** page.tsx, layout.tsx or loading.tsx is presentational only while none of its ADDED or REMOVED
 * lines contain one of these. Substring match, case-sensitive, deliberately crude: each one is a way a
 * screen file reaches data, auth, routing or the server, and a false "full" costs twenty minutes while a
 * false "affected" ships an unrun permission check.
 */
export const PAGE_FORBIDDEN_TOKENS = [
  'await',
  'import ',
  'scoped',
  'session',
  'redirect(',
  'notFound(',
  'permission',
  'sql',
  'db.',
  'withTenant',
  "'use server'",
  '"use server"',
  'fetch(',
  'process.env',
  'export async function',
  'export function',
  'searchParams',
] as const;

/**
 * Files under test/ that are vitest SETUP, not tests or helpers: they apply to every test file without
 * being imported by any, so `vitest related` cannot see their dependents. test/r417-gate-tier.test.ts
 * pins that each one is named by a vitest config.
 */
export const TEST_SETUP_FILES = [
  'test/env.ts',
  'test/global-setup.ts',
  'test/dom-setup.ts',
  'test/browser-setup.ts',
  'test/db-names.ts',
] as const;

const USE_SERVER = /['"]use server['"]/;

/** Forced-full categories, checked FIRST so the printed reason names the real cause. */
const FULL_RULES: ReadonlyArray<{ test: (p: string) => boolean; reason: string }> = [
  { test: (p) => p.startsWith('core/'), reason: 'kernel code (core/)' },
  { test: (p) => p.startsWith('packs/'), reason: 'pack code (packs/)' },
  { test: (p) => p.startsWith('localization/'), reason: 'jurisdiction code (localization/)' },
  { test: (p) => p.startsWith('db/migrations/'), reason: 'a migration (db/migrations/)' },
  { test: (p) => p.startsWith('db/'), reason: 'the database layer (db/)' },
  {
    test: (p) => p.startsWith('lib/'),
    reason: 'lib/ (all of it): shared logic whose repo-wide reach the affected tier cannot see',
  },
  { test: (p) => /^app\/(.*\/)?actions\.tsx?$/.test(p), reason: 'a server action (app/**/actions.ts)' },
  { test: (p) => /^app\/(.*\/)?route\.tsx?$/.test(p), reason: 'a route handler (app/**/route.ts)' },
  { test: (p) => /^(src\/)?(middleware|proxy)\.[cm]?[jt]sx?$/.test(p), reason: 'middleware / proxy' },
  { test: (p) => p.startsWith('scripts/'), reason: 'scripts/ (gate, release, deploy and data tooling)' },
  { test: (p) => p.startsWith('deploy/'), reason: 'deploy/ (the box deploy path)' },
  { test: (p) => p === 'package.json' || p.endsWith('/package.json'), reason: 'package.json' },
  {
    test: (p) => /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|pnpm-workspace\.yaml)$/.test(p),
    reason: 'the lockfile / workspace',
  },
  { test: (p) => /^next\.config\./.test(p), reason: 'next.config' },
  { test: (p) => p.startsWith('public/forms/'), reason: 'statutory form templates (public/forms/)' },
  { test: (p) => /^vitest(\.[\w-]+)?\.config\./.test(p), reason: 'a vitest config' },
  { test: (p) => (TEST_SETUP_FILES as readonly string[]).includes(p), reason: 'a vitest setup file (applies to every test)' },
];

function isScreenFile(p: string): boolean {
  return /^app\/(.*\/)?(page|layout|loading)\.tsx$/.test(p);
}

export function classifyFile(c: ChangedFile): FileVerdict {
  const p = c.path;
  for (const r of FULL_RULES) if (r.test(p)) return { file: p, allowed: false, reason: r.reason };

  if (p.startsWith('components/')) {
    const sides = [c.headText, c.baseText, c.diffLines.join('\n')];
    if (sides.some((t) => t !== null && USE_SERVER.test(t))) {
      return { file: p, allowed: false, reason: "a components/ file containing 'use server'" };
    }
    return { file: p, allowed: true, rule: 'components/**' };
  }
  if (p === 'app/globals.css') return { file: p, allowed: true, rule: 'app/globals.css' };
  if (/^messages\/[^/]+\.json$/.test(p)) return { file: p, allowed: true, rule: 'messages/*.json' };
  if (p.startsWith('docs/')) return { file: p, allowed: true, rule: 'docs/**' };
  if (p.startsWith('test/')) return { file: p, allowed: true, rule: 'test/**' };
  if (p.endsWith('.md')) return { file: p, allowed: true, rule: '*.md' };
  if (p.startsWith('public/')) return { file: p, allowed: true, rule: 'public/** (not public/forms/)' };

  if (isScreenFile(p)) {
    const hits = PAGE_FORBIDDEN_TOKENS.filter((tok) => c.diffLines.some((l) => l.includes(tok)));
    if (hits.length > 0) {
      return {
        file: p,
        allowed: false,
        reason: `a screen file whose changed lines contain ${hits.map((h) => JSON.stringify(h)).join(', ')}`,
      };
    }
    return { file: p, allowed: true, rule: 'app/**/page|layout|loading.tsx (markup-only diff)' };
  }

  return { file: p, allowed: false, reason: 'not on the presentational allow-list' };
}

export function classifyChanges(changes: ChangedFile[]): TierVerdict {
  const files = changes.map(classifyFile);
  const reasons = files.flatMap((v) => (v.allowed ? [] : [`${v.file}: ${v.reason}`]));
  // An EMPTY diff is not "presentational": there is nothing for the affected tier to have tested, and a
  // receipt for it would be a claim about nothing. Full.
  if (changes.length === 0) reasons.push('(no changed files): an empty diff has no affected set');
  return { tier: reasons.length === 0 ? 'affected' : 'full', files, reasons };
}

/** The "FULL GATE REQUIRED" block both callers print. */
export function describeVerdict(v: TierVerdict, base: string): string {
  if (v.tier === 'affected') {
    return [
      `AFFECTED TIER ALLOWED — every one of ${v.files.length} changed file(s) since ${base} is presentational or docs:`,
      ...v.files.map((f) => `  ${f.file}  [${f.allowed ? f.rule : ''}]`),
    ].join('\n');
  }
  return [`FULL GATE REQUIRED — the diff since ${base} is not presentational-only:`, ...v.reasons.map((r) => `  ✗ ${r}`)].join('\n');
}
