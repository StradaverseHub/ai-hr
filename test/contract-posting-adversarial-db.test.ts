import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {migrateTestDb,closeAll,owner} from './harness';
import {contractPostingFixture,releaseContractPosting,finishContractPostingJob,approveAppliedContractPosting,completeContractPostingApproval,runContractPostingApplyTick} from './helpers/contract-posting-fixture';
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
 const changed=(await listContractSharedPostings(f.approver)).rows.find(row=>row.id===p.id);
 expect(changed).toMatchObject({employeeName:'Fictional Contract employee',employeeCode:null,sourceCurrent:false,canApprove:false,canEdit:false,canConfirmPay:false});
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
 if(results[0].postingStatus!=='pending'||results[1].postingStatus!=='pending')throw Error('A request must not apply Personnel synchronously.');
 expect(results[0].jobId).toBe(results[1].jobId);
 expect((await readContractSharedPosting(f.approver,p.id))?.status).toBe('pending');
 const applied=await completeContractPostingApproval(f.approver,results[0]);
 const duplicate=await approveContractSharedPosting(f.approver,{id:p.id,revision:p.revision});
 expect(duplicate).toMatchObject({postingStatus:'approved',alreadyApproved:true,movementId:applied.movementId});
 const[e]=await owner.db.execute<{number:number}>(sql`select contract_number as number from employment where tenant_id=${f.b.tenantId}::uuid and id=${f.employee.employmentId}::uuid`);expect(e.number).toBe(5);
 const[receipts]=await owner.db.execute<{count:number}>(sql`select count(*)::int count from contract_case_activity where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid and action='shared.posting_approved'`);expect(receipts.count).toBe(1);
 expect((await listContractSharedPostings(f.approver,{status:'approved'})).rows).toHaveLength(1);
});
it('prelocks the real Employment write before the case flow when a second database session owns that employment',async()=>{
 const f=await contractPostingFixture(),p=await releaseContractPosting(f);
 const request=await approveContractSharedPosting(f.approver,{id:p.id,revision:p.revision});
 if(request.postingStatus!=='pending')throw Error('A new approval must be queued.');
 await runContractPostingApplyTick();
 const [prepared]=await owner.client<{state:string;due:boolean}[]>`select state,(not_before is null or not_before<=now()) as due from bulk_job where tenant_id=${f.b.tenantId}::uuid and id=${request.jobId}::uuid`;
 expect(prepared).toEqual({state:'finalizing',due:true});
 let approving:Promise<unknown>|undefined;
 const outcome:{settled:boolean;value?:boolean;error?:unknown}={settled:false};
 const blocker=await owner.client.reserve();
 try{
  await blocker`begin`;
  const [{pid:blockerPid}]=await blocker<{pid:number}[]>`select pg_backend_pid() as pid`;
  await blocker`select id from employment where tenant_id=${f.b.tenantId}::uuid and id=${f.employee.employmentId}::uuid for update`;
  approving=runContractPostingApplyTick().then(value=>{outcome.settled=true;outcome.value=value;return value;},error=>{outcome.settled=true;outcome.error=error;throw error;});void approving.catch(()=>undefined);
  let waiting=false;
  for(let attempt=0;attempt<200;attempt++){
   if(outcome.settled){if(outcome.error!==undefined)throw outcome.error;throw Error('Native posting finalizer settled before the Employment lock observation: '+String(outcome.value));}
   // Each autocommit observation gets fresh backend statistics, outside the long-lived blocker transaction.
   const[state]=await owner.client<{waiting:boolean}[]>`select exists(select 1 from pg_stat_activity activity where activity.datname=current_database() and activity.application_name='aihr-bulk:contract_posting_apply:finalize' and activity.pid<>pg_backend_pid() and ${blockerPid}=any(pg_blocking_pids(activity.pid))) waiting`;
   if(state.waiting){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
  }
  expect(waiting).toBe(true);await blocker`set local lock_timeout='2s'`;
  await blocker`select case_id from contract_shared_case where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid for update`;
  await blocker`commit`;await approving;
 }finally{await blocker`rollback`.catch(()=>undefined);await approving?.catch(()=>undefined);blocker.release();}
 expect((await readContractSharedPosting(f.approver,p.id))?.status).toBe('approved');
},120_000);
it('keeps approval pending until its causative job has finished, without widening the protected worker authority',async()=>{
 const f=await contractPostingFixture(),p=await releaseContractPosting(f,{returnAtPosting:true});
 expect(await readContractSharedPosting(f.approver,p.id)).toMatchObject({workflowReady:false,canApprove:false});
 await expect(approveContractSharedPosting(f.approver,{id:p.id,revision:p.revision})).rejects.toMatchObject({code:'conflict'});
 expect((await finishContractPostingJob(p.continuationJobId,f.employeeActor,'contract_automation')).state).toBe('completed');
 expect(await readContractSharedPosting(f.approver,p.id)).toMatchObject({workflowReady:true,canApprove:true});
 await approveAppliedContractPosting(f.approver,{id:p.id,revision:p.revision});
 expect((await readContractSharedPosting(f.approver,p.id))?.status).toBe('approved');
});
