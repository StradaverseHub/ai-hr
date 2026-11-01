/** Diagnostic only: test draft row sharing WITH an independent native first-payslip barrier. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withDataCommand} from '../../core/data-command';
import {lockPayrollForAttendanceChange} from '../../core/payroll-closed-runs';
import {hireEmployee} from '../../core/org';
import * as s from '../../db/schema';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function barrier(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
const settle=(work:Promise<unknown>)=>work.then(value=>({ok:true,value}),error=>{const causes=[];for(let item=error,i=0;item&&i<8;item=item.cause,i++)causes.push({code:item.code,message:String(item.message)});return{ok:false,causes};});
it('independently compares native concurrency and first-slip/status exclusion before, candidate and restored',async()=>{
 expect(process.env.GITHUB_ACTIONS).toBe('true');expect(new URL(process.env.TEST_DATABASE_URL!).hostname).toBe('127.0.0.1');
 await resetDb();const b=await seedBase(),ctx=adminCtx(b),today=todayInKualaLumpur(),month=today.slice(0,7);
 const people=[];for(let i=0;i<3;i++)people.push(await hireEmployee(ctx,{person:{fullName:'Fictional barrier subject '+i,primaryEmail:randomUUID()+'@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'}));
 const [period]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period:month}).returning();
 const [batch]=await owner.db.insert(s.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:period.id,payPeriod:month,batchDate:today}).returning();
 const originals=await owner.client`select p.oid::regprocedure::text as identity,pg_get_functiondef(p.oid) as definition,p.prosrc,to_jsonb(p) as attributes from pg_proc p where p.oid in ('app.attendance_payroll_protection_rows(uuid)'::regprocedure,'app.attendance_payroll_protection_rows(uuid,date[])'::regprocedure)`;
 expect(originals).toHaveLength(2);const report:Record<string,unknown>={};let restored=false;
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'draft-first-slip-barrier-work.json'),JSON.stringify({kind:'REVERSIBLE_FINANCIAL_BARRIER_DESIGN_EXPERIMENT',releaseEligible:false,restored,report},null,2));
 const key=`'perf-draft-first-slip:'||b.id::text`;
 const install=async()=>{
  await owner.client.unsafe(`create function public.perf_draft_first_slip_barrier() returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $fn$
  declare batch_key uuid; begin
   for batch_key in select distinct id from unnest(case when TG_OP='INSERT' then ARRAY[NEW.batch_id] else ARRAY[OLD.batch_id,NEW.batch_id] end) wanted(id) order by id loop
    perform id from public.payroll_batch where id=batch_key for key share;
    perform pg_advisory_xact_lock(hashtextextended('perf-draft-first-slip:'||batch_key::text,0));
   end loop;return NEW;end $fn$;
   revoke all on function public.perf_draft_first_slip_barrier() from public,ai_hr_app;
   create trigger a_perf_draft_first_slip_barrier before insert or update of batch_id,employment_id,tenant_id on public.payslip for each row execute function public.perf_draft_first_slip_barrier()`);
  for(const original of originals){
   const before=String(original.prosrc);expect(before.match(/ORDER BY b.id FOR UPDATE;/g)).toHaveLength(1);
   let body=before.replace('DECLARE subject employment;','DECLARE subject employment; selected_batch record; locked_status text;');
   expect(body).not.toBe(before);
   const start=body.indexOf(' PERFORM b.id FROM payroll_batch b'),end=body.indexOf('ORDER BY b.id FOR UPDATE;',start)+'ORDER BY b.id FOR UPDATE;'.length;
   expect(start).toBeGreaterThan(0);const select=body.slice(start,end).replace(' PERFORM b.id FROM','SELECT b.id,b.status::text AS expected_status FROM').replace(' FOR UPDATE;','');
   body=body.slice(0,start)+` FOR selected_batch IN ${select} LOOP
    IF selected_batch.expected_status='draft' THEN
    BEGIN
     SELECT b.status::text INTO locked_status FROM payroll_batch b WHERE b.id=selected_batch.id FOR SHARE;
     IF locked_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Reacquire changed Payroll source' USING ERRCODE='PFD01'; END IF;
     PERFORM pg_advisory_xact_lock_shared(hashtextextended('perf-draft-first-slip:'||selected_batch.id::text,0));
    EXCEPTION WHEN SQLSTATE 'PFD01' THEN
     -- The exception subtransaction releases the provisional SHARE lock before stronger ownership.
     PERFORM b.id FROM payroll_batch b WHERE b.id=selected_batch.id FOR UPDATE;
    END;
    ELSE
     PERFORM b.id FROM payroll_batch b WHERE b.id=selected_batch.id FOR UPDATE;
    END IF;
   END LOOP;`+body.slice(end);
   await owner.client.unsafe(String(original.definition).replace(before,()=>body));
   const [attrs]=await owner.client`select to_jsonb(p)-'prosrc' as value from pg_proc p where p.oid=${original.identity}::regprocedure`;
   const expected={...original.attributes};delete expected.prosrc;expect(attrs.value).toEqual(expected);
  }
 };
 const restore=async()=>{for(const original of originals)await owner.client.unsafe(String(original.definition));await owner.client.unsafe('drop trigger if exists a_perf_draft_first_slip_barrier on payslip; drop function if exists public.perf_draft_first_slip_barrier()');};
 try{
  for(const [phaseIndex,phase]of ['before','candidate','restored'].entries()){
   const phaseDate=month+'-'+String(15+phaseIndex);
   if(phase==='candidate')await install();if(phase==='restored')await restore();
   const entered=barrier(),release=barrier();
   const first=settle(withDataCommand(ctx,async tx=>{expect(await lockPayrollForAttendanceChange(tx,people[0].employmentId,phaseDate)).toEqual([]);entered.resolve();await release.promise;await tx.insert(s.attendance).values({tenantId:b.tenantId,employmentId:people[0].employmentId,attendanceDate:phaseDate,status:'present'}).onConflictDoNothing();}));
   let other:ReturnType<typeof settle>|undefined,slip:ReturnType<typeof settle>|undefined,status:ReturnType<typeof settle>|undefined;
   let overlap=false,firstSlipBlocked=false,statusBlocked=false;
   try{
    expect(await Promise.race([entered.promise.then(()=>true),first.then(()=>false),delay(3000).then(()=>false)])).toBe(true);
    other=settle(withDataCommand(ctx,async tx=>{expect(await lockPayrollForAttendanceChange(tx,people[1].employmentId,phaseDate)).toEqual([]);await tx.insert(s.attendance).values({tenantId:b.tenantId,employmentId:people[1].employmentId,attendanceDate:phaseDate,status:'present'}).onConflictDoNothing();}));
    overlap=await Promise.race([other.then(outcome=>outcome.ok),delay(250).then(()=>false)]);expect(overlap).toBe(phase==='candidate');
    slip=settle(owner.db.insert(s.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId:people[2].employmentId,basicSalary:'0',grossPay:'0',statutory:{},totalDeductions:'0',netPay:'0',employerCost:'0'}));
    firstSlipBlocked=await Promise.race([slip.then(()=>false),delay(200).then(()=>true)]);expect(firstSlipBlocked).toBe(true);
    const nativeWait=async(fragment:string)=>{const until=Date.now()+1500;while(Date.now()<until){const [row]=await owner.client`select exists(select 1 from pg_stat_activity where wait_event_type='Lock' and position(${fragment} in query)>0 and cardinality(pg_blocking_pids(pid))>0) as blocked`;if(row.blocked)return true;await delay(10);}return false;};
    expect(await nativeWait('insert into "payslip"'),'native first-payslip writer is physically blocked, not merely slow').toBe(true);
    status=settle(owner.db.update(s.payrollBatch).set({status:'processed'}).where(eq(s.payrollBatch.id,batch.id)));
    statusBlocked=await Promise.race([status.then(()=>false),delay(200).then(()=>true)]);expect(statusBlocked).toBe(true);expect(await nativeWait('update "payroll_batch"'),'native status writer is physically blocked').toBe(true);
   }finally{release.resolve();const outcomes=await Promise.all([first,...(other?[other]:[]),...(slip?[slip]:[]),...(status?[status]:[])]);report[phase]={overlap,firstSlipBlocked,statusBlocked,outcomes};save();expect(outcomes.every(row=>row.ok)).toBe(true);}

   const physical=await owner.db.select().from(s.attendance).where(eq(s.attendance.attendanceDate,phaseDate));expect(physical).toHaveLength(2);
   await owner.db.delete(s.payslip).where(eq(s.payslip.batchId,batch.id));await owner.db.update(s.payrollBatch).set({status:'draft'}).where(eq(s.payrollBatch.id,batch.id));
   if(phase==='candidate'){
    await owner.db.insert(s.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId:people[0].employmentId,basicSalary:'0',grossPay:'0',statutory:{},totalDeductions:'0',netPay:'0',employerCost:'0'});
    const nonDraft=[];
    await owner.db.update(s.payrollBatch).set({status:'processed'}).where(eq(s.payrollBatch.id,batch.id));
    await withDataCommand(ctx,async tx=>{
     expect(await lockPayrollForAttendanceChange(tx,people[0].employmentId,phaseDate)).toEqual([{batchId:batch.id,status:'processed'}]);
     let denied=false;try{await owner.client.begin(connection=>connection`select id from payroll_batch where id=${batch.id}::uuid for share nowait`);}catch(error){expect((error as {code:string}).code).toBe('55P03');denied=true;}expect(denied).toBe(true);nonDraft.push({state:'processed',exclusive:true});
    });
    await owner.db.update(s.payrollBatch).set({status:'draft'}).where(eq(s.payrollBatch.id,batch.id));
    const oldMonth=new Date(Date.parse(month+'-01T12:00:00Z')-180*86400000).toISOString().slice(0,7),oldDate=oldMonth+'-15';
    const [oldPeriod]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period:oldMonth}).returning();
    const [closed]=await owner.db.insert(s.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:oldPeriod.id,payPeriod:oldMonth,batchDate:oldDate}).returning();
    await owner.db.insert(s.payslip).values({tenantId:b.tenantId,batchId:closed.id,employmentId:people[0].employmentId,basicSalary:'0',grossPay:'0',statutory:{},totalDeductions:'0',netPay:'0',employerCost:'0'});
    await owner.db.update(s.payrollBatch).set({status:'closed'}).where(eq(s.payrollBatch.id,closed.id));
    await withDataCommand(ctx,async tx=>{
     expect(await lockPayrollForAttendanceChange(tx,people[0].employmentId,oldDate)).toEqual([{batchId:closed.id,status:'closed'}]);
     let denied=false;try{await owner.client.begin(connection=>connection`select id from payroll_batch where id=${closed.id}::uuid for share nowait`);}catch(error){expect((error as {code:string}).code).toBe('55P03');denied=true;}expect(denied).toBe(true);nonDraft.push({state:'closed',exclusive:true});
    });
    const changed=barrier(),commit=barrier();
    const writer=owner.client.begin(async connection=>{await connection`update payroll_batch set status='processed' where id=${batch.id}::uuid`;changed.resolve();await commit.promise;});
    await changed.promise;
    const readers=people.slice(0,2).map(person=>settle(withDataCommand(ctx,tx=>lockPayrollForAttendanceChange(tx,person.employmentId,phaseDate))));
    let twoNativeWaiters=false;
    try{const until=Date.now()+2500;while(Date.now()<until){const [row]=await owner.client`select count(*)::int as n from pg_stat_activity where wait_event_type='Lock' and position('app.attendance_payroll_protection(' in query)>0 and cardinality(pg_blocking_pids(pid))>0`;if(row.n>=2){twoNativeWaiters=true;break;}await delay(10);}expect(twoNativeWaiters,'both real guards wait on the uncommitted draft-to-processed status change').toBe(true);}
    finally{commit.resolve();await writer;}
    const race=await Promise.all(readers);expect(race).toEqual([{ok:true,value:[{batchId:batch.id,status:'processed'}]},{ok:true,value:[]}]);
    report.candidateExtra={physicalRows:physical.length,nonDraft,twoNativeWaiters,statusChangedAfterDraftRead:race,subtransactionReacquisition:true};save();
    await owner.db.delete(s.payslip).where(eq(s.payslip.batchId,batch.id));await owner.db.update(s.payrollBatch).set({status:'draft'}).where(eq(s.payrollBatch.id,batch.id));
   }

  }
 }finally{await restore();restored=true;save();}
},120000);
