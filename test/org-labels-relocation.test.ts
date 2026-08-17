/**
 * Relocate the organisation-related Profile Options to Organization Labels (feedback c9986927).
 *
 * Division, Branch, Region, Line, Section, Team, Base and Category are organisation structure, not personal
 * profile data, so their maintenance screen moves off System Settings > System Labels > Profile Options and
 * onto the Organisation Labels tab beside Departments, Positions, Cost Centres and Business Units.
 *
 * This is a maintenance-SURFACE move, NOT a data merge: the eight stay in the flat tenant-wide
 * `profile_option` catalog and keep going through the same core mutations, so every value already stored on
 * an employment row keeps resolving and no migration runs. What this suite covers:
 *   1. The category split — the eight are exactly EMPLOYMENT_PROFILE_CATEGORIES, PERSON_PROFILE_CATEGORIES is
 *      the disjoint complement, and together they still cover the whole catalog (a future category cannot
 *      silently fall off both surfaces).
 *   2. Source guards for the relocation itself: the Profile Options tab renders only the person categories;
 *      the Organisation Labels page builds a rail slot per relocated category; the shared grid renders those
 *      slots and swaps the body for them — WITHOUT disturbing the Grades slot (b1b81a08) it sits beside.
 *   3. No functionality removed — create / edit / activate / deactivate / delete all still work on a
 *      relocated category through the very actions the Organisation Labels tab calls, and each still appends
 *      its DomainEvent.
 *   4. Nothing already saved changes — a value stored on employment before the move still validates, and the
 *      in-use delete guard still refuses to orphan it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The grid actions resolve getSession() and call revalidatePath(); redirect() throws in real Next.js, so the
// mock throws too (a value-returning action must never fall through into a second redirect).
let actionCtx: import('../db/client').SessionContext | null = null;
vi.mock('../lib/session', () => ({ getSession: vi.fn(async () => actionCtx) }));
vi.mock('next/navigation', () => ({
  redirect: (p: string): never => {
    throw new Error(`NEXT_REDIRECT:${p}`);
  },
  notFound: vi.fn(() => undefined),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));

import {
  removeProfileOptionAction,
  saveProfileOptionsAction,
} from '../app/admin/settings/system-labels/profile-options/actions';
import {
  EMPLOYMENT_PROFILE_CATEGORIES,
  PERSON_PROFILE_CATEGORIES,
  PROFILE_OPTION_CATEGORIES,
  ProfileOptionInUseError,
  createProfileOption,
  deleteProfileOption,
  listAllProfileOptions,
} from '../core/profile-options';
import { hireEmployee, setEmploymentInfo } from '../core/org';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');
const gridSrc = read('../components/system-labels-grid.tsx');
const optionsGridSrc = read('../components/profile-options-grid.tsx');
const orgPageSrc = read('../app/admin/settings/system-labels/page.tsx');
const profileTabSrc = read('../app/admin/settings/system-labels/profile-options/page.tsx');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const RELOCATED = ['division', 'branch', 'region', 'line', 'section', 'team', 'base', 'category'] as const;

let b: Base;
const ctx = () => adminCtx(b);

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  actionCtx = adminCtx(b);
});
afterAll(async () => {
  await closeAll();
});

describe('c9986927 · the split — eight organisation categories, the rest stay personal', () => {
  it('EMPLOYMENT_PROFILE_CATEGORIES is exactly the eight the reporter listed', () => {
    expect([...EMPLOYMENT_PROFILE_CATEGORIES].sort()).toEqual([...RELOCATED].sort());
  });

  it('PERSON_PROFILE_CATEGORIES is the disjoint complement, and together they cover the catalog', () => {
    for (const c of RELOCATED) expect(PERSON_PROFILE_CATEGORIES).not.toContain(c);
    // The genuine personal-profile lists stay put.
    for (const c of ['religion', 'race', 'nationality', 'state', 'country', 'relationship', 'salutation'] as const) {
      expect(PERSON_PROFILE_CATEGORIES).toContain(c);
    }
    // No category may fall off BOTH surfaces (or land on both) when one is added later.
    expect([...PERSON_PROFILE_CATEGORIES, ...EMPLOYMENT_PROFILE_CATEGORIES].sort()).toEqual(
      [...PROFILE_OPTION_CATEGORIES].sort(),
    );
  });
});

describe('c9986927 · the destination — a rail entry per relocated category on Organisation Labels', () => {
  it('the Organisation Labels page builds one slot per relocated category from the SAME catalog', () => {
    expect(orgPageSrc).toContain('EMPLOYMENT_PROFILE_CATEGORIES.map');
    expect(orgPageSrc).toContain('listAllProfileOptions(s, { activeOnly: false })');
    expect(orgPageSrc).toContain('optionSlots={optionSlots}');
    // The relocated lists are tenant-wide (like grades) and must NOT be narrowed by the company scope.
    expect(orgPageSrc.includes('inScope(profileOptions)')).toBe(false);
    // Same actions as the Profile Options tab ⇒ same core mutations, same DomainEvents, same guards.
    expect(orgPageSrc).toContain('saveProfileOptionsAction');
    expect(orgPageSrc).toContain('removeProfileOptionAction');
  });

  it('the shared grid renders the option rail entries and swaps the body for the selected one', () => {
    expect(gridSrc).toContain('optionSlots?: { key: string; label: string; count: number; body: ReactNode }[]');
    expect(gridSrc).toContain('setOptionKey(slot.key)');
    expect(gridSrc).toContain('optionSlots.find((s) => s.key === optionKey)?.body');
    // The rail selections are mutually exclusive — a kind, Grades or Grade Groups click clears the option
    // body. 9a65f808 added the FOURTH selection (Grade Groups) and this expression grew with it rather
    // than being loosened: the property being guarded is that a kind click clears EVERY other selection,
    // and a substring check that stopped naming them all would pass on a rail showing two bodies at once.
    expect(gridSrc).toContain('!showGrades && !showGradeGroups && optionKey === null && kind === k');
    expect(gridSrc).toContain('setShowGradeGroups(false)');
  });

  it('the Grades slot beside it is untouched (over-deletion guard on b1b81a08)', () => {
    expect(gridSrc).toContain('gradesSlot?: ReactNode');
    expect(gridSrc).toContain('{showGrades && gradesSlot !== undefined ? (');
    expect(gridSrc).toContain("t('category.grade')");
    expect(orgPageSrc).toContain('gradesSlot={gradesSlot}');
  });

  it('the embedded editor hides only its own rail — every control it carries is unchanged', () => {
    expect(optionsGridSrc).toContain('hideRail = false');
    expect(optionsGridSrc).toContain('{!hideRail && (');
    // The capabilities the reporter requires be preserved are all still rendered by the one editor.
    for (const control of ["t('addRow')", "t('saveAll')", "t('delete')", "t('activate')", "t('deactivate')"]) {
      expect(optionsGridSrc, `${control} still rendered`).toContain(control);
    }
  });

  it('the relocated categories keep their existing labels, present in all six locales', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`../messages/${loc}.json`));
      for (const c of RELOCATED) {
        const label = msgs?.admin?.profileOptions?.category?.[c];
        expect(typeof label, `${loc}.admin.profileOptions.category.${c}`).toBe('string');
        expect((label as string).length).toBeGreaterThan(0);
      }
    }
  });
});

describe('c9986927 · the origin — the eight are gone from Profile Options', () => {
  it('the Profile Options tab renders only the person categories', () => {
    expect(profileTabSrc).toContain('categories={[...PERSON_PROFILE_CATEGORIES]}');
    expect(profileTabSrc.includes('PROFILE_OPTION_CATEGORIES')).toBe(false);
    // The empty-state seed offer must count only what this tab still shows, or a tenant holding nothing but
    // org values would see an empty grid with no way to seed the personal-profile defaults.
    expect(profileTabSrc).toContain('PERSON_PROFILE_CATEGORIES.reduce');
  });
});

describe('c9986927 · no functionality removed on a relocated category', () => {
  it('create / edit / deactivate all still run through the Organisation Labels tab actions', async () => {
    const value = `Div ${randomUUID().slice(0, 5)}`;
    const created = await saveProfileOptionsAction({
      creates: [{ key: 'd1', category: 'division', value, label: value, description: 'Northern arm', sortOrder: 2 }],
      updates: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('unreachable');
    const id = created.createdIds[0].id;

    const edited = await saveProfileOptionsAction({
      creates: [],
      updates: [{ key: id, id, label: 'Northern Division', description: '', sortOrder: 5, setActive: false }],
    });
    expect(edited.ok).toBe(true);

    const all = await listAllProfileOptions(ctx(), { activeOnly: false });
    const row = all.division.find((o) => o.id === id)!;
    expect(row.label).toBe('Northern Division');
    expect(row.description).toBeNull();
    expect(row.sortOrder).toBe(5);
    expect(row.isActive).toBe(false);
    // `value` is the contract with stored employment data — the move must not have made it editable.
    expect(row.value).toBe(value);

    const types = await eventTypesFor(b.tenantId, id);
    expect(types).toEqual(
      expect.arrayContaining(['profile-option.created', 'profile-option.updated', 'profile-option.deactivated']),
    );
  });

  it('delete still works on an unused relocated value and appends its event', async () => {
    const opt = await createProfileOption(ctx(), { category: 'base', value: `Base ${randomUUID().slice(0, 5)}` });
    const res = await removeProfileOptionAction(opt.id);
    expect(res.ok).toBe(true);
    const all = await listAllProfileOptions(ctx(), { activeOnly: false });
    expect(all.base.some((o) => o.id === opt.id)).toBe(false);
    expect(await eventTypesFor(b.tenantId, opt.id)).toContain('profile-option.deleted');
  });
});

describe('c9986927 · nothing already saved changes', () => {
  it('a value stored on employment before the move still validates and cannot be deleted away', async () => {
    const hire = await hireEmployee(ctx(), {
      person: { fullName: 'Relocation Check', primaryEmail: `reloc_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      positionId: b.positionId,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const value = `Team ${randomUUID().slice(0, 5)}`;
    const opt = await createProfileOption(ctx(), { category: 'team', value });
    await setEmploymentInfo(ctx(), { employmentId: hire.employmentId, orgTeam: value });

    const [emp] = await owner.db
      .select({ orgTeam: schema.employment.orgTeam })
      .from(schema.employment)
      .where(eq(schema.employment.id, hire.employmentId))
      .limit(1);
    expect(emp.orgTeam).toBe(value);

    // Re-saving the unchanged stored value is still tolerated (the legacy-value rule the catalog was built on).
    await expect(
      setEmploymentInfo(ctx(), { employmentId: hire.employmentId, orgTeam: value }),
    ).resolves.toBeTruthy();

    // And the in-use guard still refuses to orphan it — from the relocated surface's own delete action too.
    await expect(deleteProfileOption(ctx(), opt.id)).rejects.toBeInstanceOf(ProfileOptionInUseError);
    const refused = await removeProfileOptionAction(opt.id);
    expect(refused.ok).toBe(false);
  });
});
