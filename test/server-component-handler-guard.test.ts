/**
 * Server Component event-handler guard (feedback 978b2914).
 *
 * A React Server Component cannot pass a function prop (onChange / onClick / onSubmit / …) to the
 * client boundary — doing so throws "Event handlers cannot be passed to Client Component props." at
 * request time. This exact bug shipped on /analytics: app/analytics/page.tsx put an inline
 * `onChange` on a <select>, and because the page is searchParams-dynamic the build never rendered it,
 * so the crash only surfaced in production. The fix extracts the interactive control into a
 * 'use client' island (app/analytics/YearSelect.tsx).
 *
 * This guard sweeps every app/**\/page.tsx that is a Server Component (no top-of-file 'use client')
 * and fails if it contains a JSX event-handler attribute — catching the whole class of regression,
 * cheaply and DB-free (no DOM runner needed).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const APP = root + 'app';

function serverPages(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) serverPages(p, out);
    else if (e.name === 'page.tsx') {
      const src = readFileSync(p, 'utf8');
      // Only Server Components can violate the boundary; 'use client' pages are exempt.
      if (!/^\s*['"]use client['"]/m.test(src)) out.push(p.slice(root.length));
    }
  }
  return out;
}

// A JSX handler attribute: on<Capital>={ ... }. Excludes string-valued HTML attrs (none use on*="...").
const HANDLER_ATTR = /\son[A-Z][A-Za-z]*=\{/;

describe('Server Components pass no event-handler props (feedback 978b2914)', () => {
  const pages = serverPages(APP);

  it('finds server page.tsx files to check', () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  for (const page of pages) {
    it(`${page} has no JSX event handlers`, () => {
      const src = readFileSync(root + page, 'utf8');
      const offenders = src.split('\n').flatMap((line, i) => (HANDLER_ATTR.test(line) ? [`${page}:${i + 1}  ${line.trim()}`] : []));
      expect(offenders, `move interactive controls into a 'use client' island:\n${offenders.join('\n')}`).toEqual([]);
    });
  }

  it('the specific fix stands: /analytics uses the YearSelect client island', () => {
    const page = readFileSync(root + 'app/analytics/page.tsx', 'utf8');
    expect(page).toMatch(/import \{ YearSelect \} from '\.\/YearSelect'/);
    expect(page).not.toMatch(/onChange=/);
    const island = readFileSync(root + 'app/analytics/YearSelect.tsx', 'utf8');
    expect(island).toMatch(/^'use client'/);
    expect(island).toMatch(/requestSubmit/);
  });
});
