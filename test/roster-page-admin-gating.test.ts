/**
 * 23390097 — WHO IS OFFERED THE THREE ADMIN TOOLS ON THE ROSTER SCREEN, measured on the RENDERED page.
 *
 * app/roster/page.tsx gates Upload Shift Roster, Download Template, Generate roster and Copy roster
 * behind `{admin && …}`, because all four end in a write to roster_assignment and its RLS requires
 * app.can_admin_employment. Offering them to a supervisor is offering a form that can only ever end in
 * a 42501.
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
import { RosterTemplateButton } from '../components/roster-grid';

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
async function renderAs(s: SessionContext): Promise<unknown> {
  SCOPE = { s, scopeIds: [b.companyId], allowedCount: 1 };
  return RosterPage({ searchParams: Promise.resolve({ month: MONTH }) } as any);
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
  it('Upload Shift Roster, Download Template, Generate roster and Copy roster are all on the page', async () => {
    const tree = await renderAs(admin);
    const labels = stringsIn(tree);

    expect(labels).toContain('uploadRoster');
    expect(labels).toContain('downloadTemplate');
    expect(hasTemplateButton(tree), 'the Download Template button itself, not just its label').toBe(true);

    expect(labels).toContain('generate');
    expect(labels).toContain('copyTitle');
    expect(formActions(tree)).toContain(generateRosterAction);
    expect(formActions(tree)).toContain(copyRosterAction);
  });
});

describe('…and offers a supervisor none of them', () => {
  it('the four admin affordances are absent from a supervisor’s page', async () => {
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
  });
});
