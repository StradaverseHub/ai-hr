import {afterAll,beforeAll,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {migrateTestDb,closeAll,owner} from './harness';
import {contractPostingFixture,releaseContractPosting,finishContractPostingJob,type ContractPostingFixture} from './helpers/contract-posting-fixture';
import {applyDueMovementsTx} from '../core/movement';
import {approveContractSharedPosting,readContractSharedPostingApprovalJob,contractSharedTracker} from '../packs/contracts/service';
import {pgSqlState} from '../lib/db-error';

beforeAll(migrateTestDb);afterAll(closeAll);
async function facts(f:ContractPostingFixture){
 const[row]=await owner.db.execute(sql`select to_jsonb(e) as employment,
  (select jsonb_agg(to_jsonb(a) order by id) from public.assignment a where a.tenant_id=e.tenant_id and a.employment_id=e.id) as assignments,
  (select jsonb_agg(to_jsonb(c) order by id) from public.compensation c where c.tenant_id=e.tenant_id and c.employment_id=e.id) as compensation
  from public.employment e where e.tenant_id=${f.b.tenantId}::uuid and e.id=${f.employee.employmentId}::uuid`);
 return row;
}
async function receipts(f:ContractPostingFixture,postingId:string){
 return owner.db.execute(sql`select to_jsonb(p) as posting,to_jsonb(r) as receipt from public.personnel_posting p
  join public.contract_shared_posting r on r.tenant_id=p.tenant_id and r.posting_id=p.id
  where p.tenant_id=${f.b.tenantId}::uuid and p.id=${postingId}::uuid`);
}
it('keeps a genuinely approved future schedule unchanged when a due caller supplies a future selection date',async()=>{
 const f=await contractPostingFixture({future:true}),posting=await releaseContractPosting(f),before=await facts(f);
 const queued=await approveContractSharedPosting(f.approver,{id:posting.id,revision:posting.revision});
 if(queued.postingStatus!=='pending')throw Error('The genuine first approval must queue.');
 await finishContractPostingJob(queued.jobId,f.approver,'contract_posting_apply');
 expect(await readContractSharedPostingApprovalJob(f.approver,queued.jobId)).toMatchObject({jobState:'completed',postingStatus:'approved',applicationState:'scheduled'});
 expect(await facts(f)).toEqual(before);
 const admitted=await receipts(f,posting.id);
 const scheduled=await owner.db.execute<{id:string;row:Record<string,unknown>}>(sql`select id,to_jsonb(d) as row from public.domain_event d
  where tenant_id=${f.b.tenantId}::uuid and subject_employment_id=${f.employee.employmentId}::uuid and event_type='employment.movement.scheduled'
  and payload->'input'->>'contractPostingId'=${posting.id}`);
 expect(scheduled).toHaveLength(1);
 expect(scheduled[0].row).toMatchObject({event_type:'employment.movement.scheduled',actor_type:'user',actor_id:f.approver.userId,subject_employment_id:f.employee.employmentId,
  payload:{effectiveDate:f.newStart,input:{contractPostingId:posting.id}}});
 expect(admitted).toHaveLength(1);
 expect(admitted[0]).toMatchObject({posting:{status:'approved',movement_id:scheduled[0].id},receipt:{applied_at:null}});
 const tracked=(await contractSharedTracker(f.proposer)).rows.find(row=>row.employmentId===f.employee.employmentId);
 expect(tracked).toMatchObject({startOn:f.start,endOn:f.end,contractNumber:4});
 expect(tracked?.scheduledPeriod).toEqual({postingId:posting.id,label:posting.label,eventType:'contractRenewal',startOn:f.newStart,endOn:f.newEnd,contractNumber:5,status:'scheduled'});
 await expect(withTenant(f.approver,tx=>applyDueMovementsTx(tx,f.approver,f.employee.employmentId,f.today))).rejects.toThrow();
 expect(await withTenant(f.admin,tx=>applyDueMovementsTx(tx,f.admin,f.employee.employmentId,f.today))).toMatchObject({applied:0,noop:0});
 // The explicit API day selects candidates; it does not move PostgreSQL's real KL clock.
 // Native receipt completion refuses early application and rolls back every temporary write.
 const early=await withTenant(f.admin,tx=>applyDueMovementsTx(tx,f.admin,f.employee.employmentId,f.newStart)).then(()=>null,(error:unknown)=>error);
 expect(pgSqlState(early)).toBe('23514');
 expect(await facts(f)).toEqual(before);expect(await receipts(f,posting.id)).toEqual(admitted);
 expect(await owner.db.execute(sql`select id,to_jsonb(d) as row from public.domain_event d
  where tenant_id=${f.b.tenantId}::uuid and subject_employment_id=${f.employee.employmentId}::uuid and event_type='employment.movement.scheduled'
  and payload->'input'->>'contractPostingId'=${posting.id}`)).toEqual(scheduled);
 expect(await readContractSharedPostingApprovalJob(f.approver,queued.jobId)).toMatchObject({applicationState:'scheduled'});
 expect(await withTenant(f.admin,tx=>applyDueMovementsTx(tx,f.admin,f.employee.employmentId,f.today))).toMatchObject({applied:0,noop:0});
},120_000);
it('does not reapply or duplicate closure for a genuine current-day Contract application',async()=>{
 const f=await contractPostingFixture(),posting=await releaseContractPosting(f);
 expect(f.newStart).toBe(f.today);
 const queued=await approveContractSharedPosting(f.approver,{id:posting.id,revision:posting.revision});
 if(queued.postingStatus!=='pending')throw Error('The genuine first approval must queue.');
 await finishContractPostingJob(queued.jobId,f.approver,'contract_posting_apply');
 expect(await readContractSharedPostingApprovalJob(f.approver,queued.jobId)).toMatchObject({jobState:'completed',postingStatus:'approved',applicationState:'applied'});
 const settled=await facts(f),admitted=await receipts(f,posting.id);
 const tracked=(await contractSharedTracker(f.proposer)).rows.find(row=>row.employmentId===f.employee.employmentId);
 expect(tracked).toMatchObject({startOn:f.newStart,endOn:f.newEnd,contractNumber:5,scheduledPeriod:null});
 for(let pass=0;pass<2;pass++)expect(await withTenant(f.admin,tx=>applyDueMovementsTx(tx,f.admin,f.employee.employmentId,f.today))).toMatchObject({applied:0,noop:0});
 expect(await facts(f)).toEqual(settled);expect(await receipts(f,posting.id)).toEqual(admitted);
 const[count]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.domain_event
  where tenant_id=${f.b.tenantId}::uuid and subject_employment_id=${f.employee.employmentId}::uuid and payload->'movement'->>'type'='contractTermination'`);
 expect(count.n).toBe(1);
},120_000);
// A future-approved schedule becoming due on a later real calendar day is a separate temporal
// acceptance scenario. These tests do not fabricate an old approval, move event dates or bypass time.
