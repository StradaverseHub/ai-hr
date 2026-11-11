import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
// Installed server processes that load the HR service graph under `--conditions=react-server` resolve `react` to its
// server build, which has no createContext. A client-only module anywhere in such a graph (Lucide icons, a context
// provider) crashes the process at import, before it does any work. The combined release reached Lucide from
// packs/payroll/service.ts (payroll history job -> bulk-job kernel -> import graph -> core/admin.ts ->
// lib/leave-visual.ts) and broke the minute notification sweep and the operator probation runtime. This loads the
// exact module set each entry imports, under the same condition, without a database.
const root = new URL('..', import.meta.url).pathname;
function importsOf(script: string, dynamicOnly: boolean): string[] {
  const text = readFileSync(join(root, script), 'utf8');
  const pattern = dynamicOnly ? /import\('(\.\.?\/[^']+)'\)/g : /(?:from\s*|import\s*\(\s*)'(\.\.?\/[^']+)'/g;
  return [...text.matchAll(pattern)].map((match) => './' + relative(root, join(root, dirname(script), match[1])));
}
function loadUnderServerCondition(modules: readonly string[]) {
  const source = `for (const name of ${JSON.stringify(modules)}) await import(name + '.ts');`;
  return spawnSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: root, encoding: 'utf8', timeout: 90000,
    env: { ...process.env, DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/no_database' },
  });
}
it('loads every module the notification email sweep imports in its server-runtime child', () => {
  const modules = importsOf('scripts/notification-email-sweep.ts', true);
  expect(modules.length).toBeGreaterThanOrEqual(15);
  expect(modules).toContain('./packs/lifecycle/service');
  const result = loadUnderServerCondition(modules);
  expect(result.error).toBeUndefined(); expect(result.stderr).toBe(''); expect(result.status).toBe(0);
}, 120000);
it('loads every module the operator probation runtime imports under its required server runtime', () => {
  const modules = importsOf('scripts/operator/probation-runtime.ts', false);
  expect(modules).toEqual(expect.arrayContaining(['./packs/probation/service', './core/entitlements', './db/client', './lib/internal-auth/config']));
  const result = loadUnderServerCondition(modules);
  expect(result.error).toBeUndefined(); expect(result.stderr).toBe(''); expect(result.status).toBe(0);
}, 120000);
it('loads the payroll pack facade and the leave-type validation owner without reaching a client-only module', () => {
  const result = loadUnderServerCondition(['./packs/payroll/service', './core/admin']);
  expect(result.error).toBeUndefined(); expect(result.stderr).toBe(''); expect(result.status).toBe(0);
}, 120000);
it('keeps the server allow-lists free of dependencies and equal to the rendered palette and icon registry', async () => {
  const keys = readFileSync(join(root, 'lib/leave-visual-keys.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  expect(keys).not.toMatch(/\bimport\b|\brequire\(/);
  expect(readFileSync(join(root, 'core/admin.ts'), 'utf8')).toContain("from '@/lib/leave-visual-keys'");
  const visual = await import('../lib/leave-visual');
  expect(visual.LEAVE_COLOR_TOKENS).toEqual(Object.keys(visual.LEAVE_COLORS));
  expect(visual.LEAVE_ICON_KEYS).toEqual(Object.keys(visual.LEAVE_ICONS));
  for (const probe of ['toString', 'constructor', '__proto__', '', 'Blue']) {
    expect(visual.isLeaveColorToken(probe)).toBe(false); expect(visual.isLeaveIconKey(probe)).toBe(false);
  }
});
