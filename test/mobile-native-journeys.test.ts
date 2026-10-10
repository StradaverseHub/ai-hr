/** Real handlers + core + RLS. Only bearer session resolution is injected, as in mobile-api-routes.test.ts. */
import { randomUUID } from 'node:crypto';
import { and,eq,sql } from 'drizzle-orm';
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import sharp from 'sharp';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import { hireEmployee,setReportingLine } from '../core/org';
import { setAttendancePolicy,setAttendancePhotoSetting } from '../packs/attendance/service';
import { AuthRequiredError } from '../lib/auth-errors';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,type Base } from './harness';
let caller:SessionContext;
let blocked=false;
vi.mock('../lib/session',async original=>({...await original<typeof import('../lib/session')>(),getMobileSession:async()=>{if(blocked)throw new AuthRequiredError('revoked');return caller;}}));
const clock=await import('../app/api/mobile/v1/clock/route');
const device=await import('../app/api/mobile/v1/clock-device/route');
const leave=await import('../app/api/mobile/v1/leave-requests/route');
const options=await import('../app/api/mobile/v1/leave-options/route');
const preview=await import('../app/api/mobile/v1/leave-preview/route');
const team=await import('../app/api/mobile/v1/team/route');
let base:Base;
const today=()=>todayInKualaLumpur();
function nextMonday(){const d=new Date(today()+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+((8-d.getUTCDay())%7||7));return d.toISOString().slice(0,10);}
async function hire(name:string,b=base,role:'employee'|'manager'|'hr_admin'='employee',departmentId=b.deptA){
  const e=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@native.test'},companyId:b.companyId,departmentId,employmentType:'full_time',hiredOn:`${Number(today().slice(0,4))-1}-01-01`});
  const userId=await createAppUser(b.tenantId,e.personId,role);
  const ctx:SessionContext={tenantId:b.tenantId,userId,personId:e.personId,roles:[role],grants:[{role,companyId:b.companyId}],entitlements:harnessSnapshot(b.tenantId)};
  return {...e,ctx};
}
async function fund(e:string){await seedEntitlement(adminCtx(base),{leaveTypeId:base.annualLeaveTypeId,annualDays:30,validFrom:today().slice(0,4)+'-01-01'});await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:e,leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'30',effectiveOn:today().slice(0,4)+'-01-01'});}
const intent=()=>({action:'in',requestId:randomUUID(),lat:3,lng:101,accuracy:5,sampledAt:Date.now()});
const application=()=>({requestId:randomUUID(),leaveTypeId:base.annualLeaveTypeId,startDate:nextMonday(),endDate:nextMonday(),durationType:'full_day',reason:'Native request'});
async function call(fn:(r:Request)=>Promise<Response>,path:string,body?:unknown,file?:Blob){
  const form=body===undefined?undefined:new FormData();if(form){form.set('command',JSON.stringify(body));if(file)form.set(path==='clock'?'photo':'document',file,path==='clock'?'photo.jpg':'medical.pdf');}
  const response=await fn(new Request(`https://hr.example.com/api/mobile/v1/${path}`,form?{method:'POST',body:form}:undefined));
  return {status:response.status,headers:response.headers,body:await response.json()};
}
const register=async()=>device.POST(new Request('https://hr.example.com/api/mobile/v1/clock-device',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label:'Native test phone'})}));
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();base=await seedBase();blocked=false;});afterAll(closeAll);

describe('native online attendance',()=>{
  it('enforces device policy, stores device attribution and refuses a revoked-device replay',async()=>{
    const a=await hire('Native Clock');caller=a.ctx;
    await setAttendancePolicy(adminCtx(base),{companyId:base.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:05',halfDayBefore:'13:00',workingDays:[1,2,3,4,5],requireRegisteredDevice:true});
    expect((await call(clock.GET,'clock')).body.state.deviceRequired).toBe(true);
    expect((await call(clock.POST,'clock',intent())).body).toEqual({outcome:'refused',code:'device_required'});
    expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(0);
    const d=await(await register()).json();const command={...intent(),deviceToken:d.deviceToken};
    const first=await call(clock.POST,'clock',command);expect(first.body.outcome).toBe('accepted');
    const replay=await call(clock.POST,'clock',command);expect(replay.body).toEqual(first.body);
    const rows=await owner.db.select().from(schema.attendanceClockCapture);expect(rows).toHaveLength(1);expect(rows[0].deviceId).toBe(d.deviceId);
    await owner.db.update(schema.employeeDevice).set({revokedAt:new Date()}).where(eq(schema.employeeDevice.id,d.deviceId));
    expect((await call(clock.POST,'clock',command)).body).toEqual({outcome:'refused',code:'device_required'});
    const wire=JSON.stringify((await call(clock.GET,'clock')).body);expect(wire).not.toContain(d.deviceToken);expect(wire).not.toContain('photoBytes');
  });
  it('photo policy is re-read at submit and malformed photos have a safe refusal',async()=>{
    const a=await hire('Native Photo');caller=a.ctx;
    await setAttendancePhotoSetting(adminCtx(base),{employmentId:a.employmentId,setting:'required'});
    expect((await call(clock.POST,'clock',intent())).body.code).toBe('photo_required');
    expect((await call(clock.POST,'clock',intent(),new Blob(['bad'],{type:'image/jpeg'}))).body.code).toBe('photo_invalid');
    const bytes=await sharp({create:{width:20,height:20,channels:3,background:'#123456'}}).jpeg().toBuffer();
    const accepted=await call(clock.POST,'clock',intent(),new Blob([new Uint8Array(bytes)],{type:'image/jpeg'}));expect(accepted.body.receipt.photoAvailable).toBe(true);
    expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(1);
  });
  it('freshness, forged identity/policy keys and duplicate multipart fields cannot write',async()=>{
    const a=await hire('Native Strict');caller=a.ctx;
    expect((await call(clock.POST,'clock',{...intent(),sampledAt:Date.now()-180000})).body.code).toBe('location_required');
    for(const extra of [{employmentId:a.employmentId},{deviceGateExempt:true},{tenantId:base.tenantId},{hasDocument:true}])expect((await call(clock.POST,'clock',{...intent(),...extra})).status).toBe(400);
    const form=new FormData();form.append('command',JSON.stringify(intent()));form.append('command',JSON.stringify(intent()));
    expect((await clock.POST(new Request('https://hr.example.com/api/mobile/v1/clock',{method:'POST',body:form}))).status).toBe(400);
    expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(0);
  });
  it('concurrent identical requests record one punch and altered replays refuse',async()=>{
    const a=await hire('Concurrent Native');caller=a.ctx;const command=intent();
    const results=await Promise.all([call(clock.POST,'clock',command),call(clock.POST,'clock',command)]);
    expect(results[0].body).toEqual(results[1].body);expect(results[0].body.outcome).toBe('accepted');
    expect((await call(clock.POST,'clock',{...command,lat:4})).body.code).toBe('clock_conflict');
    expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(1);
  });
});

describe('native leave submission and receipts',()=>{
  it('creates the request, document and receipt together; concurrent replay cannot duplicate any of them',async()=>{
    const a=await hire('Native Leave');caller=a.ctx;await fund(a.employmentId);
    await owner.db.update(schema.leaveType).set({requiresDocument:true,allowedMimeTypes:['application/pdf'],maxDocBytes:1000}).where(eq(schema.leaveType.id,base.annualLeaveTypeId));
    const command=application(),file=new Blob(['%PDF-1.7 native medical document'],{type:'application/pdf'});
    const [first,replay]=await Promise.all([call(leave.POST,'leave-requests',command,file),call(leave.POST,'leave-requests',command,file)]);
    expect(first.body.outcome).toBe('accepted');expect(replay.body).toEqual(first.body);
    expect(await owner.db.select().from(schema.leaveRequest)).toHaveLength(1);expect(await owner.db.select().from(schema.leaveRequestAttachment)).toHaveLength(1);
    const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'mobile.leave.submitted'));expect(events).toHaveLength(1);
    expect((await call(leave.POST,'leave-requests',{...command,reason:'Changed'},file)).body.outcome).toBe('refused');
    const history=await call(leave.GET,'leave-requests');expect(history.body.items).toHaveLength(1);expect(history.body.items[0].id).toBe(first.body.id);
  });
  it('conversion previews name the configured target; split children retain the uploaded document atomically',async()=>{
    const a=await hire('Converted Native');caller=a.ctx;await fund(a.employmentId);
    const [emergency]=await owner.db.insert(schema.leaveType).values({tenantId:base.tenantId,code:'EL',role:'emergency',name:'Emergency absence',paid:true,counting:'working_days'}).returning();
    await owner.db.insert(schema.leaveType).values({tenantId:base.tenantId,code:'UNPAID',name:'Unpaid',paid:false,counting:'calendar_days'});
    await owner.db.update(schema.leaveType).set({minAdvanceDays:30,overrideRules:[{trigger:'advance_notice_not_met',action:'convert_to_emergency',enabled:true,targetLeaveTypeId:emergency.id}]}).where(eq(schema.leaveType.id,base.annualLeaveTypeId));
    const command={...application(),overrideConsent:['advance_notice_not_met:convert_to_emergency']};
    const response=await preview.POST(new Request('https://hr.example.com/api/mobile/v1/leave-preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(command)}));
    expect((await response.json()).overrides).toEqual([expect.objectContaining({toTypeName:'Emergency absence'})]);
    const first=await call(leave.POST,'leave-requests',command,new Blob(['%PDF-1.7 evidence'],{type:'application/pdf'}));expect(first.body.outcome).toBe('accepted');
    const attachments=await owner.db.select().from(schema.leaveRequestAttachment);expect(attachments).toHaveLength(1);expect(attachments[0].leaveRequestId).toBe(first.body.id);
    expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'mobile.leave.submitted'))).toHaveLength(1);
  });
  it('bad or missing mandatory documents leave no request, attachment or command receipt',async()=>{
    const a=await hire('Atomic Doc');caller=a.ctx;await fund(a.employmentId);
    await owner.db.update(schema.leaveType).set({requiresDocument:true,allowedMimeTypes:['application/pdf'],maxDocBytes:10}).where(eq(schema.leaveType.id,base.annualLeaveTypeId));
    expect((await call(leave.POST,'leave-requests',application())).body.outcome).toBe('refused');
    expect((await call(leave.POST,'leave-requests',application(),new Blob(['%PDF-1.7 '+ 'x'.repeat(100)],{type:'application/pdf'}))).body.outcome).toBe('refused');
    expect(await owner.db.select().from(schema.leaveRequest)).toHaveLength(0);expect(await owner.db.select().from(schema.leaveRequestAttachment)).toHaveLength(0);
    expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'mobile.leave.submitted'))).toHaveLength(0);
  });
  it('a receipt write failure rolls back the leave request too and leaks no SQL',async()=>{
    const a=await hire('Atomic Receipt');caller=a.ctx;await fund(a.employmentId);
    await owner.db.execute(sql`CREATE FUNCTION native_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='mobile.leave.submitted' THEN RAISE EXCEPTION 'SECRET receipt SQL fault'; END IF; RETURN NEW; END $$`);
    await owner.db.execute(sql`CREATE TRIGGER native_receipt_fault BEFORE INSERT ON domain_event FOR EACH ROW EXECUTE FUNCTION native_receipt_fault()`);
    try{const result=await call(leave.POST,'leave-requests',application());expect(result.status).toBe(500);expect(result.body).toEqual({error:'internal'});expect(await owner.db.select().from(schema.leaveRequest)).toHaveLength(0);}
    finally{await owner.db.execute(sql`DROP TRIGGER native_receipt_fault ON domain_event`);await owner.db.execute(sql`DROP FUNCTION native_receipt_fault()`);}
  });
  it('strict submissions never trust hasDocument or another employment; hidden types cannot be previewed',async()=>{
    const a=await hire('Native Owner'),peer=await hire('Native Peer');caller=a.ctx;
    expect((await call(leave.POST,'leave-requests',{...application(),hasDocument:true})).status).toBe(400);
    expect((await call(leave.POST,`leave-requests?employmentId=${peer.employmentId}`,application())).status).toBe(400);
    const [hidden]=await owner.db.insert(schema.leaveType).values({tenantId:base.tenantId,code:'PRIVATE_NATIVE',name:'Hidden secret type',paid:true,counting:'calendar_days',visibleToEmployee:false}).returning({id:schema.leaveType.id});
    expect(JSON.stringify((await call(options.GET,'leave-options')).body)).not.toContain(hidden.id);
    expect((await call(leave.POST,'leave-requests',{...application(),leaveTypeId:hidden.id})).status).toBe(400);
    const response=await preview.POST(new Request('https://hr.example.com/api/mobile/v1/leave-preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...application(),leaveTypeId:hidden.id})}));expect(response.status).toBe(400);
  });
});

describe('native subjects, teams and bearer boundary',()=>{
  it('an employed administrator cannot select a peer or a foreign tenant even though RLS grants visibility',async()=>{
    const a=await hire('Native Admin',base,'hr_admin'),peer=await hire('Visible Peer'),foreign=await hire('Foreign Native',await seedBase());caller=a.ctx;
    for(const id of [peer.employmentId,foreign.employmentId])for(const [handler,path] of [[clock.GET,'clock'],[leave.GET,'leave-requests'],[options.GET,'leave-options']] as const)expect((await call(handler,`${path}?employmentId=${id}`)).status).toBe(400);
    expect((await call(clock.GET,'clock')).body.employmentId).toBe(a.employmentId);
    const aWire=JSON.stringify((await call(leave.GET,'leave-requests')).body);expect(aWire).not.toContain(foreign.employmentId);
  });
  it('My Team scope governs availability and employees cannot widen it with query parameters',async()=>{
    const manager=await hire('Manager',base,'manager'),report=await hire('Direct Report'),peer=await hire('Other Department Peer',base,'employee',base.deptB);
    await setReportingLine(adminCtx(base),{subordinateEmploymentId:report.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:today()});
    const [request]=await owner.db.insert(schema.leaveRequest).values({tenantId:base.tenantId,employmentId:report.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:today(),endDate:today(),days:'1',status:'approved'}).returning();
    await owner.db.insert(schema.leaveRequestDate).values({tenantId:base.tenantId,leaveRequestId:request.id,subjectEmploymentId:report.employmentId,leaveDate:today(),days:'1',status:'approved'});
    caller=manager.ctx;const result=await call(team.GET,'team');expect(result.body.enabled).toBe(true);expect(result.body.items.map((r:{employmentId:string})=>r.employmentId)).toContain(report.employmentId);expect(result.body.items.map((r:{employmentId:string})=>r.employmentId)).not.toContain(peer.employmentId);
    const subject=result.body.items.find((r:{employmentId:string})=>r.employmentId===report.employmentId);expect(subject.dates).toEqual([expect.objectContaining({date:today(),status:'approved'})]);
    caller=report.ctx;expect((await call(team.GET,`team?scope=all&employmentId=${peer.employmentId}`)).body).toMatchObject({enabled:false,items:[]});
  });
  it('revoked/offboarded bearer resolution refuses reads and writes before mutation or cookie fallback',async()=>{
    const a=await hire('Offboarded Native');caller=a.ctx;blocked=true;
    for(const [handler,path] of [[clock.GET,'clock'],[leave.GET,'leave-requests'],[options.GET,'leave-options'],[team.GET,'team'],[clock.POST,'clock'],[leave.POST,'leave-requests'],[device.POST,'clock-device']] as const){const r=await handler(new Request('https://hr.example.com/api/mobile/v1/'+path,{headers:{cookie:'dev_user=admin'}}));expect(r.status).toBe(401);expect(r.headers.get('cache-control')).toBe('no-store');}
    expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(0);expect(await owner.db.select().from(schema.leaveRequest)).toHaveLength(0);
  });
});
