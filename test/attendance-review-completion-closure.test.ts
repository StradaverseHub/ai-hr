/** Real migrated Attendance custody/native owners; source-qualified trigger-closure adversaries. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {pgSqlState} from '../lib/db-error';
import {todayInKualaLumpur} from '../lib/hr-date';
import {hireEmployee} from '../core/org';
import {assertReviewBodyPendingParentContract} from './helpers/review-body-pending-parent-contract';
import {createBatch,generatePayslips,createAdditionalRun,createAdditionalRunTx,createPolicy,assignPolicy,lockPayrollForAttendanceChange} from '../packs/payroll/service';
import {previewPayrollHistoryUpload,confirmPayrollHistoryUpload,previewPayrollHistoryRevert,revertPayrollHistoryUpload} from '../core/payroll-history-revisions';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {grantAssistant} from '../core/assistant-grant';
import {erasePersonPii} from '../core/pdpa';
import {captureNativeOutcomeTargetsTx} from '../core/module-native-outcome-targets';
import {createAttendanceRule,setEmploymentScheduleGroupTx,attendanceDayEditor,saveAttendanceDayEdit} from '../packs/attendance/service';
import {scheduleGroupMaintenanceReviews as groupStore} from '../core/assistant-actions/schedule-group-maintenance-review-store';
import {dayScheduleCorrectionReviews as dayStore} from '../core/assistant-actions/day-schedule-correction-review-store';
import {withScheduleGroupMaintenanceSubjectTx,prepareScheduleGroupMaintenanceSourceTx,confirmScheduleGroupMaintenanceSourceTx} from '../core/assistant-actions/schedule-group-maintenance-source';
import {withDayScheduleIntervalTx,prepareDayScheduleSourceTx,confirmDayScheduleSourceTx} from '../core/assistant-actions/day-schedule-correction-source';
import {ScheduleGroupMaintenance as G} from '../lib/assistant-actions/schedule-group-maintenance-contract';
import {DayScheduleCorrection as D} from '../lib/assistant-actions/day-schedule-correction-contract';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext,target:{employmentId:string;personId:string},groupId:string;
const cleanup:(()=>Promise<unknown>)[]=[];
const root=()=>({...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]});
beforeAll(migrateTestDb);afterAll(closeAll);
afterEach(async()=>{for(const drop of cleanup.reverse())await drop();cleanup.length=0;vi.unstubAllEnvs();});
beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-attendance-trigger-closure-key');await resetDb();b=await seedBase();
 for(const module of ['assistant','attendance'])await setModule(b.tenantId,module,'active');
 target=await hireEmployee(root(),{person:{fullName:'Fictional Attendance closure subject',primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 await grantAssistant(root(),{appUserId:b.adminUserId});ctx={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};
 groupId=(await createAttendanceRule(root(),{name:'Fictional closure group',status:'active',lateGracePeriodMinutes:0,lateAfterMinutes:0,lateDeductMinutes:0,includeGraceInLateness:false,earlyGracePeriodMinutes:0,earlyAfterMinutes:0,earlyDeductMinutes:0,includeGraceInEarlyOut:false,applyToEarlyOt:false,otRows:[]})).id;
});
// An independent actual persisted snapshot, including bodies, unrelated employment fields and native
// rows/events. Never compare a command's own summary to itself as a rollback oracle.
const tables=['public.app_user','public.pay_period','public.payslip','public.company_payroll_config','public.payroll_policy','public.payroll_history_import_attempt','public.payroll_history_import_record','public.payroll_history_import_snapshot','public.payroll_history_import_revision','public.payroll_history_import_event','public.employment','public.person','public.role_assignment','public.access_configuration','app.access_profile_write_generation','public.domain_event','public.attendance','public.attendance_punch','public.attendance_day_adjustment','public.attendance_overtime_source','public.attendance_overtime_calculation','public.attendance_overtime_calculation_evidence','public.attendance_overtime_policy_part','public.attendance_overtime_line','public.payroll_batch','app.assistant_own_leave_review','app.assistant_own_leave_review_content'];
async function snapshot(){return Promise.all(tables.map(async table=>{const[row]=await owner.db.execute<{rows:unknown}>(sql.raw(`select coalesce(jsonb_agg(j order by j::text),'[]'::jsonb) as rows from (select to_jsonb(x) j from ${table} x) source`));return{table,rows:row.rows};}));}
async function refused(work:()=>Promise<unknown>,before:Awaited<ReturnType<typeof snapshot>>){let failure:unknown;try{await work();}catch(error){failure=error;}expect(pgSqlState(failure)).toBe('42501');expect(await snapshot()).toEqual(before);return failure;}
async function trigger(table:string,when:string,body:string,deferred=false){
 const name='zz_test_attendance_'+randomUUID().replaceAll('-','');
 await owner.db.execute(sql.raw(`create function public.${name}() returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$ begin ${body} end $$`));
 await owner.db.execute(sql.raw(`create ${deferred?'constraint ':''}trigger ${name} ${when} on ${table} ${deferred?'deferrable initially deferred ':''}for each row execute function public.${name}()`));
 cleanup.push(async()=>{await owner.db.execute(sql.raw(`drop trigger if exists ${name} on ${table}`));await owner.db.execute(sql.raw(`drop function if exists public.${name}()`));});
}
async function groupHuman(){const[e]=await owner.db.select().from(s.employment).where(eq(s.employment.id,target.employmentId));return G.Human.parse({action:G.action,contractVersion:1,employmentId:target.employmentId,subjectId:target.employmentId,expectedGroupId:e.attendanceRuleId,attendanceRuleId:e.attendanceRuleId===null?groupId:null});}
async function dayHuman(date=todayInKualaLumpur()){const editor=await attendanceDayEditor(root(),target.employmentId,date);if(!editor)throw Error('Missing real native baseline');return D.Human.parse({action:D.action,contractVersion:1,employmentId:target.employmentId,subjectId:target.employmentId,date,baseline:editor.baseline,shiftId:null,dayKind:editor.dayKind===null?'rest_day':null,reason:'Fictional closure correction',confirmPayrollRecalculation:editor.processed});}
const actions=[G.action,D.action] as const;
async function prepared(action:typeof actions[number],date=todayInKualaLumpur()){
 if(action===G.action){const human=await groupHuman(),review=(await groupStore.prepare(ctx,human)).review;return{action,human,review} as const;}
 const human=await dayHuman(date),review=(await dayStore.prepare(ctx,human)).review;return{action,human,review} as const;
}
type Pick=Awaited<ReturnType<typeof prepared>>;
const confirm=(pick:Pick)=>pick.action===G.action?groupStore.confirm(ctx,{actionId:pick.review.actionId,reviewedDigest:pick.review.reviewedDigest}):dayStore.confirm(ctx,{action:D.action,contractVersion:1,actionId:pick.review.actionId,reviewedDigest:pick.review.reviewedDigest});
const reopen=(pick:Pick)=>pick.action===G.action?groupStore.reopen(ctx,pick.review.actionId):dayStore.reopen(ctx,pick.review.actionId);
async function completeTx(tx:Tx,pick:Pick,beforeComplete?:(tx:Tx)=>Promise<unknown>){
 if(pick.action===G.action)return withScheduleGroupMaintenanceSubjectTx(tx,ctx,target.employmentId,'pending',async fresh=>{
  const expected=await prepareScheduleGroupMaintenanceSourceTx(tx,fresh,pick.human),native=await confirmScheduleGroupMaintenanceSourceTx(tx,fresh,pick.human,expected.reviewedDigest);
  await captureNativeOutcomeTargetsTx(tx,fresh,{action:G.action,sourceId:pick.review.actionId,eventId:native.eventId,targets:[{kind:'employment',id:target.employmentId},{kind:'person',id:target.personId}]});
  if(beforeComplete)await beforeComplete(tx);
  await tx.execute(sql`select app.assistant_assigned_review_complete(${pick.review.actionId}::uuid,${G.action},${pick.review.reviewedDigest},${native.eventId}::uuid)`);
 });
 return withDayScheduleIntervalTx(tx,ctx,{employmentId:target.employmentId,date:pick.human.date},async(fresh,subject)=>{
  const expected=await prepareDayScheduleSourceTx(tx,fresh,pick.human,subject),native=await confirmDayScheduleSourceTx(tx,fresh,pick.human,expected.reviewedDigest,subject);
  await captureNativeOutcomeTargetsTx(tx,fresh,{action:D.action,sourceId:pick.review.actionId,eventId:native.eventId,targets:[{kind:'employment',id:target.employmentId},{kind:'person',id:target.personId}]});
  if(beforeComplete)await beforeComplete(tx);
  await tx.execute(sql`select app.assistant_attendance_day_schedule_command(p_operation=>'complete',p_id=>${pick.review.actionId}::uuid,p_reviewed=>${pick.review.reviewedDigest},p_event=>${native.eventId}::uuid)`);
 });
}
async function completionControl(pick:Pick){
 // Application has no direct ledger/body SELECT grant. A fixture-only, exact-row reader
 // observes this transaction's persisted SQL state without widening production authority.
 const name='fixture_attendance_complete_read_'+randomUUID().replaceAll('-','');
 await owner.db.execute(sql.raw(`create function app.${name}() returns jsonb language sql security definer set search_path=pg_catalog,public,pg_temp as $$ select jsonb_build_object('state',q.state,'bodies',(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=q.id)) from app.assistant_own_leave_review q where q.id='${pick.review.actionId}'::uuid and q.tenant_id=app.current_tenant_id() and q.user_id=app.current_user_id() $$;revoke all on function app.${name}() from public;grant execute on function app.${name}() to ai_hr_app;`));cleanup.push(()=>owner.db.execute(sql.raw(`drop function if exists app.${name}()`)));
 const before=await snapshot(),control=Error('rollback actual protected complete positive');
 await expect(withTenant(ctx,async tx=>{await completeTx(tx,pick);const[row]=await tx.execute<{record:{state:string;bodies:number}}>(sql`select ${sql.raw('app.'+name)}() record`);expect(row.record).toEqual({state:'completed',bodies:0});throw control;})).rejects.toBe(control);expect(await snapshot()).toEqual(before);
}
for(const action of actions){
 it(`${action}: refuses a real ordinary AFTER DELETE ciphertext resurrection and rolls back the entire native/custody transaction`,async()=>{
  const pick=await prepared(action),[body]=await owner.db.execute<{size:number}>(sql`select octet_length(ciphertext)::int as size from app.assistant_own_leave_review_content where action_id=${pick.review.actionId}::uuid`);expect(body.size).toBeGreaterThan(0);
  // A genuine pending body UPDATE succeeds; the completed-only guard is nonvacuously scoped.
  await owner.db.execute(sql`update app.assistant_own_leave_review_content set ciphertext=ciphertext where action_id=${pick.review.actionId}::uuid`);
  await trigger('app.assistant_own_leave_review_content','after delete',`if OLD.action_id='${pick.review.actionId}'::uuid then insert into app.assistant_own_leave_review_content values(OLD.action_id,OLD.kid,OLD.wrapped_dek,OLD.ciphertext);end if;return OLD;`);
  const before=await snapshot();await refused(()=>withTenant(ctx,tx=>completeTx(tx,pick)),before);
 });
 it(`${action}: refuses a later BEFORE terminal-ledger identity rewrite with exact 42501`,async()=>{
  const pick=await prepared(action);
  await trigger('app.assistant_own_leave_review','before update',`if OLD.id='${pick.review.actionId}'::uuid and OLD.state='awaiting_confirmation' and NEW.state='completed' then NEW.expires_at:=OLD.expires_at-interval '1 second';end if;return NEW;`);
  const before=await snapshot();await refused(()=>withTenant(ctx,tx=>completeTx(tx,pick)),before);
 });
 it(`${action}: catches a late BEFORE body retarget after the first guard and preserves both real rows`,async()=>{
  const completed=await prepared(action);expect((await confirm(completed)).kind).toBe('completed');
  const pending=await prepared(action),[body]=await owner.db.execute<{size:number}>(sql`select octet_length(ciphertext)::int as size from app.assistant_own_leave_review_content where action_id=${pending.review.actionId}::uuid`);expect(body.size).toBeGreaterThan(0);
  await trigger('app.assistant_own_leave_review_content','before update',`if OLD.action_id='${pending.review.actionId}'::uuid then NEW.action_id:='${completed.review.actionId}'::uuid;end if;return NEW;`);
  const before=await snapshot();await refused(()=>owner.db.execute(sql`update app.assistant_own_leave_review_content set ciphertext=ciphertext where action_id=${pending.review.actionId}::uuid`),before);
 });
 it(`${action}: SET CONSTRAINTS IMMEDIATE cannot authorize a later write to the completed native root`,async()=>{
  const pick=await prepared(action),before=await snapshot();
  await refused(()=>withTenant(ctx,async tx=>{await completeTx(tx,pick);await tx.execute(sql`set constraints all immediate`);
   if(action===G.action)await tx.execute(sql`update public.employment set employee_code='UNREVIEWED_AFTER_COMPLETION' where id=${target.employmentId}::uuid`);
   else await tx.execute(sql`update public.attendance_day_adjustment set reason='Unreviewed after completion' where employment_id=${target.employmentId}::uuid and attendance_date=${todayInKualaLumpur()}::date`);
  }),before);
 });
 it(`${action}: rechecks fresh authority after an ordinary completion trigger and rolls back role/native/custody effects`,async()=>{
  const pick=await prepared(action);
  await trigger('app.assistant_own_leave_review_content','after delete',`if OLD.action_id='${pick.review.actionId}'::uuid then delete from public.role_assignment where app_user_id='${ctx.userId}'::uuid;end if;return OLD;`);
  const before=await snapshot();await refused(()=>withTenant(ctx,tx=>completeTx(tx,pick)),before);
 });
 it(`${action}: preserves later native edits, original historical recovery and actual completed-review PDPA`,async()=>{
  const pick=await prepared(action),done=await confirm(pick);expect(done.kind).toBe('completed');
  if(action===G.action)await withTenant(root(),tx=>setEmploymentScheduleGroupTx(tx,root(),{employmentId:target.employmentId,attendanceRuleId:null}));
  else{const human=await dayHuman();await saveAttendanceDayEdit(root(),{...human,kind:'schedule',dayKind:'holiday',reason:'Later separately authorized native correction'});}
  expect(await reopen(pick)).toEqual(done);
  await erasePersonPii(root(),{subjectEmploymentId:target.employmentId,scope:'contact',requestRef:'FICTIONAL-ATTENDANCE-COMPLETION-PRIVACY',reason:'Fictional completed review privacy check'});
  const[body]=await owner.db.execute<{count:number}>(sql`select count(*)::int as count from app.assistant_own_leave_review_content where action_id=${pick.review.actionId}::uuid`);expect(body.count).toBe(0);expect(await reopen(pick)).toEqual(done);
 });
}
it('group PRE-native full employment commitment refuses an unrelated employee-code rewrite, with a nonempty native control and whole rollback',async()=>{
 const pick=await prepared(G.action);if(pick.action!==G.action)throw Error('Expected group review');const human=pick.human,[original]=await owner.db.select().from(s.employment).where(eq(s.employment.id,target.employmentId));expect(original.employeeCode).toEqual(expect.any(String));expect(original.employeeCode!.length).toBeGreaterThan(0);
 // Control: the real native owner can actually update this nonempty source and emit its event.
 await expect(withTenant(ctx,async tx=>{const current=await prepareScheduleGroupMaintenanceSourceTx(tx,ctx,human),native=await confirmScheduleGroupMaintenanceSourceTx(tx,ctx,human,current.reviewedDigest);expect(native.eventId).toEqual(expect.any(String));throw Error('rollback successful native control');})).rejects.toThrow('rollback successful native control');
 await trigger('public.employment','before update',`if OLD.id='${target.employmentId}'::uuid and NEW.attendance_rule_id is distinct from OLD.attendance_rule_id then NEW.employee_code:='UNREVIEWED_PREIMAGE';end if;return NEW;`);
 const before=await snapshot();await refused(()=>withTenant(ctx,async tx=>{const current=await prepareScheduleGroupMaintenanceSourceTx(tx,ctx,human);await confirmScheduleGroupMaintenanceSourceTx(tx,ctx,human,current.reviewedDigest);}),before);
});

for(const action of actions){
 it(`${action}: composes central0861 pending-parent guards with real parent-first and body-first connection ordering`,async()=>{
  await assertReviewBodyPendingParentContract({ctx,kind:action,terminalState:'completed',
   prepare:async()=>{const pick=await prepared(action);return{actionId:pick.review.actionId,pick};},
   retire:row=>confirm(row.pick),businessSnapshot:snapshot,
   retireTx:async(tx,id)=>{if(action===G.action)return tx.execute(sql`select app.assistant_assigned_review_read(${id}::uuid,${G.action},true)`);return tx.execute(sql`select app.assistant_attendance_day_schedule_command(p_operation=>'discard',p_id=>${id}::uuid)`);},
  });
 },30000);
 it(`${action}: refuses a same-root actor PERSON relink after IMMEDIATE, with a genuine valid relink control`,async()=>{
  const pick=await prepared(action),name='fixture_attendance_actor_'+randomUUID().replaceAll('-','');
  await owner.db.execute(sql.raw(`create function app.${name}() returns integer language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$ declare n integer;begin update public.app_user set person_id='${target.personId}'::uuid where id='${ctx.userId}'::uuid;get diagnostics n=row_count;return n;end $$;revoke all on function app.${name}() from public;grant execute on function app.${name}() to ai_hr_app;`));
  cleanup.push(()=>owner.db.execute(sql.raw(`drop function if exists app.${name}()`)));
  const before=await snapshot(),control=Error('rollback valid actor relink control');
  await expect(withTenant(ctx,async tx=>{const[row]=await tx.execute<{n:number}>(sql`select ${sql.raw('app.'+name)}() n`);expect(row.n).toBe(1);throw control;})).rejects.toBe(control);expect(await snapshot()).toEqual(before);
  await refused(()=>withTenant(ctx,async tx=>{await completeTx(tx,pick);await tx.execute(sql`set constraints all immediate`);await tx.execute(sql`select ${sql.raw('app.'+name)}()`);}),before);
 });
 it(`${action}: a genuinely slow ordinary body-delete trigger cannot outlive the final confirmation deadline`,async()=>{
  const pick=await prepared(action),sequence='fixture_attendance_expiry_'+randomUUID().replaceAll('-',''),entry=sequence+'_entry',exit=sequence+'_exit';
  // Sequence changes survive the intended full transaction rollback. Each records the
  // actual SQL clock minus the actual stored expiry in microseconds, not a mocked clock.
  for(const marker of [entry,exit]){await owner.db.execute(sql.raw(`create sequence public.${marker} as bigint minvalue -9223372036854775808 maxvalue 9223372036854775807 start with 0`));cleanup.push(()=>owner.db.execute(sql.raw(`drop sequence if exists public.${marker}`)));}
  await trigger('app.assistant_own_leave_review_content','after delete',`if OLD.action_id='${pick.review.actionId}'::uuid then
   declare actual_expiry timestamptz;entered timestamptz;exited timestamptz;begin
    select expires_at into actual_expiry from app.assistant_own_leave_review where id=OLD.action_id;
    if not found then raise exception 'Fictional callback expiry missing' using errcode='P0001';end if;
    entered:=clock_timestamp();perform setval('public.${entry}',floor(extract(epoch from (entered-actual_expiry))*1000000)::bigint,true);
    if entered>=actual_expiry then raise exception 'Fictional callback entered after expiry' using errcode='P0001';end if;
    perform pg_sleep(3);
    exited:=clock_timestamp();perform setval('public.${exit}',floor(extract(epoch from (exited-actual_expiry))*1000000)::bigint,true);
    if exited<=actual_expiry then raise exception 'Fictional callback exited before expiry' using errcode='P0001';end if;
   end;
  end if;return OLD;`);
  // Fixture-only exact-row deadline setup; the app itself has no raw ledger UPDATE.
  const deadline='fixture_attendance_deadline_'+randomUUID().replaceAll('-','');
  await owner.db.execute(sql.raw(`create function app.${deadline}() returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$ begin update app.assistant_own_leave_review set expires_at=clock_timestamp()+interval '2 seconds' where id='${pick.review.actionId}'::uuid and state='awaiting_confirmation' and tenant_id=app.current_tenant_id() and user_id=app.current_user_id();if not found then raise exception 'Fictional deadline row missing';end if;end $$;revoke all on function app.${deadline}() from public;grant execute on function app.${deadline}() to ai_hr_app;`));cleanup.push(()=>owner.db.execute(sql.raw(`drop function if exists app.${deadline}()`)));
  // Arm immediately before SQL completion, after actual native work/target capture;
  // three seconds crosses the real deadline within the real five-second statement cap.
  const before=await snapshot(),failure=await refused(()=>withTenant(ctx,tx=>completeTx(tx,pick,inner=>inner.execute(sql`select ${sql.raw('app.'+deadline)}()`))),before);
  const messages:string[]=[];let cause:unknown=failure;const visited=new Set<unknown>();
  while(cause&&typeof cause==='object'&&!visited.has(cause)){visited.add(cause);const error=cause as {message?:string;cause?:unknown};if(error.message)messages.push(error.message);cause=error.cause;}
  expect(messages).toContain('Attendance confirmation expired');
  const[entrySeen]=await owner.db.execute<{called:boolean;delta:string}>(sql.raw(`select is_called called,last_value::text delta from public.${entry}`));
  const[exitSeen]=await owner.db.execute<{called:boolean;delta:string}>(sql.raw(`select is_called called,last_value::text delta from public.${exit}`));
  expect(entrySeen.called,'ordinary callback entry must precede expiry').toBe(true);expect(exitSeen.called,'the real sleeping callback must return past expiry').toBe(true);
  expect(BigInt(entrySeen.delta)<BigInt(0)).toBe(true);expect(BigInt(exitSeen.delta)>BigInt(0)).toBe(true);
 },30000);
}

async function payrollFixture(){
 await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'multi_cycle_payroll','active');ctx={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};
 await setCompensation(ctx,{employmentId:target.employmentId,basicSalary:4000,monthlyAllowance:0,effectiveFrom:'2020-01-01'});
 await setStatutoryProfileMY(ctx,{personId:target.personId,icNumber:'900101011234'});
 const period=todayInKualaLumpur().slice(0,7),source=(await createBatch(ctx,{companyId:b.companyId,payPeriod:period})).batchId;
 await generatePayslips(ctx,{batchId:source});const slips=await owner.db.select().from(s.payslip).where(and(eq(s.payslip.batchId,source),eq(s.payslip.employmentId,target.employmentId))).orderBy(s.payslip.id);expect(slips).toHaveLength(1);const slip=slips[0];expect(slip).toMatchObject({employmentId:target.employmentId});
 const next=(await createAdditionalRun(ctx,{companyId:b.companyId,payPeriod:period,runType:'bonus'})).batchId;
 return{source,next,slipId:slip.id,period};
}
async function memberWriter(sourceSlip:string,batchId:string){
 const name='fixture_attendance_member_'+randomUUID().replaceAll('-',''),id=randomUUID();
 await owner.db.execute(sql.raw(`create function app.${name}() returns integer language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$ declare n integer;begin
  update public.payroll_batch set status='processed' where id='${batchId}'::uuid;
  insert into public.payslip select (jsonb_populate_record(null::public.payslip,to_jsonb(ps)||jsonb_build_object('id','${id}','batch_id','${batchId}'))).* from public.payslip ps where ps.id='${sourceSlip}'::uuid;
  get diagnostics n=row_count;return n;end $$;revoke all on function app.${name}() from public;grant execute on function app.${name}() to ai_hr_app;`));
 cleanup.push(()=>owner.db.execute(sql.raw(`drop function if exists app.${name}()`)));return name;
}
it('dated completion blocks a NEW actual target payslip membership absent from the reviewed batch IDs and rolls back the whole transaction',async()=>{
 const f=await payrollFixture(),pick=await prepared(D.action),name=await memberWriter(f.slipId,f.next);
 if(pick.action!==D.action)throw Error('Expected dated review');
 expect(pick.review.review.before.payroll.map(row=>row.batchId)).not.toContain(f.next);expect(pick.review.review.before.payroll.map(row=>row.batchId)).toContain(f.source);
 const before=await snapshot(),control=Error('rollback valid native-derived membership control');
 await expect(withTenant(ctx,async tx=>{const[row]=await tx.execute<{n:number}>(sql`select ${sql.raw('app.'+name)}() n`);expect(row.n).toBe(1);throw control;})).rejects.toBe(control);expect(await snapshot()).toEqual(before);
 await refused(()=>withTenant(ctx,async tx=>{await completeTx(tx,pick);await tx.execute(sql`set constraints all immediate`);await tx.execute(sql`select ${sql.raw('app.'+name)}()`);}),before);
});
it('dated completion blocks a NEW native-created relevant run and its target membership while permitting an unrelated payroll month',async()=>{
 const f=await payrollFixture(),pick=await prepared(D.action),before=await snapshot();
 // Parent creation alone does not establish Attendance ownership; real native run creation is legal.
 // Adding the actual subject's processed payslip then makes this new ID relevant and must refuse.
 const name='fixture_attendance_new_member_'+randomUUID().replaceAll('-','');
 await owner.db.execute(sql.raw(`create function app.${name}(batch uuid) returns integer language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$ declare n integer;begin update public.payroll_batch set status='processed' where id=batch;insert into public.payslip select (jsonb_populate_record(null::public.payslip,to_jsonb(ps)||jsonb_build_object('id',gen_random_uuid(),'batch_id',batch))).* from public.payslip ps where ps.id='${f.slipId}'::uuid;get diagnostics n=row_count;return n;end $$;revoke all on function app.${name}(uuid) from public;grant execute on function app.${name}(uuid) to ai_hr_app;`));
 cleanup.push(()=>owner.db.execute(sql.raw(`drop function if exists app.${name}(uuid)`)));
 await refused(()=>withTenant(ctx,async tx=>{await completeTx(tx,pick);await tx.execute(sql`set constraints all immediate`);const created=await createAdditionalRunTx(tx,ctx,{companyId:b.companyId,payPeriod:f.period,runType:'bonus'});expect(created.batchId).toEqual(expect.any(String));await tx.execute(sql`select ${sql.raw('app.'+name)}(${created.batchId}::uuid)`);}),before);
 const future=new Date(Date.parse(f.period+'-01T00:00:00Z'));future.setUTCMonth(future.getUTCMonth()+3);const otherPeriod=future.toISOString().slice(0,7);
 const other=(await createBatch(ctx,{companyId:b.companyId,payPeriod:otherPeriod})).batchId,otherName=await memberWriter(f.slipId,other),positive=Error('rollback unrelated period positive');
 const positiveBefore=await snapshot();await expect(withTenant(ctx,async tx=>{await completeTx(tx,pick);await tx.execute(sql`set constraints all immediate`);const[row]=await tx.execute<{n:number}>(sql`select ${sql.raw('app.'+otherName)}() n`);expect(row.n).toBe(1);throw positive;})).rejects.toBe(positive);expect(await snapshot()).toEqual(positiveBefore);
});

it('new payroll membership uses the native calendar/company/custom frequency cutoff windows with independent boundary goldens',async()=>{
 const f=await payrollFixture(),name='fixture_attendance_cutoff_'+randomUUID().replaceAll('-','');
 await owner.db.execute(sql.raw(`create function app.${name}(day date) returns boolean language sql security definer set search_path=pg_catalog,public,pg_temp as $$ select app._assistant_attendance_batch_covers('${target.employmentId}'::uuid,day,to_jsonb(b)) from public.payroll_batch b where b.id='${f.source}'::uuid $$;revoke all on function app.${name}(date) from public;grant execute on function app.${name}(date) to ai_hr_app;`));cleanup.push(()=>owner.db.execute(sql.raw(`drop function if exists app.${name}(date)`)));
 const previous=new Date(Date.parse(f.period+'-01T00:00:00Z'));previous.setUTCMonth(previous.getUTCMonth()-1);const prior=previous.toISOString().slice(0,7);
 const check=async(date:string,expected:boolean)=>withTenant(ctx,async tx=>{
  const[row]=await tx.execute<{matches:boolean}>(sql`select ${sql.raw('app.'+name)}(${date}::date) matches`);expect(row.matches).toBe(expected);
  const native=await lockPayrollForAttendanceChange(tx,target.employmentId,date);expect(native.some(batch=>batch.batchId===f.source)).toBe(expected);
 });
 // Default calendar month, not a guessed adjacent-month union.
 await check(prior+'-28',false);await check(f.period+'-01',true);
 await owner.db.insert(s.companyPayrollConfig).values({tenantId:b.tenantId,companyId:b.companyId,attendanceCutOffDay:15}).onConflictDoUpdate({target:s.companyPayrollConfig.companyId,set:{attendanceCutOffDay:15}});
 await check(prior+'-14',false);await check(prior+'-15',true);await check(f.period+'-14',true);await check(f.period+'-15',false);
 const policy=await createPolicy(ctx,{companyId:b.companyId,name:'Fictional weekly Attendance cutoff',policyType:'monthly',config:{frequency:'weekly',cutOff:{mode:'custom',anchorDay:15,perType:{attendance:20},perFrequency:{weekly:{anchorDay:22,perType:{attendance:25}}}}}});
 await assignPolicy(ctx,{employmentId:target.employmentId,policyId:policy.id});
 await check(prior+'-24',false);await check(prior+'-25',true);await check(f.period+'-24',true);await check(f.period+'-25',false);
});

it('group final closure retains its PRE-native expected row through an ordinary BEFORE terminal-ledger employment mutation',async()=>{
 const pick=await prepared(G.action),[original]=await owner.db.select().from(s.employment).where(eq(s.employment.id,target.employmentId));expect(original.employeeCode).toEqual(expect.any(String));
 await trigger('app.assistant_own_leave_review','before update',`if OLD.id='${pick.review.actionId}'::uuid and OLD.state='awaiting_confirmation' and NEW.state='completed' then update public.employment set employee_code='UNREVIEWED_BEFORE_LEDGER' where id='${target.employmentId}'::uuid;end if;return NEW;`);
 const before=await snapshot();await refused(()=>withTenant(ctx,tx=>completeTx(tx,pick)),before);
});
it('dated final closure catches new payroll membership inserted BEFORE the parent becomes completed, beyond the completed-root fence',async()=>{
 const f=await payrollFixture(),pick=await prepared(D.action),name=await memberWriter(f.slipId,f.next),sequence='fixture_attendance_membership_'+randomUUID().replaceAll('-','');
 await owner.db.execute(sql.raw(`create sequence public.${sequence}`));cleanup.push(()=>owner.db.execute(sql.raw(`drop sequence if exists public.${sequence}`)));
 const control=Error('rollback before-ledger valid membership control'),before=await snapshot();
 await expect(withTenant(ctx,async tx=>{const[row]=await tx.execute<{n:number}>(sql`select ${sql.raw('app.'+name)}() n`);expect(row.n).toBe(1);throw control;})).rejects.toBe(control);expect(await snapshot()).toEqual(before);
 await trigger('app.assistant_own_leave_review','before update',`if OLD.id='${pick.review.actionId}'::uuid and OLD.state='awaiting_confirmation' and NEW.state='completed' then perform nextval('public.${sequence}');perform app.${name}();end if;return NEW;`);
 await refused(()=>withTenant(ctx,tx=>completeTx(tx,pick)),before);
 const[seen]=await owner.db.execute<{called:boolean}>(sql.raw(`select is_called as called from public.${sequence}`));expect(seen.called).toBe(true);
});

it('raw group completion cannot substitute the already-tampered current JSON for the SQL-owned PRE-native commitment',async()=>{
 const pick=await prepared(G.action);if(pick.action!==G.action)throw Error('Expected group');
 const[privateRow]=await owner.db.execute<{version:number;digest:string}>(sql`select attendance_group_proof_version as version,attendance_group_unchanged as digest from app.assistant_own_leave_review where id=${pick.review.actionId}::uuid`);expect(privateRow.version).toBe(1);expect(privateRow.digest).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(pick.review)).not.toContain(privateRow.digest);
 const sequence='fixture_attendance_forged_seen_'+randomUUID().replaceAll('-','');await owner.db.execute(sql.raw(`create sequence public.${sequence};grant usage on sequence public.${sequence} to ai_hr_app`));cleanup.push(()=>owner.db.execute(sql.raw(`drop sequence if exists public.${sequence}`)));
 const before=await snapshot();await refused(()=>withTenant(ctx,async tx=>{
  const{setEmploymentScheduleGroupTx}=await import('../packs/attendance/service');
  const native=await setEmploymentScheduleGroupTx(tx,ctx,{employmentId:target.employmentId,attendanceRuleId:pick.human.attendanceRuleId},{returnEventId:true});expect(native.eventId).toEqual(expect.any(String));
  await tx.execute(sql`update public.employment set employee_code='FORGED_CURRENT_POSTIMAGE' where id=${target.employmentId}::uuid`);
  const[callerExpected]=await tx.execute<{value:Record<string,unknown>}>(sql`select to_jsonb(e) as value from public.employment e where e.id=${target.employmentId}::uuid`);expect(callerExpected.value.employee_code).toBe('FORGED_CURRENT_POSTIMAGE');await tx.execute(sql.raw(`select nextval('public.${sequence}')`));
  await captureNativeOutcomeTargetsTx(tx,ctx,{action:G.action,sourceId:pick.review.actionId,eventId:native.eventId!,targets:[{kind:'employment',id:target.employmentId},{kind:'person',id:target.personId}]});
  // There is no app-callable JSON expectation seam. The fixed four-arg owner re-reads protected
  // SQL prepare data and rejects even though the real group event/current tuple otherwise agree.
  await tx.execute(sql`select app.assistant_assigned_review_complete(${pick.review.actionId}::uuid,${G.action},${pick.review.reviewedDigest},${native.eventId}::uuid)`);
 }),before);const[seen]=await owner.db.execute<{called:boolean}>(sql.raw(`select is_called as called from public.${sequence}`));expect(seen.called).toBe(true);
});
it('SQL-owned group pending evidence cannot be replaced or cleared through a type-correct owner UPDATE',async()=>{
 const pick=await prepared(G.action);await owner.db.execute(sql`update app.assistant_own_leave_review set attendance_group_unchanged=attendance_group_unchanged where id=${pick.review.actionId}::uuid`);
 const before=await snapshot();await refused(()=>owner.db.execute(sql`update app.assistant_own_leave_review set attendance_group_unchanged=${'0'.repeat(64)} where id=${pick.review.actionId}::uuid`),before);
 expect((await confirm(pick)).kind).toBe('completed');
 const[row]=await owner.db.execute<{version:number;digest:string|null;before:string|null;after:string|null}>(sql`select attendance_group_proof_version as version,attendance_group_unchanged as digest,attendance_group_before as before,attendance_group_after as after from app.assistant_own_leave_review where id=${pick.review.actionId}::uuid`);expect(row).toEqual({version:1,digest:null,before:null,after:null});
});
async function historyFixture(){
 await setModule(b.tenantId,'payroll','active');ctx={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};
 await owner.db.update(s.company).set({companyLabel:'HATTN'}).where(eq(s.company.id,b.companyId));
 await owner.db.update(s.employment).set({employeeCode:'HISTATTN001'}).where(eq(s.employment.id,target.employmentId));
 await seedPayrollCycleCatalog(ctx,b.companyId);await owner.db.insert(s.payComponent).values({tenantId:b.tenantId,code:'BASIC',name:'Fictional history basic',kind:'allowance',displayCategory:'basic'});
 const month=new Date(Date.parse(todayInKualaLumpur().slice(0,7)+'-01T00:00:00Z'));month.setUTCMonth(month.getUTCMonth()-1);const period=month.toISOString().slice(0,7),date=period+'-15';
 const csv=Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...(['BASIC','EEEPF','EESOCSO','EEEIS','PCB'] as const).map(code=>['HISTATTN001',period,'ME',code,'HATTN',code==='BASIC'?'5000.00':'0.00'])]));
 const upload=()=>previewPayrollHistoryUpload(ctx,{name:'fictional-attendance-history.csv',content:csv,operationKey:randomUUID()});
 const first=await upload();expect(first.plan.counts).toMatchObject({created:1,invalid:0});const imported=await confirmPayrollHistoryUpload(ctx,{attemptId:first.attemptId,previewHash:first.plan.previewHash,confirmReplacement:true});expect(imported.changes).toHaveLength(1);const snapshotId=imported.changes[0].snapshotId;if(!snapshotId)throw Error('Missing real imported snapshot');
 expect((await withTenant(ctx,tx=>tx.execute<{active:boolean}>(sql`select app.payroll_history_effective(${snapshotId}::uuid) as active`)))[0].active).toBe(true);
 const revert=await previewPayrollHistoryRevert(ctx,first.attemptId);expect(revert.count).toBe(1);expect(await revertPayrollHistoryUpload(ctx,first.attemptId,revert.previewHash)).toMatchObject({restored:1});
 expect((await withTenant(ctx,tx=>tx.execute<{active:boolean}>(sql`select app.payroll_history_effective(${snapshotId}::uuid) as active`)))[0].active).toBe(false);
 const[record]=await owner.db.select().from(s.payrollHistoryImportRecord).where(and(eq(s.payrollHistoryImportRecord.employmentId,target.employmentId),eq(s.payrollHistoryImportRecord.period,period)));expect(record).toBeTruthy();
 const candidate=await upload();expect(candidate.plan.counts.invalid).toBe(0);expect(candidate.plan.rows).toHaveLength(1);
 return{date,period,snapshotId,recordId:record.id,attemptId:candidate.attemptId,upload};
}
async function historyWriter(f:Awaited<ReturnType<typeof historyFixture>>,roundtrip:boolean){
 const name='fixture_attendance_provenance_'+randomUUID().replaceAll('-','');
 await owner.db.execute(sql.raw(`create function app.${name}() returns integer language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$ declare prior public.payroll_history_import_revision;created public.payroll_history_import_revision;n integer;begin
 select * into prior from public.payroll_history_import_revision where record_id='${f.recordId}'::uuid order by ordinal desc limit 1;
 insert into public.payroll_history_import_revision(tenant_id,record_id,ordinal,attempt_id,snapshot_id,previous_revision_id,kind,cycle_name) values('${b.tenantId}'::uuid,'${f.recordId}'::uuid,prior.ordinal+1,'${f.attemptId}'::uuid,'${f.snapshotId}'::uuid,prior.id,'correction',prior.cycle_name) returning * into created;
 ${roundtrip?`insert into public.payroll_history_import_revision(tenant_id,record_id,ordinal,attempt_id,snapshot_id,previous_revision_id,kind,cycle_name) values('${b.tenantId}'::uuid,'${f.recordId}'::uuid,created.ordinal+1,'${f.attemptId}'::uuid,NULL,created.id,'revert',created.cycle_name);`:''}
 return ${roundtrip?2:1};end $$;revoke all on function app.${name}() from public;grant execute on function app.${name}() to ai_hr_app;`));
 cleanup.push(()=>owner.db.execute(sql.raw(`drop function if exists app.${name}()`)));return name;
}
it('actual native import/revert controls establish valid history provenance; a same-root revision-only reactivation refuses after IMMEDIATE',async()=>{
 const f=await historyFixture(),pick=await prepared(D.action,f.date),name=await historyWriter(f,false);await completionControl(pick);const before=await snapshot(),control=Error('rollback genuine next-revision SQL control');
 await expect(withTenant(ctx,async tx=>{const[row]=await tx.execute<{n:number}>(sql`select ${sql.raw('app.'+name)}() n`);expect(row.n).toBe(1);const[active]=await tx.execute<{active:boolean}>(sql`select app.payroll_history_effective(${f.snapshotId}::uuid) active`);expect(active.active).toBe(true);throw control;})).rejects.toBe(control);expect(await snapshot()).toEqual(before);
 await refused(()=>withTenant(ctx,async tx=>{await completeTx(tx,pick);await tx.execute(sql`set constraints all immediate`);await tx.execute(sql`select ${sql.raw('app.'+name)}()`);}),before);
});
it('protected dated SQL prepare evidence catches a BEFORE-ledger history correction/revert roundtrip even when the effective batch set ends unchanged',async()=>{
 const f=await historyFixture(),pick=await prepared(D.action,f.date),name=await historyWriter(f,true);await completionControl(pick);const before=await snapshot(),control=Error('rollback valid history roundtrip control');
 await expect(withTenant(ctx,async tx=>{const[row]=await tx.execute<{n:number}>(sql`select ${sql.raw('app.'+name)}() n`);expect(row.n).toBe(2);const[active]=await tx.execute<{active:boolean}>(sql`select app.payroll_history_effective(${f.snapshotId}::uuid) active`);expect(active.active).toBe(false);throw control;})).rejects.toBe(control);expect(await snapshot()).toEqual(before);
 const sequence='fixture_attendance_history_seen_'+randomUUID().replaceAll('-','');await owner.db.execute(sql.raw(`create sequence public.${sequence}`));cleanup.push(()=>owner.db.execute(sql.raw(`drop sequence if exists public.${sequence}`)));
 await trigger('app.assistant_own_leave_review','before update',`if OLD.id='${pick.review.actionId}'::uuid and OLD.state='awaiting_confirmation' and NEW.state='completed' then perform nextval('public.${sequence}');perform app.${name}();end if;return NEW;`);
 await refused(()=>withTenant(ctx,tx=>completeTx(tx,pick)),before);const[seen]=await owner.db.execute<{called:boolean}>(sql.raw(`select is_called as called from public.${sequence}`));expect(seen.called).toBe(true);
});
it('later separate-root actual native history import and revert preserve the original recorded Attendance receipt',async()=>{
 const f=await historyFixture(),pick=await prepared(D.action,f.date),done=await confirm(pick);expect(done.kind).toBe('completed');
 const next=await f.upload();const imported=await confirmPayrollHistoryUpload(ctx,{attemptId:next.attemptId,previewHash:next.plan.previewHash,confirmReplacement:true});expect(imported.changes).toHaveLength(1);expect(await reopen(pick)).toEqual(done);
 const revert=await previewPayrollHistoryRevert(ctx,next.attemptId);expect(await revertPayrollHistoryUpload(ctx,next.attemptId,revert.previewHash)).toMatchObject({restored:1});expect(await reopen(pick)).toEqual(done);
});

async function cutoffFixture(kind:'policy'|'company'|'default'){
 const payroll=await payrollFixture();
 await owner.db.insert(s.companyPayrollConfig).values({tenantId:b.tenantId,companyId:b.companyId,attendanceCutOffDay:null,defaultPayrollPolicyId:null}).onConflictDoUpdate({target:s.companyPayrollConfig.companyId,set:{attendanceCutOffDay:null,defaultPayrollPolicyId:null}});
 const selected=await createPolicy(ctx,{companyId:b.companyId,name:'Fictional selected Attendance window',policyType:'monthly',config:{cutOff:{mode:'custom',anchorDay:25}}});
 const other=await createPolicy(ctx,{companyId:b.companyId,name:'Fictional unrelated window',policyType:'monthly',config:{cutOff:{mode:'custom',anchorDay:1}}});
 if(kind==='policy')await assignPolicy(ctx,{employmentId:target.employmentId,policyId:selected.id});
 else await assignPolicy(ctx,{employmentId:target.employmentId,policyId:null});
 if(kind==='default')await owner.db.update(s.companyPayrollConfig).set({defaultPayrollPolicyId:selected.id}).where(eq(s.companyPayrollConfig.companyId,b.companyId));
 const date=payroll.period+'-10',pick=await prepared(D.action,date),name='fixture_attendance_cutoff_drift_'+randomUUID().replaceAll('-','');
 const mutation=kind==='policy'?`update public.payroll_policy set config='{"cutOff":{"mode":"custom","anchorDay":1}}'::jsonb where id='${selected.id}'::uuid`
  :kind==='default'?`update public.company_payroll_config set default_payroll_policy_id='${other.id}'::uuid where company_id='${b.companyId}'::uuid`
  :`update public.company_payroll_config set attendance_cut_off_day=1 where company_id='${b.companyId}'::uuid`;
 await owner.db.execute(sql.raw(`create function app.${name}() returns integer language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$ declare n integer;begin ${mutation};get diagnostics n=row_count;return n;end $$;revoke all on function app.${name}() from public;grant execute on function app.${name}() to ai_hr_app;`));cleanup.push(()=>owner.db.execute(sql.raw(`drop function if exists app.${name}()`)));
 return{...payroll,date,pick,name,selected:selected.id,other:other.id};
}
for(const kind of ['policy','company','default'] as const){
 it(`dated root protects relevant ${kind} cutoff/selection changes after IMMEDIATE with an independently valid membership-changing control`,async()=>{
  const f=await cutoffFixture(kind);await completionControl(f.pick);const before=await snapshot(),control=Error('rollback actual cutoff membership movement');
  await expect(withTenant(ctx,async tx=>{expect((await lockPayrollForAttendanceChange(tx,target.employmentId,f.date)).some(row=>row.batchId===f.source)).toBe(true);const[row]=await tx.execute<{n:number}>(sql`select ${sql.raw('app.'+f.name)}() n`);expect(row.n).toBe(1);expect((await lockPayrollForAttendanceChange(tx,target.employmentId,f.date)).some(row=>row.batchId===f.source)).toBe(false);throw control;})).rejects.toBe(control);expect(await snapshot()).toEqual(before);
  await refused(()=>withTenant(ctx,async tx=>{await completeTx(tx,f.pick);await tx.execute(sql`set constraints all immediate`);await tx.execute(sql`select ${sql.raw('app.'+f.name)}()`);}),before);
 });
 it(`SQL prepare dependency commitment catches a BEFORE-ledger ${kind} drift while completed-root fences are inactive`,async()=>{
  const f=await cutoffFixture(kind);await completionControl(f.pick);const sequence='fixture_attendance_dep_seen_'+randomUUID().replaceAll('-','');await owner.db.execute(sql.raw(`create sequence public.${sequence}`));cleanup.push(()=>owner.db.execute(sql.raw(`drop sequence if exists public.${sequence}`)));
  await trigger('app.assistant_own_leave_review','before update',`if OLD.id='${f.pick.review.actionId}'::uuid and OLD.state='awaiting_confirmation' and NEW.state='completed' then perform nextval('public.${sequence}');perform app.${f.name}();end if;return NEW;`);
  const before=await snapshot();await refused(()=>withTenant(ctx,tx=>completeTx(tx,f.pick)),before);const[seen]=await owner.db.execute<{called:boolean}>(sql.raw(`select is_called as called from public.${sequence}`));expect(seen.called).toBe(true);
 });
}
it('root dependency guards preserve unrelated policies and company fields, ignored defaults/anchors, and later separately authorized policy edits',async()=>{
 await setModule(b.tenantId,'payroll','active');ctx={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};
 const{createCompany}=await import('../core/admin');const foreign=await createCompany(ctx,{legalName:'Fictional unrelated payroll company'}),foreignPolicy=await createPolicy(ctx,{companyId:foreign.id,name:'Fictional foreign cutoff',policyType:'monthly',config:{cutOff:{mode:'custom',anchorDay:15}}});
 await owner.db.insert(s.companyPayrollConfig).values({tenantId:b.tenantId,companyId:foreign.id,attendanceCutOffDay:15,defaultPayrollPolicyId:foreignPolicy.id}).onConflictDoUpdate({target:s.companyPayrollConfig.companyId,set:{attendanceCutOffDay:15,defaultPayrollPolicyId:foreignPolicy.id}});
 const f=await cutoffFixture('policy'),before=await snapshot(),control=Error('rollback unrelated dependency positives'),name='fixture_attendance_unrelated_'+randomUUID().replaceAll('-','');
 await owner.db.execute(sql.raw(`create function app.${name}() returns integer language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$ declare n integer;total integer:=0;begin
  update public.payroll_policy set config='{"cutOff":{"mode":"custom","anchorDay":20}}'::jsonb where id='${f.other}'::uuid;get diagnostics n=row_count;total:=total+n;
  update public.company_payroll_config set pay_day=28,attendance_cut_off_day=1,default_payroll_policy_id='${f.other}'::uuid where company_id='${b.companyId}'::uuid;get diagnostics n=row_count;total:=total+n;
  update public.payroll_policy set config='{"cutOff":{"mode":"custom","anchorDay":1}}'::jsonb where id='${foreignPolicy.id}'::uuid;get diagnostics n=row_count;total:=total+n;
  update public.company_payroll_config set attendance_cut_off_day=1 where company_id='${foreign.id}'::uuid;get diagnostics n=row_count;total:=total+n;return total;end $$;revoke all on function app.${name}() from public;grant execute on function app.${name}() to ai_hr_app;`));cleanup.push(()=>owner.db.execute(sql.raw(`drop function if exists app.${name}()`)));
 await expect(withTenant(ctx,async tx=>{await completeTx(tx,f.pick);await tx.execute(sql`set constraints all immediate`);const[row]=await tx.execute<{n:number}>(sql`select ${sql.raw('app.'+name)}() n`);expect(row.n).toBe(4);expect((await lockPayrollForAttendanceChange(tx,target.employmentId,f.date)).some(row=>row.batchId===f.source)).toBe(true);throw control;})).rejects.toBe(control);expect(await snapshot()).toEqual(before);
 const done=await confirm(f.pick);expect(done.kind).toBe('completed');
 // A genuinely later root may change the selected cutoff; the recorded Attendance receipt stays historical.
 await withTenant(ctx,tx=>tx.execute(sql`select ${sql.raw('app.'+f.name)}()`));expect(await reopen(f.pick)).toEqual(done);
});
it('SQL-owned dated dependency evidence is immutable while pending and scrubbed on ordinary discard',async()=>{
 const pick=await prepared(D.action);await owner.db.execute(sql`update app.assistant_own_leave_review set attendance_day_dependencies=attendance_day_dependencies where id=${pick.review.actionId}::uuid`);
 const before=await snapshot();await refused(()=>owner.db.execute(sql`update app.assistant_own_leave_review set attendance_day_dependencies=${'0'.repeat(64)} where id=${pick.review.actionId}::uuid`),before);
 expect((await dayStore.discard(ctx,{action:D.action,contractVersion:1,actionId:pick.review.actionId})).kind).toBe('retired');
 const[row]=await owner.db.execute<{version:number;digest:string|null}>(sql`select attendance_day_proof_version as version,attendance_day_dependencies as digest from app.assistant_own_leave_review where id=${pick.review.actionId}::uuid`);expect(row).toEqual({version:1,digest:null});
});

// V4: mutable caller context must never turn actual protected-tenant root writes into unrelated rows.
async function contextWriter(inner:string){
 const name='fixture_attendance_context_'+randomUUID().replaceAll('-',''),sequence=name+'_seen';
 await owner.db.execute(sql.raw(`create sequence public.${sequence};create function app.${name}() returns integer language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$ begin perform nextval('public.${sequence}');return app.${inner}();end $$;revoke all on function app.${name}() from public;grant execute on function app.${name}() to ai_hr_app;`));
 cleanup.push(()=>owner.db.execute(sql.raw(`drop sequence if exists public.${sequence}`)));cleanup.push(()=>owner.db.execute(sql.raw(`drop function if exists app.${name}()`)));
 return{name,sequence};
}
async function contextRefused(pick:Pick,inner:string,otherTenant:string){
 const writer=await contextWriter(inner),before=await snapshot();let failure:unknown;
 try{await withTenant(ctx,async tx=>{await completeTx(tx,pick);await tx.execute(sql`set constraints all immediate`);const[row]=await tx.execute<{tenant:string}>(sql`select set_config('app.tenant_id',${otherTenant},true) tenant`);expect(row.tenant).toBe(otherTenant);await tx.execute(sql`select ${sql.raw('app.'+writer.name)}()`);});}catch(error){failure=error;}
 expect(pgSqlState(failure)).toBe('42501');const messages:string[]=[];let cursor:unknown=failure;const seen=new Set<unknown>();while(cursor&&typeof cursor==='object'&&!seen.has(cursor)){seen.add(cursor);const e=cursor as {message?:string;cause?:unknown};if(e.message)messages.push(e.message);cursor=e.cause;}expect(messages.some(message=>message.includes('Attendance completed root tenant context changed'))).toBe(true);
 const[reach]=await owner.db.execute<{called:boolean}>(sql.raw(`select is_called called from public.${writer.sequence}`));expect(reach.called).toBe(true);expect(await snapshot()).toEqual(before);
}
it('V4 switched caller tenant cannot hide an original-tenant same-root history revision after IMMEDIATE',async()=>{
 const f=await historyFixture(),pick=await prepared(D.action,f.date),name=await historyWriter(f,false),other=await seedBase();await completionControl(pick);
 const before=await snapshot(),control=Error('rollback actual history revision under switched context');
 await expect(withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('app.tenant_id',${other.tenantId},true)`);const[row]=await tx.execute<{n:number}>(sql`select ${sql.raw('app.'+name)}() n`);expect(row.n).toBe(1);throw control;})).rejects.toBe(control);expect(await snapshot()).toEqual(before);
 await contextRefused(pick,name,other.tenantId);
});
it('V4 switched caller tenant cannot add original-tenant new payroll membership outside the recorded IDs',async()=>{
 const f=await payrollFixture(),pick=await prepared(D.action),name=await memberWriter(f.slipId,f.next),other=await seedBase();await completionControl(pick);
 const before=await snapshot(),control=Error('rollback valid switched-context membership control');
 await expect(withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('app.tenant_id',${other.tenantId},true)`);const[row]=await tx.execute<{n:number}>(sql`select ${sql.raw('app.'+name)}() n`);expect(row.n).toBe(1);throw control;})).rejects.toBe(control);expect(await snapshot()).toEqual(before);
 await contextRefused(pick,name,other.tenantId);
});
it('V4 switched context preserves a genuine other-tenant policy write in the completed root',async()=>{
 const other=await seedBase();await setModule(other.tenantId,'payroll','active');const otherCtx={...await entitledCtx(other,['hr_admin']),grants:[{role:'hr_admin' as const,companyId:null}]};
 const policy=await createPolicy(otherCtx,{companyId:other.companyId,name:'Fictional foreign-tenant cutoff',policyType:'monthly',config:{cutOff:{mode:'custom',anchorDay:25}}});
 const pick=await prepared(D.action),name='fixture_attendance_foreign_'+randomUUID().replaceAll('-','');
 await owner.db.execute(sql.raw(`create function app.${name}() returns integer language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$ declare n integer;begin update public.payroll_policy set config='{"cutOff":{"mode":"custom","anchorDay":1}}'::jsonb where id='${policy.id}'::uuid and tenant_id='${other.tenantId}'::uuid;get diagnostics n=row_count;return n;end $$;revoke all on function app.${name}() from public;grant execute on function app.${name}() to ai_hr_app;`));cleanup.push(()=>owner.db.execute(sql.raw(`drop function if exists app.${name}()`)));
 const before=await snapshot(),control=Error('rollback genuine foreign-tenant policy positive');
 await expect(withTenant(ctx,async tx=>{await completeTx(tx,pick);await tx.execute(sql`set constraints all immediate`);await tx.execute(sql`select set_config('app.tenant_id',${other.tenantId},true)`);const[row]=await tx.execute<{n:number}>(sql`select ${sql.raw('app.'+name)}() n`);expect(row.n).toBe(1);throw control;})).rejects.toBe(control);expect(await snapshot()).toEqual(before);
});
for(const action of actions)it(`${action}: V4 later direct metadata DELETE refuses but genuine app_user FK cascade removes the completed receipt`,async()=>{
 const userId=await createAppUser(b.tenantId,null,'hr_admin');await grantAssistant(root(),{appUserId:userId});ctx={...await entitledCtx(b,['hr_admin']),userId,personId:null,grants:[{role:'hr_admin',companyId:null}]};
 const pick=await prepared(action);expect((await confirm(pick)).kind).toBe('completed');const before=await snapshot();
 await refused(()=>owner.db.execute(sql`delete from app.assistant_own_leave_review where id=${pick.review.actionId}::uuid`),before);
 const nativeBefore=(await snapshot()).filter(row=>!['public.app_user','public.role_assignment','public.access_configuration','app.access_profile_write_generation','app.assistant_own_leave_review','app.assistant_own_leave_review_content'].includes(row.table));
 const[exists]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from app.assistant_own_leave_review where id=${pick.review.actionId}::uuid`);expect(exists.n).toBe(1);
 // Actual catalog-configured ON DELETE CASCADE; separate transaction from confirmation.
 await owner.db.transaction(async tx=>{
  // Actual restrictive FK children of the disposable actor must be removed first.
  // The review is removed only by the real configured USER cascade.
  await tx.delete(s.assistantGrant).where(eq(s.assistantGrant.appUserId,userId));
  await tx.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,userId));
  await tx.delete(s.appUser).where(eq(s.appUser.id,userId));
 });
 const[gone]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from app.assistant_own_leave_review where id=${pick.review.actionId}::uuid`);expect(gone.n).toBe(0);
 expect((await snapshot()).filter(row=>!['public.app_user','public.role_assignment','public.access_configuration','app.access_profile_write_generation','app.assistant_own_leave_review','app.assistant_own_leave_review_content'].includes(row.table))).toEqual(nativeBefore);
});
