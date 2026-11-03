/** AI v2 Phase 2 hardening (4 November 2026) — the payroll loops, the Audit loop and the checklist, on fictional data, over
 * the real owners and the real database (migrations 2005, 2006, 2008 as edited and 2011).
 *
 *  1. The Audit loop deduplicates a capture only against the LATEST capture of its key: a change and its revert are both
 *     captured (review finding A5).
 *  2. Its control settings have bounds; a company administrator tightens them and only a group administrator loosens them,
 *     in the service and in the database; every change, and every Salary payroll loop setting, is a configuration event the
 *     month's audit pack captures (A4, A1).
 *  3. Nobody disposes of a finding about themselves: the database derives the subject logins and refuses them, and the
 *     person a finding's employment belongs to (A3).
 *  4. A read-only auditor reads exactly their granted companies, built from what the loop captured (A9).
 *  5. The inputs snapshot is bounded: one row per employment and input kind, on a large fictional run, and a failing
 *     schedule read never stops the transaction (A6).
 *  6. The close circuit's prior cycle is the same run type, in the ordinary evaluation and in the close function (B2).
 *  7. Standing acknowledgements: a warning leaves the counts and stays listed, in the loop and the pack; a block is never
 *     suppressed and its resolve is pre-filled; nobody acknowledges their own; revocable; learned standing rules are
 *     approved only by a group administrator who did not make the dispositions (B4).
 *  8. Grouped dispositions: one tap for a pattern, each still a person's disposition, and the same people's net-swing-only
 *     anomaly verdicts resolved with it (B5).
 *  9. Automatic cut-off reminders: only people with something pending, counts only and no pay figure, once per cut-off and
 *     lead, switchable per company (B6).
 * 10. Freshness: the payroll tick refreshes only companies whose payroll changed; one company's failing read fails only that
 *     company; the Pre-salary loop re-checks at the end of cut-off day (B1).
 * Expected values are written out from the fixtures. No model is called. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';

const model=vi.hoisted(()=>({calls:0}));
vi.mock('../lib/ai',async importOriginal=>{
 const original=await importOriginal<typeof import('../lib/ai')>();
 const refuse=async()=>{model.calls++;throw new Error('No model call is allowed in a loop.');};
 return {...original,generateDraft:refuse,converse:refuse,readImage:refuse};
});
// One company's Pre-salary read can be made to fail, to prove the others are still checked.
const failing=vi.hoisted(()=>({companyId:null as string|null}));
vi.mock('../core/loops/payroll-inputs',async importOriginal=>{
 const original=await importOriginal<typeof import('../core/loops/payroll-inputs')>();
 return {...original,detectPayrollInputs:async(...args:Parameters<typeof original.detectPayrollInputs>)=>{
  if(failing.companyId&&args[1].companyIds.includes(failing.companyId))throw new Error('Fictional owner read failure.');
  return original.detectPayrollInputs(...args);}};
});

import * as schema from '../db/schema';
import {terasLoopCase,terasLoopRun} from '../db/teras-schema';
import {payrollAuditCapture,payrollAuditDisposition,payrollAuditFinding} from '../db/payroll-audit-schema';
import {payrollCheckAcknowledgement,terasCutOffReminder,terasPayrollSwingDisposition} from '../db/teras-payroll-cycle-schema';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee,setReportingLine} from '../core/org';
import {setCompensation} from '../core/comp';
import {createAdditionalRun,createBatch} from '../packs/payroll/service';
import {evaluateCircuitBreakerWithSourceTx} from '../core/payroll-anomaly';
import {agentContext,ensureAgentPrincipal} from '../core/agent-principal';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {runLoop} from '../core/loops/run';
import {setLoopPause} from '../core/loops/controls';
import {setPayrollLoopSetting} from '../core/loops/payroll-loop-settings';
import {payrollChangedCompanies,lastLoopRunsTx} from '../core/loops/payroll-freshness';
import {sendCutOffReminders} from '../core/loops/cut-off-reminders';
import {loopMayStillActTx} from '../core/loops/act-gate';
import {acknowledgeCheck,decideRuleProposal,revokeAcknowledgement,ruleProposalsTx} from '../core/loops/acknowledgements';
import {acknowledgedBlocks,disposeSwingGroup,resolveAcknowledgedBlock} from '../core/loops/grouped-dispositions';
import {appendCapturesTx} from '../core/payroll-audit/append';
import {capturePayrollPeriod} from '../core/payroll-audit/capture';
import {disposeFinding} from '../core/payroll-audit/controls';
import {grantAuditReader,setControlSettings} from '../core/payroll-audit/settings';
import {auditLoopDetail,repeatAuditIssues} from '../core/payroll-audit/status';
import {auditorLoopDetail,hasAuditReaderGrant} from '../core/payroll-audit/auditor-view';
import {captureRunInputsAtProcessingTx,runInputsTx} from '../core/payroll-audit/inputs';
import {buildAuditPack,type AuditPackLabels} from '../core/payroll-audit/pack';
import {AUDIT_CAPTURE_KINDS,AUDIT_CONTROL_IDS} from '../core/payroll-audit/types';
import {dispatchNotifications} from '../core/notifications';
import JSZip from 'jszip';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

const PERIOD='2026-06';
let b:Base,principalId:string;
type Login=SessionContext&{userId:string};
async function groupAdministrator():Promise<Login>{
 const userId=await createAppUser(b.tenantId,null,'hr_admin');
 return {...(await entitledCtx(b,['hr_admin'])),userId,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
}
async function companyAdministrator(companyId:string,personId:string|null=null):Promise<Login>{
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:`user_${randomUUID()}`,personId}).returning({id:schema.appUser.id});
 await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,companyId,role:'hr_admin'});
 return {...(await entitledCtx(b,['hr_admin'])),userId:user.id,personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId}]};
}
async function employeeLogin(personId:string|null=null):Promise<Login>{
 const userId=await createAppUser(b.tenantId,personId,'employee');
 return {...(await entitledCtx(b,['employee'])),userId,personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
}
let seq=0;
async function hire(name:string,companyId=b.companyId,departmentId=b.deptA){
 const n=++seq;
 const hired=await hireEmployee(await entitledCtx(b),{person:{fullName:name,primaryEmail:`fixture-${n}-${randomUUID()}@fixture.test`},companyId,departmentId,
  employmentType:'full_time',hiredOn:'2024-01-01'});
 await setCompensation(await entitledCtx(b),{employmentId:hired.employmentId,basicSalary:3000,effectiveFrom:'2024-01-01'});
 // A complete statutory and bank record, so nobody has a details gap unless a test makes one.
 await owner.db.insert(schema.employeeStatutoryMy).values({tenantId:b.tenantId,personId:hired.personId,icNumber:`9001010112${String(10+n).slice(-2)}`,
  epfNumber:`EPF${n}`,socsoNumber:`SOCSO${n}`,taxNumber:`TAX${n}`,bankName:'Maybank',bankAccountNo:`1234567890${String(10+n).slice(-2)}`});
 return hired;
}
const tamper=(statement:ReturnType<typeof sql>)=>owner.db.transaction(async tx=>{await tx.execute(sql`set local session_replication_role=replica`);await tx.execute(statement);});
const finding=async(p:{controlId:string;payPeriod?:string;employmentId?:string|null;evidence?:Record<string,unknown>;companyId?:string})=>
 (await owner.db.insert(payrollAuditFinding).values({tenantId:b.tenantId,companyId:p.companyId??b.companyId,payPeriod:p.payPeriod??PERIOD,batchId:null,employmentId:p.employmentId??null,
  controlId:p.controlId as never,subjectKey:`test:${p.controlId}:${randomUUID()}`,evidence:p.evidence??{fictional:true},writer:'user',writerId:b.adminUserId}).returning())[0];
const LABELS:AuditPackLabels={title:'Payroll audit pack',company:'Company',payPeriod:'Pay month',generated:'Generated',by:'By',runs:'Runs',
 runLine:'{runType} run {runSeq}: {status}',statutory:'Statutory',filingEvidence:'Filing',findings:'Findings',findingLine:'{control}: {count}',corrections:'Corrections',
 correctionLine:'{action}',captures:'Captures',captureLine:'{kind}: {count}',verification:'Tamper check',verified:'{count} verified',notVerified:'{count} problems',
 anchors:'{matched} anchored',files:'Files',none:'None',findingItem:'{control}: {who} ({state})',open:'open',unprintable:'{count}',
 dispositions:{expected:'Expected',corrected:'Corrected',false_positive:'Not an issue',escalated:'Escalated'},
 kinds:Object.fromEntries(AUDIT_CAPTURE_KINDS.map(kind=>[kind,kind])) as AuditPackLabels['kinds'],controls:Object.fromEntries(AUDIT_CONTROL_IDS.map(id=>[id,id])) as AuditPackLabels['controls']};

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{model.calls=0;seq=0;failing.companyId=null;await resetDb();b=await seedBase();
 for(const module of ['payroll','claims','multi_cycle_payroll'])await setModule(b.tenantId,module,'active');
 principalId=await ensureAgentPrincipal(owner.db,b.tenantId);});
afterEach(()=>{expect(model.calls,'a payroll loop called a model').toBe(0);});

describe('A5: a capture is deduplicated only against the latest capture of its key',()=>{
 it('captures a change and its revert, and skips only an unchanged repeat',async()=>{
  const group=await groupAdministrator();
  const write=(content:Record<string,unknown>)=>withTenant(group,tx=>appendCapturesTx(tx,b.tenantId,{kind:'user',userId:group.userId},{companyId:b.companyId,payPeriod:PERIOD},
   [{kind:'config_change',sourceKey:'config:fictional-key',batchId:null,content}]));
  expect(await write({value:'A'})).toBe(1);
  expect(await write({value:'A'})).toBe(0);
  expect(await write({value:'B'})).toBe(1);
  // Back to A: the revert is evidence too, captured again.
  expect(await write({value:'A'})).toBe(1);
  const rows=await withTenant(group,tx=>tx.select().from(payrollAuditCapture).where(eq(payrollAuditCapture.sourceKey,'config:fictional-key')).orderBy(payrollAuditCapture.seq));
  expect(rows.map(row=>(row.content as {value:string}).value)).toEqual(['A','B','A']);
  expect(rows[0].contentHash).toBe(rows[2].contentHash);
  for(let i=1;i<rows.length;i++)expect(rows[i].prevHash).toBe(rows[i-1].chainHash);
 });
});

describe('A4 and A1: control settings are bounded, loosening is a group administrator\'s, and every change is in the pack',()=>{
 it('lets a company administrator tighten, refuses them a loosening in the service and the database, and captures every change',async()=>{
  const group=await groupAdministrator(),local=await companyAdministrator(b.companyId);
  // Tighter: a longer window, a lower amount, and preparer-and-closer made a finding.
  expect(await setControlSettings(local,{companyId:b.companyId,bankChangeDays:10,adjustmentThreshold:800,preparerClosedMode:'finding'}))
   .toEqual({bankChangeDays:10,adjustmentThreshold:800,preparerClosedMode:'finding',version:1});
  for(const looser of [{bankChangeDays:9,adjustmentThreshold:800},{bankChangeDays:10,adjustmentThreshold:900},{bankChangeDays:10,adjustmentThreshold:800,preparerClosedMode:'info'}])
   await expect(setControlSettings(local,{companyId:b.companyId,...looser})).rejects.toMatchObject({reason:'group_administrator'});
  // Past the service, the database refuses it too.
  await expect(withTenant(local,tx=>tx.execute(sql`update public.payroll_audit_control_setting
   set bank_change_days=4,changed_by_user_id=${local.userId}::uuid where company_id=${b.companyId}::uuid`))).rejects.toThrow(/group administrator/);
  // Out of bounds is refused by both.
  await expect(setControlSettings(group,{companyId:b.companyId,bankChangeDays:31,adjustmentThreshold:800})).rejects.toMatchObject({reason:'invalid'});
  await expect(owner.db.execute(sql`update public.payroll_audit_control_setting set adjustment_threshold=99.99 where company_id=${b.companyId}::uuid`)).rejects.toThrow();
  // The group administrator loosens.
  expect(await setControlSettings(group,{companyId:b.companyId,bankChangeDays:5,adjustmentThreshold:1200,preparerClosedMode:'info'}))
   .toEqual({bankChangeDays:5,adjustmentThreshold:1200,preparerClosedMode:'info',version:2});
  // A Salary payroll loop setting too: capped at 50%, and recorded.
  await expect(setPayrollLoopSetting(group,{companyId:b.companyId,thresholdBp:5001})).rejects.toMatchObject({reason:'invalid'});
  await setPayrollLoopSetting(group,{companyId:b.companyId,thresholdBp:2500});
  // The month's capture lists each as a configuration change, with before and after.
  await capturePayrollPeriod(group,{companyId:b.companyId,payPeriod:todayMonth()});
  const config=(await withTenant(group,tx=>tx.select().from(payrollAuditCapture).where(and(eq(payrollAuditCapture.kind,'config_change'),eq(payrollAuditCapture.companyId,b.companyId)))))
   .map(row=>row.content as {eventType:string;actorId:string;payload:{after?:unknown;to?:unknown}});
  expect(config.filter(item=>item.eventType==='payroll-audit.settings-changed').map(item=>[item.actorId,item.payload.after])).toEqual([
   [local.userId,{bankChangeDays:10,adjustmentThreshold:'800.00',preparerClosedMode:'finding'}],[group.userId,{bankChangeDays:5,adjustmentThreshold:'1200.00',preparerClosedMode:'info'}]]);
  expect(config.filter(item=>item.eventType==='teras-payroll-loop.setting-changed').map(item=>(item.payload.to as {thresholdBp:number}).thresholdBp)).toEqual([2500]);
 });
});
/** The HR month the configuration events fall in (they are captured from the first day of the pay month). */
const todayMonth=()=>new Date(Date.now()+8*3_600_000).toISOString().slice(0,7);

describe('A3: nobody disposes of a finding about themselves',()=>{
 it('derives the subject logins in the database and refuses them, and the person the finding\'s employment belongs to',async()=>{
  const group=await groupAdministrator(),other=await groupAdministrator();
  const changed=await finding({controlId:'formula_changed_open_period',evidence:{change:'pay_component',changedBy:group.userId}});
  expect(changed.subjectUserIds).toEqual([group.userId]);
  await expect(disposeFinding(group,{findingId:changed.id,disposition:'expected',note:'Mine, and fine.'})).rejects.toMatchObject({reason:'subject'});
  // Past the service, the disposition policy refuses it.
  await expect(withTenant(group,tx=>tx.insert(payrollAuditDisposition).values({tenantId:b.tenantId,findingId:changed.id,companyId:b.companyId,disposition:'expected',
   note:'Forged.',disposedByUserId:group.userId}))).rejects.toThrow(/row-level security/i);
  await disposeFinding(other,{findingId:changed.id,disposition:'expected',note:'Reviewed by another administrator.'});
  // A finding about the administrator's own employment (their own bank change) is not theirs to dispose of either.
  const own=await hire('Fictional Payroll Lead');
  const lead=await companyAdministrator(b.companyId,own.personId);
  const mine=await finding({controlId:'bank_change_before_pay_day',employmentId:own.employmentId,evidence:{payDay:'2026-06-30'}});
  expect(mine.subjectUserIds).toEqual([]);
  await expect(disposeFinding(lead,{findingId:mine.id,disposition:'expected',note:'My own account.'})).rejects.toMatchObject({reason:'subject'});
  await disposeFinding(group,{findingId:mine.id,disposition:'expected',note:'Checked with the lead.'});
 });
});

describe('A9: a read-only auditor reads exactly their granted companies',()=>{
 it('opens the Audit loop for the granted company only, built from the captures, with no person named',async()=>{
  const group=await groupAdministrator();
  const [second]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Second Sdn Bhd'}).returning();
  const person=await hire('Fictional Auditor Subject');
  await finding({controlId:'pay_without_attendance',employmentId:person.employmentId});
  await finding({controlId:'pay_without_attendance',companyId:second.id});
  const auditor=await employeeLogin();
  expect(await hasAuditReaderGrant(auditor)).toBe(false);
  await expect(auditorLoopDetail(auditor,{payPeriod:PERIOD})).resolves.toMatchObject({companies:[]});
  await grantAuditReader(group,{companyId:b.companyId,appUserId:auditor.userId});
  expect(await hasAuditReaderGrant(auditor)).toBe(true);
  const view=await auditorLoopDetail(auditor,{payPeriod:PERIOD,companyIds:[b.companyId,second.id]});
  expect(view.companies.map(item=>item.companyId)).toEqual([b.companyId]);
  expect(view.findings.map(item=>[item.controlId,item.employmentId,item.personName])).toEqual([['pay_without_attendance',person.employmentId,null]]);
  expect(view.canCapture).toBe(false);
  // The administrator's own view is unchanged and an auditor still cannot use it.
  await expect(auditLoopDetail(auditor,{payPeriod:PERIOD})).rejects.toMatchObject({reason:'not_administrator'});
 });
});

describe('A6: the inputs snapshot is bounded and never stops the run',()=>{
 it('folds one row per employment and input kind on a large fictional run, and a failing schedule read is recorded as a miss',async()=>{
  const group=await groupAdministrator();
  const {batchId}=await createBatch(await entitledCtx(b),{companyId:b.companyId,payPeriod:PERIOD});
  const N=1500;
  await tamper(sql`with p as (insert into public.person(tenant_id,full_name,primary_email) select ${b.tenantId}::uuid,'Fictional Bulk '||g,'bulk-'||g||'@fixture.test'
    from generate_series(1,${N}) g returning id),
   e as (insert into public.employment(tenant_id,person_id,company_id,hired_on) select ${b.tenantId}::uuid,p.id,${b.companyId}::uuid,'2024-01-01' from p returning id),
   s as (insert into public.payslip(tenant_id,batch_id,employment_id,basic_salary,gross_pay,statutory,total_deductions,net_pay,employer_cost)
    select ${b.tenantId}::uuid,${batchId}::uuid,e.id,1000,1000,'{}'::jsonb,0,1000,1000 from e returning employment_id)
   insert into public.attendance(tenant_id,employment_id,attendance_date,status,day_type,worked_minutes)
    select ${b.tenantId}::uuid,s.employment_id,d::date,'present','workday',480 from s cross join (values ('2026-06-01'),('2026-06-02')) v(d)`);
  const windows={attendance:{start:'2026-06-01',end:'2026-06-30'},overtime:{start:'2026-06-01',end:'2026-06-30'},leave:{start:'2026-06-01',end:'2026-06-30'},
   claim:{start:'2026-06-01',end:'2026-06-30'}};
  const first=await withTenant(group,tx=>runInputsTx(tx,{batchId,payPeriod:PERIOD,windows}));
  expect(first.employments).toBe(N);
  expect(first.components.attendance.rows).toBe(2*N);
  expect(first.results.rows).toBe(N);
  // The snapshot itself holds a count and a hash per kind: small, whatever the run's size.
  expect(JSON.stringify(first).length).toBeLessThan(3000);
  // The same rows hash the same way; one changed row changes the component's hash.
  expect((await withTenant(group,tx=>runInputsTx(tx,{batchId,payPeriod:PERIOD,windows}))).components.attendance.hash).toBe(first.components.attendance.hash);
  await tamper(sql`update public.attendance set worked_minutes=420 where tenant_id=${b.tenantId}::uuid and attendance_date='2026-06-02'
   and employment_id=(select employment_id from public.payslip where batch_id=${batchId}::uuid order by employment_id limit 1)`);
  expect((await withTenant(group,tx=>runInputsTx(tx,{batchId,payPeriod:PERIOD,windows}))).components.attendance.hash).not.toBe(first.components.attendance.hash);
  // A schedule that cannot be read stays inside the capture's savepoint: the transaction goes on, and the miss is recorded.
  const outcome=await withTenant(group,async tx=>{
   const ok=await captureRunInputsAtProcessingTx(tx,group,{batchId,companyId:b.companyId,payPeriod:PERIOD,trigger:'processed',
    windows:async savepoint=>{await savepoint.execute(sql`select 1/0`);return windows;}});
   const [still]=await tx.execute(sql`select 1 as one`) as unknown as {one:number}[];
   return {ok,still:Number(still.one)};
  });
  expect(outcome).toEqual({ok:false,still:1});
  const misses=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,b.tenantId),eq(schema.domainEvent.eventType,'payroll-audit.inputs-not-captured')));
  expect(misses.map(event=>(event.payload as {reason:string}).reason)).toEqual(['not_written']);
 },120_000);
});

describe('B2: the prior cycle is the same run type',()=>{
 it('compares a salary run with the last salary run and a bonus run with the last bonus run, in the evaluation and the close function',async()=>{
  const group=await groupAdministrator(),ctx=await entitledCtx(b);
  const may=(await createBatch(ctx,{companyId:b.companyId,payPeriod:'2026-05'})).batchId;
  const juneBonus=(await createAdditionalRun(ctx,{companyId:b.companyId,payPeriod:'2026-06',runType:'bonus'})).batchId;
  const july=(await createBatch(ctx,{companyId:b.companyId,payPeriod:'2026-07'})).batchId;
  const augustBonus=(await createAdditionalRun(ctx,{companyId:b.companyId,payPeriod:'2026-08',runType:'bonus'})).batchId;
  const prior=(batchId:string)=>withTenant(group,tx=>evaluateCircuitBreakerWithSourceTx(tx,b.tenantId,batchId)).then(result=>result.source.priorBatchId);
  const closePrior=async(batchId:string)=>(await withTenant(group,tx=>tx.execute(sql`select prior_batch_id from app.payroll_close_circuit_inputs(${batchId}::uuid)`)) as unknown as {prior_batch_id:string|null}[])[0]?.prior_batch_id??null;
  expect([await prior(july),await closePrior(july)]).toEqual([may,may]);
  expect([await prior(augustBonus),await closePrior(augustBonus)]).toEqual([juneBonus,juneBonus]);
  // The close source check accepts the same-type prior and refuses the other type's.
  await expect(withTenant(group,tx=>tx.execute(sql`select app.payroll_close_source_people(${july}::uuid,${may}::uuid,array[]::uuid[])`))).resolves.toBeDefined();
  await expect(withTenant(group,tx=>tx.execute(sql`select app.payroll_close_source_people(${july}::uuid,${juneBonus}::uuid,array[]::uuid[])`))).rejects.toThrow(/Payroll source unavailable/);
 });
});

describe('B4: standing acknowledgements',()=>{
 it('takes an acknowledged warning out of the open and repeat counts, keeps it listed in the loop and the pack, and is revocable',async()=>{
  const group=await groupAdministrator();
  const driver=await hire('Fictional Cash Driver');
  await finding({controlId:'pay_without_attendance',payPeriod:'2026-05',employmentId:driver.employmentId});
  const june=await finding({controlId:'pay_without_attendance',payPeriod:PERIOD,employmentId:driver.employmentId});
  let detail=await auditLoopDetail(group,{payPeriod:PERIOD,companyIds:[b.companyId]});
  expect(detail.companies[0].findings).toEqual({open:1,disposed:0,acknowledged:0});
  expect((await repeatAuditIssues(group,{payPeriod:PERIOD,companyIds:[b.companyId]})).get(b.companyId)).toEqual(['pay_without_attendance']);
  // Nobody acknowledges a check about themselves; another company's administrator cannot acknowledge here.
  const self=await companyAdministrator(b.companyId,driver.personId);
  await expect(acknowledgeCheck(self,{companyId:b.companyId,checkId:'audit:pay_without_attendance',scope:'person',employmentId:driver.employmentId,reason:'Me.'}))
   .rejects.toMatchObject({reason:'own'});
  const [second]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Second Sdn Bhd'}).returning();
  await expect(acknowledgeCheck(await companyAdministrator(second.id),{companyId:b.companyId,checkId:'audit:pay_without_attendance',scope:'company',reason:'No.'}))
   .rejects.toMatchObject({reason:'not_administrator'});
  await expect(acknowledgeCheck(group,{companyId:b.companyId,checkId:'audit:not_a_check',scope:'company',reason:'x'})).rejects.toMatchObject({reason:'invalid'});
  const ack=await acknowledgeCheck(group,{companyId:b.companyId,checkId:'audit:pay_without_attendance',scope:'person',employmentId:driver.employmentId,
   reason:'Cash-paid driver, never clocks in',reviewOn:'2027-01-31'});
  await expect(acknowledgeCheck(group,{companyId:b.companyId,checkId:'audit:pay_without_attendance',scope:'person',employmentId:driver.employmentId,reason:'Again'}))
   .rejects.toMatchObject({reason:'already'});
  detail=await auditLoopDetail(group,{payPeriod:PERIOD,companyIds:[b.companyId]});
  expect(detail.companies[0].findings).toEqual({open:0,disposed:0,acknowledged:1});
  expect(detail.findings.find(item=>item.id===june.id)).toMatchObject({disposition:null,acknowledgement:{id:ack.id,scope:'person',reason:'Cash-paid driver, never clocks in',reviewOn:'2027-01-31'}});
  expect((await repeatAuditIssues(group,{payPeriod:PERIOD,companyIds:[b.companyId]})).get(b.companyId)).toBeUndefined();
  // The pack lists it; the event is captured as a configuration change.
  const pack=await buildAuditPack(group,{companyId:b.companyId,payPeriod:PERIOD},LABELS);
  const zip=await JSZip.loadAsync(pack.bytes);
  expect(JSON.parse(await zip.file('acknowledgements.json')!.async('string'))).toEqual([expect.objectContaining({id:ack.id,check:'audit:pay_without_attendance',scope:'person',
   employmentId:driver.employmentId,reason:'Cash-paid driver, never clocks in',reviewOn:'2027-01-31',source:'person',createdBy:group.userId})]);
  const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,b.tenantId),eq(schema.domainEvent.eventType,'payroll-check.acknowledgement-recorded')));
  expect(events.map(event=>[event.actorId,(event.payload as {checkId:string}).checkId])).toEqual([[group.userId,'audit:pay_without_attendance']]);
  // Never rewritten: only revoked, once; then the finding counts again.
  await expect(withTenant(group,tx=>tx.update(payrollCheckAcknowledgement).set({reason:'Rewritten'}).where(eq(payrollCheckAcknowledgement.id,ack.id)))).rejects.toThrow();
  await revokeAcknowledgement(group,{id:ack.id});
  await expect(revokeAcknowledgement(group,{id:ack.id})).rejects.toMatchObject({reason:'not_found'});
  expect((await auditLoopDetail(group,{payPeriod:PERIOD,companyIds:[b.companyId]})).companies[0].findings).toEqual({open:1,disposed:0,acknowledged:0});
 });

 it('never suppresses a block: it is listed with its resolve pre-filled from the acknowledgement, and a person presses it',async()=>{
  const group=await groupAdministrator();
  const person=await hire('Fictional Site Worker');
  const {batchId}=await createBatch(await entitledCtx(b),{companyId:b.companyId,payPeriod:PERIOD});
  const [verdict]=await owner.db.insert(schema.payrollAnomalyVerdict).values({tenantId:b.tenantId,batchId,employmentId:person.employmentId,disposition:'block'} as never).returning();
  await owner.db.insert(schema.payrollAnomalyFinding).values({tenantId:b.tenantId,verdictId:verdict.id,detectorId:'missing-bank-profile',severity:'block',facts:{},suggestedAction:'anomaly.action.fixture'} as never);
  expect(await acknowledgedBlocks(group,{companyIds:[b.companyId],payPeriod:PERIOD})).toEqual([]);
  await acknowledgeCheck(group,{companyId:b.companyId,checkId:'anomaly:missing-bank-profile',scope:'person',employmentId:person.employmentId,reason:'Paid in cash at the site office'});
  const blocks=await acknowledgedBlocks(group,{companyIds:[b.companyId],payPeriod:PERIOD});
  expect(blocks.map(item=>[item.verdictId,item.detectors,item.reason])).toEqual([[verdict.id,['missing-bank-profile'],'Paid in cash at the site office']]);
  // Still unresolved until a person presses it; then resolved with the reason.
  const [before]=await owner.db.select().from(schema.payrollAnomalyVerdict).where(eq(schema.payrollAnomalyVerdict.id,verdict.id));
  expect(before.resolvedAt).toBeNull();
  await resolveAcknowledgedBlock(group,{verdictId:verdict.id,companyId:b.companyId,payPeriod:PERIOD});
  const [after]=await owner.db.select().from(schema.payrollAnomalyVerdict).where(eq(schema.payrollAnomalyVerdict.id,verdict.id));
  expect([after.resolution,after.resolutionNote,after.resolvedByUserId]).toEqual(['accepted','Expected (standing acknowledgement): Paid in cash at the site office',group.userId]);
 });

 it('proposes a standing rule from five expected dispositions running, approved only by a group administrator who made none of them',async()=>{
  const disposer=await groupAdministrator(),approver=await groupAdministrator(),local=await companyAdministrator(b.companyId);
  const person=await hire('Fictional Commission Seller');
  for(const month of ['2026-01','2026-02','2026-03','2026-04','2026-05']){
   const row=await finding({controlId:'shared_bank_account',payPeriod:month,employmentId:person.employmentId});
   await disposeFinding(disposer,{findingId:row.id,disposition:'expected',note:'Joint account with the spouse.'});
  }
  const proposals=await withTenant(approver,tx=>ruleProposalsTx(tx,b.tenantId,[b.companyId]));
  expect(proposals.map(p=>[p.checkId,p.employmentId,p.evidence.runs,p.evidence.expected,[...p.disposers]])).toEqual([['audit:shared_bank_account',person.employmentId,5,5,[disposer.userId]]]);
  const key=proposals[0].key;
  await expect(decideRuleProposal(local,{companyId:b.companyId,proposalKey:key,decision:'approved'})).rejects.toMatchObject({reason:'group_administrator'});
  await expect(decideRuleProposal(disposer,{companyId:b.companyId,proposalKey:key,decision:'approved'})).rejects.toMatchObject({reason:'own_evidence'});
  const decided=await decideRuleProposal(approver,{companyId:b.companyId,proposalKey:key,decision:'approved'});
  expect(decided.acknowledgement).toMatchObject({checkId:'audit:shared_bank_account',scope:'person',employmentId:person.employmentId,source:'proposal',createdByUserId:approver.userId});
  // Approved and acknowledged: no longer proposed.
  expect(await withTenant(approver,tx=>ruleProposalsTx(tx,b.tenantId,[b.companyId]))).toEqual([]);
  // A proposal-sourced acknowledgement without the approver's own approved decision is refused by the database.
  await expect(withTenant(local,tx=>tx.insert(payrollCheckAcknowledgement).values({tenantId:b.tenantId,companyId:b.companyId,checkId:'audit:pay_after_last_day',scope:'company',
   reason:'Forged',source:'proposal',decisionId:decided.decision.id,createdByUserId:local.userId}))).rejects.toThrow(/row-level security/i);
 });
});

describe('B5: grouped dispositions',()=>{
 it('disposes of every open flag of a pattern in one tap, each as the person\'s own, and resolves the same people\'s net-swing-only verdicts',async()=>{
  const group=await groupAdministrator();
  const [p1,p2,p3]=[await hire('Fictional Raise One'),await hire('Fictional Raise Two'),await hire('Fictional Other Pattern')];
  const {batchId}=await createBatch(await entitledCtx(b),{companyId:b.companyId,payPeriod:PERIOD});
  const flag=async(employmentId:string,pattern:string,swingBp:number)=>(await owner.db.insert(terasLoopCase).values({tenantId:b.tenantId,workerId:'loop_salary_payroll',
   companyId:b.companyId,employmentId,subjectKey:`swing:${employmentId}:${PERIOD}`,recipient:'hr',state:'open',facts:{payPeriod:PERIOD,swingBp,direction:'up',pattern,thresholdBp:1500,causes:['salary_change']},
   openedRunId:randomUUID(),checkedRunId:randomUUID()}).returning())[0];
  await flag(p1.employmentId,'cause:salary_change',2100);await flag(p2.employmentId,'cause:salary_change',1900);const other=await flag(p3.employmentId,'cause:overtime_hours',2600);
  const verdict=async(employmentId:string,detectors:string[])=>{const [row]=await owner.db.insert(schema.payrollAnomalyVerdict).values({tenantId:b.tenantId,batchId,employmentId,disposition:'review'} as never).returning();
   for(const detectorId of detectors)await owner.db.insert(schema.payrollAnomalyFinding).values({tenantId:b.tenantId,verdictId:row.id,detectorId,severity:'review',facts:{},suggestedAction:'anomaly.action.fixture'} as never);return row.id;};
  const onlySwing=await verdict(p1.employmentId,['net-swing']),mixed=await verdict(p2.employmentId,['net-swing','proration-mismatch']);
  expect(await disposeSwingGroup(group,{companyId:b.companyId,payPeriod:PERIOD,pattern:'cause:salary_change',disposition:'expected'})).toEqual({disposed:2,skipped:0,verdictsResolved:1});
  const dispositions=await withTenant(group,tx=>tx.select().from(terasPayrollSwingDisposition));
  expect(dispositions.map(row=>[row.employmentId,row.disposition,row.decidedByUserId]).sort()).toEqual([[p1.employmentId,'expected',group.userId],[p2.employmentId,'expected',group.userId]].sort());
  const resolved=async(id:string)=>(await owner.db.select({at:schema.payrollAnomalyVerdict.resolvedAt}).from(schema.payrollAnomalyVerdict).where(eq(schema.payrollAnomalyVerdict.id,id)))[0].at!==null;
  // The net-swing-only verdict is the same decision; the one with another finding waits for its own review.
  expect([await resolved(onlySwing),await resolved(mixed)]).toEqual([true,false]);
  // The other pattern is untouched; the group is gone; a real problem resolves nothing.
  expect((await owner.db.select().from(terasPayrollSwingDisposition).where(eq(terasPayrollSwingDisposition.caseId,other.id)))).toEqual([]);
  await expect(disposeSwingGroup(group,{companyId:b.companyId,payPeriod:PERIOD,pattern:'cause:salary_change',disposition:'expected'})).rejects.toMatchObject({reason:'changed'});
  expect(await disposeSwingGroup(group,{companyId:b.companyId,payPeriod:PERIOD,pattern:'cause:overtime_hours',disposition:'problem'})).toEqual({disposed:1,skipped:0,verdictsResolved:0});
  // An employee cannot.
  await expect(disposeSwingGroup(await employeeLogin(),{companyId:b.companyId,payPeriod:PERIOD,pattern:'cause:overtime_hours',disposition:'expected'})).rejects.toMatchObject({reason:'not_administrator'});
 });
});

describe('B6: automatic cut-off reminders',()=>{
 it('reminds only people with something pending, once per cut-off and lead, with counts and no pay figure, and is switchable per company',async()=>{
  const group=await groupAdministrator();
  // Cut-offs on the 26th: July's inputs close on 25 July (attendance, claims and salary alike).
  await owner.db.insert(schema.companyPayrollConfig).values({tenantId:b.tenantId,companyId:b.companyId,cutOffDay:26,attendanceCutOffDay:26,claimCutOffDay:26});
  const [drafting,quiet,claimant,manager]=[await hire('Fictional Drafter'),await hire('Fictional Quiet'),await hire('Fictional Claimant'),await hire('Fictional Manager')];
  await setReportingLine(await entitledCtx(b),{subordinateEmploymentId:claimant.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2024-01-01'});
  const [type]=await owner.db.insert(schema.claimType).values({tenantId:b.tenantId,code:`REM${randomUUID().slice(0,4)}`,name:'Fictional travel',requiresReceipt:false}).returning();
  await owner.db.insert(schema.claimRequest).values([
   {tenantId:b.tenantId,employmentId:drafting.employmentId,claimTypeId:type.id,amount:'987.65',incurredOn:'2026-07-05',status:'draft'},
   {tenantId:b.tenantId,employmentId:claimant.employmentId,claimTypeId:type.id,amount:'123.45',incurredOn:'2026-07-06',status:'pending'}]);
  await setWorkerSwitch(group,{workerId:'loop_payroll_inputs',enabled:true});
  const entitlements=(await entitledCtx(b)).entitlements!;
  // 20 July is five days before the 25th: the loop's run sends the reminders after preparing.
  expect(await runLoop('loop_payroll_inputs',{tenantId:b.tenantId,principalId,entitlements,today:'2026-07-20',now:new Date('2026-07-19T19:00:00Z')})).toMatchObject({status:'ran'});
  const ledger=async()=>(await withTenant(group,tx=>tx.select().from(terasCutOffReminder))).map(row=>[row.recipientEmploymentId,row.cutOff,row.leadDays,row.audience,row.ownItems,row.approvals]).sort();
  expect(await ledger()).toEqual([[drafting.employmentId,'2026-07-25',5,'employee',1,0],[manager.employmentId,'2026-07-25',5,'approver',0,1]].sort());
  // Each is the recipient's own notice, with counts and the date and nothing else.
  await dispatchNotifications(await entitledCtx(b),{});
  const notices=await owner.db.select().from(schema.notification).where(eq(schema.notification.kind,'teras-loop.cut-off-reminder'));
  expect(notices.map(row=>row.recipientEmploymentId).sort()).toEqual([drafting.employmentId,manager.employmentId].sort());
  for(const notice of notices){
   expect(JSON.stringify(notice)).not.toMatch(/987|123\.45|3000/);
   expect(notice.linkPath).toBe('/');
  }
  expect(notices.find(row=>row.recipientEmploymentId===drafting.employmentId)!.body).toBe('You have 1 item of your own to finish before the payroll cut-off on 2026-07-25. Open Before payroll on Today to see them.');
  expect(notices.find(row=>row.recipientEmploymentId===manager.employmentId)!.body).toBe('You have 1 request waiting for your decision before the payroll cut-off on 2026-07-25. Open Before payroll on Today to see them.');
  // Nobody with nothing pending, and the agent wrote the ledger.
  expect((await ledger()).map(row=>row[0])).not.toContain(quiet.employmentId);
  // Rate-limited: the same cut-off and lead never again, however often it runs.
  const again=()=>sendCutOffReminders({tenantId:b.tenantId,principalId,runId:randomUUID(),agent:agentOf(entitlements),sponsor:group,companies:[b.companyId],today:'2026-07-20'});
  expect(await again()).toMatchObject({sent:0});
  // Switched off for the company: nothing at the 2-day lead; on again, sent.
  await setPayrollLoopSetting(group,{companyId:b.companyId,remindersEnabled:false});
  const twoDays=()=>sendCutOffReminders({tenantId:b.tenantId,principalId,runId:randomUUID(),agent:agentOf(entitlements),sponsor:group,companies:[b.companyId],today:'2026-07-23'});
  expect(await twoDays()).toMatchObject({sent:0});
  await setPayrollLoopSetting(group,{companyId:b.companyId,remindersEnabled:true});
  expect(await twoDays()).toMatchObject({sent:2});
  // A paused company gets none (the database refuses the agent's write).
  await setLoopPause(group,{workerId:'loop_payroll_inputs',companyId:b.companyId,paused:true});
  expect(await sendCutOffReminders({tenantId:b.tenantId,principalId,runId:randomUUID(),agent:agentOf(entitlements),sponsor:group,companies:[b.companyId],today:'2026-07-24'})).toMatchObject({sent:0});
 });
});
const agentOf=(entitlements:NonNullable<SessionContext['entitlements']>):SessionContext=>agentContext(b.tenantId,principalId,entitlements);

describe('B1: freshness and resilience',()=>{
 it('names only the companies whose payroll changed since the loop last ran there',async()=>{
  const group=await groupAdministrator();
  const [second]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Second Sdn Bhd'}).returning();
  const [third]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Third Sdn Bhd'}).returning();
  const before=new Date(Date.now()-60_000);
  // The first company processed a run after the loop's last run; the second has had none since; the third never ran.
  const {batchId}=await createBatch(await entitledCtx(b),{companyId:b.companyId,payPeriod:PERIOD});
  await owner.db.insert(schema.domainEvent).values({tenantId:b.tenantId,aggregateType:'payroll-batch',aggregateId:batchId,eventType:'payroll-batch.processed',actorType:'user',actorId:b.adminUserId});
  const since=new Map<string,Date|null>([[b.companyId,before],[second.id,new Date()],[third.id,null]]);
  expect((await payrollChangedCompanies(group,{companies:[b.companyId,second.id,third.id],since})).sort()).toEqual([b.companyId,third.id].sort());
  // The loop's own last runs are what the tick compares with.
  expect([...(await withTenant(agentOf((await entitledCtx(b)).entitlements!),tx=>lastLoopRunsTx(tx,b.tenantId,'loop_salary_payroll',[b.companyId]))).values()]).toEqual([null]);
 });

 it('records a failed read for one company only and still checks the others; re-checks Pre-salary at the end of cut-off day',async()=>{
  const group=await groupAdministrator();
  const [second]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Second Sdn Bhd'}).returning();
  await setWorkerSwitch(group,{workerId:'loop_payroll_inputs',enabled:true});
  const entitlements=(await entitledCtx(b)).entitlements!;
  failing.companyId=second.id;
  const run=(now:string,today='2026-07-31')=>runLoop('loop_payroll_inputs',{tenantId:b.tenantId,principalId,entitlements,today,now:new Date(now)});
  expect(await run('2026-07-30T19:00:00Z')).toMatchObject({status:'ran',companies:1});
  const runs=await withTenant(group,tx=>tx.select().from(terasLoopRun).where(eq(terasLoopRun.workerId,'loop_payroll_inputs')));
  expect(runs.map(row=>[row.companyId,row.status]).sort()).toEqual([[b.companyId,'ran'],[second.id,'failed']].sort());
  failing.companyId=null;
  // 31 July is both companies' cut-off (month end). Daily: at 20:00 the first company is not due again; from 23:00 it is.
  expect(await run('2026-07-31T12:00:00Z')).toMatchObject({status:'ran',companies:1});// only the second, which failed
  expect(await run('2026-07-31T14:30:00Z')).toMatchObject({status:'ran',companies:0});
  expect(await run('2026-07-31T15:05:00Z')).toMatchObject({status:'ran',companies:2});
  expect(await run('2026-07-31T15:20:00Z')).toMatchObject({status:'ran',companies:0});
 });

 it('applies an automatic action only while the loop may still act: switch, stop, pause and level, read inside the transaction',async()=>{
  const group=await groupAdministrator();
  const LOOP='loop_missing_employee_data';
  const gate=()=>withTenant(group,tx=>loopMayStillActTx(tx,{tenantId:b.tenantId,workerId:LOOP,companyId:b.companyId}));
  expect(await gate()).toBe(false);// off, and at Prepare
  await setWorkerSwitch(group,{workerId:LOOP,enabled:true});
  await tamper(sql`insert into public.teras_loop_level(tenant_id,worker_id,company_id,level,changed_by,changed_by_user_id)
   values (${b.tenantId}::uuid,${LOOP},${b.companyId}::uuid,2,'administrator',${group.userId}::uuid)`);
  expect(await gate()).toBe(true);
  await setLoopPause(group,{workerId:LOOP,companyId:b.companyId,paused:true});
  expect(await gate()).toBe(false);
  await setLoopPause(group,{workerId:LOOP,companyId:b.companyId,paused:false});
  expect(await gate()).toBe(true);
  await tamper(sql`update public.teras_loop_level set level=1 where tenant_id=${b.tenantId}::uuid and worker_id=${LOOP}`);
  expect(await gate()).toBe(false);
 });
});
