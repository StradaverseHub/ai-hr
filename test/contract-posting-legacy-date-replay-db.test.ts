/** Inactive date-projection compatibility proof. Real legacy-shaped writer below; scalar JSON cases are not authority proofs.
 * Source only; no manufactured ledger, clock, frame, actor, capability or runtime PASS claim.
 */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {createBusinessUnit} from '../core/admin';
import {setLabelGlobal} from '../core/system-labels';
import {hireEmployee,setEmploymentInfo} from '../core/org';
import {movementHistory,movementCorrectionBaseTx} from '../core/movement';
import {prepareCompanyOrganisationRun,companyOrganisationRunReport,decideCompanyOrganisationRun,processCompanyOrganisationRun} from '../core/company-organisation';
import {approveContractSharedPosting,readContractSharedPostingApprovalJob} from '../packs/contracts/service';
import {todayInKualaLumpur,addCalendarMonths} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {migrateTestDb,closeAll,owner,createAppUser} from './harness';
import {contractPostingFixture,releaseContractPosting,finishContractPostingJob} from './helpers/contract-posting-fixture';
beforeAll(migrateTestDb);afterAll(closeAll);
it.each(['without-effective-date','without-end-date'] as const)('replays a genuine legacy probation tag %s',async(shape)=>{
 const target=addCalendarMonths(todayInKualaLumpur().slice(0,7)+'-01',-1);
 const groupId=randomUUID();let futureEnd='',actualDay='',unitId='',originalEvent:Record<string,unknown>|undefined;
 const f=await contractPostingFixture({endOn:addDaysIso(target,-1),beforeAdopt:async({admin,employee,b,start,today})=>{
  futureEnd=addDaysIso(today,40);
  // Both are current admitted writer shapes; the real after-image owns the extension end date.
  const futureEffective=addDaysIso(today,10);
  const tag={type:'probationExtension',groupId,...(shape==='without-effective-date'?{endDate:futureEnd}:{effectiveDate:futureEffective})};
  await setEmploymentInfo(admin,{employmentId:employee.employmentId,extendedConfirmationDate:futureEnd,movement:tag});
  const[event]=await owner.db.execute<{row:Record<string,unknown>;day:string;extended:string}>(sql`select to_jsonb(d) as row,(d.occurred_at at time zone 'Asia/Kuala_Lumpur')::date::text as day,e.extended_confirmation_date::text as extended from public.domain_event d join public.employment e on e.tenant_id=d.tenant_id and e.id=d.subject_employment_id where d.tenant_id=${b.tenantId}::uuid and d.subject_employment_id=${employee.employmentId}::uuid and d.event_type='employment.info.updated' and d.payload->'movement'->>'groupId'=${groupId}`);
  expect(event).toBeDefined();expect(event.extended).toBe(futureEnd);actualDay=shape==='without-effective-date'?event.day:futureEffective;originalEvent=event.row;
  expect(event.row.payload).toMatchObject({movement:tag,after:{extendedConfirmationDate:futureEnd}});
  const recordedTag=(event.row.payload as {movement:Record<string,unknown>}).movement;
  if(shape==='without-effective-date')expect(recordedTag).not.toHaveProperty('effectiveDate');
  else{expect(recordedTag).not.toHaveProperty('endDate');expect(actualDay>today).toBe(true);}
  const rows=(await movementHistory(admin,employee.employmentId)).filter(row=>row.kind==='probationExtension');expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({effectiveDate:actualDay,endDate:futureEnd,status:'applied'});
  expect(await withTenant(admin,tx=>movementCorrectionBaseTx(tx,admin,employee.employmentId,rows[0].id))).toMatchObject({scheduled:false,effectiveDate:actualDay,recorded:{endDate:futureEnd}});
  const checkerEmployee=await hireEmployee(admin,{person:{fullName:'Fictional independent legacy Org checker',primaryEmail:randomUUID()+'@legacy-org.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:start});
  const checkerUserId=await createAppUser(b.tenantId,checkerEmployee.personId,'hr_admin');
  const checker:SessionContext={...admin,userId:checkerUserId,personId:checkerEmployee.personId,roles:['hr_admin'],grants:undefined};
  expect(checker.userId).not.toBe(admin.userId);expect(checker.personId).not.toBe(admin.personId);
  unitId=(await createBusinessUnit(admin,{companyId:b.companyId,code:'LEGACY-ORG',name:'Fictional legacy date managed unit'})).id;
  await setLabelGlobal(admin,{kind:'business_unit',labelId:unitId,isGlobal:true});
  const runId=await prepareCompanyOrganisationRun(admin,{kind:'mapping',companyIds:[b.companyId],effectiveOn:start,changes:[{companyId:b.companyId,businessUnitId:unitId,parentCompanyId:null}]});
  const report=await companyOrganisationRunReport(checker,runId);
  await decideCompanyOrganisationRun(checker,{id:runId,digest:report.run.digest,approve:true,reason:'Independent review of fictional legacy date mapping'});
  let run=await processCompanyOrganisationRun(admin,runId);for(let attempt=0;attempt<30&&run.state==='staging';attempt++)run=await processCompanyOrganisationRun(admin,runId);
  expect(run.state).toBe('published');
 }});
 const facts=async()=>{const[row]=await owner.db.execute<{extended:string;join:string|null;hire:string;counter:number;start:string;end:string;unit:string}>(sql`select e.extended_confirmation_date::text as extended,e.join_date::text as "join",e.hired_on::text as hire,e.contract_number as counter,e.contract_start_date::text as start,e.contract_end_date::text as end,a.business_unit_id as unit from public.employment e join public.assignment a on a.tenant_id=e.tenant_id and a.employment_id=e.id and a.valid_to is null and a.superseded_at is null where e.tenant_id=${f.b.tenantId}::uuid and e.id=${f.employee.employmentId}::uuid`);return row;};
 const before=await facts();expect(before).toMatchObject({extended:futureEnd,counter:4,unit:unitId});
 const beforeClasses=await owner.db.execute<{day:string}>(sql`select effective_on::text as day from public.employment_organisation_classification where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid`);
 expect(beforeClasses.length).toBeGreaterThan(0);expect(beforeClasses.some(row=>row.day===actualDay)).toBe(false);
 const[rights]=await withTenant(f.approver,tx=>tx.execute<{maintain:boolean}>(sql`select app.access_workforce_employment(${f.employee.employmentId}::uuid,'workforce.maintain') as maintain`));expect(rights.maintain).toBe(false);
 const posting=await releaseContractPosting(f),queued=await approveContractSharedPosting(f.approver,{id:posting.id,revision:posting.revision});if(queued.postingStatus!=='pending')throw Error('The genuine first approval must queue.');
 expect(await facts()).toEqual(before);await finishContractPostingJob(queued.jobId,f.approver,'contract_posting_apply');
 expect(await readContractSharedPostingApprovalJob(f.approver,queued.jobId)).toMatchObject({jobState:'completed',postingStatus:'approved',applicationState:'applied'});
 expect(await facts()).toEqual({...before,counter:5,start:f.newStart,end:f.newEnd});
 const classes=await owner.db.execute<{actor:string;unit:string;kind:string}>(sql`select actor_id as actor,tags->>'businessUnitId' as unit,actor_kind as kind from public.employment_organisation_classification where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid and effective_on=${actualDay}::date`);
 expect(classes.length).toBeGreaterThan(0);expect(classes.every(row=>row.actor===f.approver.userId&&row.unit===unitId&&row.kind==='user')).toBe(true);
 const audit=await owner.db.execute<{actor:string;kind:string}>(sql`select actor_id as actor,payload->'bulkJob'->>'kind' as kind from public.domain_event where tenant_id=${f.b.tenantId}::uuid and subject_employment_id=${f.employee.employmentId}::uuid and event_type='employment.organisation-tagged' and payload->>'effectiveOn'=${actualDay} and payload->'bulkJob'->>'id'=${queued.jobId}`);
 expect(audit.length).toBeGreaterThan(0);expect(audit.every(row=>row.actor===f.approver.userId&&row.kind==='contract_posting_apply')).toBe(true);
 const[eventAfter]=await owner.db.execute<{row:Record<string,unknown>}>(sql`select to_jsonb(d) as row from public.domain_event d where tenant_id=${f.b.tenantId}::uuid and id=${String(originalEvent!.id)}::uuid`);expect(eventAfter.row).toEqual(originalEvent);
},180_000);

// Read-only scalar projection examples. These JSON values never enter business admission or a worker frame.
const group='11111111-1111-4111-8111-111111111111',otherGroup='22222222-2222-4222-8222-222222222222';
const root=(occurred_at:string,effectiveDate?:string)=>({event_type:'employment.info.updated',occurred_at,payload:{movement:{type:'probationExtension',groupId:group,...(effectiveDate===undefined?{}:{effectiveDate})},before:{extendedConfirmationDate:null},after:{extendedConfirmationDate:'2028-04-01'},fields:['extendedConfirmationDate']}});
const dated=(day:string,groupId=group)=>({event_type:'compensation.set',occurred_at:'2028-01-01T00:00:00.000Z',payload:{effectiveFrom:day,movement:{type:'probationExtension',groupId,secondary:true}}});
const scalarCases=[
 {name:'valid explicit day wins',event:root('2028-01-01T00:00:00.000Z','2028-02-29'),group:[dated('2028-03-01')],day:'2028-02-29'},
 {name:'unique matching group day',event:root('2028-01-01T00:00:00.000Z'),group:[dated('2028-02-29'),dated('2028-02-29'),dated('2028-03-01',otherGroup)],day:'2028-02-29'},
 {name:'reporting delegate is not group date evidence',event:root('2028-02-28T16:00:00.000Z'),group:[{event_type:'reporting-line.set',payload:{validFrom:'2028-03-10',lineType:'delegate',movement:{groupId:group,secondary:true}}}],day:'2028-02-29'},
 {name:'ordinary reporting line is group evidence',event:root('2028-01-01T00:00:00.000Z'),group:[{event_type:'reporting-line.set',payload:{validFrom:'2028-02-29',lineType:'manager',movement:{groupId:group,secondary:true}}}],day:'2028-02-29'},
 ...['assignment.transferred','employment.assignment.changed','employment.company.transferred'].map(event_type=>({name:event_type+' dated evidence',event:root('2028-01-01T00:00:00.000Z'),group:[{event_type,payload:{effectiveDate:'2028-02-29',movement:{groupId:group,secondary:true}}}],day:'2028-02-29'})),
 {name:'conflicting group falls back',event:root('2028-02-28T16:00:00.000Z'),group:[dated('2028-02-28'),dated('2028-03-01')],day:'2028-02-29'},
 {name:'missing group before KL midnight',event:root('2028-02-28T15:59:59.999Z'),group:[],day:'2028-02-28'},
 {name:'missing group at KL midnight',event:root('2028-02-28T16:00:00.000Z'),group:[],day:'2028-02-29'},
 {name:'leap day to March',event:root('2028-02-29T16:00:00.000Z'),group:[],day:'2028-03-01'},
 {name:'year boundary',event:root('2027-12-31T16:00:00.000Z'),group:[],day:'2028-01-01'},
 {name:'invalid nonleap explicit and evidence',event:root('2027-02-28T16:00:00.000Z','2027-02-29'),group:[dated('2027-02-29')],day:'2027-03-01'},
 {name:'zero year explicit and evidence',event:root('2028-01-01T00:00:00.000Z','0000-01-01'),group:[dated('0000-01-01')],day:'2028-01-01'},
 {name:'invalid explicit recovers unique evidence',event:root('2028-01-01T00:00:00.000Z','not-a-date'),group:[dated('2028-02-29')],day:'2028-02-29'},
];
it.each(scalarCases)('projects the private read-only day: $name',async fixture=>{
 const[row]=await owner.db.execute<{day:string|null}>(sql`select app.contract_posting_projected_org_day(${JSON.stringify(fixture.event)}::jsonb,${JSON.stringify(fixture.group)}::jsonb)::text as day`);
 expect(row.day).toBe(fixture.day);
});
