/**
 * Customizable employee dashboard layout (feedback 7d9d145d). The old dashboard and its customizer were retired on
 * 12 Nov 2026 (owner decision); the stored envelope survives as My Home's own-row preference owner, so this file now
 * pins the pure envelope helpers and My Home's persistence through the same seam, including that the retired
 * manager and HR-admin slots are kept, never erased.
 *
 * Covers the expected_function points that are testable off the UI:
 *  - default order renders when no layout is saved (null → DEFAULT_ORDER)
 *  - saving an order persists and reloads on the next read
 *  - Reset to Default clears the saved layout back to null
 *  - one employee's layout is independent of another's (own-row-only SECURITY DEFINER write seam)
 *  - the pure normaliser repairs partial / unknown / duplicate stored orders (forward-compatible)
 *  - the layout write appends NO domain event (deliberate substrate carve-out — cosmetic UI pref)
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import {
  getEmployeeHomePreferences,
  getEmployeeHomeDisplayPreferences,
  setEmployeeHomePreferences,
  resetEmployeeHomePreferences,
} from '../core/dashboard-prefs';
import {
  DEFAULT_ORDER,
  extractRoleLayout,
  isDefaultOrder,
  mergeRoleLayout,
  normalizeDashboardOrder,
  removeRoleLayout,
} from '../lib/dashboard-layout';

import { closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

/** A fresh employee login identity (app_user + employee role), no person needed. */
async function newEmployeeCtx(): Promise<SessionContext> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: b.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { tenantId: b.tenantId, userId: u.id, roles: ['employee'] };
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('dashboard-layout pure helpers', () => {
  it('DEFAULT_ORDER contains every block exactly once and is the default', () => {
    expect(new Set(DEFAULT_ORDER).size).toBe(DEFAULT_ORDER.length);
    expect(isDefaultOrder([...DEFAULT_ORDER])).toBe(true);
  });

  it('normalizes non-array / empty input to the default order', () => {
    expect(normalizeDashboardOrder(null)).toEqual([...DEFAULT_ORDER]);
    expect(normalizeDashboardOrder(undefined)).toEqual([...DEFAULT_ORDER]);
    expect(normalizeDashboardOrder('nope')).toEqual([...DEFAULT_ORDER]);
    expect(normalizeDashboardOrder([])).toEqual([...DEFAULT_ORDER]);
  });

  it('keeps a valid custom order and appends any missing blocks (forward-compatible)', () => {
    const partial = ['recentActivity', 'plannedAbsences'];
    const out = normalizeDashboardOrder(partial);
    expect(out.slice(0, 2)).toEqual(['recentActivity', 'plannedAbsences']);
    // every default block present exactly once
    expect(new Set(out)).toEqual(new Set(DEFAULT_ORDER));
    expect(out.length).toBe(DEFAULT_ORDER.length);
    expect(isDefaultOrder(out)).toBe(false);
  });

  it('drops unknown ids and de-duplicates', () => {
    const messy = ['cards', 'cards', 'bogus', 42, 'recentActivity'];
    const out = normalizeDashboardOrder(messy);
    expect(out.filter((x) => x === 'cards').length).toBe(1);
    expect(out).not.toContain('bogus');
    expect(new Set(out)).toEqual(new Set(DEFAULT_ORDER));
  });
});

describe('per-role layout envelope (pure, 9606c59f)', () => {
  const emp = { selected: ['leaveBalance'], order: ['leaveBalance'] };
  const mgr = { selected: ['teamAwayToday'], order: ['teamAwayToday'] };

  it('a LEGACY flat value is the employee slot; every other role reads "nothing saved"', () => {
    expect(extractRoleLayout(['recentActivity', 'cards'], 'employee')).toEqual(['recentActivity', 'cards']);
    expect(extractRoleLayout(['recentActivity', 'cards'], 'manager')).toBeNull();
    expect(extractRoleLayout(emp, 'employee')).toEqual(emp);
    expect(extractRoleLayout(emp, 'hr_admin')).toBeNull();
    expect(extractRoleLayout(null, 'employee')).toBeNull();
  });

  it('a role-keyed envelope yields each slot independently', () => {
    const raw = { employee: emp, manager: mgr };
    expect(extractRoleLayout(raw, 'employee')).toEqual(emp);
    expect(extractRoleLayout(raw, 'manager')).toEqual(mgr);
    expect(extractRoleLayout(raw, 'hr_admin')).toBeNull();
  });

  it('mergeRoleLayout replaces one slot and preserves the others; a legacy flat migrates to employee', () => {
    expect(mergeRoleLayout({ employee: emp }, 'manager', mgr)).toEqual({ employee: emp, manager: mgr });
    // legacy flat + a manager save → the flat value becomes the employee slot, nothing lost
    expect(mergeRoleLayout(emp, 'manager', mgr)).toEqual({ employee: emp, manager: mgr });
    // saving the same role overwrites its slot only
    const next = { selected: ['nextHoliday'], order: ['nextHoliday'] };
    expect(mergeRoleLayout({ employee: emp, manager: mgr }, 'employee', next)).toEqual({
      employee: next,
      manager: mgr,
    });
  });

  it('removeRoleLayout drops one slot, keeps the rest, and returns null when nothing remains', () => {
    expect(removeRoleLayout({ employee: emp, manager: mgr }, 'manager')).toEqual({ employee: emp });
    expect(removeRoleLayout({ employee: emp }, 'employee')).toBeNull();
    // legacy flat reset by the employee → everything gone (the pre-9606c59f behaviour)
    expect(removeRoleLayout(emp, 'employee')).toBeNull();
    // legacy flat reset by a manager → the employee's flat layout survives
    expect(removeRoleLayout(emp, 'manager')).toEqual({ employee: emp });
  });
});

/** Write a raw value straight through the SECURITY DEFINER seam (bypassing normalisation) to simulate a
 *  legacy stored layout. Uses the app-role db under the caller's session GUCs. */
async function withRawSeam(ctx: SessionContext, raw: unknown): Promise<void> {
  const { withTenant } = await import('../db/client');
  await withTenant(ctx, async (tx) => {
    await tx.execute(sql`select app.dashboard_layout_set(${JSON.stringify(raw)}::jsonb)`);
  });
}


// Home persists card choices through this existing own-row owner, rather than a parallel preference table.
import {EMPLOYEE_HOME_CARDS,defaultEmployeeHomePreferences} from '../lib/employee-home';
const HOME_CARDS=EMPLOYEE_HOME_CARDS.map((cardKey,index)=>({cardKey,employeeSelectable:cardKey!=='summary',
  defaultDisplay:true,mandatory:cardKey==='summary',displayOrder:index}));
/** A retired manager-dashboard slot as the old customizer stored it. */
const MANAGER_SLOT={selected:['teamAwayToday'],order:['teamAwayToday']};
async function rawLayout(ctx:SessionContext){
  const [row]=await owner.db.select({layout:schema.appUser.dashboardLayout}).from(schema.appUser).where(eq(schema.appUser.id,ctx.userId!));
  return row.layout;
}
describe('Home cosmetic preferences share the canonical dashboard owner',()=>{
  it('reads old corresponding visibility without losing new cards or rewriting the stored layout',async()=>{
    const ctx=await newEmployeeCtx();
    const legacyCards=['leaveBalance','nextHoliday','upcomingEvents','pendingTasks','noticeBoard'].map((cardKey,index)=>({cardKey,employeeSelectable:true,defaultDisplay:true,mandatory:false,displayOrder:index}));
    await withRawSeam(ctx,{employee:{selected:['leaveBalance'],order:legacyCards.map(row=>row.cardKey)}});
    const before=await rawLayout(ctx),preferences=await getEmployeeHomePreferences(ctx,HOME_CARDS);
    expect(preferences.cardOrder).toEqual([...EMPLOYEE_HOME_CARDS]);
    expect(preferences.hiddenCards).toEqual(['calendar','notices','tasks']);
    expect(preferences.hiddenCards).not.toContain('today');expect(preferences.hiddenCards).not.toContain('timeOff');
    const notDefault=HOME_CARDS.map(card=>card.cardKey==='celebrations'?{...card,defaultDisplay:false}:card);
    expect((await getEmployeeHomePreferences(ctx,notDefault)).hiddenCards).toEqual(['calendar','notices','tasks','celebrations']);
    expect(await rawLayout(ctx)).toEqual(before);
    await setEmployeeHomePreferences(ctx,preferences,HOME_CARDS);
    expect(await getEmployeeHomePreferences(ctx,HOME_CARDS)).toEqual(preferences);
  });
  it('persists/reopens choices once, keeps another role and login private, and resets only Home',async()=>{
    const ctx=await newEmployeeCtx(),other=await newEmployeeCtx();
    await withRawSeam(ctx,{manager:MANAGER_SLOT});
    const preferences={...defaultEmployeeHomePreferences(),timeZone:'America/New_York',weekStartsOn:0,
      hiddenCards:['tasks'] as const,cardOrder:['calendar',...EMPLOYEE_HOME_CARDS.filter(key=>key!=='calendar')]};
    await setEmployeeHomePreferences(ctx,preferences,HOME_CARDS);
    expect(await getEmployeeHomePreferences(ctx,HOME_CARDS)).toEqual(preferences);
    const raw=await rawLayout(ctx) as Record<string,unknown>;
    expect(raw.homeDisplay).toEqual({version:1,timeZone:'America/New_York',weekStartsOn:0});
    expect(await getEmployeeHomeDisplayPreferences(ctx)).toEqual({timeZone:'America/New_York',weekStartsOn:0});
    expect(raw).not.toHaveProperty('hiddenCards');expect(raw).not.toHaveProperty('cardOrder');
    expect((extractRoleLayout(raw,'employee') as {selected:string[]}).selected).not.toContain('tasks');
    expect(raw.manager).toEqual(MANAGER_SLOT);
    expect(await getEmployeeHomePreferences(other,HOME_CARDS)).toEqual(defaultEmployeeHomePreferences());
    const {timeZone,weekStartsOn}=defaultEmployeeHomePreferences();
    expect(await getEmployeeHomeDisplayPreferences(other)).toEqual({timeZone,weekStartsOn});
    await resetEmployeeHomePreferences(ctx);
    expect(await getEmployeeHomePreferences(ctx,HOME_CARDS)).toEqual(defaultEmployeeHomePreferences());
    expect(await rawLayout(ctx)).toEqual({manager:MANAGER_SLOT});
  });
  it('keeps the retired manager and HR-admin slots through concurrent Home writes and a Home reset',async()=>{
    // No screen reads or writes those slots since the old dashboard was retired (12 Nov 2026); their stored values
    // are kept, not cleared.
    const ctx=await newEmployeeCtx(),retired={manager:MANAGER_SLOT,hr_admin:{selected:['headcount'],order:['headcount']}};
    await withRawSeam(ctx,retired);
    const preferences={...defaultEmployeeHomePreferences(),timeZone:'Asia/Tokyo',weekStartsOn:6};
    await Promise.all([setEmployeeHomePreferences(ctx,preferences,HOME_CARDS),
      setEmployeeHomePreferences(ctx,{...preferences,weekStartsOn:0},HOME_CARDS)]);
    expect([0,6]).toContain((await getEmployeeHomePreferences(ctx,HOME_CARDS)).weekStartsOn);
    expect(await rawLayout(ctx)).toMatchObject(retired);
    await resetEmployeeHomePreferences(ctx);
    expect(await rawLayout(ctx)).toEqual(retired);
  });
  it('appends NO domain event (deliberate substrate carve-out for a cosmetic UI pref)', async () => {
    const ctx = await newEmployeeCtx();
    await setEmployeeHomePreferences(ctx, defaultEmployeeHomePreferences(), HOME_CARDS);
    await resetEmployeeHomePreferences(ctx);
    const rows = (await owner.db.execute(
      sql`select count(*)::int as n from domain_event
          where tenant_id = ${b.tenantId} and aggregate_type = 'dashboard-layout'`,
    )) as unknown as { n: number }[];
    expect(rows[0]?.n ?? 0).toBe(0);
  });
  it('does not grant a disabled card or save invalid timezone, mandatory-card removal or extra identity fields',async()=>{
    const ctx=await newEmployeeCtx(),preferences=defaultEmployeeHomePreferences();
    await setEmployeeHomePreferences(ctx,preferences,HOME_CARDS);
    expect((await getEmployeeHomePreferences(ctx,HOME_CARDS.filter(card=>card.cardKey!=='notices'))).hiddenCards).toContain('notices');
    const before=await rawLayout(ctx);
    for(const input of [{...preferences,timeZone:'invalid/timezone'},{...preferences,hiddenCards:['summary']},
      {...preferences,userId:randomUUID()},{...preferences,weekStartsOn:7}])
      expect(()=>setEmployeeHomePreferences(ctx,input,HOME_CARDS)).toThrow();
    expect(await rawLayout(ctx)).toEqual(before);
  });
  it('falls back on corrupt stored display data without overwriting it during read or another role save',async()=>{
    const ctx=await newEmployeeCtx(),invalid={version:99,timeZone:'invalid/timezone',weekStartsOn:9};
    await withRawSeam(ctx,{homeDisplay:invalid});
    const {timeZone,weekStartsOn}=defaultEmployeeHomePreferences();
    expect(await getEmployeeHomeDisplayPreferences(ctx)).toEqual({timeZone,weekStartsOn});
    expect(await getEmployeeHomePreferences(ctx,HOME_CARDS)).toEqual(defaultEmployeeHomePreferences());
    expect(await rawLayout(ctx)).toEqual({homeDisplay:invalid});
  });
});
