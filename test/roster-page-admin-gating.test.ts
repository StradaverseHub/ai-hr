/**
 * 23390097 — WHO IS OFFERED THE ADMIN AFFORDANCES ON THE ROSTER SCREEN, measured on the RENDERED page.
 *
 * app/roster/page.tsx gates Upload Shift Roster, Download Template, Generate roster and Copy roster
 * behind `{admin && …}`, because all four end in a write to roster_assignment and its RLS requires
 * app.can_admin_employment. Offering them to a supervisor is offering a form that can only ever end in
 * a 42501.
 *
 * 2ec1e3d2 adds a FIFTH, of a different kind: the "Manage shift schedules" link. It writes nothing, but
 * it points at /admin/attendance, which calls requireAdmin and bounces a supervisor back to '/' with no
 * message — a door that will not open. The gate is the same `{admin && …}`, and the assertions for it
 * sit in the same three blocks below. Its SENTENCE (manageShiftsHint) deliberately stays for everybody:
 * a supervisor who cannot open the screen still benefits from knowing where the setting lives. That is
 * pinned in the third block, and it is the assertion that stops a later tidy-up deleting the whole line.
 *
 * NOTHING TESTED THAT. page.tsx is a server component and no test rendered it, so `{admin && …}` could
 * become `{true && …}` — the whole gate deleted — and the suite stayed green. A source grep would not
 * have been much better: it pins the spelling of a line rather than what a supervisor is shown.
 *
 * So this renders the real page, twice, against the real database — once as an HR administrator and once
 * as a supervisor — and reads the tree. The supervisor block also asserts what the supervisor DOES get
 * (the screen, its Export link, the company), because "absent" is trivially true of a page that failed to
 * render at all, and that false green is the one this file must not produce.
 *
 * Precedent for the shape: test/tp1-scope-guard.test.ts, which renders a guarded server page the same way.
 * Server-side refusal for the ACTIONS behind these buttons is test/roster-write-guard.test.ts — a hidden
 * button is not a guard, and neither file substitutes for the other.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { createShift } from '../core/roster';

let SCOPE: { s: SessionContext; scopeIds: string[]; allowedCount: number };
vi.mock('@/lib/scope', () => ({ scopedSession: async () => SCOPE }));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (k: string) => k,
  getLocale: async () => 'en',
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('next/navigation', () => ({ redirect: () => { throw new Error('NEXT_REDIRECT'); } }));
vi.mock('@/lib/session', () => ({ getSession: async () => SCOPE.s }));

import RosterPage from '../app/roster/page';
import { copyRosterAction, generateRosterAction } from '../app/roster/actions';
import { RosterGrid, RosterTemplateButton } from '../components/roster-grid';
import { ROSTER_MAX_RANGE_DAYS } from '../lib/roster-month';

/** The company seedBase creates — printed by the page when there is only one to choose from. */
const COMPANY = 'Acme Sdn Bhd';
const MONTH = '2026-08';

let b: Base;
let admin: SessionContext;
let supervisor: SessionContext;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  admin = adminCtx(b);
  // A REAL non-admin session — same tenant, same user, a role that is not hr_admin / super_admin.
  supervisor = { ...admin, roles: ['manager'] };
  await hireEmployee(admin, {
    person: { fullName: 'Ahmad Zulkifli', primaryEmail: `az_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
    employeeCode: 'A0001',
  });
  await createShift(admin, {
    companyId: b.companyId,
    name: 'Morning full',
    code: 'MB28',
    startTime: '08:00:00',
    endTime: '17:00:00',
    weeklyPattern: [1, 2, 3, 4, 5],
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Render the roster screen as `s`. Translations are mocked to return their KEY, so a label below is the
 *  message key the page asked for — which is what makes an exact-match assertion possible. */
async function renderAs(s: SessionContext, sp: Record<string, string> = {}): Promise<unknown> {
  SCOPE = { s, scopeIds: [b.companyId], allowedCount: 1 };
  return RosterPage({ searchParams: Promise.resolve({ month: MONTH, ...sp }) } as any);
}

/** Every React element in a rendered tree, descending through element-valued props as well as children. */
function elementsIn(node: unknown, acc: any[] = [], seen = new Set<unknown>()): any[] {
  if (!node || typeof node !== 'object' || seen.has(node)) return acc;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const n of node) elementsIn(n, acc, seen);
    return acc;
  }
  const el = node as any;
  if (el.type !== undefined) acc.push(el);
  for (const v of Object.values(el.props ?? {})) if (v && typeof v === 'object') elementsIn(v, acc, seen);
  return acc;
}

/** Every STRING anywhere in the tree — children AND string-valued props, because a label reaches a
 *  component as a prop (RosterTemplateButton's `label`, SectionHeader's `title`) far more often than as
 *  a text child. Returned as an ARRAY so `toContain` is an EXACT match: `t('generate')` must not be
 *  satisfied by `t('generateHint')`. */
function stringsIn(tree: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const visit = (n: unknown): void => {
    if (typeof n === 'string') {
      out.push(n);
      return;
    }
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    for (const v of Object.values(n as Record<string, unknown>)) visit(v);
  };
  visit(tree);
  return out;
}

/** The server action a `<form action={…}>` in the tree is bound to — the least forgeable evidence that
 *  the Generate / Copy cards are really on the page, since their labels are only message keys. */
const formActions = (tree: unknown): unknown[] =>
  elementsIn(tree)
    .filter((el) => el.type === 'form' && typeof el.props?.action === 'function')
    .map((el) => el.props.action);

const hasTemplateButton = (tree: unknown): boolean => elementsIn(tree).some((el) => el.type === RosterTemplateButton);

describe('the roster screen offers its write tools to an HR administrator', () => {
  /**
   * a57f0584 (r322) — UPDATED, NOT LOOSENED: this now renders WITH a company chosen.
   *
   * Roster used to pick `companies[0]` whenever none was asked for, so "no companyId" and "one company"
   * were the same render and this case never had to say which it meant. The screen now opens on EVERY
   * authorised company, and Generate / Copy / Upload each write roster_assignment for a NAMED company, so
   * they are offered once one is chosen. The property this file exists for — an administrator gets these
   * five and a supervisor gets none — is unchanged and still asserted; the case below pins the new state.
   */
  it('Upload, Download Template, Generate, Copy and Manage shift schedules are all on the page', async () => {
    const tree = await renderAs(admin, { companyId: b.companyId });
    const labels = stringsIn(tree);

    expect(labels).toContain('uploadRoster');
    expect(labels).toContain('downloadTemplate');
    expect(hasTemplateButton(tree), 'the Download Template button itself, not just its label').toBe(true);

    expect(labels).toContain('generate');
    expect(labels).toContain('copyTitle');
    expect(formActions(tree)).toContain(generateRosterAction);
    expect(formActions(tree)).toContain(copyRosterAction);

    // 2ec1e3d2 — the link stays exactly where it was for the people it actually opens for.
    expect(labels).toContain('manageShiftsLink');
  });
});

describe('a57f0584 · the all-companies view is read-only, and says why', () => {
  /**
   * The cross-company roster is a READ. Both write tools take a companyId, and `copyRosterAction` posts
   * every employee on screen as hidden employmentIds — across twelve companies that is a bulk write
   * nobody asked for. Withdrawing the affordance (rather than rendering a form with an empty hidden
   * field, which would post '' and fail inside the action) is what makes the widening safe without
   * paginating the grid: the writable view still holds exactly the rows it held before.
   */
  it('an administrator viewing every company gets the tools withheld, with a reason on screen', async () => {
    const labels = stringsIn(await renderAs(admin));
    expect(labels, 'the forms are gone').not.toContain('generate');
    expect(labels).not.toContain('copyTitle');
    expect(labels, 'and the upload with them').not.toContain('uploadRoster');
    expect(labels, 'but the screen SAYS so rather than going quiet').toContain('pickCompanyToEdit');
  });

  it('and the roster itself still rendered — the read is what this view is for', async () => {
    const labels = stringsIn(await renderAs(admin));
    // NOT the company switcher: it renders only when there is more than one company to switch BETWEEN,
    // and this harness seeds one. Its all-companies option is pinned on the source in
    // test/a57f0584-roster-all-companies.test.ts, where a second company exists to make it meaningful.
    expect(labels, 'the read is unaffected by withholding the write tools').toContain('exportLabel');
    expect(labels).toContain('filterBusinessGroup');
  });
});

describe('…and offers a supervisor none of them', () => {
  it('the five admin affordances are absent from a supervisor’s page', async () => {
    const tree = await renderAs(supervisor);
    const labels = stringsIn(tree);

    // Upload — /roster/import calls requireAdmin, so the link could only ever bounce them.
    expect(labels).not.toContain('uploadRoster');
    // Download Template — a file a supervisor could never send back up.
    expect(labels).not.toContain('downloadTemplate');
    expect(hasTemplateButton(tree)).toBe(false);
    // Generate and Copy — forms whose only possible outcome for this session is a refused write.
    expect(labels).not.toContain('generate');
    expect(labels).not.toContain('copyTitle');
    expect(formActions(tree)).not.toContain(generateRosterAction);
    expect(formActions(tree)).not.toContain(copyRosterAction);
    // 2ec1e3d2 — Manage shift schedules: /admin/attendance is requireAdmin, so following it can only
    // ever bounce this session back to '/' with nothing said. Not a write, but the same broken promise.
    expect(labels).not.toContain('manageShiftsLink');
  });

  it('but the page RENDERED — otherwise every assertion above is a false green', async () => {
    const tree = await renderAs(supervisor);
    const labels = stringsIn(tree);

    // The screen itself, its heading, and the company it is showing.
    expect(labels).toContain('title');
    expect(labels).toContain('monthlyRoster');
    expect(labels).toContain(COMPANY);
    // Export stays open: reading the month is exactly what a supervisor is here to do.
    expect(labels).toContain('exportLabel');
    // …and the filter row, which is the other half of the screen the reporter asked for.
    expect(labels).toContain('filterDepartment');
    expect(labels).toContain('query');
    // 2ec1e3d2 — the SENTENCE survives the link being gated. This is the substance of the option chosen
    // there: hide the door, keep the directions. Without this assertion a later tidy-up could delete the
    // whole card and the "not.toContain('manageShiftsLink')" above would stay trivially green.
    expect(labels).toContain('manageShiftsHint');
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * a57f0584 rev 2 — THE THREE VIEWS, ON THE RENDERED PAGE.
 *
 * The window arithmetic is pinned in test/a57f0584-roster-views.test.ts. What only a RENDER can show is
 * that the screen actually offers all three, that the control belonging to each view is the one on
 * screen, and — the case that matters most — that the dates drawn are the WINDOW'S dates. A resolver
 * that is correct and a page that ignores it look identical to a unit test.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

/** The GridDate[] the page handed the grid — the columns a reader would actually see. */
const gridDatesOf = (tree: unknown): string[] => {
  const grid = elementsIn(tree).find((el: any) => el.type === RosterGrid);
  return ((grid?.props?.dates ?? []) as { iso: string }[]).map((d) => d.iso);
};
/** Every href anywhere in the tree — Export, Exceptions, the view switcher and the steppers. */
const hrefsIn = (tree: unknown): string[] =>
  elementsIn(tree)
    .map((el: any) => el?.props?.href)
    .filter((h: unknown): h is string => typeof h === 'string');

describe('a57f0584 rev 2 · Month, Week and a Custom range', () => {
  it('offers all three views, with the one on screen marked as current', async () => {
    const tree = await renderAs(admin);
    const labels = stringsIn(tree);
    for (const k of ['viewLabel', 'viewMonth', 'viewWeek', 'viewCustom']) expect(labels, k).toContain(k);
    const current = elementsIn(tree).filter((el: any) => el?.props?.['aria-current'] === 'page');
    expect(current, 'exactly one view is current').toHaveLength(1);
  });

  it('the MONTH view draws the whole month and offers the month picker', async () => {
    const tree = await renderAs(admin, { view: 'month', month: MONTH });
    expect(gridDatesOf(tree)).toHaveLength(31);
    expect(gridDatesOf(tree)[0]).toBe('2026-08-01');
    const labels = stringsIn(tree);
    expect(labels, 'the month picker').toContain('filterMonth');
    expect(labels, 'and not the range fields').not.toContain('filterFrom');
    expect(labels).not.toContain('filterWeekOf');
  });

  /** SEVEN COLUMNS, Monday to Sunday, snapped from a Wednesday — the property a month view cannot fake. */
  it('the WEEK view draws seven days snapped to the Monday, and swaps in its own control', async () => {
    const tree = await renderAs(admin, { view: 'week', from: '2026-08-12' });
    expect(gridDatesOf(tree)).toEqual([
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
      '2026-08-15',
      '2026-08-16',
    ]);
    const labels = stringsIn(tree);
    expect(labels).toContain('filterWeekOf');
    expect(labels, 'the month picker is gone rather than sitting there inert').not.toContain('filterMonth');
    expect(labels).not.toContain('filterFrom');
  });

  it('the CUSTOM view draws exactly the range asked for, with From and To', async () => {
    const tree = await renderAs(admin, { view: 'custom', from: '2026-08-03', to: '2026-08-16' });
    const dates = gridDatesOf(tree);
    expect(dates).toHaveLength(14);
    expect([dates[0], dates[dates.length - 1]], 'both ends of the window are drawn').toEqual(['2026-08-03', '2026-08-16']);
    const labels = stringsIn(tree);
    expect(labels).toContain('filterFrom');
    expect(labels).toContain('filterTo');
    expect(labels).not.toContain('filterMonth');
  });

  /**
   * THE CAP, AS THE OPERATOR MEETS IT: the screen still renders, it shows the capped window starting at
   * the From that was typed, and it SAYS what it did. A roster that failed to draw because somebody put
   * 2027 in the To box would be a worse bug than the one this prevents.
   */
  it('a range wider than the cap renders clamped, and the screen says so', async () => {
    const tree = await renderAs(admin, { view: 'custom', from: '2026-03-01', to: '2026-12-31' });
    const dates = gridDatesOf(tree);
    expect(dates.length, 'clamped to the cap').toBe(ROSTER_MAX_RANGE_DAYS);
    expect(dates[0], 'and it honours the From that was typed').toBe('2026-03-01');
    expect(stringsIn(tree), 'the notice names what happened').toContain('rangeTooWide');
  });

  it('a backwards range renders the From date alone, and says so', async () => {
    const tree = await renderAs(admin, { view: 'custom', from: '2026-08-20', to: '2026-08-01' });
    expect(gridDatesOf(tree)).toEqual(['2026-08-20']);
    expect(stringsIn(tree)).toContain('rangeBackwards');
  });

  /** EVERY WAY OFF THE SCREEN CARRIES THE WINDOW, or Export on a week silently downloads a month. */
  it('Export, Exceptions and each row Edit all carry the window on screen', async () => {
    const tree = await renderAs(admin, { view: 'week', from: '2026-08-12' });
    const hrefs = hrefsIn(tree);
    const exportHref = hrefs.find((h) => h.startsWith('/roster/export'));
    const exceptionsHref = hrefs.find((h) => h.startsWith('/roster/exceptions'));
    for (const [name, href] of [['export', exportHref], ['exceptions', exceptionsHref]] as const) {
      expect(href, `${name} link exists`).toBeDefined();
      expect(href, `${name} carries the view`).toContain('view=week');
      expect(href, `${name} carries the window`).toContain('from=2026-08-10');
      expect(href).toContain('to=2026-08-16');
    }
    const grid = elementsIn(tree).find((el: any) => el.type === RosterGrid);
    expect(grid?.props?.editQuery, 'and the grid builds its Edit links from the same string').toContain('view=week');
    expect(grid?.props?.editQuery).toContain('from=2026-08-10');
  });

  /** A LINK WRITTEN BEFORE THIS ROUND carried `month=` alone. It must still mean the month view. */
  it('an old month-only link still resolves to the month view', async () => {
    const tree = await renderAs(admin, { month: '2026-08' });
    expect(gridDatesOf(tree)).toHaveLength(31);
    expect(stringsIn(tree)).toContain('filterMonth');
  });
});
