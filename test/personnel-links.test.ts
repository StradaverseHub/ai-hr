/**
 * People → Personnel split (rename + admin-only management).
 *
 * The module was renamed "People" → "Personnel" and split into a read-only employee directory
 * (`/personnel`) and an admin-only management surface (`/admin/personnel`). Every non-admin inbound
 * surface (dashboard headcount tile + onboarding link, org chart, leave approvals, the payroll
 * fixed-transactions "manage" link) must resolve to the everyday `/personnel` route — NOT the admin
 * route and NOT the retired `/people` route, or a normal employee/manager would be bounced. Audit-log
 * entity links, being an admin surface, resolve to `/admin/personnel`.
 *
 * This is a static-source guard (the previous investigation missed the two dashboard links); it fails
 * loudly if a future edit reintroduces a `/people` link or points an everyday inbound link at the admin
 * route. It is intentionally DB-free so it runs fast and deterministically.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { aggregateHref } from '../lib/audit-format';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

describe('People → Personnel: audit entity links point at the admin management route', () => {
  it('employee / employment audit links resolve to /admin/personnel/:id', () => {
    expect(aggregateHref('employee', 'abc')).toBe('/admin/personnel/abc');
    expect(aggregateHref('employment', 'abc')).toBe('/admin/personnel/abc');
  });
});

describe('People → Personnel: everyday inbound links resolve to /personnel (never /people, never /admin)', () => {
  const everyday: { file: string; label: string }[] = [
    { file: 'app/page.tsx', label: 'dashboard headcount tile + onboarding view-all' },
    { file: 'components/org-chart.tsx', label: 'org chart node link' },
    { file: 'app/approvals/page.tsx', label: 'leave approval requester links' },
    { file: 'app/payroll/transactions/fixed/page.tsx', label: 'payroll fixed-transactions manage link' },
  ];

  for (const { file, label } of everyday) {
    it(`${label} (${file}) has no retired /people link`, () => {
      const src = read(file);
      // No `/people` URL literal should survive (allow `/personnel`, but not `/people` or `/people/`).
      expect(/["'`]\/people(\/|["'`?])/.test(src)).toBe(false);
    });
    it(`${label} (${file}) links to /personnel and not to /admin/personnel`, () => {
      const src = read(file);
      expect(src.includes('/personnel')).toBe(true);
      expect(src.includes('/admin/personnel')).toBe(false);
    });
  }
});

describe('People → Personnel: routes exist where expected', () => {
  it('the read-only directory + detail live under /personnel', () => {
    expect(() => read('app/personnel/page.tsx')).not.toThrow();
    expect(() => read('app/personnel/[employmentId]/page.tsx')).not.toThrow();
  });

  it('the admin management surface lives under /admin/personnel and requires admin', () => {
    const listPage = read('app/admin/personnel/page.tsx');
    const detailPage = read('app/admin/personnel/[employmentId]/page.tsx');
    expect(listPage.includes('requireAdmin')).toBe(true);
    expect(detailPage.includes('requireAdmin')).toBe(true);
  });

  it('old /people URLs still resolve via redirect stubs', () => {
    const listStub = read('app/people/page.tsx');
    const detailStub = read('app/people/[employmentId]/page.tsx');
    expect(listStub.includes('/personnel')).toBe(true);
    expect(listStub.includes('redirect')).toBe(true);
    expect(detailStub.includes('/personnel/')).toBe(true);
    expect(detailStub.includes('redirect')).toBe(true);
  });
});
