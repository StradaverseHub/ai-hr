/**
 * Owner rule (4 November 2026) — `pay-without-attendance` is not an exception where the company does not use Attendance.
 * `attendanceInUseFor` is the evaluator's one decision about that, made ONCE per batch from the tenant's entitlement
 * snapshot (core/payroll-anomaly.ts gatherContext). NO DATABASE: the function is pure over the snapshot.
 *
 * THE DIRECTION OF EVERY DOUBT IS "IN USE". Answering FALSE switches the ghost-employee check off for a whole company, so
 * FALSE is only ever the answer when the tenant's own entitlements were read, the tenant is in good standing, and the
 * Attendance module is granted neither tenant-wide nor for this company. A suspended tenant (every billable module reads
 * off), an unreadable snapshot, a malformed one and the deployment kill lever all leave the check on.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { attendanceInUseFor } from '../core/payroll-anomaly';
import { TENANT_STATUS_UNRESOLVED, type EntitlementSnapshot } from '../core/entitlements';

const TENANT = '00000000-0000-4000-8000-000000000001';
const COMPANY = '00000000-0000-4000-8000-0000000000c1';
const OTHER_COMPANY = '00000000-0000-4000-8000-0000000000c2';

const snap = (over: Partial<EntitlementSnapshot> = {}): EntitlementSnapshot => ({
  tenantId: TENANT,
  enabledModules: [],
  scopedModules: {},
  settings: {},
  tenantStatus: 'active',
  ...over,
});

const killBefore = process.env.MODULE_KILL;
afterEach(() => {
  if (killBefore === undefined) delete process.env.MODULE_KILL;
  else process.env.MODULE_KILL = killBefore;
});

describe('attendanceInUseFor — is Attendance in use for this company?', () => {
  it('is FALSE only for a tenant in good standing with no Attendance grant for the company', () => {
    expect(attendanceInUseFor(snap(), COMPANY)).toBe(false);
    expect(attendanceInUseFor(snap({ tenantStatus: 'trial' }), COMPANY)).toBe(false);
    // Other modules are irrelevant to the answer.
    expect(attendanceInUseFor(snap({ enabledModules: ['payroll', 'claims'] }), COMPANY)).toBe(false);
  });

  it('tenant-wide enablement: in use for every company', () => {
    const s = snap({ enabledModules: ['payroll', 'attendance'] });
    expect(attendanceInUseFor(s, COMPANY)).toBe(true);
    expect(attendanceInUseFor(s, OTHER_COMPANY)).toBe(true);
    expect(attendanceInUseFor(snap({ enabledModules: ['attendance'], tenantStatus: 'trial' }), COMPANY)).toBe(true);
  });

  it('company-scoped enablement: in use for THAT company only', () => {
    const s = snap({ scopedModules: { attendance: [COMPANY] } });
    expect(attendanceInUseFor(s, COMPANY)).toBe(true);
    expect(attendanceInUseFor(s, OTHER_COMPANY)).toBe(false);
  });

  it('fails safe (in use) for a suspended or closed tenant, whose billable modules all read off', () => {
    for (const tenantStatus of ['suspended', 'closed', 'some-future-status']) {
      expect(attendanceInUseFor(snap({ tenantStatus }), COMPANY), tenantStatus).toBe(true);
    }
  });

  it('fails safe (in use) for a snapshot that could not be read', () => {
    // toSnapshot's shape when the tenant row was invisible: no modules, status UNRESOLVED.
    expect(attendanceInUseFor(snap({ tenantStatus: TENANT_STATUS_UNRESOLVED }), COMPANY)).toBe(true);
  });

  it('fails safe (in use) for a malformed snapshot rather than throwing or answering off', () => {
    const broken = [
      { ...snap(), enabledModules: 'attendance' },
      { ...snap(), enabledModules: null },
      { ...snap(), scopedModules: null },
      { ...snap(), scopedModules: { attendance: 'not-a-list' } },
      { ...snap(), tenantId: 42 },
    ] as unknown as EntitlementSnapshot[];
    for (const s of broken) expect(attendanceInUseFor(s, COMPANY)).toBe(true);
  });

  it('the deployment kill lever never silences the check for a company that has Attendance', () => {
    process.env.MODULE_KILL = 'attendance';
    expect(attendanceInUseFor(snap({ enabledModules: ['attendance'] }), COMPANY)).toBe(true);
    expect(attendanceInUseFor(snap({ scopedModules: { attendance: [COMPANY] } }), COMPANY)).toBe(true);
    // Not granted is still not granted.
    expect(attendanceInUseFor(snap(), COMPANY)).toBe(false);
  });
});
