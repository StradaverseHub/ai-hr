/** Real native publication/approval fixtures; no hand-made job or event mutation. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {withTenant} from '../db/client';
import {createBusinessUnit} from '../core/admin';
import {setLabelGlobal} from '../core/system-labels';
import * as org from '../core/org';
import {createMovementEvent} from '../core/movement';
import {prepareCompanyOrganisationRun,companyOrganisationRunReport,decideCompanyOrganisationRun,processCompanyOrganisationRun} from '../core/company-organisation';
import {resolveOrganisationProjectionAssignmentTx,OrganisationProjectionLineageError} from '../core/organisation-projection-lineage';
import {approveContractSharedPosting,readContractSharedPostingApprovalJob,readContractSharedPosting} from '../packs/contracts/service';
import {readBulkJob} from '../core/bulk-job';
import {todayInKualaLumpur,addCalendarMonths} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {migrateTestDb,closeAll,owner,createAppUser} from './harness';
import {contractPostingFixture,releaseContractPosting,finishContractPostingJob,type ContractPostingFixture} from './helpers/contract-posting-fixture';
import {projectEmploymentOrganisationAssignmentTx as legacyProjection} from './fixtures/legacy-org-projection-owner';

beforeAll(migrateTestDb);afterAll(closeAll);
async function fixture(mode:'single'|'split'|'legacy'){
 const target=addCalendarMonths(todayInKualaLumpur().slice(0,7)+'-01',-1);
 let unitId='';
 const f=await contractPostingFixture({endOn:addDaysIso(target,-1),beforeAdopt:async({admin,employee,b,start,newStart})=>{
  await createMovementEvent(admin,{employmentId:employee.employmentId,kind:'transfer',effectiveDate:addDaysIso(newStart,5),departmentId:b.deptB,remarks:'Fictional native department decision before Org publication'});
  const checker=await org.hireEmployee(admin,{person:{fullName:'Fictional independent projection checker',primaryEmail:randomUUID()+'@projection.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:start});
  const checkerUser=await createAppUser(b.tenantId,checker.personId,'hr_admin');
  const checkerCtx={...admin,userId:checkerUser,personId:checker.personId,roles:['hr_admin'],grants:undefined};
  unitId=(await createBusinessUnit(admin,{companyId:b.companyId,code:'PROJECTION',name:'Fictional native projected unit'})).id;
  await setLabelGlobal(admin,{kind:'business_unit',labelId:unitId,isGlobal:true});
  const effectiveOn=mode==='split'?addDaysIso(newStart,7):start;
  const runId=await prepareCompanyOrganisationRun(admin,{kind:'mapping',companyIds:[b.companyId],effectiveOn,changes:[{companyId:b.companyId,businessUnitId:unitId,parentCompanyId:null}]});
  const report=await companyOrganisationRunReport(checkerCtx,runId);
  await decideCompanyOrganisationRun(checkerCtx,{id:runId,digest:report.run.digest,approve:true,reason:'Independent native publication review'});
  // Only the legacy case runs the byte-pinned PRE-proposal native delegate. It still uses the real
  // ordinary Maintain checks/publication transaction and writes its own immutable historical event.
  const old=mode==='legacy'?vi.spyOn(org,'projectEmploymentOrganisationAssignmentTx').mockImplementation(legacyProjection):null;
  try{
   let published=await processCompanyOrganisationRun(admin,runId);
   for(let i=0;i<30&&published.state==='staging';i++)published=await processCompanyOrganisationRun(admin,runId);
   expect(published.state).toBe('published');
  }finally{old?.mockRestore();}
 }});
 return {...f,unitId};
}
async function projections(f:ContractPostingFixture){
 return owner.db.execute<{id:string;eventType:string;aggregateId:string;payload:Record<string,unknown>}>(sql`select id,event_type as "eventType",aggregate_id as "aggregateId",payload from public.domain_event
  where tenant_id=${f.b.tenantId}::uuid and subject_employment_id=${f.employee.employmentId}::uuid and event_type='employment.organisation.projected' order by sequence`);
}
async function assignmentRows(f:ContractPostingFixture){
 return owner.db.execute(sql`select to_jsonb(a) as row from public.assignment a where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid order by id`);
}
it('uses exact native one-to-one projection IDs to replay a genuine earlier Contract posting',async()=>{
 const f=await fixture('single'),events=await projections(f);expect(events.length).toBeGreaterThan(0);
 expect(events.every(event=>(event.payload.projection as {replacements:unknown[]}).replacements.length===1)).toBe(true);
 const event=events.at(-1)!;
 const resolved=await withTenant(f.admin,tx=>resolveOrganisationProjectionAssignmentTx(tx,f.b.tenantId,f.employee.employmentId,event.aggregateId,events,[]));
 expect(resolved).toBe(((event.payload.projection as {replacements:{id:string}[]}).replacements[0]).id);
 await expect(withTenant(f.admin,tx=>resolveOrganisationProjectionAssignmentTx(tx,f.b.tenantId,f.employee.employmentId,event.aggregateId,[...events,event],[]))).rejects.toBeInstanceOf(OrganisationProjectionLineageError);
 const[other]=await owner.db.execute<{id:string}>(sql`select id from public.employment where tenant_id=${f.b.tenantId}::uuid and person_id=${f.proposer.personId!}::uuid`);
 expect(other.id).not.toBe(f.employee.employmentId);
 await expect(withTenant(f.admin,tx=>resolveOrganisationProjectionAssignmentTx(tx,f.b.tenantId,other.id,event.aggregateId,events,[]))).rejects.toBeInstanceOf(OrganisationProjectionLineageError);
 const changed=events.map(item=>item===event?{...item,payload:{...item.payload,mappingVersionId:randomUUID()}}:item);
 await expect(withTenant(f.admin,tx=>resolveOrganisationProjectionAssignmentTx(tx,f.b.tenantId,f.employee.employmentId,event.aggregateId,changed,[]))).rejects.toBeInstanceOf(OrganisationProjectionLineageError);
 const posting=await releaseContractPosting(f),queued=await approveContractSharedPosting(f.approver,{id:posting.id,revision:posting.revision});
 if(queued.postingStatus!=='pending')throw Error('The genuine first approval must queue.');
 await finishContractPostingJob(queued.jobId,f.approver,'contract_posting_apply');
 expect(await readContractSharedPostingApprovalJob(f.approver,queued.jobId)).toMatchObject({jobState:'completed',postingStatus:'approved',applicationState:'applied'});
 const[actual]=await owner.db.execute<{department:string;unit:string;start:string;end:string;counter:number}>(sql`select a.department_id as department,a.business_unit_id as unit,e.contract_start_date::text as start,e.contract_end_date::text as end,e.contract_number as counter
  from public.employment e join public.assignment a on a.tenant_id=e.tenant_id and a.employment_id=e.id and a.valid_to is null and a.superseded_at is null where e.tenant_id=${f.b.tenantId}::uuid and e.id=${f.employee.employmentId}::uuid`);
 expect(actual).toEqual({department:f.b.deptB,unit:f.unitId,start:f.newStart,end:f.newEnd,counter:5});
 expect(await projections(f)).toEqual(events);
},180_000);
for(const mode of ['split','legacy'] as const)it(`stops a genuine ${mode} Org projection for reconciliation without retrying or losing ranges`,async()=>{
 const f=await fixture(mode),events=await projections(f);expect(events.length).toBeGreaterThan(0);
 if(mode==='split')expect(events.some(event=>(event.payload.projection as {replacements:unknown[]}).replacements.length>1)).toBe(true);
 else expect(events.every(event=>!Object.hasOwn(event.payload,'projection'))).toBe(true);
 const before=await assignmentRows(f),posting=await releaseContractPosting(f),queued=await approveContractSharedPosting(f.approver,{id:posting.id,revision:posting.revision});
 if(queued.postingStatus!=='pending')throw Error('The genuine first approval must queue.');
 await expect(finishContractPostingJob(queued.jobId,f.approver,'contract_posting_apply')).rejects.toThrow();
 const job=await readBulkJob(f.approver,queued.jobId,'contract_posting_apply');expect(job.state).toBe('failed');expect(job.transient_retries).toBe(0);
 expect(job.error).toContain('reconcile the recorded organisation projection');
 expect(await readContractSharedPostingApprovalJob(f.approver,queued.jobId)).toMatchObject({jobState:'failed',postingStatus:'pending',applicationState:'needs_review'});
 expect((await readContractSharedPosting(f.approver,posting.id))?.status).toBe('pending');
 expect(await assignmentRows(f)).toEqual(before);expect(await projections(f)).toEqual(events);
},180_000);
