/**
 * Employee Leave View Configuration (feedback 65dec703 / duplicate 1fedb473).
 *
 * Per-leave-type `ess_view_config` JSONB (migration 0178) controls which entitlement/breakdown components an
 * employee sees in self-service (My Profile → Leave). HR ticks components in the Leave Config → Entitlements
 * panel. Semantics: a key mapped false ⇒ hidden in ESS; missing/true, or a null column, ⇒ visible (the
 * backward-compatible default). Gating applies to /me ONLY — the admin/HR EntitlementBreakdown passes
 * applyEssConfig=false and sees everything (that flag is a UI contract, asserted here via the same predicate).
 *
 * Coverage: migration column round-trips; resolver default (null ⇒ all-visible); updateLeaveType tri-state
 * (an essView-only save leaves sibling columns untouched, and an unrelated save leaves ess_view_config
 * untouched) + audit before/after; unknown-key rejection; the read layer threads a resolved essView onto
 * BOTH leaveBalances rows and leaveEntitlementBreakdown (missing ⇒ visible, explicit false honoured); and the
 * /me-vs-admin gating contract (applyEssConfig=false ⇒ never gated).
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { updateLeaveType } from '../core/admin';
import { listLeaveTypes, leaveBalances, leaveEntitlementBreakdown } from '../core/read';
import {
  resolveEssView,
  isEssViewComponentKey,
  ESS_VIEW_COMPONENT_KEYS,
  type EssViewComponentKey,
} from '../core/ess-view';
import {
  ENTITLEMENT_PANEL_SECTIONS,
  ESS_VIEW_CHECKLIST_GROUPS,
} from '../components/leave/entitlement-panel-config';
import type { SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

async function hireEmployeeCtx(): Promise<{ ctx: SessionContext; employmentId: string }> {
  const { employmentId, personId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'EssView', primaryEmail: `ev_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { ctx: { tenantId: b.tenantId, userId, roles: ['employee'], personId }, employmentId };
}

function uniqCode(): string {
  return `EV_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;
}

/** Insert a calendar-counted leave type with an optional ess_view_config. */
async function leaveType(code: string, essViewConfig?: Record<string, boolean> | null): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      allowNegativeBalance: true, // 0ef0defd: test type opts out of the submit-time balance gate (test not about balance)
      tenantId: b.tenantId,
      code,
      name: code,
      paid: true,
      counting: 'calendar_days',
      essViewConfig: essViewConfig ?? null,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** The /me-vs-admin gating contract, mirrored from components/leave/EntitlementBreakdown.tsx `show`. */
function show(applyEssConfig: boolean, essView: Record<string, boolean> | undefined, key: string): boolean {
  return !applyEssConfig || essView?.[key] !== false;
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

describe('resolveEssView — default & partial semantics', () => {
  it('null config ⇒ every component visible (backward compatible)', () => {
    const v = resolveEssView(null);
    for (const k of ESS_VIEW_COMPONENT_KEYS) expect(v[k]).toBe(true);
  });

  it('a partial map ⇒ missing keys visible, explicit false honoured', () => {
    const v = resolveEssView({ available: false, taken: true });
    expect(v.available).toBe(false);
    expect(v.taken).toBe(true);
    // A key absent from the stored map resolves to visible.
    expect(v.forfeited).toBe(true);
  });

  it('an unknown stored key is ignored (never throws on legacy data)', () => {
    const v = resolveEssView({ someLegacyKey: false } as Record<string, boolean>);
    // All known keys still resolve; the junk key simply does not appear.
    expect(Object.keys(v).sort()).toEqual([...ESS_VIEW_COMPONENT_KEYS].sort());
  });

  it('11876072: the removed upcomingApprovedLeave toggle is a dead key — normalized away on read', () => {
    // The §5 Upcoming Leave section left the employee panel, so its toggle left the closed allow-list.
    expect(ESS_VIEW_COMPONENT_KEYS).not.toContain('upcomingApprovedLeave');
    // A leave type that stored the toggle before the removal keeps working: the stored entry is simply
    // ignored on read (no migration/backfill needed), and every live key still resolves to its default.
    const v = resolveEssView({ upcomingApprovedLeave: false } as Record<string, boolean>);
    expect(Object.keys(v).sort()).toEqual([...ESS_VIEW_COMPONENT_KEYS].sort());
    for (const k of ESS_VIEW_COMPONENT_KEYS) expect(v[k]).toBe(true);
  });
});

/**
 * Feedback 1f6fd6d8 — the configuration screen and the employee panel must be ONE list.
 *
 * The reporter's complaint was that the Employee Leave View Configuration still offered field names the
 * redesigned Leave Balance Summary no longer shows. The defect underneath is a two-way drift, and both
 * directions are equally broken: a key with no row is a switch that does nothing, and a gated row with no key
 * is a row nobody can reach. Neither shows up in any behavioural test, because a dead switch behaves exactly
 * like a live one that happens to be on. So the property is asserted directly against the descriptor.
 */
describe('1f6fd6d8 — every switch gates a row, every gated row has a switch', () => {
  const sectionKeys = new Set(
    ENTITLEMENT_PANEL_SECTIONS.flatMap((s) => [
      s.essKey,
      s.itemsEssKey,
      ...(s.fields ?? []).map((f) => f.essKey),
    ]).filter((k): k is EssViewComponentKey => k != null),
  );

  it('no component key is orphaned — each one gates a section, a field or an itemised block', () => {
    const orphans = ESS_VIEW_COMPONENT_KEYS.filter((k) => !sectionKeys.has(k));
    expect(orphans).toEqual([]);
  });

  it('obsolete keys are gone, and every line of the revised summary is configurable', () => {
    for (const dead of [
      // Dropped by r75: their rows had already left the product.
      'entitlementToDate',
      'expiredBroughtForward',
      'transactionHistory',
      // Dropped by 1f6fd6d8 with the sections they gated. `unplanned`/`overutilized` were labels with no
      // value wiring at all; `carryForwardExpiry`'s date moved onto the Brought Forward Forfeited row and
      // hides with it; `entitlementCalcBreakdown` was that section's own gate and now names nothing.
      'unplanned',
      'overutilized',
      'carryForwardExpiry',
      'entitlementCalcBreakdown',
    ]) {
      expect(ESS_VIEW_COMPONENT_KEYS as readonly string[]).not.toContain(dead);
    }
    // The nine lines the reporter's revised summary names must all be configurable, and nothing else may be:
    // an item HR can tick that the summary does not render is precisely what ed17a4f9 was raised about.
    expect([...ESS_VIEW_COMPONENT_KEYS]).toEqual([
      'eligible',
      'ytdEntitled',
      'broughtForward',
      'adjustment',
      'total',
      'taken',
      'pendingApproval',
      'forfeited',
      'available',
    ]);
  });

  it('seven of the nine keys are the ORIGINAL strings, so stored selections survive the redesign', () => {
    // Key CHOICE is a data-migration decision, not cosmetics: reusing the existing key string is what keeps
    // an HR admin's saved show/hide choice for that row after the summary was rebuilt around it. Only the
    // two genuinely new lines needed new keys.
    for (const preserved of ['ytdEntitled', 'broughtForward', 'adjustment', 'taken', 'pendingApproval', 'forfeited', 'available']) {
      expect(ESS_VIEW_COMPONENT_KEYS as readonly string[]).toContain(preserved);
    }
    expect(resolveEssView({ taken: false, ytdEntitled: false }).taken).toBe(false);
    expect(resolveEssView({ taken: false, ytdEntitled: false }).ytdEntitled).toBe(false);
    // …and a stored value under a RETIRED key is ignored rather than throwing or leaking through.
    const legacy = resolveEssView({ unplanned: false, entitlementCalcBreakdown: false, taken: false });
    expect((legacy as Record<string, unknown>).unplanned).toBeUndefined();
    expect(legacy.taken).toBe(false);
  });

  it('every ess-gated key the panel references is a REAL component key (no typo gates nothing)', () => {
    for (const k of sectionKeys) expect(isEssViewComponentKey(k)).toBe(true);
  });

  it('the admin checklist is the panel\'s own list, in the panel\'s own order, with no leftover group', () => {
    // Groups follow ascending section order …
    const order = ENTITLEMENT_PANEL_SECTIONS.slice().sort((a, c) => a.order - c.order).map((s) => s.key);
    const groupKeys = ESS_VIEW_CHECKLIST_GROUPS.map((g) => g.key);
    expect(groupKeys).toEqual(order.filter((k) => groupKeys.includes(k)));
    // … and the trailing "Other" bucket is empty now that no key is orphaned.
    expect(groupKeys).not.toContain('other');
    // Together the groups cover every key exactly once.
    const flat = ESS_VIEW_CHECKLIST_GROUPS.flatMap((g) => g.keys);
    expect(flat.slice().sort()).toEqual([...ESS_VIEW_COMPONENT_KEYS].sort());
  });

  it('EVERY rendered row is now reachable from the configuration screen — no exceptions left', () => {
    // This used to allow two documented exceptions: the reconciliation block (a sum an HR toggle could
    // half-hide would not add up) and §1's un-gated Balance row. 1f6fd6d8 removed the reconciliation block
    // and replaced Balance with Available Balance, which IS configurable — so the exception list is empty and
    // the reporter's ask ("any field enabled or disabled in the configuration should immediately reflect in
    // the Leave Balance Summary") holds for every line without a carve-out.
    const unreachable = ENTITLEMENT_PANEL_SECTIONS.flatMap((s) => (s.fields ?? []).map((f) => ({ section: s, field: f })))
      .filter(({ section, field }) => field.essKey == null && section.essKey == null)
      .map(({ section, field }) => `${section.key}.${field.key}`);
    expect(unreachable).toEqual([]);
  });
});

describe('migration 0178 — ess_view_config column', () => {
  it('exists and round-trips a JSONB map on a fresh test DB', async () => {
    const ltId = await leaveType(uniqCode(), { available: false, forfeited: false });
    const [row] = await owner.db
      .select({ cfg: schema.leaveType.essViewConfig })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, ltId));
    expect((row?.cfg as Record<string, boolean> | null)?.available).toBe(false);
    expect((row?.cfg as Record<string, boolean> | null)?.forfeited).toBe(false);
  });
});

describe('updateLeaveType — essViewConfig tri-state, validation & audit', () => {
  it('setting a config persists and reads back via the admin projection', async () => {
    const ltId = await leaveType(uniqCode(), null);
    await updateLeaveType(adminCtx(b), {
      id: ltId,
      name: uniqCode(),
      essViewConfig: { available: true, forfeited: false, adjustment: false },
    });
    const t = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((x) => x.id === ltId);
    const cfg = t?.essViewConfig as Record<string, boolean> | null;
    expect(cfg?.forfeited).toBe(false);
    expect(cfg?.adjustment).toBe(false);
    expect(cfg?.available).toBe(true);
  });

  it('an essView-only save leaves a sibling column (backdatingLimitDays) untouched', async () => {
    const [row] = await owner.db
      .insert(schema.leaveType)
      .values({ allowNegativeBalance: true, tenantId: b.tenantId, code: uniqCode(), name: 'X', paid: true, counting: 'calendar_days', backdatingLimitDays: 7 })
      .returning({ id: schema.leaveType.id });
    await updateLeaveType(adminCtx(b), { id: row.id, name: 'X', essViewConfig: { taken: false } });
    const t = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((x) => x.id === row.id);
    expect(t?.backdatingLimitDays).toBe(7); // sibling survived
    expect((t?.essViewConfig as Record<string, boolean> | null)?.taken).toBe(false);
  });

  it('an unrelated save (doc-only) leaves ess_view_config untouched', async () => {
    const ltId = await leaveType(uniqCode(), { available: false });
    await updateLeaveType(adminCtx(b), { id: ltId, name: uniqCode(), requiresDocument: true });
    const t = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((x) => x.id === ltId);
    // The pre-existing config must survive a save that never carried the essView marker.
    expect((t?.essViewConfig as Record<string, boolean> | null)?.available).toBe(false);
  });

  it('rejects an unknown component key', async () => {
    const ltId = await leaveType(uniqCode(), null);
    await expect(
      updateLeaveType(adminCtx(b), {
        id: ltId,
        name: uniqCode(),
        essViewConfig: { notARealComponent: false } as Record<string, boolean>,
      }),
    ).rejects.toThrow(/Unknown leave-view component key/);
  });

  it('an all-visible / empty config collapses to null', async () => {
    const ltId = await leaveType(uniqCode(), { available: false });
    await updateLeaveType(adminCtx(b), { id: ltId, name: uniqCode(), essViewConfig: {} });
    const t = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((x) => x.id === ltId);
    expect(t?.essViewConfig).toBeNull();
  });

  it('records the change in its own audit block against the correct prior value', async () => {
    const ltId = await leaveType(uniqCode(), { available: true });
    await updateLeaveType(adminCtx(b), { id: ltId, name: uniqCode(), essViewConfig: { available: false } });
    const payload = await latestEventPayload(b.tenantId, ltId, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown>;
    const after = payload?.after as Record<string, unknown>;
    expect((before.essViewConfig as Record<string, boolean> | null)?.available).toBe(true);
    expect((after.essViewConfig as Record<string, boolean> | null)?.available).toBe(false);
  });

  it('a doc-only save does NOT claim an essViewConfig change in the audit event', async () => {
    const ltId = await leaveType(uniqCode(), { available: false });
    await updateLeaveType(adminCtx(b), { id: ltId, name: uniqCode(), requiresDocument: true });
    const payload = await latestEventPayload(b.tenantId, ltId, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown> | undefined;
    const after = payload?.after as Record<string, unknown> | undefined;
    expect('essViewConfig' in (before ?? {})).toBe(false);
    expect('essViewConfig' in (after ?? {})).toBe(false);
  });
});

describe('read layer — resolved essView threaded onto balances & breakdown', () => {
  it('default (null config) ⇒ leaveBalances row is all-visible', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    await leaveType(uniqCode(), null);
    const rows = await leaveBalances(ctx, employmentId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.essView.available).toBe(true);
      expect(r.essView.forfeited).toBe(true);
    }
  });

  it('a hidden key reaches the leaveBalances row for that type; other types stay visible', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const hiddenId = await leaveType(uniqCode(), { available: false, taken: false });
    const openId = await leaveType(uniqCode(), null);
    const rows = await leaveBalances(ctx, employmentId);
    const hidden = rows.find((r) => r.leaveTypeId === hiddenId);
    const open = rows.find((r) => r.leaveTypeId === openId);
    expect(hidden?.essView.available).toBe(false);
    expect(hidden?.essView.taken).toBe(false);
    expect(hidden?.essView.pendingApproval).toBe(true); // untouched key ⇒ visible
    expect(open?.essView.available).toBe(true);
  });

  it('leaveEntitlementBreakdown carries the resolved essView (missing ⇒ visible, false honoured)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    // 1f6fd6d8 re-pointed this from `transactionHistory`, which is no longer a component key (its §6 section
    // was removed universally by 1dd4d827, so the switch gated nothing). `forfeited` is the equivalent case
    // under the new list: a real §7 row with its own toggle.
    const ltId = await leaveType(uniqCode(), { forfeited: false });
    const bd = await leaveEntitlementBreakdown(ctx, employmentId, ltId, '2026-06-15');
    expect(bd).not.toBeNull();
    expect(bd!.essView.forfeited).toBe(false);
    expect(bd!.essView.available).toBe(true);
  });

  it('a legacy stored toggle for a REMOVED key is ignored, and the tenant\'s other choices survive', async () => {
    // The migration story for 1f6fd6d8: a tenant who had ticked things before the three dead keys went away
    // must not lose the rest of their configuration, and the dead key must not reappear as a resolved field.
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), { transactionHistory: false, entitlementToDate: false, taken: false });
    const bd = await leaveEntitlementBreakdown(ctx, employmentId, ltId, '2026-06-15');
    expect(bd!.essView.taken).toBe(false); // the surviving choice is honoured
    expect('transactionHistory' in bd!.essView).toBe(false);
    expect('entitlementToDate' in bd!.essView).toBe(false);
  });
});

describe('gating contract — /me gates, admin/HR does not', () => {
  it('applyEssConfig=false ⇒ every component shows even when the config hides it (admin/HR view)', () => {
    const essView = resolveEssView({ available: false, forfeited: false });
    // Admin passes applyEssConfig=false — nothing is ever hidden.
    expect(show(false, essView, 'available')).toBe(true);
    expect(show(false, essView, 'forfeited')).toBe(true);
  });

  it('applyEssConfig=true ⇒ a hidden component is gated out, a visible one stays (the /me view)', () => {
    const essView = resolveEssView({ available: false });
    expect(show(true, essView, 'available')).toBe(false);
    expect(show(true, essView, 'taken')).toBe(true); // missing key ⇒ visible
  });
});
