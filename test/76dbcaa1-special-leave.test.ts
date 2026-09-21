/**
 * 76dbcaa1 — Special Leave: one pooled entitlement, and the reasons that draw on it.
 *
 * ⚠️ MOST OF THIS ITEM WAS ALREADY BUILT, and the plan said so before it was approved. Measured on
 * production first: `leave_shared_group` already holds ONE group, "Special Leave", 10.00 days with a 3.00
 * per-application cap, and `leave_shared_group_member` already holds exactly the six types the ticket
 * lists (CGL, CPL, EXM, GD, NDL, STD). The pooled card on My Leave already existed (46afcc48). The engine
 * already enforces the shared ceiling. What was missing was a way IN to the reasons, and a picker that
 * did not read as seven unrelated entitlements.
 *
 * WHAT THIS FILE PINS
 *   1. the members are exposed with their IDS, from the same pass that builds the names, so the picker
 *      and the card can never disagree about who is in the pool;
 *   2. the picker groups a pooled type under its pool and still posts ONE leaveTypeId;
 *   3. the details screen is the employee's own, resolves through `myEmployment`, and 404s a group the
 *      viewer has none of rather than rendering an empty page that confirms the id exists;
 *   4. `?type=` is seeded, never trusted — an id the subject may not take falls back.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const DETAIL = 'app/leave/shared/[groupId]/page.tsx';
const FIELDS = 'components/leave-duration-fields.tsx';
const GROUP = 'core/leave-shared-group.ts';
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

describe('76dbcaa1 · the members carry their ids, from one pass', () => {
  it('members and memberNames are built from the SAME list', () => {
    const src = codeOnly(read(GROUP));
    expect(src).toContain('memberNames: mine.map(');
    expect(src).toContain('members: mine.map(');
    // Hidden members are in both: hiding a balance card is a presentation choice, never an entitlement
    // one, and a reason list that dropped half the pot would describe a different pot.
    expect(read(GROUP)).toContain('includeHidden: true');
  });
});

describe('76dbcaa1 · the picker groups a pooled type under its pool', () => {
  it('renders an optgroup per pool, and ungrouped types stay where they were', () => {
    const src = codeOnly(read(FIELDS));
    expect(src).toContain('<optgroup');
    expect(src, 'ungrouped types are rendered on their own').toContain('.filter((x) => !x.groupName)');
  });

  it('still posts ONE leaveTypeId — the grouping is a label, not a second control', () => {
    const src = codeOnly(read(FIELDS));
    expect((src.match(/name="leaveTypeId"/g) ?? []).length, 'exactly one posted field').toBe(1);
    expect(src, 'no second name for a group').not.toContain('name="sharedGroupId"');
  });

  /** A stale or hand-typed `?type=` must not preselect something the subject cannot take. */
  it('seeds the selection from defaultTypeId but falls back when it is not on offer', () => {
    const src = codeOnly(read(FIELDS));
    expect(src).toContain('types.some((t) => t.id === defaultTypeId)');
    expect(src).toContain('types[0]?.id');
  });
});

describe('76dbcaa1 · the details screen is the employee’s own', () => {
  it('resolves the signed-in employee and never takes one as a parameter', () => {
    const src = codeOnly(read(DETAIL));
    expect(src).toContain('myEmployment(s)');
    expect(src, 'no employee parameter — there is no on-behalf path here').not.toContain('employmentId:');
  });

  it('404s a group the viewer has none of, rather than rendering an empty screen', () => {
    const src = codeOnly(read(DETAIL));
    expect((src.match(/notFound\(\)/g) ?? []).length, 'missing employment AND missing group').toBe(2);
  });

  it('shows what is drawable with the ceiling as context — never the ceiling as the figure', () => {
    const src = codeOnly(read(DETAIL));
    expect(src, 'the big number is `available`').toContain('formatDays(group.available)');
    expect(src, 'the ceiling is a caption').toContain("t('ofLimit'");
  });

  it('each reason links into the EXISTING apply form, not a second write path', () => {
    const src = codeOnly(read(DETAIL));
    expect(src).toContain('href={`/leave?type=${m.id}`}');
    expect(src, 'the details screen submits nothing').not.toContain("'use server'");
    expect(src).not.toContain('<form');
  });

  it('is a guarded route with a column in the access grid', () => {
    expect(read('lib/permissions.ts')).toContain("'/leave/shared/[groupId]'");
  });
});

describe('76dbcaa1 · every string it renders exists in all six locales', () => {
  const keys = [...new Set([...codeOnly(read(DETAIL)).matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]))];

  it('found the keys to check', () => {
    expect(keys.length).toBeGreaterThan(4);
    expect(keys).toContain('reasonsHeading');
  });

  it.each(LOCALES)('%s resolves every one, plus the card’s View details', (loc) => {
    const bag = JSON.parse(read(`messages/${loc}.json`)).me.sharedLeaveGroups as Record<string, unknown>;
    for (const k of keys) expect(typeof bag[k], `${loc}: me.sharedLeaveGroups.${k}`).toBe('string');
    expect(typeof bag.viewDetails, `${loc}: viewDetails`).toBe('string');
  });
});
