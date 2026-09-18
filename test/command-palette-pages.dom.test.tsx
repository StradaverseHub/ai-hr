/**
 * r306 — WHAT ⌘K IS ALLOWED TO OFFER.
 *
 * The palette's page list is `visibleNavRows` (components/sidebar.tsx) — the rail's own visibility
 * answer, not a second copy of it. That choice is the whole design, so what is pinned here is the
 * property it buys: the palette offers exactly what the menu offers, for the same viewer, and never a
 * dead link.
 *
 * WHY THAT MATTERS MORE THAN IT SOUNDS. A finder with its own idea of who may see what is a permission
 * system nobody audited: it would advertise a screen the rail hides, and the person would either land
 * on a refusal or, worse, learn the name of something they are not entitled to. Hiding a row was never
 * the control (ADR-0077 D3 puts that at the service boundary) — but a menu and a search box that
 * disagree is still a bug, and it is the same shape as the bell/queue drift r305 had just repaid.
 *
 * NOT ASSERTED, deliberately: that every offered page has a column in lib/permissions.ts SCREENS. It
 * does not — 11 of the rail's destinations (/me, /claims, /feedback, /assistant, /knowledge-base, the
 * five attendance self-service rows, /admin/scheduled-actions) are absent from that matrix because it
 * collapses routes by guard. Writing that assertion would have meant either a false claim or a
 * silently loosened one; "no dead destination" is the claim this file can honestly make.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { visibleNavRows } from '../components/sidebar';

const ADMIN = { isAdmin: true, canApprove: true, enabledModules: null } as const;
const EMPLOYEE = { isAdmin: false, canApprove: false, enabledModules: null } as const;
const MANAGER = { isAdmin: false, canApprove: true, enabledModules: null } as const;

const hrefs = (g: Parameters<typeof visibleNavRows>[0]) => visibleNavRows(g).map((r) => r.href);

describe('the palette offers what the rail offers', () => {
  it('an admin reaches admin screens and an employee does not', () => {
    expect(hrefs(ADMIN)).toContain('/admin/users');
    expect(hrefs(ADMIN)).toContain('/admin/organization');
    // The employee list is the self-service rail: no admin surface at any depth.
    const employee = hrefs(EMPLOYEE);
    expect(employee.filter((h) => h.startsWith('/admin'))).toEqual([]);
    expect(employee).not.toContain('/analytics');
    // …but the everyday rows are all there, including the ones that live in a manager-mixed group.
    expect(employee).toContain('/leave');
    expect(employee).toContain('/personnel');
    expect(employee).toContain('/');
  });

  it('a manager reaches the approvals queue; a plain employee does not', () => {
    // The row carries managerUp, which is the flag the rail ANDs with the module check.
    expect(hrefs(MANAGER)).toContain('/approvals');
    expect(hrefs(EMPLOYEE)).not.toContain('/approvals');
  });

  it('a module the tenant has not bought is not offered', () => {
    const withPayroll = hrefs({ isAdmin: true, canApprove: true, enabledModules: ['payroll', 'leave', 'attendance', 'claims', 'performance'] });
    const withoutPayroll = hrefs({ isAdmin: true, canApprove: true, enabledModules: ['leave', 'attendance', 'claims', 'performance'] });
    expect(withPayroll.some((h) => h.startsWith('/payroll'))).toBe(true);
    expect(withoutPayroll.some((h) => h.startsWith('/payroll'))).toBe(false);
    // Fewer rows overall, and never more: dropping a module cannot ADD a destination.
    expect(withoutPayroll.length).toBeLessThan(withPayroll.length);
  });

  it('a session with no entitlement snapshot is offered everything (nav fails open)', () => {
    // lib/nav-entitlements.ts: null means "no opinion". Fail-closed here would empty the menu of a
    // paying tenant during a resolver blip, while every page still worked.
    const noOpinion = hrefs({ isAdmin: true, canApprove: true, enabledModules: null });
    const empty = hrefs({ isAdmin: true, canApprove: true, enabledModules: [] });
    expect(noOpinion.length).toBeGreaterThan(empty.length);
  });

  it('every offered destination is a real page, so nothing dead is advertised', () => {
    const dead = hrefs(ADMIN)
      .map((h) => h.split('?')[0]!)
      .filter((p) => {
        const rel = p.replace(/^\//, '');
        return !existsSync(join(process.cwd(), 'app', rel, 'page.tsx'));
      });
    expect(dead, `these palette destinations have no page.tsx: ${dead.join(', ')}`).toEqual([]);
  });

  it('offers pages, never a flyout parent, and never the same href twice', () => {
    const rows = visibleNavRows(ADMIN);
    // A parent node is a disclosure, not a destination: every row must carry a usable href.
    for (const r of rows) expect(r.href.startsWith('/'), `bad href: ${r.href}`).toBe(true);
    expect(new Set(hrefs(ADMIN)).size).toBe(hrefs(ADMIN).length);
  });

  it('carries the section each page sits under, so results can be grouped', () => {
    const sections = new Set(visibleNavRows(ADMIN).map((r) => r.sectionLabelKey));
    // Every current group is labelled, so no row should come back section-less.
    expect(sections.has(null)).toBe(false);
    expect(sections.size).toBeGreaterThanOrEqual(3);
  });
});
