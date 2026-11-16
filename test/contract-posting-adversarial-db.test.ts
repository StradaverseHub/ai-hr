import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {migrateTestDb,closeAll,owner} from './harness';
import {contractPostingFixture,releaseContractPosting} from './helpers/contract-posting-fixture';
import {approveContractSharedPosting,editContractSharedPosting,readContractSharedPosting,listContractSharedPostings,confirmContractSharedPay} from '../packs/contracts/service';

beforeAll(migrateTestDb);afterAll(closeAll);
it('denies forged protected effects and monetary posting values, including direct native commands',async()=>{
 const f=await contractPostingFixture(),p=await releaseContractPosting(f);
 await expect(withTenant(f.admin,tx=>tx.execute(sql`select app.contract_shared_create_posting(${f.caseId}::uuid,${randomUUID()}::uuid,'forged-step')`))).rejects.toThrow();
 expect(()=>editContractSharedPosting(f.approver,{id:p.id,revision:p.revision,eventType:p.eventType,values:{...p.current,basicSalary:'9999'}})).toThrow(/valid dates/);
 await expect(withTenant(f.approver,tx=>tx.execute(sql`select app.personnel_posting_edit(${p.id}::uuid,${p.revision},${JSON.stringify({...p.current,basicSalary:'9999'})}::jsonb)`))).rejects.toThrow();
 await expect(withTenant(f.approver,tx=>tx.execute(sql`select app.contract_shared_posting_approve(${p.id}::uuid,${p.revision},${JSON.stringify({...p.current,basicSalary:'9999'})}::jsonb)`))).rejects.toThrow();
 expect(await readContractSharedPosting(f.approver,p.id)).toMatchObject({status:'pending',revision:p.revision,current:p.current});
});
it('does not reinterpret the posting as another person’s Employment or a changed native period',async()=>{
 const f=await contractPostingFixture({payChanges:true}),p=await releaseContractPosting(f);
 await owner.db.execute(sql`update employment set person_id=${f.admin.personId}::uuid where tenant_id=${f.b.tenantId}::uuid and id=${f.employee.employmentId}::uuid`);
 await expect(approveContractSharedPosting(f.approver,{id:p.id,revision:p.revision})).rejects.toThrow();
 // Restore the original subject, then mutate only the Personnel source period.
 await owner.db.execute(sql`update employment set person_id=${f.employee.personId}::uuid where tenant_id=${f.b.tenantId}::uuid and id=${f.employee.employmentId}::uuid`);
 await owner.db.execute(sql`update employment set contract_end_date=contract_end_date+1 where tenant_id=${f.b.tenantId}::uuid and id=${f.employee.employmentId}::uuid`);
 await expect(approveContractSharedPosting(f.approver,{id:p.id,revision:p.revision})).rejects.toMatchObject({code:'conflict'});
 expect((await readContractSharedPosting(f.approver,p.id))?.status).toBe('pending');
 await expect(confirmContractSharedPay(f.approver,{caseId:f.caseId,expectedRevision:p.caseRevision,confirmed:true})).rejects.toMatchObject({code:'conflict'});
});
it('serializes two real approvals into one canonical posting receipt',async()=>{
 const f=await contractPostingFixture(),p=await releaseContractPosting(f);
 const results=await Promise.all([approveContractSharedPosting(f.approver,{id:p.id,revision:p.revision}),approveContractSharedPosting(f.approver,{id:p.id,revision:p.revision})]);
 expect(results.map(r=>r.alreadyApproved).sort()).toEqual([false,true]);expect(results[0].movementId).toBe(results[1].movementId);
 const[e]=await owner.db.execute<{number:number}>(sql`select contract_number as number from employment where tenant_id=${f.b.tenantId}::uuid and id=${f.employee.employmentId}::uuid`);expect(e.number).toBe(5);
 const[receipts]=await owner.db.execute<{count:number}>(sql`select count(*)::int count from contract_case_activity where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid and action='shared.posting_approved'`);expect(receipts.count).toBe(1);
 expect((await listContractSharedPostings(f.approver,{status:'approved'})).rows).toHaveLength(1);
});
it('prelocks the real Employment write before the case flow when a second database session owns that employment',async()=>{
 const f=await contractPostingFixture(),p=await releaseContractPosting(f),blocker=await owner.client.reserve();
 let reportPid!:(pid:number)=>void;const started=new Promise<number>(resolve=>{reportPid=resolve;});
 const rollback=new Error('Deliberate posting lock-order fixture rollback');let approving:Promise<unknown>|undefined;
 try{
  await blocker`begin`;
  await blocker`select id from employment where tenant_id=${f.b.tenantId}::uuid and id=${f.employee.employmentId}::uuid for update`;
  approving=withTenant(f.approver,async tx=>{
   const[row]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() pid`);reportPid(row.pid);
   await tx.execute(sql`select app.contract_shared_posting_approve(${p.id}::uuid,${p.revision},null)`);
   throw rollback;
  });void approving.catch(()=>undefined);
  const pid=await started;let waiting=false;
  for(let attempt=0;attempt<200;attempt++){
   const[state]=await blocker<{waiting:boolean}[]>`select cardinality(pg_blocking_pids(${pid}))>0 waiting`;
   if(state.waiting){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
  }
  expect(waiting).toBe(true);await blocker`set local lock_timeout='2s'`;
  await blocker`select case_id from contract_shared_case where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid for update`;
  await blocker`commit`;await expect(approving).rejects.toBe(rollback);
 }finally{await blocker`rollback`.catch(()=>undefined);await approving?.catch(()=>undefined);blocker.release();}
 expect((await readContractSharedPosting(f.approver,p.id))?.status).toBe('pending');
},120_000);
