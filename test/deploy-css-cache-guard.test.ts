import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * atelier-css-fix (2026-10-20): the box's warm Turbopack cache shipped a stylesheet without a newly
 * imported CSS file. deploy/css-cache-guard.sh clears the cache when the CSS inputs changed. These run the
 * REAL script in a throwaway project directory and assert what it does to the cache, not its source text.
 */
const GUARD = resolve(__dirname, '../deploy/css-cache-guard.sh');
const DEPLOY = readFileSync(resolve(__dirname, '../deploy/deploy.sh'), 'utf8');
let dir: string;

const sh = (script: string) =>
  execFileSync('bash', ['-c', `set -euo pipefail; . '${GUARD}'; ${script}`], { cwd: dir, encoding: 'utf8' });
const cache = () => join(dir, '.next/cache/turbopack');
const warmCache = () => { mkdirSync(cache(), { recursive: true }); writeFileSync(join(cache(), 'blob'), 'x'); };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'css-guard-'));
  mkdirSync(join(dir, 'app/(app)'), { recursive: true });
  mkdirSync(join(dir, 'components/x'), { recursive: true });
  writeFileSync(join(dir, 'app/globals.css'), ':root { --a: 1; }\n');
  writeFileSync(join(dir, 'components/x/y.module.css'), '.y { color: red; }\n');
  writeFileSync(join(dir, 'app/(app)/layout.tsx'), "import './globals.css';\nexport default function L() { return null; }\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('deploy/css-cache-guard.sh', () => {
  it('a warm cache with no recorded CSS inputs is cleared (first deploy builds cold once)', () => {
    warmCache();
    expect(sh('aihr_css_cache_guard')).toContain('clearing the Turbopack cache');
    expect(existsSync(cache())).toBe(false);
  });

  it('after a recorded build, unchanged CSS keeps the cache', () => {
    warmCache();
    sh('aihr_css_cache_guard; aihr_css_cache_record');
    warmCache();
    expect(sh('aihr_css_cache_guard')).toContain('keeping the Turbopack cache');
    expect(existsSync(join(cache(), 'blob'))).toBe(true);
  });

  it.each([
    ['an edited CSS file', () => writeFileSync(join(dir, 'app/globals.css'), ':root { --a: 2; }\n')],
    ['a new CSS import in the layout', () =>
      writeFileSync(join(dir, 'app/(app)/layout.tsx'), "import './globals.css';\nimport './atelier.css';\nexport default function L() { return null; }\n")],
    ['a new CSS file', () => writeFileSync(join(dir, 'app/atelier.css'), '.a { color: blue; }\n')],
    ['an edited CSS module under components/', () => writeFileSync(join(dir, 'components/x/y.module.css'), '.y { color: green; }\n')],
  ])('%s clears the cache', (_label, change) => {
    warmCache();
    sh('aihr_css_cache_guard; aihr_css_cache_record');
    warmCache();
    change();
    expect(sh('aihr_css_cache_guard')).toContain('clearing the Turbopack cache');
    expect(existsSync(cache())).toBe(false);
  });

  it('the record step writes the hash only when called (deploy.sh calls it after a successful build)', () => {
    sh('aihr_css_cache_guard');
    expect(existsSync(join(dir, '.next/cache/aihr-css-inputs.sha256'))).toBe(false);
    sh('aihr_css_cache_guard; aihr_css_cache_record');
    expect(readFileSync(join(dir, '.next/cache/aihr-css-inputs.sha256'), 'utf8')).toMatch(/^[0-9a-f]{64}\n$/);
  });
});

describe('deploy.sh wiring', () => {
  it('guards before the build and records after it, before the build is marked built', () => {
    const guard = DEPLOY.indexOf('aihr_css_cache_guard');
    const build = DEPLOY.indexOf('pnpm build', guard);
    const record = DEPLOY.indexOf('aihr_css_cache_record');
    const built = DEPLOY.indexOf('dstate built');
    for (const i of [guard, build, record, built]) expect(i).toBeGreaterThan(-1);
    expect(DEPLOY.indexOf('. deploy/css-cache-guard.sh')).toBeLessThan(guard);
    expect(guard).toBeLessThan(build);
    expect(build).toBeLessThan(record);
    expect(record).toBeLessThan(built);
    // set -e: a failed build exits before the record, so the next deploy clears again.
    expect(DEPLOY).toMatch(/^set -euo pipefail$/m);
  });
});
