/** AI v2 P2-2b — the payroll Audit loop on fictional data (migration 0965, core/payroll-audit).
 *
 *  1. Capture, end to end: a fictional January 2026 run is processed and closed through the payroll services, then
 *     captured; every kind of evidence the run produced is captured once, an unchanged month captures nothing new, and the
 *     chain verifies with each capture anchored in the audit log.
 *  2. Tamper evidence: changing a captured row, deleting one in the middle and deleting the last are each detected.
 *  3. Each control check fires on its fixture and stays quiet on its counterpart; the preparer-and-closer check flags a
 *     run that was closed, and never blocked the close.
 *  4. Access logging: viewing and exporting payroll data writes an entry, and the entries are captured.
 *  5. The audit pack: its files, the hash of each in the manifest, and the archive hash.
 *  6. Corrections take a root cause from the fixed list; dispositions are a person's, with a note.
 *  7. Role access and isolation: another company's administrator, an employee, another tenant and an auditor without a
 *     grant read nothing; an auditor with a grant reads the pack and may not dispose.
 *  8. The daily loop: off by default; switched on, it runs as the agent principal under its sponsor, honours the
 *     per-company pause, and records each run.
 *  9. No model is called (the gateway is replaced by one that counts and refuses).
 * Expected values are written out from the fixtures, never re-derived from the loop's own helpers. */
import {createHash,randomUUID} from 'node:crypto';
import JSZip from 'jszip';
import {PDFArray,PDFDict,PDFDocument,PDFName,PDFRawStream,decodePDFRawStream} from 'pdf-lib';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';

const model=vi.hoisted(()=>({calls:0}));
vi.mock('../lib/ai',async importOriginal=>{
 const original=await importOriginal<typeof import('../lib/ai')>();
 const refuse=async()=>{model.calls++;throw new Error('No model call is allowed in the Audit loop.');};
 return {...original,generateDraft:refuse,converse:refuse,readImage:refuse};
});

import * as schema from '../db/schema';
import {payrollAuditCapture,payrollAuditFinding} from '../db/payroll-audit-schema';
import {terasLoopRun} from '../db/teras-schema';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setBankProfileMY,setStatutoryProfileMY} from '../localization/my/statutory';
import {closeBatch,createBatch,generatePayslips} from '../core/payroll';
import {ensureAgentPrincipal} from '../core/agent-principal';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {setLoopPause} from '../core/loops/controls';
import {capturePayrollPeriod,collectPayrollPeriodArtefactsTx} from '../core/payroll-audit/capture';
import {disposeFinding,runControlChecks,AuditFindingRefused} from '../core/payroll-audit/controls';
import {recordCorrectionCause} from '../core/payroll-audit/corrections';
import {recordPayrollAccess,recordPayrollExport} from '../core/payroll-audit/access-log';
import {verifyCapturesTx} from '../core/payroll-audit/verify';
import {buildAuditPack,AuditPackRefused,type AuditPackLabels} from '../core/payroll-audit/pack';
import {auditAdministration,grantAuditReader,revokeAuditReader,setControlSettings} from '../core/payroll-audit/settings';
import {auditLoopDetail,auditLoopSummary} from '../core/payroll-audit/status';
import {runPayrollAuditLoop} from '../core/payroll-audit/run';
import {INPUT_COMPONENTS,captureRunInputsAtProcessingTx} from '../core/payroll-audit/inputs';
import {AUDIT_CAPTURE_KINDS,AUDIT_CONTROL_IDS,AUDIT_DISPOSITIONS,AUDIT_ROOT_CAUSES} from '../core/payroll-audit/types';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

const PERIOD='2026-01',TODAY='2026-02-10';
let b:Base;
type Person={employmentId:string;personId:string};

/** A login with no employee record (so the company's payroll needs nothing for them), with the grants given. */
async function adminLogin(base:Base,grants:{role:string;companyId:string|null}[]):Promise<SessionContext&{userId:string}>{
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:`user_${randomUUID()}`,personId:null}).returning({id:schema.appUser.id});
 for(const grant of grants)await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId:grant.companyId,role:grant.role as 'hr_admin'});
 const ctx=await entitledCtx(base,[...new Set(grants.map(grant=>grant.role))]);
 return {...ctx,userId:user.id,roles:[...new Set(grants.map(grant=>grant.role))],grants};
}
async function hirePaid(ctx:SessionContext,companyId:string,departmentId:string,name:string,ic:string,salary:number):Promise<Person>{
 const hired=await hireEmployee(ctx,{person:{fullName:name,primaryEmail:`${randomUUID()}@fixture.test`},companyId,departmentId,employmentType:'full_time',hiredOn:'2025-01-01'});
 await setCompensation(ctx,{employmentId:hired.employmentId,basicSalary:salary,effectiveFrom:'2025-01-01'});
 await setStatutoryProfileMY(ctx,{personId:hired.personId,icNumber:ic,taxCategory:1,numChildren:0});
 return {employmentId:hired.employmentId,personId:hired.personId};
}
const capturesOf=(ctx:SessionContext,companyId:string,period=PERIOD)=>withTenant(ctx,tx=>tx.select().from(payrollAuditCapture)
 .where(and(eq(payrollAuditCapture.companyId,companyId),eq(payrollAuditCapture.payPeriod,period))).orderBy(payrollAuditCapture.seq));
const findingsOf=(ctx:SessionContext,companyId:string)=>withTenant(ctx,tx=>tx.select().from(payrollAuditFinding).where(eq(payrollAuditFinding.companyId,companyId)));
const verify=(ctx:SessionContext,companyId:string)=>withTenant(ctx,tx=>verifyCapturesTx(tx,ctx.tenantId,{companyId,payPeriod:PERIOD}));
/** The owner, with triggers off (session_replication_role replica bypasses the append-only guard): a tamperer with database access. */
const tamper=(statement:ReturnType<typeof sql>)=>owner.db.transaction(async tx=>{await tx.execute(sql`set local session_replication_role=replica`);await tx.execute(statement);});
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const LABELS:AuditPackLabels={title:'Payroll audit pack',company:'Company',payPeriod:'Pay month',generated:'Generated',by:'By',runs:'Runs',
 runLine:'{runType} run {runSeq}: {status}, closed {closedAt}, released {releasedAt}',statutory:'Statutory and bank files',filingEvidence:'Filing evidence and receipts',
 findings:'Control findings',findingLine:'{control}: {count} ({open} open, {disposed} disposed)',corrections:'Corrections after the run',
 correctionLine:'{action} on {at}: root cause {cause}, {note}',captures:'Captures',captureLine:'{kind}: {count}',verification:'Tamper check',
 verified:'{count} captures verified. Chain head {head}.',notVerified:'{count} problems found. See verification.json.',
 anchors:'{matched} anchored in the audit log, {chained} inside its hash chain.',files:'Files',none:'None',
 findingItem:'{control}: {who} ({state})',open:'open',unprintable:'{count} characters could not be drawn.',
 dispositions:{expected:'Expected',corrected:'Corrected',false_positive:'Not an issue',escalated:'Escalated'},
 kinds:Object.fromEntries(AUDIT_CAPTURE_KINDS.map(kind=>[kind,kind])) as AuditPackLabels['kinds'],
 controls:Object.fromEntries(AUDIT_CONTROL_IDS.map(id=>[id,id])) as AuditPackLabels['controls']};

/** The January 2026 fixture: company 1 with three people, processed and closed by one administrator; company 2 with one
 * person, processed by that administrator and closed by another. */
type Fixture={hr:SessionContext&{userId:string};group:SessionContext&{userId:string};co2:string;dept2:string;a:Person;bb:Person;c:Person;d:Person;
 batch1:string;batch2:string};
async function fixture():Promise<Fixture>{
 await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'attendance','active');
 const hr={...await entitledCtx(b),grants:[{role:'hr_admin',companyId:null}],roles:['hr_admin']} as SessionContext&{userId:string};
 const group=await adminLogin(b,[{role:'hr_admin',companyId:null}]);
 const [co]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Two Sdn Bhd'}).returning({id:schema.company.id});
 const [dept]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:co.id,name:'Fictional Ops'}).returning({id:schema.department.id});
 const a=await hirePaid(hr,b.companyId,b.deptA,'Aisyah Fictional','900101015551',5000);
 const bb=await hirePaid(hr,b.companyId,b.deptA,'Bala Fictional','900101015552',4000);
 const c=await hirePaid(hr,b.companyId,b.deptA,'Chong Fictional','900101015553',4500);
 const d=await hirePaid(hr,co.id,dept.id,'Dewi Fictional','900101015554',3000);
 // Bank details: A and C share one account; B has their own. Set through the statutory owner, so each change is an event.
 await setBankProfileMY(hr,{personId:a.personId,bankName:'Maybank',bankAccountNo:'1122-3344-5566'});
 await setBankProfileMY(hr,{personId:c.personId,bankName:'Maybank',bankAccountNo:'112233445566'});
 await setBankProfileMY(hr,{personId:bb.personId,bankName:'CIMB',bankAccountNo:'998877665544'});
 await setBankProfileMY(hr,{personId:d.personId,bankName:'RHB',bankAccountNo:'556677889900'});
 const {batchId:batch1}=await createBatch(hr,{companyId:b.companyId,payPeriod:PERIOD});
 await generatePayslips(hr,{batchId:batch1});
 await closeBatch(hr,{batchId:batch1});
 const {batchId:batch2}=await createBatch(hr,{companyId:co.id,payPeriod:PERIOD});
 await generatePayslips(hr,{batchId:batch2});
 await closeBatch(group,{batchId:batch2});
 return {hr,group,co2:co.id,dept2:dept.id,a,bb,c,d,batch1,batch2};
}

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{model.calls=0;await resetDb();b=await seedBase();});
afterEach(()=>{expect(model.calls,'the Audit loop called a model').toBe(0);});

describe('the vocabularies match migration 0965',()=>{
 it('lists the same capture kinds, controls, dispositions and root causes as the CHECKs',async()=>{
  const sqlText=(await import('node:fs')).readFileSync(new URL('../db/migrations/2006_payroll_audit_loop.sql',import.meta.url),'utf8');
  const list=(column:string)=>{const m=sqlText.match(new RegExp(`${column} text NOT NULL CHECK \\(${column} IN \\(([^)]*)\\)\\)`));return (m?.[1]??'').replace(/\s+/g,'').split(',').map(v=>v.replace(/'/g,''));};
  expect(list('kind')).toEqual([...AUDIT_CAPTURE_KINDS]);
  expect(list('control_id')).toEqual([...AUDIT_CONTROL_IDS]);
  expect(list('disposition')).toEqual([...AUDIT_DISPOSITIONS]);
  expect(list('root_cause')).toEqual([...AUDIT_ROOT_CAUSES]);
 });
});

describe('capture, end to end',()=>{
 it('captures every kind of evidence the run produced, once, and verifies with each capture anchored',async()=>{
  const f=await fixture();
  const first=await capturePayrollPeriod(f.hr,{companyId:b.companyId,payPeriod:PERIOD});
  expect(first).toMatchObject({companyId:b.companyId,payPeriod:PERIOD,runs:1});
  expect(first.captured).toBe(first.artefacts);
  const rows=await capturesOf(f.hr,b.companyId);
  // Everything the capture appended, after the inputs snapshot the processing owner took when the run was processed.
  expect(rows).toHaveLength(first.captured+1);
  expect(rows[0]).toMatchObject({kind:'inputs_snapshot',sourceKey:'inputs:'+f.batch1,seq:1});
  expect(rows.map(row=>row.seq)).toEqual(rows.map((_,i)=>i+1));
  const kinds=new Set(rows.map(row=>row.kind));
  for(const kind of ['run','inputs_snapshot','payslip','change','rule_version','approval','payslip_release','filing'] as const)expect(kinds.has(kind),kind).toBe(true);
  // One payslip each for the three people of company 1, nobody from company 2.
  expect(rows.filter(row=>row.kind==='payslip').map(row=>row.sourceKey).sort()).toEqual([f.a,f.bb,f.c].map(p=>`payslip:${f.batch1}:${p.employmentId}`).sort());
  // The inputs snapshot names each component with a row count and a sha256.
  const inputs=rows.find(row=>row.sourceKey==='inputs:'+f.batch1)!.content as {employments:number;components:Record<string,{rows:number;hash:string}>};
  expect(inputs.employments).toBe(3);
  expect(Object.keys(inputs.components).sort()).toEqual(['attendance','claims','leave','overtime','payChanges','runComponents','runInputs','transactions']);
  expect(rows.find(row=>row.sourceKey==='inputs_now:'+f.batch1)!.content).toMatchObject({basis:'at_capture',employments:3});
  expect(inputs.components.payChanges.rows).toBeGreaterThanOrEqual(3);
  for(const component of Object.values(inputs.components))expect(component.hash).toMatch(/^[0-9a-f]{64}$/);
  // The draft-to-final trail: the run's own processed and closed events, with who.
  const changes=rows.filter(row=>row.kind==='change').map(row=>row.content as {eventType?:string;actorId?:string});
  expect(changes.filter(item=>item.eventType==='payroll-batch.processed').map(item=>item.actorId)).toEqual([f.hr.userId]);
  expect(changes.filter(item=>item.eventType==='payroll-batch.closed').map(item=>item.actorId)).toEqual([f.hr.userId]);
  const approval=rows.find(row=>row.kind==='approval')!.content as {status:string;closed:{actorId:string}[];processed:{actorId:string}[]};
  expect(approval.status).toBe('closed');
  expect(approval.closed.map(item=>item.actorId)).toEqual([f.hr.userId]);
  expect(rows.find(row=>row.kind==='payslip_release')!.content).toMatchObject({payslips:3,openedBy:0});
  // The database computed every hash and link.
  for(const row of rows){
   expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);expect(row.chainHash).toMatch(/^[0-9a-f]{64}$/);
   expect(row.writer).toBe('user');expect(row.writerId).toBe(f.hr.userId);
  }
  expect(rows[0].prevHash).toBe('GENESIS');
  for(let i=1;i<rows.length;i++)expect(rows[i].prevHash).toBe(rows[i-1].chainHash);
  // Nothing changed: capturing again appends nothing.
  expect((await capturePayrollPeriod(f.hr,{companyId:b.companyId,payPeriod:PERIOD})).captured).toBe(0);
  const v=await verify(f.hr,b.companyId);
  expect(v).toMatchObject({valid:true,checked:rows.length,head:rows.at(-1)!.chainHash,issues:[]});
  expect(v.anchors).toMatchObject({visible:true,matched:rows.length});
  // Each anchor is the domain event the database wrote with the capture; inside the tenant chain when the chain is armed.
  const anchors=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,b.tenantId),eq(schema.domainEvent.eventType,'payroll-audit.captured')));
  expect(anchors.filter(event=>(event.payload as {companyId?:string}).companyId===b.companyId)).toHaveLength(rows.length);
  expect(v.anchors.inAuditChain).toBe(anchors.filter(event=>(event.payload as {companyId?:string}).companyId===b.companyId&&event.chainSeq!==null).length);
  // New evidence is a new capture, linked to the last one: here, an administrator viewed the run's register.
  await recordPayrollAccess(f.hr,{surface:'register',action:'view',companyId:b.companyId,payPeriod:PERIOD,batchId:f.batch1});
  const again=await capturePayrollPeriod(f.hr,{companyId:b.companyId,payPeriod:PERIOD});
  expect(again.captured).toBe(1);
  const latest=(await capturesOf(f.hr,b.companyId)).at(-1)!;
  expect(latest).toMatchObject({kind:'access',seq:rows.length+1,prevHash:rows.at(-1)!.chainHash});
  expect((latest.content as {entry:Record<string,unknown>}).entry).toEqual({surface:'register',action:'view',companyId:b.companyId,payPeriod:PERIOD,batchId:f.batch1});
 });

 it('refuses an append-only change through the application role, and the writer cannot choose its own hashes',async()=>{
  const f=await fixture();
  await capturePayrollPeriod(f.hr,{companyId:b.companyId,payPeriod:PERIOD});
  const [row]=await capturesOf(f.hr,b.companyId);
  const updated=await withTenant(f.hr,tx=>tx.update(payrollAuditCapture).set({content:{forged:true}}).where(eq(payrollAuditCapture.id,row.id))).then(()=>null,(e:unknown)=>e);
  expect(updated).not.toBeNull();
  const forged=await withTenant(f.hr,tx=>tx.insert(payrollAuditCapture).values({tenantId:b.tenantId,companyId:b.companyId,payPeriod:PERIOD,batchId:null,kind:'run',
   sourceKey:'run:forged',content:{forged:true},contentHash:'0'.repeat(64),prevHash:'GENESIS',chainHash:'0'.repeat(64),seq:1,writer:'user',writerId:f.hr.userId}).returning());
  expect(forged[0].contentHash).not.toBe('0'.repeat(64));
  expect(forged[0].seq).toBeGreaterThan(1);
  expect(forged[0].prevHash).not.toBe('GENESIS');
  expect((await verify(f.hr,b.companyId)).valid).toBe(true);
 });
});

describe('tamper evidence',()=>{
 it('detects a changed capture, a deleted middle capture and a deleted last capture',async()=>{
  const f=await fixture();
  await capturePayrollPeriod(f.hr,{companyId:b.companyId,payPeriod:PERIOD});
  const rows=await capturesOf(f.hr,b.companyId);
  const middle=rows[Math.floor(rows.length/2)],last=rows.at(-1)!,payslip=rows.find(row=>row.kind==='payslip')!;
  await tamper(sql`update public.payroll_audit_capture set content=jsonb_set(content,'{payslip,net_pay}','"1.00"') where id=${payslip.id}::uuid`);
  let v=await verify(f.hr,b.companyId);
  expect(v.valid).toBe(false);
  expect(v.issues).toEqual([{seq:payslip.seq,captureId:payslip.id,problem:'mutated'}]);
  await tamper(sql`delete from public.payroll_audit_capture where id=${middle.id}::uuid`);
  v=await verify(f.hr,b.companyId);
  expect(v.issues).toEqual(expect.arrayContaining([{seq:middle.seq+1,captureId:rows[middle.seq].id,problem:'gap'},{seq:middle.seq,captureId:middle.id,problem:'missing'}]));
  await tamper(sql`delete from public.payroll_audit_capture where id=${last.id}::uuid`);
  v=await verify(f.hr,b.companyId);
  expect(v.issues).toEqual(expect.arrayContaining([{seq:last.seq,captureId:last.id,problem:'missing'}]));
  expect(v.checked).toBe(rows.length-2);
 });
});

describe('continuous control checks',()=>{
 /** The control fixtures, seeded as the owner with triggers off: the native owners' own rows, dated where the checks look. */
 async function controlFixtures(f:Fixture){
  // Bank change: A's change moved to 3 days before pay day (31 January), B's to 21 days before, C's and D's long before.
  for(const [person,at] of [[f.a,'2026-01-28T10:00:00+08:00'],[f.bb,'2026-01-10T10:00:00+08:00'],[f.c,'2025-11-01T10:00:00+08:00'],[f.d,'2025-11-01T10:00:00+08:00']] as const)
   await tamper(sql`update public.domain_event set occurred_at=${at}::timestamptz where tenant_id=${b.tenantId}::uuid and event_type='employee.bank.updated' and payload->>'personId'=${person.personId}`);
  // Pay after the last working day: B left on 31 December 2025.
  await tamper(sql`update public.employment set last_working_date='2025-12-31' where id=${f.bb.employmentId}::uuid`);
  // Attendance for A and C in January; none for B.
  for(const person of [f.a,f.c])for(const day of ['2026-01-05','2026-01-06'])
   await tamper(sql`insert into public.attendance(tenant_id,employment_id,attendance_date,status,day_type,worked_minutes) values (${b.tenantId}::uuid,${person.employmentId}::uuid,${day}::date,'present','workday',480)`);
  // Statutory overrides: A above 1000 with no reason; B above with a reason; C below with none.
  for(const [person,pcb,reason] of [[f.a,'1500.00',''],[f.bb,'2000.00','Arrears agreed with the employee'],[f.c,'500.00','']] as const)
   await tamper(sql`insert into public.payroll_statutory_adjustment(tenant_id,batch_id,employment_id,pcb,reason) values (${b.tenantId}::uuid,${f.batch1}::uuid,${person.employmentId}::uuid,${pcb}::numeric,${reason})`);
  // A formula revision saved while run 1 was open, and one saved the day before it was created.
  const formula=randomUUID(),inside=randomUUID(),before=randomUUID();
  await tamper(sql`insert into public.pay_formula(id,tenant_id,formula_id,created_by) values (${formula}::uuid,${b.tenantId}::uuid,'FICTIONAL_OT',${b.adminUserId}::uuid)`);
  for(const [id,ordinal,offset] of [[before,1,"-1 day"],[inside,2,"1 millisecond"]] as const)
   await tamper(sql`insert into public.pay_formula_revision(id,tenant_id,formula_id,ordinal,description,method,source,program,content_hash,dependencies,dependency_snapshot,created_by,created_at)
    select ${id}::uuid,${b.tenantId}::uuid,${formula}::uuid,${ordinal}::int,'Fictional','write','1','{"version":"1"}'::jsonb,${'f'.repeat(64)},'[]'::jsonb,'{}'::jsonb,${b.adminUserId}::uuid,
     b.created_at+${offset}::interval from public.payroll_batch b where b.id=${f.batch1}::uuid`);
  return {inside};
 }

 it('each check fires on its fixture and stays quiet on its counterpart; preparer-and-closer flags without blocking',async()=>{
  const f=await fixture();
  const {inside}=await controlFixtures(f);
  expect(await runControlChecks(f.hr,{companyId:b.companyId,payPeriod:PERIOD})).toMatchObject({opened:7});
  const found=await findingsOf(f.hr,b.companyId);
  const by=(control:string)=>found.filter(row=>row.controlId===control);
  expect(by('bank_change_before_pay_day').map(row=>[row.employmentId,row.evidence])).toEqual([[f.a.employmentId,expect.objectContaining({payDay:'2026-01-31',changedOn:'2026-01-28',
   daysBeforePayDay:3,windowDays:7,bankAfter:'Maybank',accountAfterLast4:'5566',accountBeforeLast4:null})]]);
  expect(by('shared_bank_account')).toHaveLength(1);
  expect(by('shared_bank_account')[0].evidence).toMatchObject({accountLast4:'5566',people:2,paidHere:2,employmentIds:[f.a.employmentId,f.c.employmentId].sort(),banks:['Maybank']});
  expect(JSON.stringify(by('shared_bank_account')[0].evidence)).not.toContain('112233445566');
  expect(by('pay_after_last_day').map(row=>[row.employmentId,(row.evidence as {lastWorkingDay:string}).lastWorkingDay])).toEqual([[f.bb.employmentId,'2025-12-31']]);
  expect(by('pay_without_attendance').map(row=>row.employmentId)).toEqual([f.bb.employmentId]);
  expect(by('preparer_closed_run').map(row=>[row.batchId,row.evidence])).toEqual([[f.batch1,expect.objectContaining({userId:f.hr.userId,blocked:false})]]);
  expect(by('adjustment_without_reason').map(row=>[row.employmentId,(row.evidence as {type:string}).type,(row.evidence as {threshold:string}).threshold]))
   .toEqual([[f.a.employmentId,'statutory_adjustment','1000.00']]);
  expect(by('formula_changed_open_period').map(row=>(row.evidence as {revisionId:string}).revisionId)).toEqual([inside]);
  // The close was never blocked: run 1 is closed and released.
  const [closed]=await owner.db.select({status:schema.payrollBatch.status,releasedAt:schema.payrollBatch.releasedAt}).from(schema.payrollBatch).where(eq(schema.payrollBatch.id,f.batch1));
  expect(closed.status).toBe('closed');expect(closed.releasedAt).not.toBeNull();
  // Company 2: processed by one administrator and closed by another, its own bank account, no attendance recorded.
  await runControlChecks(f.hr,{companyId:f.co2,payPeriod:PERIOD});
  expect((await findingsOf(f.hr,f.co2)).map(row=>row.controlId)).toEqual(['pay_without_attendance']);
  // Recorded once per subject: running again opens nothing.
  expect(await runControlChecks(f.hr,{companyId:b.companyId,payPeriod:PERIOD})).toMatchObject({opened:0});
 });

 it('reads the company\'s own window and amount, set by a payroll administrator and audited',async()=>{
  const f=await fixture();
  await controlFixtures(f);
  await expect(setControlSettings(f.hr,{companyId:b.companyId,bankChangeDays:0,adjustmentThreshold:1000})).rejects.toMatchObject({reason:'invalid'});
  await expect(setControlSettings(f.hr,{companyId:b.companyId,bankChangeDays:7,adjustmentThreshold:10.005})).rejects.toMatchObject({reason:'invalid'});
  expect(await setControlSettings(f.hr,{companyId:b.companyId,bankChangeDays:5,adjustmentThreshold:1800})).toEqual({bankChangeDays:5,adjustmentThreshold:1800,version:1});
  expect(await setControlSettings(f.hr,{companyId:b.companyId,bankChangeDays:2,adjustmentThreshold:2500})).toEqual({bankChangeDays:2,adjustmentThreshold:2500,version:2});
  const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,b.tenantId),eq(schema.domainEvent.eventType,'payroll-audit.settings-changed')))
   .orderBy(schema.domainEvent.sequence);
  expect(events.map(event=>[event.actorId,(event.payload as {before:unknown;after:unknown}).before,(event.payload as {after:unknown}).after])).toEqual([
   [f.hr.userId,{bankChangeDays:7,adjustmentThreshold:'1000.00'},{bankChangeDays:5,adjustmentThreshold:'1800.00'}],
   [f.hr.userId,{bankChangeDays:5,adjustmentThreshold:'1800.00'},{bankChangeDays:2,adjustmentThreshold:'2500.00'}]]);
  // A's change was 3 days before pay day (outside 2 days) and A's override 1500.00 (under 2500.00): both quiet now.
  await runControlChecks(f.hr,{companyId:b.companyId,payPeriod:PERIOD});
  const found=await findingsOf(f.hr,b.companyId);
  expect(found.filter(row=>row.controlId==='bank_change_before_pay_day'||row.controlId==='adjustment_without_reason')).toEqual([]);
  // Another company's administrator cannot change this company's settings.
  const other=await adminLogin(b,[{role:'hr_admin',companyId:f.co2}]);
  await expect(setControlSettings(other,{companyId:b.companyId,bankChangeDays:3,adjustmentThreshold:1000})).rejects.toMatchObject({reason:'not_administrator'});
 });

 it('a disposition is a payroll administrator\'s, with a note, and the latest one is the finding\'s state',async()=>{
  const f=await fixture();
  await runControlChecks(f.hr,{companyId:b.companyId,payPeriod:PERIOD});
  const finding=(await findingsOf(f.hr,b.companyId)).find(row=>row.controlId==='preparer_closed_run')!;
  await expect(disposeFinding(f.hr,{findingId:finding.id,disposition:'expected',note:'  '})).rejects.toMatchObject({reason:'invalid'});
  await expect(disposeFinding(f.hr,{findingId:finding.id,disposition:'ignored',note:'x'})).rejects.toMatchObject({reason:'invalid'});
  await disposeFinding(f.hr,{findingId:finding.id,disposition:'escalated',note:'Raised with the finance director.'});
  await disposeFinding(f.hr,{findingId:finding.id,disposition:'expected',note:'One-person team this month; reviewed after the fact.'});
  const detail=await auditLoopDetail(f.hr,{payPeriod:PERIOD,companyIds:[b.companyId]});
  expect(detail.findings.find(item=>item.id===finding.id)).toMatchObject({disposition:'expected',note:'One-person team this month; reviewed after the fact.',disposedBy:f.hr.userId});
  const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,b.tenantId),eq(schema.domainEvent.eventType,'payroll-audit.finding-disposed')))
   .orderBy(schema.domainEvent.sequence);
  expect(events.map(event=>(event.payload as {disposition:string}).disposition)).toEqual(['escalated','expected']);
  // An administrator of the other company only cannot dispose of it.
  const other=await adminLogin(b,[{role:'hr_admin',companyId:f.co2}]);
  await expect(disposeFinding(other,{findingId:finding.id,disposition:'corrected',note:'Not mine.'})).rejects.toBeInstanceOf(AuditFindingRefused);
 });
});

describe('corrections after the run',()=>{
 it('takes a root cause from the fixed list with a note; the latest statement wins and is captured',async()=>{
  const f=await fixture();
  // The payroll owner's record of a closed run reopened (the native unlock writes exactly this row).
  const historyId=randomUUID();
  await tamper(sql`insert into public.payroll_status_history(id,tenant_id,batch_id,action,from_status,to_status,actor_type,actor_id,reason)
   values (${historyId}::uuid,${b.tenantId}::uuid,${f.batch1}::uuid,'unlock','closed','processed','user',${f.hr.userId}::uuid,'Fictional: overtime keyed after close')`);
  const key='status:'+historyId;
  let detail=await auditLoopDetail(f.hr,{payPeriod:PERIOD,companyIds:[b.companyId]});
  expect(detail.corrections).toEqual([expect.objectContaining({correctionKey:key,action:'unlock',reason:'Fictional: overtime keyed after close',rootCause:null})]);
  expect(detail.companies[0].corrections).toEqual({count:1,withoutRootCause:1});
  await expect(recordCorrectionCause(f.hr,{correctionKey:key,rootCause:'bad_luck',note:'x'})).rejects.toMatchObject({reason:'invalid'});
  await recordCorrectionCause(f.hr,{correctionKey:key,rootCause:'input_error',note:'Keyed to the wrong employee.'});
  await recordCorrectionCause(f.hr,{correctionKey:key,rootCause:'late_input',note:'The claim arrived after the cut-off.'});
  detail=await auditLoopDetail(f.hr,{payPeriod:PERIOD,companyIds:[b.companyId]});
  expect(detail.corrections[0]).toMatchObject({rootCause:'late_input',note:'The claim arrived after the cut-off.',recordedBy:f.hr.userId});
  expect(detail.companies[0].corrections).toEqual({count:1,withoutRootCause:0});
  await capturePayrollPeriod(f.hr,{companyId:b.companyId,payPeriod:PERIOD});
  const correction=(await capturesOf(f.hr,b.companyId)).find(row=>row.kind==='correction')!;
  expect((correction.content as {rootCauses:{root_cause:string}[]}).rootCauses.map(item=>item.root_cause)).toEqual(['input_error','late_input']);
 });
});

describe('access logging',()=>{
 it('records each view and export with the file hash, never a figure, and the pack download is itself recorded',async()=>{
  const f=await fixture();
  const view=await recordPayrollAccess(f.hr,{surface:'payslip_admin',action:'view',companyId:b.companyId,payPeriod:PERIOD,batchId:f.batch1,employmentId:f.a.employmentId});
  const file='EMPLOYEE,NET\r\nA,1\r\n';
  const exported=await recordPayrollExport(f.hr,{surface:'run_export',companyId:b.companyId,payPeriod:PERIOD,batchId:f.batch1,format:'csv'},file,1);
  expect(view.recorded&&exported.recorded).toBe(true);
  const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,b.tenantId),eq(schema.domainEvent.eventType,'payroll-data.accessed')))
   .orderBy(schema.domainEvent.sequence);
  expect(events.map(event=>[event.actorId,event.subjectEmploymentId,event.payload])).toEqual([
   [f.hr.userId,null,{surface:'payslip_admin',action:'view',companyId:b.companyId,payPeriod:PERIOD,batchId:f.batch1,employmentId:f.a.employmentId}],
   [f.hr.userId,null,{surface:'run_export',action:'export',companyId:b.companyId,payPeriod:PERIOD,batchId:f.batch1,format:'csv',fileSha256:sha(file),bytes:19,rows:1}]]);
  // Free text and unknown surfaces are refused before anything is written.
  await expect(recordPayrollAccess(f.hr,{surface:'register',action:'view',companyId:b.companyId,detail:'Net pay RM 5,000'} as never)).rejects.toThrow();
  await expect(recordPayrollAccess(f.hr,{surface:'somewhere',action:'view',companyId:b.companyId} as never)).rejects.toThrow();
  const pack=await buildAuditPack(f.hr,{companyId:b.companyId,payPeriod:PERIOD},LABELS);
  const zip=await JSZip.loadAsync(pack.bytes);
  const log=await zip.file('access-log.csv')!.async('string');
  expect(log.split('\r\n').filter(Boolean)).toHaveLength(3);
  expect(log).toContain(sha(file));
 });
});

describe('the audit pack',()=>{
 it('holds the summary and the evidence, each listed with its sha256 in the manifest',async()=>{
  const f=await fixture();
  await runControlChecks(f.hr,{companyId:b.companyId,payPeriod:PERIOD});
  const pack=await buildAuditPack(f.hr,{companyId:b.companyId,payPeriod:PERIOD},LABELS);
  expect(pack.sha256).toBe(sha(pack.bytes));
  expect(pack.filename).toBe('audit-pack-Acme-Sdn-Bhd-2026-01.zip');
  const zip=await JSZip.loadAsync(pack.bytes);
  expect(Object.keys(zip.files).sort()).toEqual(['access-log.csv','captures.csv','captures.json','findings.csv','findings.json','manifest.json','summary.pdf','verification.json']);
  const manifest=JSON.parse(await zip.file('manifest.json')!.async('string')) as {files:{name:string;sha256:string;bytes:number}[];captures:number;chainHead:string;verification:{valid:boolean}};
  expect(manifest.files.map(file=>file.name).sort()).toEqual(['access-log.csv','captures.csv','captures.json','findings.csv','findings.json','summary.pdf','verification.json']);
  for(const file of manifest.files){
   const bytes=await zip.file(file.name)!.async('uint8array');
   expect(file.sha256,file.name).toBe(sha(bytes));expect(file.bytes,file.name).toBe(bytes.byteLength);
  }
  const captures=JSON.parse(await zip.file('captures.json')!.async('string')) as {seq:number;chainHash:string}[];
  const stored=await capturesOf(f.hr,b.companyId);
  expect(captures.map(item=>[item.seq,item.chainHash])).toEqual(stored.map(row=>[row.seq,row.chainHash]));
  expect(manifest).toMatchObject({captures:stored.length,chainHead:stored.at(-1)!.chainHash,verification:{valid:true}});
  const findings=JSON.parse(await zip.file('findings.json')!.async('string')) as {controlId:string}[];
  // Each of the three people has no attendance recorded, one person processed and closed, and A and C share an account.
  expect(findings.map(item=>item.controlId).sort()).toEqual(['pay_without_attendance','pay_without_attendance','pay_without_attendance','preparer_closed_run','shared_bank_account']);
  expect(new TextDecoder().decode((await zip.file('summary.pdf')!.async('uint8array')).slice(0,5))).toBe('%PDF-');
  expect(await zip.file('verification.json')!.async('string')).toContain('"valid": true');
 });
});

describe('role access and isolation',()=>{
 it('reads nothing for another company\'s administrator, an employee or another tenant; an auditor reads only with a grant',async()=>{
  const f=await fixture();
  await capturePayrollPeriod(f.hr,{companyId:b.companyId,payPeriod:PERIOD});
  await runControlChecks(f.hr,{companyId:b.companyId,payPeriod:PERIOD});
  const other=await adminLogin(b,[{role:'hr_admin',companyId:f.co2}]);
  expect(await capturesOf(other,b.companyId)).toEqual([]);
  expect(await findingsOf(other,b.companyId)).toEqual([]);
  await expect(capturePayrollPeriod(other,{companyId:b.companyId,payPeriod:PERIOD})).rejects.toMatchObject({reason:'not_administrator'});
  expect((await auditLoopSummary(other,{payPeriod:PERIOD})).companies.map(item=>item.companyId)).toEqual([f.co2]);
  const employee={tenantId:b.tenantId,userId:(await adminLogin(b,[{role:'employee',companyId:null}])).userId,roles:['employee'],grants:[{role:'employee',companyId:null}],
   entitlements:f.hr.entitlements} as SessionContext;
  expect(await capturesOf(employee,b.companyId)).toEqual([]);
  await expect(auditLoopSummary(employee,{payPeriod:PERIOD})).rejects.toMatchObject({reason:'not_administrator'});
  const b2=await seedBase();
  const stranger={...await entitledCtx(b2),grants:[{role:'hr_admin',companyId:null}]} as SessionContext;
  expect(await withTenant(stranger,tx=>tx.select().from(payrollAuditCapture))).toEqual([]);
  // The auditor: no grant, no pack; with a grant from a company administrator, the pack, and still no disposition.
  const auditor=await adminLogin(b,[{role:'employee',companyId:null}]);
  await expect(buildAuditPack(auditor,{companyId:b.companyId,payPeriod:PERIOD},LABELS)).rejects.toBeInstanceOf(AuditPackRefused);
  await expect(grantAuditReader(f.hr,{companyId:b.companyId,appUserId:f.hr.userId})).rejects.toMatchObject({reason:'invalid'});
  await grantAuditReader(f.hr,{companyId:b.companyId,appUserId:auditor.userId});
  const pack=await buildAuditPack(auditor,{companyId:b.companyId,payPeriod:PERIOD},LABELS);
  expect(pack.captures).toBe((await capturesOf(f.hr,b.companyId)).length);
  expect(pack.verification.anchors.visible).toBe(false);
  expect(await capturesOf(auditor,f.co2)).toEqual([]);
  const finding=(await findingsOf(auditor,b.companyId))[0];
  await expect(disposeFinding(auditor,{findingId:finding.id,disposition:'expected',note:'Auditor note'})).rejects.toBeInstanceOf(AuditFindingRefused);
 });
});

describe('the daily loop',()=>{
 it('is off by default, runs as the agent principal under its sponsor when on, honours a pause and records each run',async()=>{
  const f=await fixture();
  const principalId=await ensureAgentPrincipal(owner.db,b.tenantId);
  const options=async()=>({tenantId:b.tenantId,principalId,entitlements:(await entitledCtx(b)).entitlements!,today:TODAY});
  expect(await runPayrollAuditLoop(await options())).toEqual({workerId:'loop_payroll_audit',status:'not_run',reasons:['switched_off']});
  // Only the inputs snapshot the processing owner took: the loop itself captured nothing while off.
  expect((await capturesOf(f.hr,b.companyId)).map(row=>row.sourceKey)).toEqual(['inputs:'+f.batch1]);
  await setWorkerSwitch(f.group,{workerId:'loop_payroll_audit',enabled:true});
  const ran=await runPayrollAuditLoop(await options());
  expect(ran).toMatchObject({workerId:'loop_payroll_audit',status:'ran',companies:2,failed:0});
  const rows=(await capturesOf(f.hr,b.companyId)).filter(row=>row.sourceKey!=='inputs:'+f.batch1);
  expect(rows.length).toBeGreaterThan(0);
  for(const row of rows)expect([row.writer,row.writerId]).toEqual(['agent',principalId]);
  const found=await findingsOf(f.hr,b.companyId);
  expect(found.map(row=>row.controlId).sort()).toEqual(['pay_without_attendance','pay_without_attendance','pay_without_attendance','preparer_closed_run','shared_bank_account']);
  for(const row of found)expect([row.writer,row.writerId]).toEqual(['agent',principalId]);
  const runs=await withTenant(f.group,tx=>tx.select().from(terasLoopRun).where(eq(terasLoopRun.workerId,'loop_payroll_audit')));
  expect(runs.map(run=>[run.companyId,run.status,run.sponsorUserId]).sort()).toEqual([[b.companyId,'ran',f.group.userId],[f.co2,'ran',f.group.userId]].sort());
  expect(runs.find(run=>run.companyId===b.companyId)).toMatchObject({opened:5,openNow:5});
  expect(runs.find(run=>run.companyId===f.co2)).toMatchObject({opened:1,openNow:1});
  // The per-company pause stops it there; the database refuses an agent capture for a paused company.
  await setLoopPause(f.group,{workerId:'loop_payroll_audit',companyId:b.companyId,paused:true});
  expect(await runPayrollAuditLoop(await options())).toMatchObject({status:'ran',companies:1});
  // Nothing in either run reached a model, filed anything or changed a run.
  const [run1]=await owner.db.select({status:schema.payrollBatch.status}).from(schema.payrollBatch).where(eq(schema.payrollBatch.id,f.batch1));
  expect(run1.status).toBe('closed');
  // The collector itself is read-only: it writes nothing.
  const before=(await capturesOf(f.hr,b.companyId)).length;
  await withTenant(f.hr,tx=>collectPayrollPeriodArtefactsTx(tx,f.hr,{companyId:b.companyId,payPeriod:PERIOD}));
  expect((await capturesOf(f.hr,b.companyId)).length).toBe(before);
 });
});

describe('the status read',()=>{
 it('counts payslips, statutory files against their due date, findings and repeat issues, from their owners',async()=>{
  const f=await fixture();
  await runControlChecks(f.hr,{companyId:b.companyId,payPeriod:PERIOD});
  const summary=await auditLoopSummary(f.hr,{payPeriod:PERIOD});
  expect(summary).toMatchObject({payPeriod:PERIOD,dueDate:'2026-02-15',level:'prepare',loop:{on:false,sponsorUserId:null}});
  const one=summary.companies.find(item=>item.companyId===b.companyId)!;
  expect(one.payslips).toEqual({total:3,released:3,opened:0});
  expect(one.statutory.map(form=>[form.form,form.prepared,form.filed])).toEqual([['epf',false,false],['socso_eis',false,false],['pcb_cp39',false,false],['hrd',false,false]]);
  expect(one.findings).toEqual({open:5,disposed:0});
  expect(one.repeatIssues).toEqual([]);
  expect(one.done).toBe(false);
  expect(summary.totals).toMatchObject({payslips:4,released:4,forms:8,formsFiled:0,openFindings:5});
 });
});

describe('the inputs snapshot, taken when the run is processed',()=>{
 it('is written in the processing transaction, and a later change to an input does not alter it',async()=>{
  const f=await fixture();
  const taken=(await capturesOf(f.hr,b.companyId)).filter(row=>row.sourceKey==='inputs:'+f.batch1);
  expect(taken).toHaveLength(1);
  expect([taken[0].writer,taken[0].writerId,taken[0].batchId]).toEqual(['user',f.hr.userId,f.batch1]);
  const snap=taken[0].content as {basis:string;trigger:string;processedBy:string;employments:number;components:Record<string,{rows:number;hash:string}>;results:{rows:number;hash:string}};
  expect(snap).toMatchObject({basis:'processed',trigger:'processed',processedBy:f.hr.userId,employments:3,results:{rows:3}});
  expect(Object.keys(snap.components).sort()).toEqual([...INPUT_COMPONENTS].sort());
  // No attendance was recorded in January when the run was processed: no rows, and the sha256 of an empty list.
  expect(snap.components.attendance).toEqual({rows:0,hash:sha('[]')});
  // Company 2's run has its own snapshot, by the same administrator who processed it.
  expect((await capturesOf(f.hr,f.co2)).filter(row=>row.sourceKey==='inputs:'+f.batch2).map(row=>[row.writer,row.writerId])).toEqual([['user',f.hr.userId]]);
  // An input changes after processing: A's attendance on 5 January is recorded late.
  await tamper(sql`insert into public.attendance(tenant_id,employment_id,attendance_date,status,day_type,worked_minutes) values (${b.tenantId}::uuid,${f.a.employmentId}::uuid,'2026-01-05','present','workday',480)`);
  await capturePayrollPeriod(f.hr,{companyId:b.companyId,payPeriod:PERIOD});
  const after=await capturesOf(f.hr,b.companyId);
  // The snapshot of the run is the same row with the same hashes: what the run used.
  expect(after.filter(row=>row.sourceKey==='inputs:'+f.batch1)).toEqual(taken);
  // The capture of the inputs now shows the change against it.
  const now=after.find(row=>row.sourceKey==='inputs_now:'+f.batch1)!.content as {components:Record<string,{rows:number;hash:string}>;processedSnapshot:{changedSinceProcessing:string[]}};
  expect(now.components.attendance.rows).toBe(1);
  expect(now.components.attendance.hash).not.toBe(snap.components.attendance.hash);
  expect(now.processedSnapshot.changedSinceProcessing).toContain('attendance');
  expect((await verify(f.hr,b.companyId)).valid).toBe(true);
 });

 it('never stops the run: a snapshot that cannot be written leaves the transaction usable and records the miss',async()=>{
  const f=await fixture();
  const windows={attendance:{start:'2026-01-01',end:'2026-01-31'},overtime:{start:'2026-01-01',end:'2026-01-31'},leave:{start:'2026-01-01',end:'2026-01-31'},
   claim:{start:'2026-01-01',end:'2026-01-31'}};
  const employee=await adminLogin(b,[{role:'employee',companyId:null}]);
  const refused=await withTenant(employee,async tx=>{
   const ok=await captureRunInputsAtProcessingTx(tx,employee,{batchId:f.batch1,companyId:b.companyId,payPeriod:PERIOD,windows,trigger:'processed'});
   const [still]=await tx.execute(sql`select 1 as one`) as unknown as {one:number}[];
   return {ok,still:Number(still?.one)};
  });
  expect(refused).toEqual({ok:false,still:1});
  const loginless={tenantId:b.tenantId,roles:['hr_admin'],entitlements:f.hr.entitlements} as SessionContext;
  expect(await withTenant(loginless,tx=>captureRunInputsAtProcessingTx(tx,loginless,{batchId:f.batch1,companyId:b.companyId,payPeriod:PERIOD,windows,trigger:'processed'}))).toBe(false);
  const misses=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,b.tenantId),eq(schema.domainEvent.eventType,'payroll-audit.inputs-not-captured')))
   .orderBy(schema.domainEvent.sequence);
  expect(misses.map(event=>[event.actorId,(event.payload as {reason:string}).reason,(event.payload as {batchId:string}).batchId])).toEqual([
   [employee.userId,'not_written',f.batch1],[null,'no_login',f.batch1]]);
  // The run's own snapshot is untouched by either attempt.
  expect((await capturesOf(f.hr,b.companyId)).filter(row=>row.sourceKey==='inputs:'+f.batch1)).toHaveLength(1);
 });
});

describe('the administration of the Audit loop',()=>{
 it('shows each company\'s settings and auditors to its administrators, and never to an employee or a manager',async()=>{
  const f=await fixture();
  const auditor=await adminLogin(b,[{role:'employee',companyId:null}]);
  const view=await auditAdministration(f.hr);
  expect(view.companies.map(item=>[item.companyName,item.settings])).toEqual([['Acme Sdn Bhd',{bankChangeDays:7,adjustmentThreshold:1000,version:null}],
   ['Fictional Two Sdn Bhd',{bankChangeDays:7,adjustmentThreshold:1000,version:null}]]);
  expect(view.candidates.map(item=>item.appUserId)).toContain(auditor.userId);
  expect(view.candidates.map(item=>item.appUserId)).not.toContain(f.hr.userId);
  const grant=await grantAuditReader(f.hr,{companyId:b.companyId,appUserId:auditor.userId});
  // Granting twice keeps the one current grant.
  expect((await grantAuditReader(f.hr,{companyId:b.companyId,appUserId:auditor.userId})).id).toBe(grant.id);
  expect((await auditAdministration(f.hr,{companyIds:[b.companyId]})).companies[0].readers.map(item=>item.appUserId)).toEqual([auditor.userId]);
  await revokeAuditReader(f.hr,{grantId:grant.id});
  expect((await auditAdministration(f.hr,{companyIds:[b.companyId]})).companies[0].readers).toEqual([]);
  await expect(revokeAuditReader(f.hr,{grantId:grant.id})).rejects.toMatchObject({reason:'not_found'});
  const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,b.tenantId),eq(schema.domainEvent.aggregateType,'payroll-audit-reader')))
   .orderBy(schema.domainEvent.sequence);
  expect(events.map(event=>[event.eventType,event.actorId,(event.payload as {appUserId:string}).appUserId])).toEqual([
   ['payroll-audit.reader-granted',f.hr.userId,auditor.userId],['payroll-audit.reader-revoked',f.hr.userId,auditor.userId]]);
  // A revoked grant is never rewritten or deleted, even by the owner role with the policies bypassed.
  await expect(owner.db.execute(sql`delete from public.payroll_audit_reader where id=${grant.id}::uuid`)).rejects.toThrow();
  // Employees and managers are refused every part of it.
  const manager=await adminLogin(b,[{role:'manager',companyId:null}]);
  for(const person of [auditor,manager]){
   await expect(auditAdministration(person)).rejects.toMatchObject({reason:'not_administrator'});
   await expect(grantAuditReader(person,{companyId:b.companyId,appUserId:f.group.userId})).rejects.toMatchObject({reason:'not_administrator'});
   await expect(setControlSettings(person,{companyId:b.companyId,bankChangeDays:3,adjustmentThreshold:500})).rejects.toMatchObject({reason:'not_administrator'});
  }
  // An administrator of the other company sees only that company, and cannot grant here.
  const other=await adminLogin(b,[{role:'hr_admin',companyId:f.co2}]);
  expect((await auditAdministration(other)).companies.map(item=>item.companyId)).toEqual([f.co2]);
  await expect(grantAuditReader(other,{companyId:b.companyId,appUserId:auditor.userId})).rejects.toMatchObject({reason:'not_administrator'});
 });
});

/** The text a PDF actually draws, decoded through whichever font drew each run (test/payslip-pdf-unicode.test.ts's instrument). */
async function pdfText(bytes:Uint8Array):Promise<string>{
 const bfMap=(cmap:string)=>{const map=new Map<number,string>();const utf16=(hex:string)=>{const buf=Buffer.from(hex,'hex');let out='';for(let i=0;i+1<buf.length;i+=2)out+=String.fromCharCode(buf.readUInt16BE(i));return out;};
  for(const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))for(const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g))map.set(parseInt(m[1],16),utf16(m[2]));
  for(const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))for(const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)){
   const lo=parseInt(m[1],16),hi=parseInt(m[2],16),dst=parseInt(m[3],16);for(let c=lo;c<=hi;c++)map.set(c,String.fromCodePoint(dst+(c-lo)));}
  return map;};
 const doc=await PDFDocument.load(bytes);const out:string[]=[];
 for(const page of doc.getPages()){
  const fonts=new Map<string,{composite:boolean;toUnicode:Map<number,string>|null}>();
  const dict=page.node.Resources()?.lookup(PDFName.of('Font'),PDFDict);
  for(const [key,ref] of dict?.entries()??[]){const fd=page.node.context.lookup(ref,PDFDict);const tu=fd.get(PDFName.of('ToUnicode'));const stream=tu?page.node.context.lookup(tu):null;
   fonts.set(key.asString(),{composite:fd.get(PDFName.of('Subtype'))?.toString()==='/Type0',
    toUnicode:stream instanceof PDFRawStream?bfMap(Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')):null});}
  const contents=page.node.Contents();const streams=contents instanceof PDFArray?contents.asArray().map(r=>page.node.context.lookup(r)):[contents];
  let src='';for(const st of streams)if(st instanceof PDFRawStream)src+=Buffer.from(decodePDFRawStream(st).decode()).toString('latin1');
  let cur:{composite:boolean;toUnicode:Map<number,string>|null}|null=null;
  for(const m of src.matchAll(/(\/[A-Za-z0-9#+._-]+)\s+([\d.]+)\s+Tf|<([0-9A-Fa-f\s]*)>\s*Tj|\(((?:\\.|[^\\()])*)\)\s*Tj/g)){
   if(m[1]!=null)cur=fonts.get(m[1])??null;
   else if(m[3]!=null){const hex=m[3].replace(/\s+/g,'');
    if(cur?.composite){let text='';for(let i=0;i+4<=hex.length;i+=4)text+=cur.toUnicode?.get(parseInt(hex.slice(i,i+4),16))??'\uFFFD';out.push(text);}
    else out.push(Buffer.from(hex,'hex').toString('latin1'));}
   else if(m[4]!=null)out.push(m[4].replace(/\\([()\\])/g,'$1'));
  }
 }
 return out.join('\n');
}

describe('the audit pack summary in every script',()=>{
 it('draws a Chinese, a Tamil and a Thai name, each whole, and counts nothing as undrawable',async()=>{
  const f=await fixture();
  for(const [personId,name] of [[f.a.personId,'陈伟明'],[f.bb.personId,'முருகன்'],[f.c.personId,'สมชาย']] as const)
   await tamper(sql`update public.person set full_name=${name} where id=${personId}::uuid`);
  // Each of the three has a finding (no attendance recorded), so each is named on the summary.
  await runControlChecks(f.hr,{companyId:b.companyId,payPeriod:PERIOD});
  const pack=await buildAuditPack(f.hr,{companyId:b.companyId,payPeriod:PERIOD},LABELS);
  const zip=await JSZip.loadAsync(pack.bytes);
  const text=await pdfText(await zip.file('summary.pdf')!.async('uint8array'));
  const runs=text.split('\n');
  for(const name of ['陈伟明','முருகன்','สมชาย'])expect(runs,name).toContain(name);
  expect(text).not.toContain('\uFFFD');
  expect(pack.unprintable).toBe(0);
  const manifest=JSON.parse(await zip.file('manifest.json')!.async('string')) as {summary:{unprintableCharacters:number}};
  expect(manifest.summary).toEqual({unprintableCharacters:0});
  // The evidence files carry the same names exactly.
  expect(await zip.file('captures.json')!.async('string')).not.toContain('\uFFFD');
 });
});
