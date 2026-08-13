import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  describePayload,
  actionOf,
  aggregateHref,
  canOpenAggregate,
  moduleKeyOf,
  isHighImpactAction,
  MODULE_LABEL_EN,
} from '../lib/audit-format';

describe('4ec5a940 — audit-format before/after diff renderer', () => {
  it('renders only the changed keys as "old → new"', () => {
    const lines = describePayload({
      before: { annualDays: 12, carryForwardMax: 5, method: 'grant_on_hire_prorated' },
      after: { annualDays: 14, carryForwardMax: 5, method: 'grant_on_hire_prorated' },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ key: 'annualDays', value: '12 → 14', changed: true });
  });

  it('handles a null before (first-time upsert) — every after key is a change from —', () => {
    const lines = describePayload({ before: null, after: { enabled: true, levels: ['MANAGER', 'HR'] } });
    const byKey = Object.fromEntries(lines.map((l) => [l.key, l.value]));
    expect(byKey.enabled).toBe('— → true');
    expect(byKey.levels).toContain('→');
  });

  it('renders remaining flat keys (companyId, recalc) after the comparison', () => {
    const lines = describePayload({
      companyId: 'c1',
      before: { annualDays: 12 },
      after: { annualDays: 13 },
      recalc: { affected: 2, totalDelta: 4 },
    });
    const keys = lines.map((l) => l.key);
    expect(keys).toContain('annualDays');
    expect(keys).toContain('companyId');
    expect(keys).toContain('recalc');
    // the changed diff comes before the flat keys
    expect(keys.indexOf('annualDays')).toBeLessThan(keys.indexOf('companyId'));
  });

  it('masks a sensitive key even inside a before/after diff', () => {
    const lines = describePayload({ before: { basicSalary: 5000 }, after: { basicSalary: 6000 } });
    expect(lines[0].value).not.toContain('5000');
    expect(lines[0].value).not.toContain('6000');
    expect(lines[0].value).toContain('••••');
  });

  it('truncates a very long nested value', () => {
    const big = { note: 'x'.repeat(300) };
    const lines = describePayload({ before: {}, after: big });
    expect(lines[0].value.length).toBeLessThan(140);
    expect(lines[0].value).toContain('…');
  });

  it('a no-op before/after pair reports "changed: —" rather than blank', () => {
    const lines = describePayload({ before: { a: 1 }, after: { a: 1 } });
    expect(lines).toEqual([{ key: 'changed', value: '—' }]);
  });

  it('still supports the { diff } and { fields } conventions', () => {
    expect(describePayload({ diff: { name: { from: 'A', to: 'B' } } })[0]).toEqual({
      key: 'name',
      value: 'A → B',
      changed: true,
    });
    expect(describePayload({ fields: ['x', 'y'] })).toEqual([{ key: 'changed fields', value: 'x, y' }]);
  });
});

describe('4ec5a940 — actionOf classification', () => {
  it('maps the last dot-segment to a coarse action', () => {
    expect(actionOf('leave-type.created')).toBe('created');
    expect(actionOf('leave-policy.updated')).toBe('updated');
    expect(actionOf('leave-policy.deleted')).toBe('deleted');
    expect(actionOf('leave-type.archived')).toBe('archived');
    expect(actionOf('leave-type.unarchived')).toBe('unarchived');
    expect(actionOf('grade.superseded')).toBe('superseded');
    expect(actionOf('leave-grant.granted')).toBe('created');
    expect(actionOf('something.weird')).toBe('other');
  });

  it('flags irreversible / archival actions as high-impact', () => {
    expect(isHighImpactAction(actionOf('x.deleted'))).toBe(true);
    expect(isHighImpactAction(actionOf('x.archived'))).toBe(true);
    expect(isHighImpactAction(actionOf('x.updated'))).toBe(false);
  });
});

describe('4ec5a940 — moduleKeyOf', () => {
  it('maps aggregates to their bounded context', () => {
    expect(moduleKeyOf('leave-type')).toBe('leave');
    expect(moduleKeyOf('job-grade')).toBe('organization');
    expect(moduleKeyOf('payroll-batch')).toBe('payroll');
    expect(moduleKeyOf('attendance')).toBe('attendance');
    expect(moduleKeyOf('performance-review')).toBe('performance');
    expect(moduleKeyOf('totally-unknown')).toBe('other');
  });

  it('every module key has an English export label', () => {
    for (const k of ['leave', 'organization', 'payroll', 'attendance', 'performance', 'other'] as const) {
      expect(MODULE_LABEL_EN[k]).toBeTruthy();
    }
  });
});

/**
 * 47609f53 — the dashboard's Recent activity card offered every reader a link into the admin-only
 * Personnel screen, which redirects a non-admin straight back to the dashboard. `canOpenAggregate`
 * decides whether a row is OFFERED as a link; it grants nothing.
 *
 * AGGREGATE holds exactly four linkable types and their destinations are gated three different ways:
 *   /admin/personnel/{id}    scopedAdmin  (employee, employment)
 *   /payroll/{id}            requireAdmin (payroll-batch)
 *   /performance/{id}        requireAdmin (review-cycle)
 *   /performance/review/{id} getSession + RLS on can_see_employment (performance-review) — NOT admin
 * The last one is the one that ALREADY WORKS for a non-admin and must keep working: the feed is
 * filtered by domain_event_read, whose non-admin branch is that same can_see_employment predicate, so
 * a reader who can see the row can open the page. Un-linking it would be a regression, not a fix.
 */
describe('47609f53 — canOpenAggregate gates a Recent activity row on the reader', () => {
  const ADMIN_ONLY = ['employee', 'employment', 'payroll-batch', 'review-cycle'] as const;

  for (const type of ADMIN_ONLY) {
    it(`${type} → linked for an admin, plain text for everyone else`, () => {
      expect(canOpenAggregate(type, true)).toBe(true);
      expect(canOpenAggregate(type, false)).toBe(false);
    });
  }

  it('performance-review stays linked for a non-admin (its destination is not admin-gated)', () => {
    expect(canOpenAggregate('performance-review', false)).toBe(true);
    expect(canOpenAggregate('performance-review', true)).toBe(true);
  });

  it('a type with no destination is never openable, admin or not', () => {
    // The overwhelming majority of aggregates carry a label but no href — there is nothing to open,
    // so the answer must be false rather than "true, an admin may open <undefined>".
    for (const type of ['leave-request', 'attendance', 'payslip', 'totally-unknown']) {
      expect(aggregateHref(type, 'x')).toBeUndefined();
      expect(canOpenAggregate(type, true)).toBe(false);
      expect(canOpenAggregate(type, false)).toBe(false);
    }
  });

  it('every gate answer agrees with whether a href exists at all', () => {
    // Cannot-drift check: canOpenAggregate must never say true for a type aggregateHref won't resolve.
    for (const type of [...ADMIN_ONLY, 'performance-review', 'person', 'holiday']) {
      for (const isAdmin of [true, false]) {
        if (canOpenAggregate(type, isAdmin)) expect(aggregateHref(type, 'id1')).toBeTruthy();
      }
    }
  });
});

/**
 * The fix lives in the CONTRACT BETWEEN lib/audit-format.ts and app/page.tsx: the helper above can be
 * perfectly correct while the dashboard never calls it, and every unit test here would still pass
 * (AGENTS.md rule 17). These are source-shape assertions across the call site.
 *
 * NB app/page.tsx must not gain a `/admin/personnel` literal — test/personnel-links.test.ts asserts
 * that everyday inbound links there never point at the admin route. The href stays in AGGREGATE.
 */
describe('47609f53 — the dashboard Recent activity card actually applies the gate', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const src = readFileSync(root + 'app/page.tsx', 'utf8');
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/.*$/gm, '');
  const code = stripComments(src);

  it('imports canOpenAggregate and calls it (not merely mentions it in a comment)', () => {
    expect(code).toMatch(/\bcanOpenAggregate\b/);
    expect(code).toMatch(/canOpenAggregate\s*\(/);
  });

  it('the row href is computed through the gate, not from aggregateHref alone', () => {
    // The only aggregateHref call on this page must be reachable only via canOpenAggregate.
    const hrefCalls = code.match(/aggregateHref\s*\(/g) ?? [];
    expect(hrefCalls).toHaveLength(1);
    expect(code).toMatch(/canOpenAggregate\s*\([^)]*\)[\s\S]{0,120}?aggregateHref\s*\(/);
  });

  it('the "View all" link on the same card is still admin-gated', () => {
    // It already was; this pins that the row fix did not disturb it.
    expect(code).toMatch(/isAdmin\(s\)\s*&&[\s\S]{0,200}?\/admin\/audit/);
  });

  it('still renders the plain label when there is no href', () => {
    expect(code).toMatch(/aggregateLabel\s*\(/);
  });
});
