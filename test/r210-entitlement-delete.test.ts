/**
 * r210 0c367864 — DELETE AN ENTITLEMENT TABLE OR AN ELIGIBILITY RULE, AND THE GUARD THAT SAYS WHEN NOT TO.
 *
 * THE SITUATION THIS CHANGES, measured on production 2026-08-20: 47 entitlement tables in force, THREE
 * eligibility rules, 152 accrual rows already granted. There was no way to remove a table at all, and the
 * one way to take it out of use — "Stop from" a date — lived several fields down inside the Edit panel, so
 * from the list you would never know it existed. Annual Leave's sixteen tables have never had a rule and
 * so have never handed anybody a day; other types have granted. BOTH branches of the guard below are
 * therefore reachable on the customer's own data, which is why each has its own case here.
 *
 * WHAT EACH GROUP PINS, and why it needs the kind of test it has:
 *
 *   §A THE WRITE, against a real database. A delete is the one operation whose bug cannot be seen from its
 *      caller: deleting only the RUNNING version leaves the superseded ones behind, returns success, and
 *      shows an empty list — while a report for a closed year still resolves the table the operator
 *      believes they removed. Only counting rows afterwards sees it.
 *   §B THE GUARD, and the honesty of it. `leave_ledger` carries NO reference to the table or rule that
 *      produced a row, so "has this table granted anything" has no exact answer (core/entitlement-template
 *      module header). The conservative test is the date window, and these cases pin BOTH directions: a
 *      grant inside the window refuses, a grant outside it does not — otherwise "refuse when anything was
 *      ever granted for this leave type" would pass every case that only checks the refusal. It also pins
 *      the case the whole item dies on if it is missed: `openLeaveYear` writes an `accrual` row of 0.00
 *      days for EVERY employee and type whether or not anything was granted, so a guard reading the entry
 *      type alone makes the never-used table undeletable and says so in a sentence that is false.
 *   §B2 THE COMPANY FENCE, which is application code because RLS cannot do it — WITH CHECK is not
 *      consulted for DELETE. It is the only company scope on a rule delete and nothing else in the suite
 *      asserts it, so removing the call leaves a green suite.
 *   §C THE HEALTH CARD RE-DERIVES. A deleted table must not still be reported as "a table without a rule".
 *      `lib/leave-config-health.ts` is pure and derives from what it is handed, so the fact under test is
 *      that the delete really removes the rows the next read hands it.
 *      A SECOND FACT §B pins, and it is a deliberate design choice rather than an omission: the SCREEN
 *      does not pre-compute the grant refusal. Doing so put one unindexed `leave_ledger` read on every
 *      render of two pages, and `leave_ledger`'s RLS calls a recursive SECURITY DEFINER function per row
 *      — measured at 1.7s per render over 50,000 ledger rows, growing linearly (`entitlementDeleteBlocks`
 *      carries the table). The rules half, which is configuration and names the operator's next step, IS
 *      on the row; the grant half is the delete's own refusal.
 *   §D THE SCREEN AND THE ACTIONS. Row actions are the whole discoverability half of the item, and the
 *      block is a server component importing a 'use server' module, so composition is asserted on the
 *      source (this repo's convention — see entitlement-tables-embed) and behaviour is not. The two
 *      action-level cases DO run: they pin the leave type being resolved BEFORE the delete, which no
 *      source read can prove is enough.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// redirect() in real Next.js THROWS to abort the request; the mock must throw too. Same shape as
// test/entitlement-save-stay.test.ts, which is where this pattern is explained at length.
let actionCtx: import('../db/client').SessionContext | null = null;
class RedirectError extends Error {
  constructor(public path: string) {
    super(`NEXT_REDIRECT:${path}`);
  }
}
vi.mock('../lib/session', () => ({ getSession: vi.fn(async () => actionCtx) }));
vi.mock('../lib/authz', () => ({ requireAdmin: vi.fn(async () => actionCtx) }));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new RedirectError(p);
  },
  notFound: vi.fn(() => undefined),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { openLeaveYear } from '../core/leave';
import {
  createEligibilityRule,
  createEntitlementTemplate,
  deleteEligibilityRule,
  deleteEntitlementTemplate,
  entitlementDeleteBlocks,
  isDeletableLineage,
  lineageInForceWindow,
  listEligibilityRules,
  listEntitlementTemplates,
  retireEntitlementTemplate,
  updateEligibilityRule,
  updateEntitlementTemplate,
} from '../core/entitlement-template';
import { leaveTypeConfigHealth, type HealthLeaveType } from '../lib/leave-config-health';
import {
  deleteEntitlementTemplateAction,
  deleteEligibilityRuleAction,
} from '../app/admin/leave/entitlements/templates/actions';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const leaf = (obj: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);

const TODAY = '2026-08-20';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  actionCtx = adminCtx(b);
});
afterAll(closeAll);

const uniq = (p: string) => `${p}_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;

async function leaveTypeRow(name?: string): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: uniq('R210'),
      name: name ?? uniq('R210 Leave'),
      paid: true,
      counting: 'calendar_days',
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

const hire = () =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'R210', primaryEmail: `r210_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });

const bands = (days: number) => [{ fromYears: 0, toYears: null, days, carryForwardDays: 0, maxBalanceDays: null }];

/** A granting ledger row, written straight to the table — the guard reads the ledger, not the engine, so
 *  the boundary cases are stated as ledger facts rather than as a grant run that happens to produce them. */
async function ledgerRow(p: {
  employmentId: string;
  leaveTypeId: string;
  effectiveOn: string;
  entryType?: 'accrual' | 'in_lieu_accrual' | 'adjustment';
  days?: number;
}) {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId: p.employmentId,
    leaveTypeId: p.leaveTypeId,
    entryType: p.entryType ?? 'accrual',
    days: String(p.days ?? 12),
    effectiveOn: p.effectiveOn,
  });
}

const versionsOf = async (lineageId: string): Promise<number> => {
  const rows = await owner.db
    .select({ id: schema.entitlementTemplate.id })
    .from(schema.entitlementTemplate)
    .where(eq(schema.entitlementTemplate.lineageId, lineageId));
  return rows.length;
};

const ruleVersionsOf = async (lineageId: string): Promise<number> => {
  const rows = await owner.db
    .select({ id: schema.entitlementEligibilityRule.id })
    .from(schema.entitlementEligibilityRule)
    .where(eq(schema.entitlementEligibilityRule.lineageId, lineageId));
  return rows.length;
};

const fd = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

/** Run a server action that ends in redirect() and return the target path. */
async function captureRedirect(run: () => Promise<void>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof RedirectError) return e.path;
    throw e;
  }
  throw new Error('expected the action to redirect, but it did not');
}

// ── §A the write ────────────────────────────────────────────────────────────────────────────────────

describe('§A r210 · a delete removes the WHOLE lineage, in one transaction, and records that it did', () => {
  /**
   * ⚠️ THE CASE THE WHOLE FILE EXISTS FOR. A lineage here has THREE versions — the original and two
   * supersessions — and only the last of them is the running one. A delete that removed just the running
   * version would return success, empty the list on screen, and leave two rows a past-date reader still
   * resolves: the operator would believe the table is gone and a closed year would still be answered from
   * it. Counting the rows afterwards is the only thing that can tell the two apart.
   */
  it('every version goes, not only the running one, and a deleted event names the lineage', async () => {
    const typeId = await leaveTypeRow('Annual Leave (r210)');
    const tpl = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'Grade H PERMANENT',
      serviceBands: bands(12),
      validFrom: '2026-01-01',
    });
    await updateEntitlementTemplate(adminCtx(b), {
      lineageId: tpl.lineageId,
      name: 'Grade H PERMANENT',
      serviceBands: bands(14),
      validFrom: '2026-02-01',
    });
    await updateEntitlementTemplate(adminCtx(b), {
      lineageId: tpl.lineageId,
      name: 'Grade H PERMANENT',
      serviceBands: bands(16),
      validFrom: '2026-03-01',
    });
    // A second lineage of the same leave type, to prove the delete is scoped to one lineage.
    const other = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'CONTRACT',
      serviceBands: bands(8),
      validFrom: '2026-01-01',
    });
    expect(await versionsOf(tpl.lineageId)).toBe(3);

    const res = await deleteEntitlementTemplate(adminCtx(b), { lineageId: tpl.lineageId });

    expect(res.deletedVersions).toBe(3);
    // EVERY version, including the two superseded ones a dated reader could still have resolved.
    expect(await versionsOf(tpl.lineageId)).toBe(0);
    expect(await versionsOf(other.lineageId)).toBe(1);
    const listed = await listEntitlementTemplates(adminCtx(b), { leaveTypeId: typeId });
    expect(listed.map((x) => x.lineageId)).toEqual([other.lineageId]);

    const [ev] = await owner.db
      .select({
        aggregateId: schema.domainEvent.aggregateId,
        payload: schema.domainEvent.payload,
      })
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.tenantId, b.tenantId),
          eq(schema.domainEvent.eventType, 'entitlement-template.deleted'),
        ),
      );
    expect(ev, 'a delete must leave a record of itself').toBeTruthy();
    // The LINEAGE, not a row id: every row is gone by the time the event is appended.
    expect(ev.aggregateId).toBe(tpl.lineageId);
    expect(ev.payload).toMatchObject({
      lineageId: tpl.lineageId,
      leaveTypeId: typeId,
      name: 'Grade H PERMANENT',
      versions: 3,
      validFrom: '2026-01-01',
    });
  });

  it('an eligibility rule deletes the same way — every version — and records it', async () => {
    const typeId = await leaveTypeRow();
    const tpl = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'PERMANENT',
      serviceBands: bands(12),
      validFrom: '2026-01-01',
    });
    const rule = await createEligibilityRule(adminCtx(b), {
      name: 'Everyone',
      templateLineageId: tpl.lineageId,
      criteria: {},
      validFrom: '2026-01-01',
    });
    await updateEligibilityRule(adminCtx(b), {
      lineageId: rule.lineageId,
      name: 'Everyone',
      criteria: {},
      validFrom: '2026-04-01',
    });
    expect(await ruleVersionsOf(rule.lineageId)).toBe(2);

    const res = await deleteEligibilityRule(adminCtx(b), { lineageId: rule.lineageId });

    expect(res.deletedVersions).toBe(2);
    expect(await ruleVersionsOf(rule.lineageId)).toBe(0);
    expect(await listEligibilityRules(adminCtx(b))).toEqual([]);
    const [ev] = await owner.db
      .select({ aggregateId: schema.domainEvent.aggregateId })
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.tenantId, b.tenantId),
          eq(schema.domainEvent.eventType, 'entitlement-eligibility.deleted'),
        ),
      );
    expect(ev?.aggregateId).toBe(rule.lineageId);
  });

  it('a lineage that is not there refuses rather than reporting a successful delete of nothing', async () => {
    await expect(deleteEntitlementTemplate(adminCtx(b), { lineageId: randomUUID() })).rejects.toThrow(
      /no longer exists/,
    );
    await expect(deleteEligibilityRule(adminCtx(b), { lineageId: randomUUID() })).rejects.toThrow(
      /no longer exists/,
    );
  });

  it('a STOPPED table that was never used can still be deleted — stopping is not a dead end', async () => {
    const typeId = await leaveTypeRow();
    const tpl = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'Typed by mistake',
      serviceBands: bands(12),
      validFrom: '2026-01-01',
    });
    await retireEntitlementTemplate(adminCtx(b), { lineageId: tpl.lineageId, validTo: '2026-02-01' });
    await deleteEntitlementTemplate(adminCtx(b), { lineageId: tpl.lineageId });
    expect(await versionsOf(tpl.lineageId)).toBe(0);
  });
});

// ── §B the guard ────────────────────────────────────────────────────────────────────────────────────

describe('§B r210 · the guard refuses with a named reason, and the reason is honest about what it knows', () => {
  it('a rule pointing at the table blocks it, BY NAME, and deleting the rule first clears the block', async () => {
    const typeId = await leaveTypeRow();
    const tpl = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'PERMANENT',
      serviceBands: bands(12),
      validFrom: '2026-01-01',
    });
    const rule = await createEligibilityRule(adminCtx(b), {
      name: 'Executives',
      templateLineageId: tpl.lineageId,
      criteria: {},
      validFrom: '2026-01-01',
    });

    // NAMED, not "some rule points here" — the operator has to know which one to go and remove.
    await expect(deleteEntitlementTemplate(adminCtx(b), { lineageId: tpl.lineageId })).rejects.toThrow(
      /Executives/,
    );
    // …and the refusal points at the other way out, which is on the same row.
    await expect(deleteEntitlementTemplate(adminCtx(b), { lineageId: tpl.lineageId })).rejects.toThrow(
      /stop this table from a date/,
    );
    expect(await versionsOf(tpl.lineageId)).toBe(1);

    await deleteEligibilityRule(adminCtx(b), { lineageId: rule.lineageId });
    await deleteEntitlementTemplate(adminCtx(b), { lineageId: tpl.lineageId });
    expect(await versionsOf(tpl.lineageId)).toBe(0);
  });

  it('a rule that USED to point here still blocks: a past-date reader resolves that old version', async () => {
    const typeId = await leaveTypeRow();
    const first = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'FIRST',
      serviceBands: bands(12),
      validFrom: '2026-01-01',
    });
    const second = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'SECOND',
      serviceBands: bands(14),
      validFrom: '2026-01-01',
    });
    const rule = await createEligibilityRule(adminCtx(b), {
      name: 'Everyone',
      templateLineageId: first.lineageId,
      criteria: {},
      validFrom: '2026-01-01',
    });
    // Re-pointed at the second table. The rule's FIRST version still names the first table, and that is
    // the version a report for January resolves.
    await updateEligibilityRule(adminCtx(b), {
      lineageId: rule.lineageId,
      templateLineageId: second.lineageId,
      validFrom: '2026-06-01',
    });
    await expect(deleteEntitlementTemplate(adminCtx(b), { lineageId: first.lineageId })).rejects.toThrow(
      /Everyone/,
    );
  });

  /**
   * ⚠️ BOTH DIRECTIONS, DELIBERATELY, AND THE SECOND HALF IS THE ONE THAT MATTERS. "Refuse when this
   * leave type has ever granted anything" would pass the first assertion and fail the tenant: 152 accrual
   * rows exist on production, so a table written LAST WEEK would be undeletable because of a grant made
   * in January. The guard is the date WINDOW, and only a grant outside it proves that is what it is.
   */
  it('a grant inside the window refuses; the same grant outside it does not', async () => {
    const typeId = await leaveTypeRow('Medical Leave');
    const emp = await hire();
    const late = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'WRITTEN IN JUNE',
      serviceBands: bands(12),
      validFrom: '2026-06-01',
    });

    // BEFORE the table started — nothing this table could have decided, so the delete goes through.
    await ledgerRow({ employmentId: emp.employmentId, leaveTypeId: typeId, effectiveOn: '2026-01-15' });
    await deleteEntitlementTemplate(adminCtx(b), { lineageId: late.lineageId });
    expect(await versionsOf(late.lineageId)).toBe(0);

    // …and the same table, with a grant INSIDE its window, refuses.
    const tpl = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'WRITTEN IN JUNE AGAIN',
      serviceBands: bands(12),
      validFrom: '2026-06-01',
    });
    await ledgerRow({ employmentId: emp.employmentId, leaveTypeId: typeId, effectiveOn: '2026-07-01' });
    const err = await deleteEntitlementTemplate(adminCtx(b), { lineageId: tpl.lineageId }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('Medical Leave');
    expect((err as Error).message).toContain('1 employee');
    // THE CAVEAT, IN THE REFUSAL ITSELF. The ledger records no table reference, so this sentence must not
    // claim the table granted those days — only that days were granted while it was in force.
    expect((err as Error).message).toMatch(/does not say which table/);
    expect((err as Error).message).toMatch(/Stop the table from a date instead/);
    expect(await versionsOf(tpl.lineageId)).toBe(1);
  });

  it('only GRANTING entries count — leave taken and manual adjustments are not evidence of a grant', async () => {
    const typeId = await leaveTypeRow();
    const emp = await hire();
    const tpl = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'PERMANENT',
      serviceBands: bands(12),
      validFrom: '2026-01-01',
    });
    await ledgerRow({
      employmentId: emp.employmentId,
      leaveTypeId: typeId,
      effectiveOn: '2026-03-01',
      entryType: 'adjustment',
      days: 2,
    });
    await deleteEntitlementTemplate(adminCtx(b), { lineageId: tpl.lineageId });
    expect(await versionsOf(tpl.lineageId)).toBe(0);
  });

  it('the grant a real generation run writes blocks it too, so this is the ledger the engine fills', async () => {
    const typeId = await leaveTypeRow('Hospitalization Leave');
    const tpl = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'All staff',
      serviceBands: bands(14),
      validFrom: '2026-01-01',
    });
    await hire();
    await openLeaveYear(adminCtx(b), { year: 2026 });
    await expect(deleteEntitlementTemplate(adminCtx(b), { lineageId: tpl.lineageId })).rejects.toThrow(
      /Hospitalization Leave/,
    );
  });

  it('a rule in force while its leave type granted cannot be deleted either, and the wording says "rule"', async () => {
    const typeId = await leaveTypeRow('Marriage Leave');
    const emp = await hire();
    const tpl = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'PERMANENT',
      serviceBands: bands(12),
      validFrom: '2026-01-01',
    });
    const early = await createEligibilityRule(adminCtx(b), {
      name: 'Everyone',
      templateLineageId: tpl.lineageId,
      criteria: {},
      validFrom: '2026-02-01',
    });
    // Dated before the rule started: outside ITS window even though the table was already in force.
    await ledgerRow({ employmentId: emp.employmentId, leaveTypeId: typeId, effectiveOn: '2026-01-10' });
    await deleteEligibilityRule(adminCtx(b), { lineageId: early.lineageId });
    expect(await ruleVersionsOf(early.lineageId)).toBe(0);

    const rule = await createEligibilityRule(adminCtx(b), {
      name: 'Everyone',
      templateLineageId: tpl.lineageId,
      criteria: {},
      validFrom: '2026-02-01',
    });
    await ledgerRow({ employmentId: emp.employmentId, leaveTypeId: typeId, effectiveOn: '2026-03-10' });
    const err = await deleteEligibilityRule(adminCtx(b), { lineageId: rule.lineageId }).catch((e: Error) => e);
    expect((err as Error).message).toContain('Marriage Leave');
    expect((err as Error).message).toMatch(/does not say which rule/);
    expect((err as Error).message).toMatch(/Stop the rule from a date instead/);
    expect(await ruleVersionsOf(rule.lineageId)).toBe(1);
  });

  it('the window spans EVERY version of the lineage, not just the running one', () => {
    // Pure, so the arithmetic is stated once rather than inferred from a refusal.
    expect(
      lineageInForceWindow([
        { validFrom: '2026-02-01', validTo: '2026-06-01' },
        { validFrom: '2026-01-01', validTo: '2026-02-01' },
      ]),
    ).toEqual({ from: '2026-01-01', to: '2026-06-01' });
    // A running version leaves the window open-ended, whatever the closed ones say.
    expect(
      lineageInForceWindow([
        { validFrom: '2026-01-01', validTo: '2026-02-01' },
        { validFrom: '2026-02-01', validTo: null },
      ]),
    ).toEqual({ from: '2026-01-01', to: null });
    expect(lineageInForceWindow([])).toBeNull();
  });

  /**
   * ⚠️ THE CASE THE CENTRAL PROMISE DIES ON, AND IT IS NOT HYPOTHETICAL — migration 0376 stamped
   * `accrual_unconfigured` on EVERY non-archived leave type, and `openLeaveYear` writes ONE `accrual`
   * row per employee per type per year UNCONDITIONALLY (its own idempotency open-marker and the expiry
   * sweep's "year was opened" marker), forced to 0.00 days for a type carrying that marker.
   *
   * So the customer's ledger is full of 0-day `accrual` rows for types that granted nobody anything. A
   * guard filtering on ENTRY TYPE alone counts every one of them: the never-used table this whole item
   * exists to let them clear becomes undeletable, and the refusal asserts something FALSE — "granted
   * entitlement to 1 employee" over a ledger holding zero days. This is the exact reproduction: one
   * unconfigured type, one table, one employee, one `openLeaveYear`.
   */
  it('the 0-day open-marker openLeaveYear ALWAYS writes is not a grant', async () => {
    const typeId = await leaveTypeRow('Annual Leave');
    await owner.db
      .update(schema.leaveType)
      .set({ accrualUnconfigured: new Date() })
      .where(eq(schema.leaveType.id, typeId));
    const tpl = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'All staff',
      serviceBands: bands(12),
      validFrom: '2026-01-01',
    });
    const emp = await hire();
    await openLeaveYear(adminCtx(b), { year: 2026 });

    // The ledger DOES hold a granting-entry-type row for this type, and it grants nothing.
    const marker = await owner.db
      .select({ entryType: schema.leaveLedger.entryType, days: schema.leaveLedger.days })
      .from(schema.leaveLedger)
      .where(
        and(
          eq(schema.leaveLedger.leaveTypeId, typeId),
          eq(schema.leaveLedger.employmentId, emp.employmentId),
        ),
      );
    expect(marker).toEqual([{ entryType: 'accrual', days: '0.00' }]);

    // …so the table is still deletable, and the whole lineage goes.
    await deleteEntitlementTemplate(adminCtx(b), { lineageId: tpl.lineageId });
    expect(await versionsOf(tpl.lineageId)).toBe(0);
  });

  /**
   * The SCREEN's reader names the pointing rules and NOTHING ELSE — see `entitlementDeleteBlocks` for
   * the measurement behind that (pre-computing the grant half cost 1.7s per page render at 50,000 ledger
   * rows, because leave_ledger's RLS calls a recursive SECURITY DEFINER function per row). What this
   * pins is the half that IS promised on the row: the rules, BY NAME, so the operator's next step is
   * spelled out — and that a grant does not silently take the Delete control away from a row.
   */
  it('the screen reader names the pointing rules, and reads no ledger', async () => {
    const typeId = await leaveTypeRow();
    const emp = await hire();
    const free = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'FREE',
      serviceBands: bands(12),
      validFrom: '2026-01-01',
    });
    const ruled = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'RULED',
      serviceBands: bands(14),
      validFrom: '2026-01-01',
    });
    await createEligibilityRule(adminCtx(b), {
      name: 'Managers',
      templateLineageId: ruled.lineageId,
      criteria: {},
      validFrom: '2026-01-01',
    });
    const blocks = await entitlementDeleteBlocks(adminCtx(b));
    expect(blocks.templates.get(ruled.lineageId)?.rules).toEqual(['Managers']);
    expect(isDeletableLineage(blocks.templates.get(ruled.lineageId))).toBe(false);
    expect(isDeletableLineage(blocks.templates.get(free.lineageId))).toBe(true);

    // A grant inside the window does NOT change what the row offers — the delete refuses it instead.
    await ledgerRow({ employmentId: emp.employmentId, leaveTypeId: typeId, effectiveOn: '2026-05-01' });
    const after = await entitlementDeleteBlocks(adminCtx(b));
    expect(isDeletableLineage(after.templates.get(free.lineageId))).toBe(true);
    await expect(deleteEntitlementTemplate(adminCtx(b), { lineageId: free.lineageId })).rejects.toThrow(
      /cannot be deleted/,
    );
  });
});

// ── §B2 the company-scope fence on a rule delete ────────────────────────────────────────────────────

/**
 * §B2 r210 · THE ONE FENCE THE DATABASE CANNOT APPLY TO A DELETE.
 *
 * Migration 0409 restored the company-scoped write check on `entitlement_eligibility_rule` — as an RLS
 * WITH CHECK, and WITH CHECK is consulted for INSERT and UPDATE only. The policy's USING clause is
 * tenant-wide on purpose (the accrual kernel resolves entitlement under non-admin sessions), so a DELETE
 * is fenced by tenant and by NOTHING ELSE. `retireEligibilityRule` is an UPDATE and IS refused by that
 * check; delete must not be the weaker door, so `assertMayDeleteRuleLineage` asks the same predicate in
 * application code.
 *
 * ⚠️ IT IS THEREFORE THE ONLY COMPANY FENCE ON THIS PATH, AND NOTHING ELSE IN THE SUITE ASSERTS IT.
 * Replacing the call with a comment leaves the whole suite green — which is exactly how a later edit
 * removes a fence nobody notices. These four cases are that pin.
 */
describe('§B2 r210 · a company-scoped admin cannot delete another company\'s eligibility rule', () => {
  /** A second company, so "another company's rule" is a real row rather than a made-up uuid. */
  async function otherCompany(): Promise<string> {
    const [c] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd' })
      .returning({ id: schema.company.id });
    return c.id;
  }
  /** The same admin, granted for ONE company instead of the whole group. `withTenant` publishes
   *  `ctx.grants` as the `app.grants` GUC, which is what `app.is_admin_for` / `app.is_group_admin` read —
   *  so this is the real session shape, not a stub of the predicate. */
  const scopedTo = (companyId: string) => ({
    ...adminCtx(b),
    grants: [{ role: 'hr_admin', companyId }],
  });

  async function ruleFor(criteria: Record<string, unknown>) {
    const typeId = await leaveTypeRow();
    const tpl = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'PERMANENT',
      serviceBands: bands(12),
      validFrom: '2026-01-01',
    });
    return createEligibilityRule(adminCtx(b), {
      name: 'Targeted',
      templateLineageId: tpl.lineageId,
      criteria,
      validFrom: '2026-01-01',
    });
  }

  it('a GROUP admin may delete a company-scoped rule', async () => {
    const rule = await ruleFor({ companyIds: [b.companyId] });
    await deleteEligibilityRule(adminCtx(b), { lineageId: rule.lineageId });
    expect(await ruleVersionsOf(rule.lineageId)).toBe(0);
  });

  it('a COMPANY-scoped admin may delete their own company\'s rule', async () => {
    const rule = await ruleFor({ companyIds: [b.companyId] });
    await deleteEligibilityRule(scopedTo(b.companyId), { lineageId: rule.lineageId });
    expect(await ruleVersionsOf(rule.lineageId)).toBe(0);
  });

  it('…and is REFUSED on a rule that reaches the whole group, which needs a group admin', async () => {
    const rule = await ruleFor({});
    const err = await deleteEligibilityRule(scopedTo(b.companyId), { lineageId: rule.lineageId }).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/reaches every company/);
    // Refused BEFORE anything was removed — the guard runs inside the same transaction, first.
    expect(await ruleVersionsOf(rule.lineageId)).toBe(1);
  });

  it('…and is REFUSED on another company\'s rule', async () => {
    const beta = await otherCompany();
    const rule = await ruleFor({ companyIds: [beta] });
    const err = await deleteEligibilityRule(scopedTo(b.companyId), { lineageId: rule.lineageId }).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/a company you administer/);
    expect(await ruleVersionsOf(rule.lineageId)).toBe(1);
  });
});

// ── §C the health card ──────────────────────────────────────────────────────────────────────────────

describe('§C r210 · a deleted table is not still reported as a table without a rule', () => {
  const healthType = (id: string): HealthLeaveType => ({
    id,
    name: 'Annual Leave',
    accrualMethod: 'grant_on_hire_prorated',
    accrualUnconfigured: false,
    archived: false,
  });

  it('the finding names both tables, then only the survivor, from the same derivation', async () => {
    const typeId = await leaveTypeRow('Annual Leave');
    const keep = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'KEEP',
      serviceBands: bands(12),
      validFrom: '2026-01-01',
    });
    const drop = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'TYPED BY MISTAKE',
      serviceBands: bands(14),
      validFrom: '2026-01-01',
    });

    const healthNow = async () =>
      leaveTypeConfigHealth({
        leaveType: healthType(typeId),
        templates: await listEntitlementTemplates(adminCtx(b), { leaveTypeId: typeId }),
        rules: await listEligibilityRules(adminCtx(b)),
        grades: [],
        today: TODAY,
      });

    const before = await healthNow();
    expect(before.findings).toContain('table_without_rule');
    expect(before.tablesWithoutRule.sort()).toEqual(['KEEP', 'TYPED BY MISTAKE']);
    expect(before.templateCount).toBe(2);

    await deleteEntitlementTemplate(adminCtx(b), { lineageId: drop.lineageId });

    const after = await healthNow();
    // The deleted table is not named at all any more — not as a finding, not in the count.
    expect(after.tablesWithoutRule).toEqual([]);
    expect(after.templateCount).toBe(1);
    // …and the one table left with no rule is now the r193 sole-table shape, which is HEALTHY, not a
    // finding. That is the health module's own gate, read rather than re-implemented here.
    expect(after.soleTableApplies).toBe(true);
    expect(after.findings).toEqual([]);
    // The delete was scoped: the table that was kept still has its version.
    expect(await versionsOf(keep.lineageId)).toBe(1);
    expect(await versionsOf(drop.lineageId)).toBe(0);
  });
});

// ── §D the screen and the two actions ───────────────────────────────────────────────────────────────

const BLOCK = 'app/admin/leave/entitlements/templates/entitlement-tables-block.tsx';
const ACTIONS = 'app/admin/leave/entitlements/templates/actions.ts';

describe('§D r210 · Stop and Delete are ROW actions, on both blocks, and every caption exists', () => {
  const blockSrc = read(BLOCK);
  /** The two table bodies, sliced apart so "the control is on the ROW" is asserted rather than "the
   *  control is somewhere in this 900-line file" — which is what was true before this item. */
  const templateRows = blockSrc.slice(
    blockSrc.indexOf('{templates.map((x) => ('),
    blockSrc.indexOf('{editingTemplate ? t('),
  );
  const ruleRows = blockSrc.slice(blockSrc.indexOf('{rules.map((x) => {'), blockSrc.indexOf('{editingRule ? t('));

  it('the entitlement table rows carry Edit, Stop-from-a-date and Delete', () => {
    expect(templateRows.length).toBeGreaterThan(200);
    expect(templateRows).toContain('action={retireEntitlementTemplateAction}');
    expect(templateRows).toContain('action={deleteEntitlementTemplateAction}');
    expect(templateRows).toContain('?editTemplate=');
    // The date is typed on the row, so Stop is genuinely "from a date" and not "from today".
    expect(templateRows).toMatch(/type="date"\s+name="validTo"/);
    // Both confirmations name the record, which is the existing contract this item had to keep.
    expect(templateRows.match(/subtitle=\{x\.name\}/g)?.length).toBe(2);
  });

  it('the eligibility rule rows carry the same three', () => {
    expect(ruleRows.length).toBeGreaterThan(200);
    expect(ruleRows).toContain('action={retireEligibilityRuleAction}');
    expect(ruleRows).toContain('action={deleteEligibilityRuleAction}');
    expect(ruleRows).toContain('?editRule=');
    expect(ruleRows).toMatch(/type="date"\s+name="validTo"/);
    expect(ruleRows.match(/subtitle=\{x\.name\}/g)?.length).toBe(2);
  });

  /**
   * ⚠️ ONE DEFINITION OF A DESTRUCTIVE CONTROL. Stop moved OUT of the edit panel; leaving a second copy
   * behind is how the two drift, and the copy several fields inside a panel is the one nobody finds —
   * which is the complaint this item opens with.
   */
  it('the edit panels no longer carry their own Stop form', () => {
    const templatePanel = blockSrc.slice(
      blockSrc.indexOf("{editingTemplate ? t('editTemplateTitle')"),
      blockSrc.indexOf('STEP 2: WHO GETS WHICH TABLE'),
    );
    const rulePanel = blockSrc.slice(blockSrc.indexOf("{editingRule ? t('editRuleTitle')"));
    expect(templatePanel.length).toBeGreaterThan(200);
    expect(rulePanel.length).toBeGreaterThan(200);
    expect(templatePanel).not.toContain('action={retireEntitlementTemplateAction}');
    expect(rulePanel).not.toContain('action={retireEligibilityRuleAction}');
    // …and the editor's own way out survived the move it was nested inside.
    expect(rulePanel).toContain("{t('cancel')}");
  });

  it('Delete is offered on the lineage HEAD, so a stopped-but-never-used table can still be cleared', () => {
    expect(blockSrc).toContain('templateHeadIds.has(x.id)');
    expect(blockSrc).toContain('ruleHeadIds.has(x.id)');
    // Computed by latest validFrom rather than taken from list order: a version may be renamed, and both
    // lists sort by name before date, so "the last row of this lineage" is not the latest one.
    expect(blockSrc).toContain('if (!prev || r.validFrom >= prev.validFrom) head.set(r.lineageId, r);');
  });

  it('where Delete is refused by a pointing rule, the row NAMES the rule', () => {
    // The plan's own words: "an eligibility rule that points at a table has to go before the table
    // itself — the screen will say so rather than making you guess." Naming them is the next step.
    expect(blockSrc).toContain("t('deleteBlockedByRules', { rules: block.rules.join(', ') })");
    expect(blockSrc).toContain('isDeletableLineage(block)');
    // …and the GRANT refusal is deliberately NOT pre-computed per row — see `entitlementDeleteBlocks`
    // for the measurement. A caption for it here would put the ledger read back on the page render.
    expect(blockSrc).not.toContain('deleteBlockedByGrants');
    expect(blockSrc).not.toContain('ruleDeleteBlocks');
  });

  it('every new caption resolves in all six catalogues', () => {
    // The block reads FOUR namespaces, so test/i18n-coverage.test.ts's check C skips it entirely — a
    // missing key here paints MISSING_MESSAGE behind a green 200 (AGENTS rule 6).
    const keys = [
      'stop',
      'delete',
      'deleteTemplate',
      'deleteTemplateConfirm',
      'deleteRule',
      'deleteRuleConfirm',
      'deleteBlockedByRules',
      'ruleTargetStopped',
    ];
    for (const k of keys) expect(blockSrc, `${k} must be asked for`).toContain(`t('${k}'`);
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`messages/${loc}.json`)) as Record<string, never>;
      for (const k of keys) {
        expect(leaf(msgs, `admin.entitlementTemplates.${k}`), `${loc}.${k}`).toBeTruthy();
      }
    }
    // The captions carry the placeholders the block passes, in every locale — a missing one renders the
    // sentence without the fact it exists to state.
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`messages/${loc}.json`)) as Record<string, never>;
      expect(String(leaf(msgs, 'admin.entitlementTemplates.deleteBlockedByRules')), loc).toContain('{rules}');
      expect(String(leaf(msgs, 'admin.entitlementTemplates.ruleTargetStopped')), loc).toContain('{table}');
    }
  });

  /**
   * The plan's own words: "after a table is stopped or deleted, the eligibility rules that pointed at it
   * are named on screen, because from that moment they reach nobody." Stopping deliberately leaves those
   * rules alone, so the rule's own row is where the consequence has to show — it printed a bare dash,
   * which reads as "no table chosen" rather than "the table it points at has been stopped".
   */
  it('a rule whose table has been stopped names the table instead of printing a dash', () => {
    expect(blockSrc).toContain("t('ruleTargetStopped', { table: stoppedTarget.name })");
    // Resolved from the lineage HEAD, so a stopped table is still nameable after it left the in-force set.
    expect(blockSrc).toContain('templateHeads.get(x.templateLineageId)');
  });

  it('the module header records that the ledger cannot attribute a grant to a table', () => {
    // So a future round widens the guard on purpose rather than assuming it was ever exact.
    const src = read('core/entitlement-template.ts');
    // The MODULE header — everything above the first import — not merely somewhere in the file: this is
    // the paragraph the next reader of the module meets before any of its code.
    const header = src.slice(0, src.indexOf("\nimport "));
    expect(header).toMatch(/REFERENCE TO THE ENTITLEMENT TABLE OR THE ELIGIBILITY RULE/);
    expect(header).toMatch(/HAS NO EXACT ANSWER/);
    expect(header).toMatch(/conservative\s+\*?\s*approximation/);
  });
});

describe('§D r210 · the delete actions resolve the leave type BEFORE the row is gone', () => {
  /**
   * ⚠️ THE TRAP THIS PINS. `leaveTypeIdForTemplateLineage` reads the lineage's own rows. Asked AFTER a
   * successful delete it returns null, `recomputeAfterSave` returns immediately, and the recalculation
   * the reporter asked for in r209 silently stops happening on exactly the write that changes the most.
   * It looks wired in every review and in every source read of the action body.
   */
  it('the source asks for it before the delete, for both actions', () => {
    const src = read(ACTIONS);
    for (const [action, service, derive] of [
      ['deleteEntitlementTemplateAction', 'deleteEntitlementTemplate(', 'leaveTypeIdForTemplateLineage('],
      ['deleteEligibilityRuleAction', 'deleteEligibilityRule(', 'leaveTypeIdForRuleLineage('],
    ] as const) {
      const start = src.indexOf(`export async function ${action}(`);
      expect(start, action).toBeGreaterThan(-1);
      const body = src.slice(start, src.indexOf('\n}\n', start));
      expect(body.indexOf(derive), `${action}: derives the leave type`).toBeGreaterThan(-1);
      expect(body.indexOf(derive), `${action}: derives it BEFORE the delete`).toBeLessThan(
        body.indexOf(`await ${service}`),
      );
    }
  });

  it('a successful delete redirects with a toast; a refused one comes back with the reason on screen', async () => {
    const typeId = await leaveTypeRow();
    const tpl = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'PERMANENT',
      serviceBands: bands(12),
      validFrom: '2026-01-01',
    });
    const rule = await createEligibilityRule(adminCtx(b), {
      name: 'Executives',
      templateLineageId: tpl.lineageId,
      criteria: {},
      validFrom: '2026-01-01',
    });

    const refusal = await captureRedirect(() =>
      deleteEntitlementTemplateAction(fd({ lineageId: tpl.lineageId, name: 'PERMANENT' })),
    );
    expect(refusal).toContain('?error=');
    expect(decodeURIComponent(refusal)).toContain('Executives');
    expect(await versionsOf(tpl.lineageId)).toBe(1);

    const ruleGone = await captureRedirect(() =>
      deleteEligibilityRuleAction(fd({ lineageId: rule.lineageId, name: 'Executives' })),
    );
    expect(ruleGone).toContain('?toast=');
    expect(decodeURIComponent(ruleGone)).toContain('Deleted Executives');

    // The embedded mount returns to the step it was pressed on, anchor and all.
    const embedded = await captureRedirect(() =>
      deleteEntitlementTemplateAction(
        fd({ lineageId: tpl.lineageId, name: 'PERMANENT', embeddedLeaveTypeId: typeId }),
      ),
    );
    expect(embedded).toContain(`#type-${typeId}`);
    expect(await versionsOf(tpl.lineageId)).toBe(0);
  });
});
