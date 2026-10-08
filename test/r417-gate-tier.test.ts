/**
 * r417 (ADR-0094) — the affected tier's risk classifier, scripts/gate-tier.ts.
 *
 * The rule is an ALLOW-LIST: the affected tier is allowed only when EVERY changed file is presentational
 * or docs. These tests pin each allowed shape, each forced-full category BY ITS REASON (a removed rule
 * must fail here even though the allow-list default would still say "full" — that is why the reasons are
 * asserted, not just the tier), and the page.tsx token rule.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PAGE_FORBIDDEN_TOKENS,
  TEST_SETUP_FILES,
  classifyChanges,
  classifyFile,
  type ChangedFile,
} from '../scripts/gate-tier';

function change(path: string, over: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status: 'M', diffLines: ['<div className="p-2">'], headText: 'x', baseText: 'x', ...over };
}
const verdict = (path: string, over: Partial<ChangedFile> = {}) => classifyFile(change(path, over));
const reasonOf = (path: string, over: Partial<ChangedFile> = {}) => {
  const v = verdict(path, over);
  return v.allowed ? `ALLOWED (${v.rule})` : v.reason;
};

describe('allowed: presentational and docs', () => {
  it.each([
    'components/company-switcher.tsx',
    'components/ui/combobox.tsx',
    'app/globals.css',
    'messages/en.json',
    'messages/zh.json',
    'docs/adr/0094-tiered-test-gate.md',
    'docs/HANDOFF-HISTORY.md',
    'test/r416-monolith-header-menus.test.ts',
    'test/helpers/some-helper.ts',
    'README.md',
    'content/guides/leave.md',
    'public/statutory/lhdn.png',
    'public/globe.svg',
  ])('%s is allowed', (p) => {
    expect(verdict(p).allowed, reasonOf(p)).toBe(true);
  });

  it('a diff that is all allowed files is the affected tier', () => {
    const v = classifyChanges([change('components/a.tsx'), change('messages/en.json'), change('docs/x.md')]);
    expect(v.tier).toBe('affected');
    expect(v.reasons).toEqual([]);
  });
});

describe('forced FULL, each with its own reason', () => {
  it.each<[string, RegExp]>([
    ['lib/permissions.ts', /lib\//],
    ['lib/hr-date.ts', /lib\//],
    ['lib/ui/format.tsx', /lib\//],
    ['lib/README.md', /lib\//], // all of lib, even its docs
    ['core/leave-compute.ts', /core\//],
    ['packs/payroll/service.ts', /packs\//],
    ['localization/my/pcb.ts', /localization\//],
    ['db/schema.ts', /db\//],
    ['db/migrations/0500_x.sql', /migration/],
    ['db/migrations/meta/_journal.json', /migration/],
    ['app/payroll/actions.ts', /server action/],
    ['app/admin/x/y/actions.ts', /server action/],
    ['app/api/health/route.ts', /route handler/],
    ['middleware.ts', /middleware/],
    ['proxy.ts', /proxy/],
    ['scripts/gate-chunked.sh', /scripts\//],
    ['scripts/improve/release.ts', /scripts\//],
    ['package.json', /package\.json/],
    ['pnpm-lock.yaml', /lockfile/],
    ['next.config.ts', /next\.config/],
    ['public/forms/ea-2023.pdf', /public\/forms/],
    ['vitest.config.ts', /vitest config/],
    ['vitest.nodb.config.ts', /vitest config/],
    ['test/env.ts', /setup file/],
    ['test/global-setup.ts', /setup file/],
    ['deploy/deploy.sh', /deploy\//],
    ['app/payroll/run-screen.tsx', /allow-list/], // an app/ file that is not a page/layout/loading
    ['i18n/request.ts', /allow-list/],
    ['tsconfig.json', /allow-list/],
    ['messages/sub/en.json', /allow-list/], // messages/*.json is one level only
  ])('%s → FULL (%s)', (p, why) => {
    const v = verdict(p);
    expect(v.allowed).toBe(false);
    expect(reasonOf(p)).toMatch(why);
  });

  it("a components/ file containing 'use server' — at HEAD, at the base, or in the diff — is FULL", () => {
    expect(reasonOf('components/x.tsx', { headText: "'use server';\nexport async function a() {}" })).toMatch(/use server/);
    expect(reasonOf('components/x.tsx', { baseText: '"use server";', headText: 'export const a = 1' })).toMatch(/use server/);
    expect(reasonOf('components/x.tsx', { status: 'D', headText: null, baseText: "'use server'" })).toMatch(/use server/);
  });

  it('ONE non-presentational file makes the whole diff FULL, and every reason is listed', () => {
    const v = classifyChanges([change('components/a.tsx'), change('lib/x.ts'), change('core/y.ts')]);
    expect(v.tier).toBe('full');
    expect(v.reasons).toHaveLength(2);
    expect(v.reasons.join('\n')).toContain('lib/x.ts');
    expect(v.reasons.join('\n')).toContain('core/y.ts');
  });

  it('an empty diff is not "presentational" — there is nothing to have tested', () => {
    expect(classifyChanges([]).tier).toBe('full');
  });
});

describe('app/**/page.tsx, layout.tsx, loading.tsx: allowed only for a markup-only diff', () => {
  it.each(['app/payroll/page.tsx', 'app/layout.tsx', 'app/leave/[id]/loading.tsx'])('%s with a className edit is allowed', (p) => {
    expect(verdict(p, { diffLines: ['      <div className="flex gap-2">', '      <div className="flex gap-3">'] }).allowed).toBe(true);
  });

  it.each(PAGE_FORBIDDEN_TOKENS.map((t) => [t]))('a changed line containing %j forces FULL', (tok) => {
    const v = verdict('app/payroll/page.tsx', { diffLines: ['<div className="p-2">', `  x ${tok} y`] });
    expect(v.allowed).toBe(false);
    expect(reasonOf('app/payroll/page.tsx', { diffLines: [`  x ${tok} y`] })).toContain(JSON.stringify(tok));
  });

  it('a REMOVED line counts as much as an added one (the collector passes both)', () => {
    // e.g. deleting a permission check from a page is exactly the change that must not skip the gate
    expect(verdict('app/x/page.tsx', { diffLines: ["  if (!can(session, 'payroll.view')) redirect('/');"] }).allowed).toBe(false);
  });

  it('the token list is the one ADR-0094 records', () => {
    expect([...PAGE_FORBIDDEN_TOKENS]).toEqual([
      'await', 'import ', 'scoped', 'session', 'redirect(', 'notFound(', 'permission', 'sql', 'db.',
      'withTenant', "'use server'", '"use server"', 'fetch(', 'process.env', 'export async function',
      'export function', 'searchParams',
    ]);
  });
});

describe('TEST_SETUP_FILES covers every vitest setup file', () => {
  it('each setupFiles / globalSetup entry named by a vitest config is in the list', () => {
    const named = new Set<string>();
    for (const cfg of ['vitest.config.ts', 'vitest.browser.config.ts']) {
      const src = readFileSync(cfg, 'utf8');
      const block = [...src.matchAll(/(?:setupFiles|globalSetup)\s*:\s*\[([^\]]*)\]/g)];
      expect(block.length, `${cfg} names its setup files`).toBeGreaterThan(0);
      for (const m of block) for (const f of m[1].matchAll(/['"]\.\/([^'"]+)['"]/g)) named.add(f[1]);
    }
    expect(named.size).toBeGreaterThanOrEqual(3);
    for (const f of named) expect(TEST_SETUP_FILES as readonly string[], f).toContain(f);
  });
});
