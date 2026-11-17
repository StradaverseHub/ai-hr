/** Real native audiences: CaseView by itself never confers Personnel posting approval. */
import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {migrateTestDb,closeAll,owner} from './harness';
import {contractPostingFixture,releaseContractPosting} from './helpers/contract-posting-fixture';
import {contractSharedContext,readContractSharedPosting,readContractSharedPostingSummary,listContractSharedPostings,approveContractSharedPosting} from '../packs/contracts/service';
beforeAll(migrateTestDb);afterAll(closeAll);
it('retains the native read-only case audience and the actual posting group as separate authorities',async()=>{
 const f=await contractPostingFixture(),posting=await releaseContractPosting(f);
 expect((await contractSharedContext(f.proposer,f.caseId)).flow).toBeTruthy();
 // Case View exposes its own shaped receipt; the native Personnel editor/terms require the
 // posting approver group even when the caller may read and decide this Contract case.
 expect(await readContractSharedPosting(f.proposer,posting.id)).toBeNull();
 const summary=await readContractSharedPostingSummary(f.proposer,f.caseId);
 expect(summary).toMatchObject({postingId:posting.id,label:posting.label,status:'pending',canConfirmPay:false});
 for(const field of ['proposed','edited','current','canApprove','canEdit'])expect(summary).not.toHaveProperty(field);
 expect((await listContractSharedPostings(f.proposer,{status:'pending'})).rows).toEqual([]);
 const authorizedBefore=await readContractSharedPosting(f.approver,posting.id);
 expect(authorizedBefore).toMatchObject({id:posting.id,status:'pending',revision:posting.revision,canApprove:true,canEdit:true});
 const nativeState=()=>owner.db.execute(sql`select p.status,p.revision,
  p.approved_by is not null or p.approved_at is not null or p.applied is not null as has_approval,
  p.movement_id is not null or r.movement_group_id is not null or r.applied_at is not null as has_movement
  from public.personnel_posting p join public.contract_shared_posting r on r.tenant_id=p.tenant_id and r.posting_id=p.id
  where p.tenant_id=${f.b.tenantId}::uuid and p.id=${posting.id}::uuid`);
 const jobCounts=()=>owner.db.execute(sql`select
  (select count(*)::int from app.contract_posting_job_source where tenant_id=${f.b.tenantId}::uuid and posting_id=${posting.id}::uuid) as sources,
  (select count(*)::int from public.bulk_job where tenant_id=${f.b.tenantId}::uuid and kind='contract_posting_apply') as jobs`);
 const before=await nativeState();expect(before).toEqual([{status:'pending',revision:posting.revision,has_approval:false,has_movement:false}]);
 expect(await jobCounts()).toEqual([{sources:0,jobs:0}]);
 // Native pending admission intentionally combines role, identity, revision and source checks
 // into the same 40001 unavailable contract BEFORE it enqueues any job. It does not reveal which failed.
 const denied=await approveContractSharedPosting(f.proposer,{id:posting.id,revision:posting.revision}).then(()=>null,(error:unknown)=>error);
 expect(denied).toMatchObject({code:'conflict'});
 expect(denied).toBeInstanceOf(Error);
 const absent=await approveContractSharedPosting(f.proposer,{id:randomUUID(),revision:posting.revision}).then(()=>null,(error:unknown)=>error);
 expect(absent).toMatchObject({code:'conflict'});
 expect(absent).toHaveProperty('message',(denied as Error).message);
 expect(await nativeState()).toEqual(before);expect(await jobCounts()).toEqual([{sources:0,jobs:0}]);
 expect(await readContractSharedPosting(f.approver,posting.id)).toEqual(authorizedBefore);
 expect(await readContractSharedPostingSummary(f.proposer,f.caseId)).toEqual(summary);
 expect((await listContractSharedPostings(f.approver,{status:'pending'})).rows).toEqual([expect.objectContaining({id:posting.id,status:'pending',revision:posting.revision,workflowReady:true,canApprove:true})]);
});
