/** c002b3c3 Personnel layout/wiring contracts: no database fixture is required. */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const LISTING = 'app/(app)/admin/personnel/page.tsx';
const PROFILE = 'app/(app)/admin/personnel/[employmentId]/page.tsx';
const ISLAND = 'app/(app)/admin/personnel/employee-switcher.tsx';

// ───────────────────────────── 3. layout + wiring (static source) ─────────────────────────────

describe('c002b3c3 · the module is full width, once, in one place', () => {
  it('both Personnel screens use the SAME container cap', () => {
    for (const f of [LISTING, PROFILE]) {
      const src = read(f);
      expect(src, `${f} should use the shared wide container`).toContain('mx-auto max-w-[100rem]');
    }
    // The two narrow caps this item was raised about are gone from these screens' root containers.
    expect(read(LISTING)).not.toContain('mx-auto max-w-5xl');
    expect(read(PROFILE)).not.toContain('mx-auto max-w-4xl');
  });

  it('the value is the one the codebase already uses for wide screens (not a fourth number)', () => {
    // If this ever fails, the fix is to converge — not to add another cap.
    //
    // 152fea7f REPOINTED THIS WITNESS. It used to name app/(app)/payroll/transactions/fixed/page.tsx, but the
    // whole Payroll module has since moved OFF `mx-auto max-w-[100rem]` and onto `pageWideCls` (true
    // full-browser width) — so that file is no longer evidence of anything about this cap. Leave Inquiry
    // is the witness now: it still carries the cap and test/leave-inquiry-layout.test.ts pins it there,
    // so the two guards fail together rather than one drifting silently past the other.
    expect(read('app/(app)/leave/page.tsx')).toContain('mx-auto max-w-[100rem]');
  });
});

describe('c002b3c3 · the switcher is mounted on both screens and stays an RSC-safe island', () => {
  it('the listing mounts it beside the Filter button, without replacing the filter', () => {
    const src = read(LISTING);
    expect(src).toContain('<EmployeeSwitcher');
    expect(src).toContain("from './employee-switcher'");
    // The filter panel is a different control answering a different question; both stay.
    expect(src).toContain('<FilterPanel');
    expect(src).toContain('dataTour="people-search"');
    // It searches the whole reachable set, narrowed by the active company context — not the page.
    expect(src).toContain('listWorkforcePickOptions(session, scopeIds)');
  });

  it('the profile mounts it and keeps the open tab across the jump', () => {
    const src = read(PROFILE);
    expect(src).toContain('<EmployeeSwitcher');
    expect(src).toContain("from '../employee-switcher'");
    expect(src).toContain('tab={tab ?? null}');
    // NO NEW READ: the switcher list is the already-loaded listEmployees set, narrowed by scope.
    expect(src).toContain('scopeIds.includes(e.companyId)');
    // …and the route's own guard is untouched: this is what refuses an out-of-scope id.
    expect(src).toContain("const emp = await employeeDetail(s,employmentId,'workforce');");
    expect(src).toContain('if(!emp)return <WorkforceScopedRecord');
  });

  it('a MALFORMED employmentId 404s instead of 500ing, and the shape check never replaces the scope check', () => {
    const src = read(PROFILE);
    // Reproduced on a dev server: `/admin/personnel/not-a-uuid` used to reach the query verbatim and
    // return a Postgres "invalid input syntax for type uuid" 500. A page whose new search box exists to
    // hand this route ids should answer "no such employee" for every id it cannot resolve, not crash
    // for one shape of them.
    expect(src).toContain('if (!UUID_RE.test(employmentId)) notFound();');
    // ORDER MATTERS: the shape check is a pre-filter, not the guard. `employeeDetail` must still run
    // for every well-formed id — that is what refuses one belonging to another company.
    expect(src.indexOf('UUID_RE.test(employmentId)')).toBeLessThan(src.indexOf('if(!isAdmin(s))return <WorkforceScopedRecord'));
    expect(src.indexOf('UUID_RE.test(employmentId)')).toBeLessThan(
      src.indexOf("const emp = await employeeDetail(s,employmentId,'workforce');"),
    );
  });

  it('the island is a client island whose props are plain data only', () => {
    const src = read(ISLAND);
    expect(src.startsWith("'use client'")).toBe(true);
    // r123: a function crossing the server→client boundary is a 500 that every green check misses.
    // The switcher navigates by URL instead, so there is no callback prop to pass.
    expect(src).not.toMatch(/on[A-Z]\w*\??:\s*\(/);
    expect(src).toContain('router.push(switcherHref(');
  });

  it('every user-visible string is a key, and the key exists in ALL six catalogs', () => {
    const src = read(ISLAND);
    const keys = [...src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'\)/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(5);
    for (const loc of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      const cat = JSON.parse(read(`messages/${loc}.json`));
      for (const k of keys) {
        const v = cat?.people?.switcher?.[k];
        expect(typeof v, `messages/${loc}.json people.switcher.${k}`).toBe('string');
        expect(v, `messages/${loc}.json people.switcher.${k}`).not.toBe('');
      }
    }
  });
});
