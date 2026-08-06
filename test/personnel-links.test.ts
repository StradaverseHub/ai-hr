/**
 * People → Personnel split (rename + admin-only management).
 *
 * The module was renamed "People" → "Personnel" and split into a read-only employee directory
 * (`/personnel`) and an admin-only management surface (`/admin/personnel`). Every non-admin inbound
 * surface (dashboard headcount tile + onboarding link, org chart, leave approvals) must resolve to the
 * everyday `/personnel` route — NOT the admin
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
    // NB: app/payroll/transactions/fixed/page.tsx used to belong here (it listed employees with a
    // "manage" → /personnel link). Feedback b7fc8583 replaced it with a self-contained fixed-transaction
    // editor that picks an employee via a <select> — it has no inbound /personnel link by design, so it
    // is no longer an everyday personnel-link surface to guard.
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
    // c002b3c3 — THIS ASSERTION HAD STOPPED GUARDING AND STILL PASSED, which is the worst way for a
    // guard to fail. The detail page moved from requireAdmin() to scopedAdmin() (which CALLS requireAdmin,
    // so the posture is unchanged), and the old `includes('requireAdmin')` kept going green off three
    // COMMENTS that merely mention the name. Deleting the guard call outright would still have passed.
    //
    // Two changes, both load-bearing: comments are stripped before matching, so prose can never satisfy
    // it again; and either gate is accepted, matching test/function-access.test.ts's own GUARD_RE.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/.*$/gm, '');
    const guarded = (path: string) => /\b(requireAdmin|scopedAdmin)\s*\(/.test(stripComments(read(path)));
    expect(guarded('app/admin/personnel/page.tsx'), 'listing page is admin-gated').toBe(true);
    expect(guarded('app/admin/personnel/[employmentId]/page.tsx'), 'detail page is admin-gated').toBe(true);
  });

  it('the guard assertion above cannot be satisfied by a comment', () => {
    // Pins the fix itself: a file whose ONLY mention of the gate is prose must fail the check.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/.*$/gm, '');
    const commentOnly = `// this page is admin-only (requireAdmin), so no widening here.\nexport default function P() { return null; }`;
    expect(/\b(requireAdmin|scopedAdmin)\s*\(/.test(stripComments(commentOnly))).toBe(false);
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
