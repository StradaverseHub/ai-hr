/**
 * r394 — My Leave's four history tab counts come from ONE grouped query (countLeaveRequestsByStatus) instead
 * of one list read per tab. The promise r302 made is that a tab's count and its rows can never disagree; this
 * pins it as parity with the list's own `total`, for every status, under every filter the page passes, and for
 * the employee's own RLS-narrowed view (another employee's request must count for neither).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { countLeaveRequestsByStatus, listLeaveRequestsPage } from '../core/read';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
let b: Base;
let me: { employmentId: string; personId: string };
let myCtx: SessionContext;
let sickTypeId: string;

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `sc_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2024-01-01',
  });
const insertReq = (employmentId: string, leaveTypeId: string, start: string, end: string, status: (typeof STATUSES)[number]) =>
  owner.db.insert(schema.leaveRequest).values({ tenantId: b.tenantId, employmentId, leaveTypeId, startDate: start, endDate: end, days: '1', status });

beforeAll(async () => {
  await migrateTestDb(); await resetDb(); b = await seedBase();
  me = await hire('Counts Mine');
  const other = await hire('Counts Theirs');
  const uMe = await createAppUser(b.tenantId, me.personId, 'employee');
  myCtx = { tenantId: b.tenantId, userId: uMe, roles: ['employee'], personId: me.personId };
  const [sick] = await owner.db.insert(schema.leaveType).values({
    allowNegativeBalance: true, tenantId: b.tenantId, code: `SICK_${randomUUID().slice(0, 6).toUpperCase()}`,
    name: 'Sick', paid: true, counting: 'calendar_days',
  }).returning({ id: schema.leaveType.id });
  sickTypeId = sick.id;
  const A = b.annualLeaveTypeId;
  // Uneven on purpose so a swapped or merged status shows: pending 3, approved 2, rejected 1, cancelled 0.
  await insertReq(me.employmentId, A, '2026-07-05', '2026-07-07', 'pending');
  await insertReq(me.employmentId, A, '2026-08-10', '2026-08-12', 'pending');
  await insertReq(me.employmentId, sickTypeId, '2026-06-28', '2026-07-01', 'pending');
  await insertReq(me.employmentId, A, '2026-03-02', '2026-03-03', 'approved');
  await insertReq(me.employmentId, sickTypeId, '2026-07-20', '2026-07-20', 'approved');
  await insertReq(me.employmentId, A, '2026-09-01', '2026-09-01', 'rejected');
  // Someone else's request in every status: must never count for me.
  for (const s of STATUSES) await insertReq(other.employmentId, A, '2026-07-05', '2026-07-07', s);
});
afterAll(async () => { await closeAll(); });

const FILTERS: Record<string, { leaveTypeIds?: string[]; from?: string; to?: string }> = {
  none: {},
  annualOnly: {},
  julyWindow: { from: '2026-07-01', to: '2026-07-31' },
  sickInJuly: { from: '2026-07-01', to: '2026-07-31' },
};

describe('r394 · per-status counts in one query equal the list totals', () => {
  for (const [name, f0] of Object.entries(FILTERS)) {
    it(`filter "${name}": every status count equals listLeaveRequestsPage({statuses:[s]}).total`, async () => {
      const f = { ...f0, ...(name === 'annualOnly' ? { leaveTypeIds: [b.annualLeaveTypeId] } : name === 'sickInJuly' ? { leaveTypeIds: [sickTypeId] } : {}) };
      const counts = await countLeaveRequestsByStatus(myCtx, { employmentIds: [me.employmentId], statuses: [...STATUSES], ...f });
      for (const s of STATUSES) {
        const { total } = await listLeaveRequestsPage(myCtx, { employmentIds: [me.employmentId], statuses: [s], ...f, limit: 1, offset: 0 });
        expect(counts[s] ?? 0, `${name}/${s}`).toBe(total);
      }
    });
  }

  it('the counts are the seeded distribution, not a coincidental agreement on zero', async () => {
    const counts = await countLeaveRequestsByStatus(myCtx, { employmentIds: [me.employmentId], statuses: [...STATUSES] });
    expect(counts).toEqual({ pending: 3, approved: 2, rejected: 1 });
  });

  it('the employee never counts another employee\'s request, even when naming that employment', async () => {
    const all = await countLeaveRequestsByStatus(myCtx, { statuses: [...STATUSES] });
    expect(all).toEqual({ pending: 3, approved: 2, rejected: 1 });
  });

  it('My Leave reads its tab counts with one grouped call, not a list read per tab', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'components/leave/own-leave-history.tsx'), 'utf8');
    expect(src).toContain('await countLeaveRequestsByStatus(session, {');
    expect(src).not.toMatch(/LEAVE_HISTORY_TABS\.map\(\s*async/);
  });
});
