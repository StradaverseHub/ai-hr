import {randomUUID} from 'node:crypto';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {claimRequest} from '../db/schema';
import {hireEmployee} from '../core/org';
import {createClaimType, listClaimHistoryPage, listClaimDraftsForEmployment, listClaimsForEmployment, listEmploymentClaimsCursorPage} from '../packs/claims/service';
import {adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base} from './harness';
import {ALL_ROW_CEILING} from '../lib/pagination';
let base: Base;
beforeAll(() => migrateTestDb());
beforeEach(async () => {await resetDb(); base = await seedBase();});
afterAll(() => closeAll());
async function fixture() {
  const ctx = adminCtx(base);
  const subject = await hireEmployee(ctx, {person: {fullName: 'Pagination fixture', primaryEmail: 'paging@example.test'},
    companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01'});
  const type = await createClaimType(ctx, {code: 'PAGE', name: 'Page fixture', defaultTaxable: false, requiresReceipt: false});
  const ids = Array.from({length: 61}, () => randomUUID()).sort().reverse();
  await owner.db.insert(claimRequest).values(ids.map((id, i) => ({id, tenantId: base.tenantId,
    employmentId: subject.employmentId, claimTypeId: type.id, amount: '1.00', incurredOn: '2026-01-02',
    status: i === 60 ? 'draft' as const : 'pending' as const, createdAt: new Date('2026-01-03T00:00:00Z')})));
  return {ctx, subject, ids};
}
describe('claims history database pagination', () => {
  it('returns only the requested page in stable order and keeps drafts separate', async () => {
    const {ctx, subject, ids} = await fixture();
    const first = await listClaimHistoryPage(ctx, subject.employmentId);
    const second = await listClaimHistoryPage(ctx, subject.employmentId, {page: '1'});
    const third = await listClaimHistoryPage(ctx, subject.employmentId, {page: '2'});
    expect(first.rows.map(row => row.id)).toEqual(ids.slice(0, 25));
    expect(second.rows.map(row => row.id)).toEqual(ids.slice(25, 50));
    expect(third.rows.map(row => row.id)).toEqual(ids.slice(50, 60));
    expect(first.state).toMatchObject({total: 60, from: 1, to: 25, hasNext: true});
    expect(third.state).toMatchObject({total: 60, from: 51, to: 60, hasNext: false});
    expect((await listClaimDraftsForEmployment(ctx, subject.employmentId)).map(row => row.id)).toEqual([ids[60]]);
    expect((await listClaimsForEmployment(ctx, subject.employmentId, {claimId: ids[30]})).map(row => row.id)).toEqual([ids[30]]);
  });
  it('caps All and invalid sizes and returns an honest empty out-of-range page', async () => {
    const {ctx, subject} = await fixture();
    expect((await listClaimHistoryPage(ctx, subject.employmentId, {size: 'all'})).state.limit).toBe(ALL_ROW_CEILING);
    expect((await listClaimHistoryPage(ctx, subject.employmentId, {size: '1000000'})).rows).toHaveLength(25);
    const beyond = await listClaimHistoryPage(ctx, subject.employmentId, {page: '20'});
    expect(beyond.rows).toEqual([]); expect(beyond.state).toMatchObject({total: 60, from: 0, to: 0, hasPrev: true});
  });
  it('uses SQL cursor pages with all-status counts and validates input', async () => {
    const {ctx,subject,ids} = await fixture();
    const one = await listEmploymentClaimsCursorPage(ctx,subject.employmentId,{limit:25,cursor:null});
    const two = await listEmploymentClaimsCursorPage(ctx,subject.employmentId,{limit:25,cursor:one.next});
    expect(one.rows.map(row=>row.id)).toEqual(ids.slice(0,25));
    expect(two.rows.map(row=>row.id)).toEqual(ids.slice(25,50));
    expect(one.counts).toEqual({draft:1,pending:60,approved:0,rejected:0,cancelled:0,paid:0});
    const drafts=await listEmploymentClaimsCursorPage(ctx,subject.employmentId,{status:'draft',limit:25,cursor:null});
    expect(drafts.rows.map(row=>row.id)).toEqual([ids[60]]);expect(drafts.counts).toEqual(one.counts);expect(drafts.next).toBeNull();
    for(const limit of [0,101,1.5])expect(()=>listEmploymentClaimsCursorPage(ctx,subject.employmentId,{limit,cursor:null})).toThrow('Invalid claim page');
    expect(()=>listEmploymentClaimsCursorPage(ctx,subject.employmentId,{limit:25,cursor:['invalid','invalid']})).toThrow('Invalid claim page');
  });

  it('preserves tenant and employment isolation for paged and detail reads', async () => {
    const {subject, ids} = await fixture();
    const other = await seedBase();
    expect((await listClaimHistoryPage(adminCtx(other), subject.employmentId)).rows).toEqual([]);
    expect((await listClaimHistoryPage(adminCtx(other), subject.employmentId)).state.total).toBe(0);
    expect(await listClaimsForEmployment(adminCtx(other), subject.employmentId, {claimId: ids[0]})).toEqual([]);
  });
});
