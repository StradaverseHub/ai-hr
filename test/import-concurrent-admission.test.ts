import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {bulkJobWaitingTx,enqueueBulkJobTx,readBulkJob} from '../core/bulk-job';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {clockingImportJobHandler,getClockingImportJob,startClockingImportJob} from '../core/attendance-clocking-import-job';
import {createEmployeeImportJob,getEmployeeImportJob} from '../core/employee-import-job';
import {hireEmployee} from '../core/org';
import {previewSystemLabelImport} from '../core/system-label-import';
import {startSystemLabelImportJob} from '../core/system-label-import-job';
import {importRewardPersonHistory,previewRewardPersonHistoryImport} from '../packs/rewards/service';
import {rewardHistoryUploadHeaders} from '../packs/rewards/person-history-model';
import {BUILTIN_MAPPING_ID} from '../lib/clocking-file';
import {toCsv} from '../lib/csv';
import {todayInKualaLumpur} from '../lib/hr-date';
import {buildSystemLabelWorkbook} from '../lib/system-label-workbook';
import {buildAttendanceFixture} from './helpers/attendance-bulk-fixture';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let base:Base;
let actors:[SessionContext,SessionContext];
beforeAll(migrateTestDb);
beforeEach(async()=>{
  await resetDb();
  base=await seedBase();
  const first=adminCtx(base);
  actors=[first,{...first,userId:await createAppUser(base.tenantId,null,'hr_admin')}];
});
afterAll(closeAll);

type Submission=(actor:SessionContext)=>Promise<string>;
async function submitTogether(kind:string,submit:(slot:number)=>Submission){
  const ids=await Promise.all(actors.map((actor,slot)=>submit(slot)(actor)));
  expect(ids[0]).not.toBe(ids[1]);
  const rows=await owner.client<{id:string;creator:string}[]>`
    select id,created_by as creator from bulk_job
    where tenant_id=${base.tenantId}::uuid and kind=${kind} and state='queued'
    order by created_at,id
  `;
  expect(rows.map(row=>row.id).sort()).toEqual([...ids].sort());
  expect(rows.map(row=>row.creator).sort()).toEqual(actors.map(actor=>actor.userId).sort());
  await expect(readBulkJob(actors[0],ids[1],kind)).rejects.toMatchObject({status:404});
  await expect(readBulkJob(actors[1],ids[0],kind)).rejects.toMatchObject({status:404});
  for(const [index,row] of rows.entries()){
    const actor=actors.find(actor=>actor.userId===row.creator)!;
    expect(await withTenant(actor,tx=>bulkJobWaitingTx(tx,row.id))).toBe(index===1);
  }
  return ids;
}

async function drain(kind:string,ids:string[]){
  const handler=BULK_JOB_HANDLERS.find(handler=>handler.kind===kind)!;
  for(let tick=0;tick<400;tick++){
    const rows=await owner.client<{id:string;state:string;error:string|null}[]>`
      select id,state,error from bulk_job where id=any(${ids}::uuid[]) order by created_at,id
    `;
    expect(rows).toHaveLength(2);
    expect(rows.filter(row=>row.state==='failed'||row.state==='cancelled')).toEqual([]);
    if(rows[0].state!=='completed')expect(rows[1].state).toBe('queued');
    if(rows.every(row=>row.state==='completed'))return;
    expect(await runBulkJobTick(owner.client,{handlers:[handler]})).toBe(true);
  }
  throw new Error(`${kind} did not complete both imports`);
}

it('admits two Personnel Everything uploads and publishes both employee records',async()=>{
  const ids=await submitTogether('employee_import',slot=>async actor=>{
    const csv=toCsv([
      ['employee_code','full_name','email','department','hired_on','employment_type','basic_salary','ic_number'],
      [`QUEUE-${slot}`,`Fictional queued employee ${slot}`,`queue-${slot}@fixture.test`,'Finance',todayInKualaLumpur(),'full_time','2500',`88010114000${slot+1}`],
    ]);
    const fileName=`employees-${slot}.csv`;
    const input={companyId:base.companyId,csv,fileName,dependentsCsv:'',registers:{},allocationsCsv:''};
    const source={name:fileName,content:Buffer.from(csv),operationKey:randomUUID()};
    const accepted=await createEmployeeImportJob(actor,input,source);
    if(!('job' in accepted))throw new Error('Expected an employee import job');
    const retry=await createEmployeeImportJob(actor,input,source);
    expect(retry).toMatchObject({existing:true,job:{id:accepted.job.id}});
    return accepted.job.id;
  });
  await drain('employee_import',ids);
  for(const [slot,actor] of actors.entries()){
    expect(await getEmployeeImportJob(actor,ids[slot])).toMatchObject({state:'completed',imported:1});
  }
  expect([...await owner.client`
    select employee_code from employment where tenant_id=${base.tenantId}::uuid and employee_code like 'QUEUE-%' order by employee_code
  `]).toEqual([{employee_code:'QUEUE-0'},{employee_code:'QUEUE-1'}]);
},180_000);

it('admits two Clocking uploads and completes both under their own logins',async()=>{
  const fixture=await buildAttendanceFixture(base,{employees:8});
  const files=[fixture.uncodedFile,fixture.codedFile];
  const ids=await submitTogether('clocking_import',slot=>async actor=>{
    const text=files[slot];
    const {job}=await startClockingImportJob(actor,{
      mappingId:slot===0?BUILTIN_MAPPING_ID:fixture.codedMappingId,
      text,fileName:`clocking-${slot}.csv`,fileBytes:Buffer.byteLength(text),
    });
    return job.id;
  });
  // While one worker holds the first import, a second worker must leave the later job queued.
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const preparing=runBulkJobTick(owner.client,{handlers:[{
    ...clockingImportJobHandler,
    async prepare(actor,job){
      entered.resolve();
      await release.promise;
      return clockingImportJobHandler.prepare(actor,job);
    },
  }]});
  try{
    await Promise.race([entered.promise,preparing.then(()=>{throw new Error('No Clocking job was prepared');})]);
    expect(await runBulkJobTick(owner.client,{handlers:[clockingImportJobHandler]})).toBe(false);
  }finally{
    release.resolve();
    await preparing;
  }
  await drain('clocking_import',ids);
  for(const [slot,actor] of actors.entries()){
    const done=await getClockingImportJob(actor,ids[slot]);
    expect(done.state).toBe('completed');
    expect(done.result?.imported).toBeGreaterThan(0);
    expect(done.result?.runId).toBeTruthy();
  }
},180_000);

it('keeps an import first when a second user started their transaction earlier',async()=>{
  const opened=Promise.withResolvers<void>(),submit=Promise.withResolvers<void>();
  const text='Card,Date,Time\nFixture,2026-01-01,09:00';
  const late=withTenant(actors[1],async tx=>{
    await tx.execute(sql`select now()`);
    opened.resolve();
    await submit.promise;
    return enqueueBulkJobTx(tx,actors[1],{
      kind:'clocking_import',source:{name:'late.csv',content:Buffer.from(text)},
      input:{mappingId:BUILTIN_MAPPING_ID,fileName:'late.csv',fileBytes:Buffer.byteLength(text)},
    });
  });
  await Promise.race([opened.promise,late.then(()=>{throw new Error('Second transaction did not wait');})]);
  const first=await startClockingImportJob(actors[0],{
    mappingId:BUILTIN_MAPPING_ID,text,fileName:'first.csv',fileBytes:Buffer.byteLength(text),
  }).finally(submit.resolve);
  const {row}=await late;
  expect(await withTenant(actors[1],tx=>bulkJobWaitingTx(tx,row.id))).toBe(true);
  expect(await withTenant(actors[0],tx=>bulkJobWaitingTx(tx,first.job.id))).toBe(false);
},60_000);

it('admits two System Labels uploads and publishes both disjoint grades',async()=>{
  const ids=await submitTogether('system_label_import',slot=>async actor=>{
    const bytes=await buildSystemLabelWorkbook({
      kinds:['grades'],includeStatus:true,references:{companies:[],grades:[],employees:[]},
      rows:{grades:[{Code:`QUEUE_GRADE_${slot}`,Label:`Queued grade ${slot}`,Rank:String(slot+1),Status:'Active',Criteria:'companies','Criteria Companies':base.companyId}]},
    });
    const preview=await previewSystemLabelImport(actor,bytes);
    expect(preview.valid,JSON.stringify(preview.rows)).toBe(true);
    const {job}=await startSystemLabelImportJob(actor,{bytes,token:preview.token,fileName:`labels-${slot}.xlsx`});
    return job.id;
  });
  await drain('system_label_import',ids);
  expect([...await owner.client`
    select code from job_grade where tenant_id=${base.tenantId}::uuid and code in ('QUEUE_GRADE_0','QUEUE_GRADE_1') order by code
  `]).toEqual([{code:'QUEUE_GRADE_0'},{code:'QUEUE_GRADE_1'}]);
},180_000);

it('admits two Rewards Person History uploads and records both awards',async()=>{
  await setModule(base.tenantId,'rewards','active');
  const entitled=await entitledCtx(base);
  actors=actors.map(actor=>({...entitled,userId:actor.userId})) as typeof actors;
  const year=Number(todayInKualaLumpur().slice(0,4))-2;
  for(const [slot,actor] of actors.entries()){
    await owner.client`
      insert into reward_setup_grant(tenant_id,user_id,role,valid_from,created_by,reason)
      values(${base.tenantId}::uuid,${actor.userId!}::uuid,'gr','2000-01-01',${base.adminUserId}::uuid,'Concurrent fixture')
      on conflict do nothing
    `;
    await hireEmployee(actor,{
      person:{fullName:`Fictional award subject ${slot}`,primaryEmail:`queue-award-${slot}@fixture.test`},
      companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',
      employeeCode:`QUEUE-AWARD-${slot}`,hiredOn:`${year-2}-01-01`,
    });
  }
  const ids=await submitTogether('reward_person_history',slot=>async actor=>{
    const raw={companyId:base.companyId,name:`rewards-${slot}.csv`,csv:toCsv([
      rewardHistoryUploadHeaders,[`QUEUE-AWARD-${slot}`,String(year),'STAR','AE','5','250','5000','1','Annual'],
    ])};
    const preview=await previewRewardPersonHistoryImport(actor,raw);
    expect(preview.problems).toEqual([]);
    return (await importRewardPersonHistory(actor,raw,preview.token)).jobId;
  });
  await drain('reward_person_history',ids);
  expect([...await owner.client`
    select upload_batch_id,created_by from reward_person_history
    where tenant_id=${base.tenantId}::uuid and upload_batch_id=any(${ids}::uuid[]) order by created_by
  `]).toEqual(actors.map((actor,slot)=>({upload_batch_id:ids[slot],created_by:actor.userId}))
    .sort((a,b)=>a.created_by!.localeCompare(b.created_by!)));
},180_000);
