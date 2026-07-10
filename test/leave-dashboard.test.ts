/**
 * Leave View Dashboard (feedback 6d78f373) — the employee /me Leave-tab redesign into PRIMARY summary cards +
 * SECONDARY collapsible groups, with sensitive/rarely-used types hidden. This build is PRESENTATION-ONLY (no
 * calc/entitlement/eligibility change); the numeric source (deriveBalanceRow), the placement resolution
 * (lib/leave-groups, exercised by leave-grouping-visibility.test.ts) and the side panel are reused as-is.
 *
 * What is NEW here and therefore tested:
 *   1. Partition + group assignment the card/group renderer relies on (pure lib/leave-groups):
 *      - PRIMARY_CODES ⇒ 'primary' (cards); default-hidden set ⇒ 'hidden' (dropped); else ⇒ 'secondary'.
 *      - resolveSecondaryGroup buckets secondary types into Family & Personal / Education / Other.
 *   2. Hidden gate on the Request Leave dropdown (reporter §3): listEligibleLeaveTypesFor must DROP a type
 *      that resolves to 'hidden' — via EITHER the code-keyed default-hidden set OR visible_to_employee=false —
 *      while keeping ordinary types, and must ADMIT it again once HR gives it an explicit placement
 *      ("unless the new configuration allows employee access"). Ordinary/unconfigured types are unaffected.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { listEligibleLeaveTypesFor } from '../core/read';
import type { SessionContext } from '../db/client';
import {
  PRIMARY_CODES,
  SECONDARY_GROUPS,
  defaultPlacementForCode,
  resolvePlacement,
  resolveSecondaryGroup,
} from '../lib/leave-groups';
import {
  adminCtx,
  closeAll,
  createAppUser,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

function uniqCode(prefix = 'DASH'): string {
  return `${prefix}_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;
}

/** Insert an active, everyone-eligible, calendar-counted leave type (unique code ⇒ insert-only is safe). */
async function leaveType(
  code: string,
  opts: { essPlacement?: string | null; visibleToEmployee?: boolean | null } = {},
): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code,
      name: code,
      paid: true,
      counting: 'calendar_days',
      essPlacement: opts.essPlacement ?? null,
      visibleToEmployee: opts.visibleToEmployee ?? null,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

async function hireEmployeeCtx(): Promise<{ ctx: SessionContext; employmentId: string }> {
  const { employmentId, personId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Dash', primaryEmail: `dash_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { ctx: { tenantId: b.tenantId, userId, roles: ['employee'], personId }, employmentId };
}

describe('leave-groups — card / group partition (pure)', () => {
  it('PRIMARY_CODES resolve to primary cards; unknown codes fall to secondary', () => {
    for (const code of PRIMARY_CODES) {
      expect(defaultPlacementForCode(code)).toBe('primary');
      expect(resolvePlacement(code, null, null)).toBe('primary');
    }
    expect(resolvePlacement(uniqCode(), null, null)).toBe('secondary');
  });

  it('the sensitive/rarely-used set defaults to hidden (dropped from cards + groups)', () => {
    for (const code of ['PROLONGED_ILLNESS_FULL', 'SUSPENSION_NOPAY', 'UNRECORDED', 'UNPAID_MEDICAL']) {
      expect(resolvePlacement(code, null, null)).toBe('hidden');
    }
  });

  it('resolveSecondaryGroup buckets into the three labelled groups (unknown ⇒ other)', () => {
    expect(resolveSecondaryGroup('MARRIAGE')).toBe('family_personal');
    expect(resolveSecondaryGroup('MATERNITY')).toBe('family_personal');
    expect(resolveSecondaryGroup('STUDY')).toBe('education');
    expect(resolveSecondaryGroup('EXAMINATION')).toBe('education');
    expect(resolveSecondaryGroup(uniqCode())).toBe('other');
    // every bucket is a declared group
    for (const g of ['family_personal', 'education', 'other'] as const) {
      expect(SECONDARY_GROUPS).toContain(g);
    }
  });
});

describe('Request Leave dropdown — hidden gate (listEligibleLeaveTypesFor)', () => {
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

  it('drops a code-keyed default-hidden type but keeps an ordinary one', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ordinary = await leaveType(uniqCode('ORD'));
    const hiddenByCode = await leaveType(`PROLONGED_ILLNESS_${randomUUID().slice(0, 8).toUpperCase()}`);

    const ids = new Set((await listEligibleLeaveTypesFor(ctx, employmentId)).map((t) => t.id));
    expect(ids.has(ordinary)).toBe(true);
    expect(ids.has(hiddenByCode)).toBe(false);
  });

  it('drops a visible_to_employee=false type from the dropdown', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const hiddenByFlag = await leaveType(uniqCode('FLAGHIDE'), { visibleToEmployee: false });

    const ids = new Set((await listEligibleLeaveTypesFor(ctx, employmentId)).map((t) => t.id));
    expect(ids.has(hiddenByFlag)).toBe(false);
  });

  it('re-admits a default-hidden type once HR gives it an explicit placement (config allows access)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const code = `SUSPENSION_${randomUUID().slice(0, 8).toUpperCase()}`;
    const id = await leaveType(code); // default-hidden by prefix

    let ids = new Set((await listEligibleLeaveTypesFor(ctx, employmentId)).map((t) => t.id));
    expect(ids.has(id)).toBe(false); // hidden by default

    // HR promotes it into a Secondary group ⇒ resolvePlacement returns 'secondary' ⇒ now applyable.
    await owner.db.update(schema.leaveType).set({ essPlacement: 'secondary' }).where(eq(schema.leaveType.id, id));
    ids = new Set((await listEligibleLeaveTypesFor(ctx, employmentId)).map((t) => t.id));
    expect(ids.has(id)).toBe(true);
  });
});
