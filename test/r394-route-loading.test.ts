/**
 * r394 — every page folder carries its own loading boundary (components/route-loading.tsx).
 *
 * Next 16 does not prefetch a dynamic route without `loading.tsx`, and a boundary covers only its own
 * segment, so a page folder without one brings back the frozen-click navigation measured on 2026-10-07.
 * A new page is caught here, not in production. The exceptions are full-screen pages outside the app
 * shell (no sidebar to keep, their own design): sign-in, invitation, password reset, the mobile preview.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const EXEMPT = [/^app\/login(\/|$)/, /^app\/invite(\/|$)/, /^app\/reset-password(\/|$)/, /^app\/mobile-preview(\/|$)/];

function pageDirs(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...pageDirs(rel));
    else if (e.name === 'page.tsx') out.push(dir);
  }
  return out;
}

describe('r394 · every page folder has a loading boundary', () => {
  const dirs = pageDirs('app');

  it('finds the app\'s pages (the sweep is not empty)', () => {
    expect(dirs.length).toBeGreaterThan(200);
    expect(dirs).toContain('app/leave');
    expect(dirs).toContain('app/leave/history');
  });

  it('each non-exempt page folder re-exports the shared RouteLoading shell', () => {
    const missing: string[] = [];
    const wrong: string[] = [];
    for (const d of dirs) {
      if (EXEMPT.some((r) => r.test(d))) continue;
      const f = path.join(ROOT, d, 'loading.tsx');
      if (!fs.existsSync(f)) { missing.push(d); continue; }
      if (!fs.readFileSync(f, 'utf8').includes("from '@/components/route-loading'")) wrong.push(d);
    }
    expect(missing, 'add `export { default } from \'@/components/route-loading\';` as loading.tsx').toEqual([]);
    expect(wrong).toEqual([]);
  });

  it('the exempt full-screen pages stay without the app-shell skeleton', () => {
    for (const d of dirs.filter((x) => EXEMPT.some((r) => r.test(x)))) {
      expect(fs.existsSync(path.join(ROOT, d, 'loading.tsx')), d).toBe(false);
    }
  });

  it('the shell is announced to assistive technology and honours reduced motion', () => {
    const src = fs.readFileSync(path.join(ROOT, 'components/route-loading.tsx'), 'utf8');
    expect(src).toContain('role="status"');
    expect(src).toContain("t('loading')");
    expect(src.match(/animate-pulse/g)?.length).toBe(src.match(/motion-reduce:animate-none/g)?.length);
  });
});
