/**
 * 6e9a126e RELEASE ONE — the written record of everything the reset will clear, and its READER.
 *
 * The approved plan tells the reporter: "Before anything is cleared we take a written record of BOTH
 * layers… That record becomes a read-only listing inside your admin screens that you can open and
 * download, so you read the old figures off it while you retype them rather than working from memory."
 *
 * ⚠️ THE CITED PRECEDENT IS A WARNING, NOT A MODEL. `leave_shared_group_reset_archive` (0342) has the
 * right SHAPE — denormalised to text so it survives the DROP of everything it describes — and the wrong
 * POSTURE: test/shared-leave-group-single-mechanism.test.ts asserts that no core file reads it. So the
 * things pinned here are the ones that precedent got wrong:
 *
 *  1. BOTH layers are captured. Revision 3 of the plan specified only the scheme side; the 67 leave_policy
 *     rows are the OTHER HALF of what release three clears, and on production they are doing most of the
 *     work (17 of 26 live employments fall through to them).
 *  2. A scheme with NO entitlement table still appears. Two such schemes exist on production. A record
 *     that silently omits them under-reports what was configured.
 *  3. The band table is rendered READABLE, in the reporter's own column order, because retyping from it is
 *     its entire purpose.
 *  4. It is RE-RUNNABLE and tagged, because release three re-captures immediately before clearing.
 *  5. There is a reader and a CSV.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createJobGrade, createLeavePolicy } from '../core/admin';
import { createBenefitScheme, createGradeGroup, upsertSchemeEntitlement } from '../core/benefit-scheme';
import {
  captureEntitlementResetArchive,
  entitlementResetArchiveCsv,
  listEntitlementArchiveCaptures,
  listEntitlementResetArchive,
} from '../core/entitlement-archive';
import type { ServiceBand } from '../core/leave-compute';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

let b: Base;
const TAG = 'test-capture';

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const REPORTER_TABLE: ServiceBand[] = [
  { fromYears: 0, toYears: 2, days: 14, carryForwardDays: 5, maxBalanceDays: 19 },
  { fromYears: 2, toYears: null, days: 16, carryForwardDays: 5, maxBalanceDays: 21 },
];

/** A scheme WITH a band table, a scheme WITHOUT one, and two dated leave_policy versions. */
async function seedBothLayers() {
  const ctx = adminCtx(b);
  const grade = await createJobGrade(ctx, { code: `G${randomUUID().slice(0, 4)}`, name: 'Grade 12' });
  const group = await createGradeGroup(ctx, { name: 'Grade 12-15', gradeIds: [grade.id] });

  const configured = await createBenefitScheme(ctx, {
    companyId: b.companyId,
    employmentType: 'full_time',
    gradeGroupId: group.id,
    name: 'Grade 12-15 Permanent',
    schemeCategory: 'Permanent',
    status: 'active',
  });
  await upsertSchemeEntitlement(ctx, {
    benefitSchemeId: configured.id,
    leaveTypeId: b.annualLeaveTypeId,
    serviceBands: REPORTER_TABLE,
  });

  // The production case that makes the LEFT JOIN load-bearing: a scheme somebody created and never filled
  // in. Two of these exist live.
  const empty = await createBenefitScheme(ctx, {
    companyId: b.companyId,
    employmentType: 'contract',
    gradeGroupId: group.id,
    name: 'Contract (unfilled)',
    status: 'active',
  });

  // The policy layer — TWO versions, so the dated windows are exercised rather than just the running one.
  await createLeavePolicy(ctx, {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays: 12,
    carryForwardMax: 5,
    method: 'earned_monthly',
    validFrom: '2024-01-01',
  });
  await createLeavePolicy(ctx, {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays: 14,
    validFrom: '2026-01-01',
  });
  return { grade, group, configured, empty };
}

describe('the entitlement reset archive captures BOTH layers, in text', () => {
  it('records the scheme layer with its band table rendered the way the reporter reads it', async () => {
    await seedBothLayers();
    const res = await captureEntitlementResetArchive(adminCtx(b), { captureTag: TAG });
    expect(res.schemeRows).toBe(2); // one configured + one with no entitlement table
    expect(res.policyRows).toBe(2); // both dated versions

    const rows = await listEntitlementResetArchive(adminCtx(b), { captureTag: TAG });
    const scheme = rows.find((r) => r.schemeName === 'Grade 12-15 Permanent')!;
    expect(scheme.layer).toBe('scheme');
    expect(scheme.schemeCategory).toBe('Permanent');
    expect(scheme.leaveTypeName).toBe('Annual Leave');
    expect(scheme.leaveTypeCode).toBe('ANNUAL');
    expect(scheme.companyName).toBe('Acme Sdn Bhd');
    expect(scheme.employmentType).toBe('full_time');
    expect(scheme.schemeGradeGroupName).toBe('Grade 12-15');
    // The grade group SURVIVES the reset, but the record still says who the table reached — a group name
    // with no members is not something anybody can retype against.
    expect(scheme.schemeGradeGroupMembers).toContain('Grade 12');
    // The reporter's four columns, in their order, as readable text. This string is the deliverable.
    expect(scheme.entitlementText).toBe(
      '0-2 yrs: 14 days, max brought forward 5, max entitled + brought forward 19 | ' +
        '2-no limit yrs: 16 days, max brought forward 5, max entitled + brought forward 21',
    );
    // The scheme layer genuinely has no dates. Saying so beats inventing a window.
    expect(scheme.validFromText).toMatch(/not dated/i);
  });

  it('records a scheme that carries NO entitlement table at all — the production case', async () => {
    await seedBothLayers();
    await captureEntitlementResetArchive(adminCtx(b), { captureTag: TAG });
    const rows = await listEntitlementResetArchive(adminCtx(b), { captureTag: TAG });
    const empty = rows.find((r) => r.schemeName === 'Contract (unfilled)')!;
    expect(empty).toBeTruthy();
    expect(empty.entitlementText).toBeNull();
    expect(empty.note).toMatch(/NO entitlement table/i);
    // WATCHED FAIL: with an INNER JOIN this row does not exist, and the record silently under-reports
    // what was configured — which is the one promise the eventual clearing makes.
  });

  it('records the POLICY layer, per dated version, with its figures rendered', async () => {
    await seedBothLayers();
    await captureEntitlementResetArchive(adminCtx(b), { captureTag: TAG });
    const rows = await listEntitlementResetArchive(adminCtx(b), { captureTag: TAG });
    const policies = rows.filter((r) => r.layer === 'policy');
    expect(policies).toHaveLength(2);

    const closed = policies.find((r) => r.validFromText === '2024-01-01')!;
    expect(closed.entitlementText).toContain('Days: 12');
    expect(closed.entitlementText).toContain('earning method: earned_monthly');
    expect(closed.entitlementText).toContain('max carry forward: 5');
    // Superseded by the 2026 version — the window is part of the record, because leave_policy is the only
    // DATED layer and its history is what the past-date readers resolve against.
    expect(closed.validToText).toBe('2026-01-01');

    const running = policies.find((r) => r.validFromText === '2026-01-01')!;
    expect(running.entitlementText).toContain('Days: 14');
    expect(running.validToText).toMatch(/still in force/i);
    // A null company is the GROUP DEFAULT — a value somebody chose, not missing data.
    expect(running.companyName).toBeNull();
    expect(running.note).toMatch(/group default/i);
  });
});

describe('the rendered figures are readable, with no half-written labels', () => {
  it('an UNBANDED policy prints no dangling "service bands:" label', async () => {
    // FOUND ON A REAL RENDER, NOT BY A TEST, which is why it is pinned here. `jsonb_typeof(missing_key)`
    // is NULL rather than a string, so `jsonb_typeof(...) <> 'array'` evaluates to NULL — which is not
    // TRUE, so the ELSE branch ran and every unbanded policy (all three on the dev database, and the
    // majority on production) printed "| service bands: " with nothing after it. A record the reporter
    // retypes from cannot end its most important column in a colon.
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      validFrom: '2026-01-01',
    });
    await captureEntitlementResetArchive(adminCtx(b), { captureTag: TAG });
    const [row] = await listEntitlementResetArchive(adminCtx(b), { captureTag: TAG });
    expect(row.entitlementText).toContain('Days: 12');
    expect(row.entitlementText).not.toContain('service bands');
    expect(row.entitlementText!.trim().endsWith(':')).toBe(false);
  });

  it('a BANDED policy prints its bands', async () => {
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      serviceBands: REPORTER_TABLE,
      validFrom: '2026-01-01',
    });
    await captureEntitlementResetArchive(adminCtx(b), { captureTag: TAG });
    const [row] = await listEntitlementResetArchive(adminCtx(b), { captureTag: TAG });
    expect(row.entitlementText).toContain('service bands: 0-2 yrs: 14 days');
    expect(row.entitlementText).toContain('2-no limit yrs: 16 days');
  });
});

describe('the record is re-runnable, tagged, and readable', () => {
  it('re-running the SAME tag adds nothing — a double-click cannot double the record', async () => {
    await seedBothLayers();
    const first = await captureEntitlementResetArchive(adminCtx(b), { captureTag: TAG });
    const second = await captureEntitlementResetArchive(adminCtx(b), { captureTag: TAG });
    expect(second).toEqual({ schemeRows: 0, policyRows: 0 });
    const rows = await listEntitlementResetArchive(adminCtx(b), { captureTag: TAG });
    expect(rows).toHaveLength(first.schemeRows + first.policyRows);
  });

  it('a LATER tag is a new snapshot, and the listing shows the latest by default', async () => {
    await seedBothLayers();
    await captureEntitlementResetArchive(adminCtx(b), { captureTag: 'release-one' });
    // Release three re-captures immediately before clearing, because configuration moves in between.
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 20,
      validFrom: '2026-07-01',
    });
    const again = await captureEntitlementResetArchive(adminCtx(b), { captureTag: 'pre-reset' });
    expect(again.policyRows).toBe(3);

    const captures = await listEntitlementArchiveCaptures(adminCtx(b));
    expect(captures.map((c) => c.captureTag)).toContain('release-one');
    expect(captures.map((c) => c.captureTag)).toContain('pre-reset');

    // No tag ⇒ the most recent snapshot. Interleaving two captures months apart would have the reporter
    // retyping a mixture of both.
    const latest = await listEntitlementResetArchive(adminCtx(b));
    expect(latest.every((r) => r.captureTag === 'pre-reset')).toBe(true);
  });

  it('downloads as a CSV carrying every column the reporter retypes from', async () => {
    await seedBothLayers();
    await captureEntitlementResetArchive(adminCtx(b), { captureTag: TAG });
    const file = await entitlementResetArchiveCsv(adminCtx(b), { captureTag: TAG });
    expect(file.filename).toContain('entitlement-configuration-record');
    expect(file.filename.endsWith('.csv')).toBe(true);
    const lines = file.content.trim().split('\n');
    expect(lines[0]).toContain('Entitlement');
    expect(lines[0]).toContain('In force from');
    expect(lines).toHaveLength(file.rows + 1);
    expect(file.content).toContain('Grade 12-15 Permanent');
    expect(file.content).toContain('0-2 yrs: 14 days');
    // The group default is SPELT OUT in the export: a blank cell in a spreadsheet reads as "unknown".
    expect(file.content).toContain('All companies (group default)');
  });

  it('an empty archive reads as empty rather than throwing', async () => {
    expect(await listEntitlementArchiveCaptures(adminCtx(b))).toEqual([]);
    expect(await listEntitlementResetArchive(adminCtx(b))).toEqual([]);
    const file = await entitlementResetArchiveCsv(adminCtx(b));
    expect(file.rows).toBe(0);
    expect(file.content.trim().split('\n')).toHaveLength(1); // header only
  });

  it('refuses a blank capture tag rather than writing an unfindable snapshot', async () => {
    await expect(captureEntitlementResetArchive(adminCtx(b), { captureTag: '  ' })).rejects.toThrow(
      /capture tag is required/i,
    );
  });
});
