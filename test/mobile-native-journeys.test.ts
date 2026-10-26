/** Real handlers + core + RLS. Only bearer session resolution is injected, as in mobile-api-routes.test.ts. */
import { randomUUID } from 'node:crypto';
import { and,eq,sql } from 'drizzle-orm';
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import sharp from 'sharp';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import { hireEmployee,setReportingLine } from '../core/org';
import { setAttendancePolicy,setAttendancePhotoSetting,createClockingLocation,setClockingControl } from '../packs/attendance/service';
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
const receipts=await import('../app/api/mobile/v1/submission-receipt/route');
const abandonment=await import('../app/api/mobile/v1/submission-abandon/route');
const clockLocation=await import('../app/api/mobile/v1/clock-location/route');
const attempts=await import('../app/api/mobile/v1/clock-attempts/route');
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
async function abandon(kind:string,requestId:string,employmentId?:string,extra:Record<string,unknown>={}){
  const r=await abandonment.POST(new Request('https://hr.example.com/api/mobile/v1/submission-abandon'+(employmentId?'?employmentId='+employmentId:''),{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind,requestId,...extra}),
  }));return {status:r.status,body:await r.json()};
}
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();base=await seedBase();blocked=false;});afterAll(closeAll);

describe('reported clock attempts are separate from attendance',()=>{
  async function report(body:unknown,employmentId?:string){
    const response=await attempts.POST(new Request('https://hr.example.com/api/mobile/v1/clock-attempts'+(employmentId?'?employmentId='+employmentId:''),{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
    }));return {status:response.status,headers:response.headers,body:await response.json()};
  }
  it('records one minimal immutable attempt under concurrent retries without any punch or clock receipt',async()=>{
    const a=await hire('Reported Attempt');caller=a.ctx;
    const command={requestId:randomUUID(),action:'in',claimedAt:Date.now()-86400000};
    const [first,second]=await Promise.all([report(command),report(command)]);
    expect(first.status).toBe(200);expect(second.body).toEqual(first.body);expect(first.headers.get('cache-control')).toBe('no-store');
    expect(first.body).toEqual({requestId:command.requestId,receivedAt:expect.any(String)});
    expect(new Date(first.body.receivedAt).getTime()).toBeGreaterThan(command.claimedAt);
    const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'mobile.clock.attempt.reported'));
    expect(events).toHaveLength(1);expect(events[0]).toMatchObject({actorId:a.ctx.userId,subjectEmploymentId:a.employmentId,payload:command});
    expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(0);expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(0);
    expect(await owner.db.select().from(schema.attendance)).toHaveLength(0);
    expect((await call(receipts.GET,`submission-receipt?kind=clock&requestId=${command.requestId}`)).body.receipt).toBeNull();
    expect((await call(clock.GET,'clock')).body.state.clockedIn).toBe(false);
    expect((await report({...command,claimedAt:command.claimedAt+1})).status).toBe(400);
    expect((await report({...command,action:'out'})).status).toBe(400);
  });
  it('does not let an attempt report bypass server-ordered abandonment',async()=>{
    const a=await hire('Abandoned Attempt');caller=a.ctx;const command=intent();
    expect((await abandon('clock',command.requestId)).body.abandoned).toBe(true);
    expect((await report({requestId:command.requestId,action:command.action,claimedAt:Date.now()})).status).toBe(200);
    expect((await call(clock.POST,'clock',command)).body).toEqual({outcome:'refused',code:'clock_conflict'});
    expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(0);
  });
  it('refuses forged metadata, foreign employment and revoked sessions before reporting',async()=>{
    const a=await hire('Own Attempt'),peer=await hire('Peer Attempt');caller=a.ctx;
    const command={requestId:randomUUID(),action:'in',claimedAt:Date.now()};
    expect((await report(command,peer.employmentId)).status).toBe(400);
    for(const extra of [{employmentId:peer.employmentId},{actorId:peer.ctx.userId},{lat:3},{verified:true},{claimedAt:-1},{claimedAt:8640000000000001}])
      expect((await report({...command,...extra})).status).toBe(400);
    blocked=true;expect((await report(command)).status).toBe(401);
    expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'mobile.clock.attempt.reported'))).toHaveLength(0);
  });
});

describe('server-ordered pending submission abandonment',()=>{
  it('prevents late clock delivery after explicit discard and retains one minimal terminal audit',async()=>{
    const a=await hire('Discard Clock');caller=a.ctx;const command=intent();
    const first=await abandon('clock',command.requestId);
    expect(first).toEqual({status:200,body:{kind:'clock',requestId:command.requestId,receipt:null,abandoned:true}});
    expect(await abandon('clock',command.requestId)).toEqual(first);
    expect((await call(clock.POST,'clock',command)).body).toEqual({outcome:'refused',code:'clock_conflict'});
    expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(0);
    expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(0);
    const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'mobile.submission.abandoned'));
    expect(events).toHaveLength(1);expect(events[0]).toMatchObject({actorId:a.ctx.userId,subjectEmploymentId:a.employmentId,payload:{kind:'clock'}});
    expect((await call(receipts.GET,`submission-receipt?kind=clock&requestId=${command.requestId}`)).body.abandoned).toBe(true);
  });
  it('returns an already accepted clock receipt without removing or correcting attendance',async()=>{
    const a=await hire('Accepted Clock');caller=a.ctx;const command=intent(),accepted=await call(clock.POST,'clock',command);
    expect(accepted.body.outcome).toBe('accepted');
    expect((await abandon('clock',command.requestId)).body).toEqual({kind:'clock',requestId:command.requestId,receipt:accepted.body.receipt,abandoned:false});
    expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(1);
    expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(1);
    expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'mobile.submission.abandoned'))).toHaveLength(0);
  });
  it('does not claim abandonment when a retained capture has no attributable receipt',async()=>{
    const a=await hire('Unattributed Capture');caller=a.ctx;const command=intent();
    expect((await call(clock.POST,'clock',command)).body.outcome).toBe('accepted');
    const [recorded]=await owner.db.select().from(schema.attendanceClockCapture).where(and(eq(schema.attendanceClockCapture.employmentId,a.employmentId),eq(schema.attendanceClockCapture.requestId,command.requestId))).limit(1);
    const orphanId=randomUUID();await owner.db.insert(schema.attendanceClockCapture).values({...recorded,id:randomUUID(),requestId:orphanId});
    expect((await abandon('clock',orphanId)).status).toBe(500);
    expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'mobile.submission.abandoned'))).toHaveLength(0);
    expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(2);
  });
  it('prevents a discarded leave intent from creating a request or attachment',async()=>{
    const a=await hire('Discard Leave');caller=a.ctx;await fund(a.employmentId);const command=application();
    expect((await abandon('leave',command.requestId)).body.abandoned).toBe(true);
    expect((await call(leave.POST,'leave-requests',command)).body).toMatchObject({outcome:'refused',code:'leave_refused'});
    expect(await owner.db.select().from(schema.leaveRequest)).toHaveLength(0);
    expect(await owner.db.select().from(schema.leaveRequestAttachment)).toHaveLength(0);
    expect((await call(receipts.GET,`submission-receipt?kind=leave&requestId=${command.requestId}`)).body.abandoned).toBe(true);
  });
  it('returns accepted leave without withdrawing it or reversing its ledger',async()=>{
    const a=await hire('Accepted Leave');caller=a.ctx;await fund(a.employmentId);const command=application();
    const accepted=await call(leave.POST,'leave-requests',command);expect(accepted.body.outcome).toBe('accepted');
    const before=await owner.db.select().from(schema.leaveLedger).orderBy(schema.leaveLedger.id);
    expect((await abandon('leave',command.requestId)).body).toEqual({kind:'leave',requestId:command.requestId,receipt:accepted.body,abandoned:false});
    expect(await owner.db.select().from(schema.leaveRequest)).toHaveLength(1);
    expect(await owner.db.select().from(schema.leaveLedger).orderBy(schema.leaveLedger.id)).toEqual(before);
  });
  it.each(['clock','leave'] as const)('serializes a concurrent %s transmission and discard into one terminal outcome',async(kind)=>{
    const a=await hire('Concurrent Discard');caller=a.ctx;if(kind==='leave')await fund(a.employmentId);
    const command=kind==='clock'?intent():application();
    const [submission,discard]=await Promise.all([call(kind==='clock'?clock.POST:leave.POST,kind==='clock'?'clock':'leave-requests',command),abandon(kind,command.requestId)]);
    expect(discard.status).toBe(200);
    const facts=await owner.db.select().from(kind==='clock'?schema.attendanceClockCapture:schema.leaveRequest);
    if(discard.body.abandoned){expect(facts).toHaveLength(0);expect(submission.body.outcome).toBe('refused');}
    else{expect(facts).toHaveLength(1);expect(submission.body.outcome).toBe('accepted');expect(discard.body.receipt).toEqual(kind==='clock'?submission.body.receipt:submission.body);}
  });
  it('does not let another actor abandon the original intent, even with its guessed reference',async()=>{
    const a=await hire('Original Actor'),peer=await hire('Peer Actor'),command=intent();caller=peer.ctx;
    expect((await abandon('clock',command.requestId,a.employmentId)).status).toBe(400);
    expect((await abandon('clock',command.requestId,undefined,{actorId:a.ctx.userId})).status).toBe(400);
    expect((await abandon('clock',command.requestId)).body.abandoned).toBe(true);
    caller=a.ctx;expect((await call(clock.POST,'clock',command)).body.outcome).toBe('accepted');
    expect((await call(receipts.GET,`submission-receipt?kind=clock&requestId=${command.requestId}`)).body.abandoned).toBeUndefined();
  });
  it('refuses malformed selectors and revoked sessions without an abandonment write',async()=>{
    const a=await hire('Strict Discard');caller=a.ctx;
    expect((await abandon('clock','not-a-reference')).status).toBe(400);
    expect((await abandon('other',randomUUID())).status).toBe(400);
    blocked=true;expect((await abandon('leave',randomUUID())).status).toBe(401);
    expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'mobile.submission.abandoned'))).toHaveLength(0);
  });
});

describe('native online attendance',()=>{
  it('previews own location without writes and rechecks containment and company policy at submit',async()=>{
    const a=await hire('Native Quality');caller=a.ctx;
    const admin=adminCtx(base),site=await createClockingLocation(admin,{companyIds:[base.companyId],name:'Own office',lat:3,lng:101,radiusM:50});
    await setClockingControl(admin,{employmentId:a.employmentId,enabled:true,clockingLocationIds:[site.id]});
    const assess=async(accuracy:number)=>{
      const response=await clockLocation.POST(new Request('https://hr.example.com/api/mobile/v1/clock-location',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lat:3,lng:101,accuracy,sampledAt:Date.now()})}));
      expect(response.headers.get('cache-control')).toBe('no-store');return {status:response.status,body:await response.json()};
    };
    expect((await assess(5000)).body).toMatchObject({outcome:'outside_site',siteName:'Own office',radiusM:50,accuracyM:5000});
    expect((await call(clock.POST,'clock',{...intent(),accuracy:5000})).body).toMatchObject({outcome:'refused',code:'outside_geofence'});
    expect((await assess(5)).body.outcome).toBe('pass');
    await setAttendancePolicy(admin,{companyId:base.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:15',halfDayBefore:'13:00',workingDays:[1,2,3,4,5],geofenceMaximumAccuracyM:1});
    expect((await call(clock.POST,'clock',intent())).body).toMatchObject({outcome:'refused',code:'location_required'});
    expect((await assess(5)).body).toMatchObject({outcome:'poor_accuracy',maximumAccuracyM:1});
    expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(0);expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(0);
  });
  it('refuses foreign employment, forged preview fields and revoked preview sessions',async()=>{
    const a=await hire('Own Preview'),peer=await hire('Foreign Preview');caller=a.ctx;
    const assess=async(selector:string,extra:Record<string,unknown>={})=>clockLocation.POST(new Request('https://hr.example.com/api/mobile/v1/clock-location'+selector,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lat:3,lng:101,accuracy:5,sampledAt:Date.now(),...extra})}));
    expect((await assess('?employmentId='+peer.employmentId)).status).toBe(400);
    expect((await assess('',{employmentId:peer.employmentId})).status).toBe(400);
    expect((await(await assess('')).json()).outcome).toBe('not_enforced');
    blocked=true;expect((await assess('')).status).toBe(401);
    expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(0);
  });
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


describe('native immutable receipt recovery',()=>{
  it('recovers a clock receipt after midnight even when the current-day dashboard has no capture',async()=>{
    const a=await hire('Receipt Clock');caller=a.ctx;const command=intent();
    const accepted=await call(clock.POST,'clock',command);expect(accepted.body.outcome).toBe('accepted');
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.now()+86400000);
    try{
      expect((await call(clock.GET,'clock')).body.state.captures).toHaveLength(0);
      const recovered=await call(receipts.GET,`submission-receipt?kind=clock&requestId=${command.requestId}&employmentId=${a.employmentId}`);
      expect(recovered.status).toBe(200);expect(recovered.body).toEqual({kind:'clock',requestId:command.requestId,receipt:accepted.body.receipt});
      expect(recovered.headers.get('cache-control')).toBe('no-store');
    }finally{vi.useRealTimers();}
    expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(1);
  });
  it('returns the original actor-scoped leave response without submitting a second request',async()=>{
    const a=await hire('Receipt Leave');caller=a.ctx;await fund(a.employmentId);const command=application();
    const accepted=await call(leave.POST,'leave-requests',command);expect(accepted.body.outcome).toBe('accepted');
    const recovered=await call(receipts.GET,`submission-receipt?kind=leave&requestId=${command.requestId}&employmentId=${a.employmentId}`);
    expect(recovered.body).toEqual({kind:'leave',requestId:command.requestId,receipt:accepted.body});
    const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'mobile.leave.submitted'));
    expect(events).toHaveLength(1);expect(await owner.db.select().from(schema.leaveRequest)).toHaveLength(1);
  });
  it('a colleague cannot recover a receipt by guessing its UUID or selecting its employee',async()=>{
    const a=await hire('Receipt Owner'),b=await hire('Receipt Peer');caller=a.ctx;const command=intent();
    expect((await call(clock.POST,'clock',command)).body.outcome).toBe('accepted');caller=b.ctx;
    const guessed=await call(receipts.GET,`submission-receipt?kind=clock&requestId=${command.requestId}`);
    expect(guessed.body.receipt).toBeNull();
    expect((await call(receipts.GET,`submission-receipt?kind=clock&requestId=${command.requestId}&employmentId=${a.employmentId}`)).status).toBe(400);
    expect(JSON.stringify(guessed.body)).not.toContain(a.employmentId);
  });
  it('rejects malformed/ambiguous selectors and returns null for a valid unknown reference',async()=>{
    const a=await hire('Receipt Validation');caller=a.ctx;
    for(const query of ['kind=clock&requestId=bad',`kind=clock&kind=leave&requestId=${randomUUID()}`,`kind=unknown&requestId=${randomUUID()}`])expect((await call(receipts.GET,'submission-receipt?'+query)).status).toBe(400);
    expect((await call(receipts.GET,`submission-receipt?kind=leave&requestId=${randomUUID()}`)).body.receipt).toBeNull();
    blocked=true;expect((await call(receipts.GET,`submission-receipt?kind=clock&requestId=${randomUUID()}`)).status).toBe(401);
  });
});
