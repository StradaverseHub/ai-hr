import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {claimRequest} from '../db/schema';
import {hireEmployee} from '../core/org';
import {currencyOfEmployment} from '../core/mobile-claims';
import {readClaimsPageData} from '../app/claims/page-data';
import {observeStatements} from './helpers/statement-observer';
import {claimRecordFacts, createClaimType, getEmployeeClaimTypes, pendingClaimTaskSummary, listClaimHistoryPage, listPendingClaims, listPendingClaimsPage, listPendingClaimSelection, listClaimDraftsForEmployment, listClaimsForEmployment} from '../packs/claims/service';
import {adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, type Base} from './harness';
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
  it('composes the employee page in one read snapshot with the same result and scope', async () => {
    const {subject, ids} = await fixture();
    await owner.db.update(claimRequest).set({status:'rejected'}).where(eq(claimRequest.id, ids[0]));
    const userId = await createAppUser(base.tenantId, subject.personId, 'employee');
    const session = {...await entitledCtx(base, ['employee']), userId, personId:subject.personId};
    const employmentId = subject.employmentId;
    const separate = await observeStatements(async () => {
      const [types, drafts, {rows:claimPage,state:pgState}, currency] = await Promise.all([
        getEmployeeClaimTypes(session, employmentId),
        listClaimDraftsForEmployment(session, employmentId),
        listClaimHistoryPage(session, employmentId),
        currencyOfEmployment(session, employmentId),
      ]);
      const rejectReasons = await claimRecordFacts(session, claimPage.filter(claim => claim.status === 'rejected').map(claim => claim.id));
      return {types, drafts, claimPage, pgState, currency, rejectReasons};
    });
    const shared = await observeStatements(() => readClaimsPageData(session, employmentId, {}));
    expect(separate.transactions).toBe(5);
    expect(shared.transactions).toBe(1);
    expect(shared.result).toEqual(separate.result);
    expect(shared.result.types).not.toHaveLength(0);
    expect(shared.result.claimPage.map(claim => claim.id)).toEqual(ids.slice(0, 25));
    expect(shared.result.drafts.map(draft => draft.id)).toEqual([ids[60]]);
    expect(shared.result.rejectReasons.has(ids[0])).toBe(true);
    const other = await seedBase();
    const foreign = await readClaimsPageData(adminCtx(other), employmentId, {});
    expect(foreign.claimPage).toEqual([]);
    expect(foreign.drafts).toEqual([]);
    expect(foreign.rejectReasons.size).toBe(0);
  });
  it('caps All and invalid sizes and returns an honest empty out-of-range page', async () => {
    const {ctx, subject} = await fixture();
    expect((await listClaimHistoryPage(ctx, subject.employmentId, {size: 'all'})).state.limit).toBe(ALL_ROW_CEILING);
    expect((await listClaimHistoryPage(ctx, subject.employmentId, {size: '1000000'})).rows).toHaveLength(25);
    const beyond = await listClaimHistoryPage(ctx, subject.employmentId, {page: '20'});
    expect(beyond.rows).toEqual([]); expect(beyond.state).toMatchObject({total: 60, from: 0, to: 0, hasPrev: true});
  });
  it('returns the exact pending queue total and a bounded selection page', async () => {
    const {ctx, ids} = await fixture();
    const first = await listPendingClaimsPage(ctx);
    const second = await listPendingClaimsPage(ctx, {page:'1'});
    const expected = ids.slice(0,60).sort();
    expect(first.page.total).toBe(60);
    expect(first.rows.map(row=>row.id)).toEqual(expected.slice(0,25));
    expect(second.rows.map(row=>row.id)).toEqual(expected.slice(25,50));
    expect((await listPendingClaims(ctx)).map(row=>row.id).sort()).toEqual(expected);
    expect((await listPendingClaimsPage(adminCtx(await seedBase()))).page.total).toBe(0);
  });
  it('captures the exact actionable claim IDs across pages under the same authority',async()=>{
    const {ctx,subject,ids}=await fixture(),expected=ids.slice(0,60).sort();
    expect(await listPendingClaimSelection(ctx)).toEqual(expected);
    const ownAdmin=await createAppUser(base.tenantId,subject.personId,'hr_admin');
    expect(await listPendingClaimSelection({...ctx,userId:ownAdmin,personId:subject.personId})).toEqual([]);
    const foreign=await seedBase();
    expect(await listPendingClaimSelection(adminCtx(foreign))).toEqual([]);
  });
  it('returns a counted task preview without transporting the complete Claims queue',async()=>{
    const {ctx,ids}=await fixture(),expected=ids.slice(0,60).sort();
    const preview=await pendingClaimTaskSummary(ctx,[base.companyId]);
    expect(preview.total).toBe(60);expect(preview.items.map(row=>row.id)).toEqual(expected.slice(0,25));
    expect(await pendingClaimTaskSummary(ctx,[])).toEqual({items:[],total:0});
    const foreign=await seedBase();expect(await pendingClaimTaskSummary(adminCtx(foreign),[base.companyId])).toEqual({items:[],total:0});
  });
  it('preserves tenant and employment isolation for paged and detail reads', async () => {
    const {subject, ids} = await fixture();
    const other = await seedBase();
    expect((await listClaimHistoryPage(adminCtx(other), subject.employmentId)).rows).toEqual([]);
    expect((await listClaimHistoryPage(adminCtx(other), subject.employmentId)).state.total).toBe(0);
    expect(await listClaimsForEmployment(adminCtx(other), subject.employmentId, {claimId: ids[0]})).toEqual([]);
  });
});
