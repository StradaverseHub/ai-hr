import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {migrateTestDb,closeAll,owner} from './harness';
import {contractPostingFixture,releaseContractPosting,type ContractPostingFixture} from './helpers/contract-posting-fixture';
import {approveContractSharedPosting,editContractSharedPosting,listContractSharedPostings,readContractSharedPosting,readContractSharedPostingSummary,confirmContractSharedPay,contractSharedContext,contractSharedTracker} from '../packs/contracts/service';
import {setCompensation} from '../core/comp';
import {createMovementEvent,movementHistory} from '../core/movement';
import {approvePersonnelPosting} from '../core/personnel-posting';

beforeAll(migrateTestDb);afterAll(closeAll);
async function facts(f:ContractPostingFixture){
 const[e]=await owner.db.execute<{start:string|null;end:string|null;number:number;terminated:string|null;hired:string;probation:string|null;confirmation:string|null;type:string;salary:string}>(sql`select e.contract_start_date::text as start,e.contract_end_date::text as end,e.contract_number as number,e.terminated_on::text as terminated,e.hired_on::text as hired,e.probation_end_date::text as probation,e.confirmation_date::text as confirmation,a.employment_type as type,c.basic_salary::text as salary from employment e join assignment a on a.tenant_id=e.tenant_id and a.employment_id=e.id and a.valid_to is null and a.superseded_at is null join compensation c on c.tenant_id=e.tenant_id and c.employment_id=e.id and c.valid_to is null and c.superseded_at is null where e.tenant_id=${f.b.tenantId}::uuid and e.id=${f.employee.employmentId}::uuid`);return e;
}
async function postedEvents(f:ContractPostingFixture){return owner.db.execute<{type:string;source:string|null}>(sql`select payload->'movement'->>'type' as type,payload->'movement'->>'contractPostingId' as source from domain_event where tenant_id=${f.b.tenantId}::uuid and subject_employment_id=${f.employee.employmentId}::uuid and payload->'movement' ? 'contractPostingId' order by sequence`);}
describe('Contract agreement → canonical Personnel postings → explicit manual pay receipt',()=>{
 it('closes a renewal with unchanged pay immediately after native posting approval',async()=>{
  const f=await contractPostingFixture({payChanges:false}),before=await facts(f),p=await releaseContractPosting(f);
  expect((await contractSharedContext(f.proposer,f.caseId)).flow?.stage).toBe('posting');
  await approveContractSharedPosting(f.approver,{id:p.id,revision:p.revision});
  expect(await facts(f)).toEqual({...before,start:f.newStart,end:f.newEnd,number:5});
  expect((await contractSharedContext(f.proposer,f.caseId)).flow).toMatchObject({stage:'renewed',payConfirmation:null});
  expect(await readContractSharedPosting(f.approver,p.id)).toMatchObject({status:'approved',canConfirmPay:false,payChanges:false});
 });
 it('keeps a conversion with changed pay open until explicit manual Payroll attestation',async()=>{
  const f=await contractPostingFixture({kind:'convert',payChanges:true}),before=await facts(f),p=await releaseContractPosting(f);
  await approveContractSharedPosting(f.approver,{id:p.id,revision:p.revision});
  expect(await facts(f)).toEqual({...before,start:null,end:null,type:'full_time'});
  const approved=await readContractSharedPosting(f.approver,p.id);
  expect(approved).toMatchObject({status:'approved',canConfirmPay:true,payChanges:true});
  expect((await contractSharedContext(f.proposer,f.caseId)).flow?.stage).toBe('pay');
  await setCompensation(f.admin,{employmentId:f.employee.employmentId,basicSalary:5200.12,effectiveFrom:f.newStart});
  expect((await contractSharedContext(f.proposer,f.caseId)).flow?.stage).toBe('pay');
  const updated=await facts(f);
  await expect(confirmContractSharedPay(f.proposer,{caseId:f.caseId,expectedRevision:approved!.caseRevision,confirmed:true})).rejects.toMatchObject({code:'forbidden'});
  expect(await confirmContractSharedPay(f.approver,{caseId:f.caseId,expectedRevision:approved!.caseRevision,confirmed:true})).toMatchObject({stage:'converted',confirmed:true});
  expect(await facts(f)).toEqual(updated);
  expect((await contractSharedContext(f.proposer,f.caseId)).flow).toMatchObject({stage:'converted',payConfirmation:{by:f.approver.userId}});
 });
 it('requires the released agreement and actual posting group, increments only the native period, and closes only after a human pay attestation',async()=>{
  const f=await contractPostingFixture({payChanges:true}),before=await facts(f);
  expect((await listContractSharedPostings(f.approver)).rows).toEqual([]);
  const p=await releaseContractPosting(f);
  const[right]=await withTenant(f.approver,tx=>tx.execute<{maintain:boolean}>(sql`select app.access_workforce_employment(${f.employee.employmentId}::uuid,'workforce.maintain') as maintain`));expect(right.maintain).toBe(false);
  expect((await listContractSharedPostings(f.employeeActor)).rows).toEqual([]);
  expect(await readContractSharedPosting(f.proposer,p.id)).toBeNull();
  await expect(approveContractSharedPosting(f.employeeActor,{id:p.id,revision:p.revision})).rejects.toThrow();
  const edited=await editContractSharedPosting(f.approver,{id:p.id,revision:p.revision,eventType:p.eventType,values:{...p.current,contractNumber:'6'}});
  await expect(approveContractSharedPosting(f.approver,{id:p.id,revision:edited.revision})).rejects.toMatchObject({code:'invalid'});
  expect(await facts(f)).toEqual(before);
  const result=await approveContractSharedPosting(f.approver,{id:p.id,revision:edited.revision,values:p.proposed});expect(result.alreadyApproved).toBe(false);
  expect(await facts(f)).toEqual({...before,start:f.newStart,end:f.newEnd,number:5});
  expect((await postedEvents(f)).map(e=>e.type).sort()).toEqual(['contractRenewal','contractTermination'].sort());
  const history=(await movementHistory(f.admin,f.employee.employmentId)).filter(r=>['contractTermination','contractRenewal'].includes(r.kind));
  expect(history.map(r=>[r.kind,r.effectiveDate])).toEqual([['contractTermination',f.end],['contractRenewal',f.newStart]]);
  expect(history.every(r=>!r.canEdit&&!r.canReverse)).toBe(true);
  const approved=await readContractSharedPosting(f.approver,p.id);expect(approved).toMatchObject({status:'approved',canConfirmPay:true});
  const retry=await approveContractSharedPosting(f.approver,{id:p.id,revision:edited.revision,values:p.proposed});expect(retry.alreadyApproved).toBe(true);expect(retry.movementId).toBe(result.movementId);
  expect(await facts(f)).toEqual({...before,start:f.newStart,end:f.newEnd,number:5});
  const current=await contractSharedContext(f.proposer,f.caseId);expect(current.flow?.stage).toBe('pay');
  const[nextPeriod]=await withTenant(f.proposer,tx=>tx.execute<{opened:{caseId:string}}>(sql`select app.contract_shared_period_open(${f.employee.employmentId}::uuid,${current.source.periodRevision}) as opened`));
  expect(nextPeriod.opened.caseId).not.toBe(f.caseId);
  await expect(confirmContractSharedPay(f.proposer,{caseId:f.caseId,expectedRevision:approved!.caseRevision,confirmed:true})).rejects.toMatchObject({code:'forbidden'});
  // The existing Payroll owner records pay. Matching the agreement does not close the Contract case.
  await setCompensation(f.admin,{employmentId:f.employee.employmentId,basicSalary:5200.12,effectiveFrom:f.newStart});
  expect((await contractSharedContext(f.proposer,f.caseId)).flow?.stage).toBe('pay');
  const confirmed=await confirmContractSharedPay(f.approver,{caseId:f.caseId,expectedRevision:approved!.caseRevision,confirmed:true});
  expect(confirmed).toEqual({caseId:f.caseId,revision:approved!.caseRevision+1,stage:'renewed',confirmed:true});
  expect((await facts(f)).salary).toBe('5200.12');
  expect(await readContractSharedPostingSummary(f.proposer,f.caseId)).toMatchObject({approverGroupName:'Fictional Contract People Ops',approvedByName:'Fictional Contract posting approver',payConfirmedByName:'Fictional Contract posting approver'});
  expect(await confirmContractSharedPay(f.approver,{caseId:f.caseId,expectedRevision:approved!.caseRevision,confirmed:true})).toEqual(confirmed);
 });
 it('converts through native Employment Type Change without creating probation, ending employment or touching pay',async()=>{
  const f=await contractPostingFixture({kind:'convert'}),before=await facts(f),p=await releaseContractPosting(f);
  await approvePersonnelPosting(f.approver,{id:p.id,revision:p.revision});
  expect(await facts(f)).toEqual({...before,start:null,end:null,type:'full_time'});
  const events=await postedEvents(f);expect(events.some(e=>e.type==='employmentTypeChange')).toBe(true);expect(events.filter(e=>e.type==='contractTermination')).toHaveLength(1);expect(events.some(e=>e.type==='contractConversion')).toBe(false);
  const convertedHistory=(await movementHistory(f.admin,f.employee.employmentId)).find(r=>r.kind==='employmentTypeChange');expect(convertedHistory).toMatchObject({effectiveDate:f.newStart,canEdit:false,canReverse:false});
  expect((await contractSharedContext(f.proposer,f.caseId)).flow?.stage).toBe('converted');
  expect((await readContractSharedPosting(f.approver,p.id))?.canConfirmPay).toBe(false);
  await expect(createMovementEvent(f.admin,{employmentId:f.employee.employmentId,kind:'contractRenewal',effectiveDate:f.today})).rejects.toThrow(/approved Contract/);
 });
 it('records a future native schedule while leaving the current Personnel period and Payroll intact',async()=>{
  const f=await contractPostingFixture({future:true,payChanges:true}),before=await facts(f),p=await releaseContractPosting(f);
  await approveContractSharedPosting(f.approver,{id:p.id,revision:p.revision});
  expect(await facts(f)).toEqual(before);
  const tracker=(await contractSharedTracker(f.proposer)).rows.find(row=>row.employmentId===f.employee.employmentId);
  expect(tracker).toMatchObject({startOn:f.start,endOn:f.end,contractNumber:4});
  // Exact shape also rules out salary, remarks, source-person IDs and private routing in the preview.
  expect(tracker?.scheduledPeriod).toEqual({postingId:p.id,label:p.label,eventType:'contractRenewal',startOn:f.newStart,endOn:f.newEnd,contractNumber:5,status:'scheduled'});
  const row=await readContractSharedPosting(f.approver,p.id);expect(row).toMatchObject({status:'approved',movementAppliedAt:null,canConfirmPay:true});
  const[scheduled]=await owner.db.execute<{input:Record<string,unknown>;date:string}>(sql`select payload->'input' as input,payload->>'effectiveDate' as date from domain_event where tenant_id=${f.b.tenantId}::uuid and subject_employment_id=${f.employee.employmentId}::uuid and event_type='employment.movement.scheduled' and payload->'input'->>'contractPostingId'=${p.id}`);
  expect(scheduled.date).toBe(f.newStart);expect(scheduled.input).toMatchObject({contractNumber:'5',contractStartDate:f.newStart,contractPostingId:p.id});expect(scheduled.input).not.toHaveProperty('basicSalary');
  expect((await movementHistory(f.admin,f.employee.employmentId)).find(r=>r.kind==='contractRenewal')).toMatchObject({effectiveDate:f.newStart,canEdit:false,canReverse:false});
  expect((await postedEvents(f)).some(e=>e.type==='contractTermination')).toBe(false);
  expect((await contractSharedContext(f.proposer,f.caseId)).flow?.stage).toBe('pay');
 });
});
