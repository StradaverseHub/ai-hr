import { randomUUID } from 'node:crypto';
import { and,eq,sql } from 'drizzle-orm';
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import sharp from 'sharp';
import * as schema from '../db/schema';
import { adminCtx,closeAll,createAppUser,eventTypesFor,latestEventPayload,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,type Base } from './harness';
import { type SessionContext,withTenant } from '../db/client';
import { hireEmployee } from '../core/org';
import { createClockingLocation,setEmployeeClockingLocations } from '../core/clocking-location';
import { registerDevice,revokeDevice } from '../core/attendance-device';
import { captureEmployeeClock,clockCapturePhoto,purgeClockPhoto,ClockConflictError,type ClockIntent } from '../core/attendance-clock';
import { ownClockToday } from '../core/attendance-clock-read';
import { checkIn,decideAttendanceCorrection,requestAttendanceCorrection,myAttendanceCorrections,MissingAttendanceRejectReasonError } from '../core/attendance';
import { decodeClockPhoto,CLOCK_PHOTO_MAX_BYTES } from '../lib/attendance-photo';
import { formatMinutesToHM,plannedOvertimeMinutes } from '../lib/overtime-duration';
import { todayInKualaLumpur } from '../lib/hr-date';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});afterEach(()=>vi.useRealTimers());
async function subject(){
 const admin=adminCtx(b),h=await hireEmployee(admin,{person:{fullName:'Synthetic Attendance Fixture',primaryEmail:randomUUID()+'@test.local'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(b.tenantId,h.personId,'employee');
 const ctx:SessionContext={tenantId:b.tenantId,userId,personId:h.personId,roles:['employee'],entitlements:harnessSnapshot(b.tenantId),grants:[{role:'employee',companyId:null}]};
 const site=await createClockingLocation(admin,{name:'Synthetic Office '+randomUUID(),lat:3,lng:101,radiusM:100});await setEmployeeClockingLocations(admin,{employmentId:h.employmentId,clockingLocationIds:[site.id]});
 const device=await registerDevice(ctx,{employmentId:h.employmentId,label:'Synthetic browser'});
 const photo=await sharp({create:{width:80,height:60,channels:3,background:'#246'}}).jpeg().toBuffer();
 const intent:ClockIntent={action:'in',requestId:randomUUID(),deviceToken:device.deviceToken,lat:3,lng:101,accuracy:10,photo,mime:'image/jpeg'};
 return {admin,ctx,h,site,device,intent};
}
const clockAt=(iso:string)=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(iso));};

describe('r378 private capture command integrity',()=>{
 it('mandatory photo/device/geofence despite policy flags off, no partial rows on failure',async()=>{
  const x=await subject();
  await expect(captureEmployeeClock(x.ctx,{...x.intent,photo:Buffer.from('not an image')})).rejects.toThrow();
  await expect(captureEmployeeClock(x.ctx,{...x.intent,deviceToken:randomUUID()})).rejects.toThrow('registered');
  await expect(captureEmployeeClock(x.ctx,{...x.intent,lat:5})).rejects.toThrow();
  await expect(captureEmployeeClock(x.ctx,{...x.intent,accuracy:NaN})).rejects.toThrow('accuracy');
  expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(0);
  expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(0);
  await expect(checkIn(x.ctx,{employmentId:x.h.employmentId,date:todayInKualaLumpur(),time:'09:00'})).rejects.toThrow();
  expect(await owner.db.select().from(schema.attendance)).toHaveLength(0);
 });
 it('same request replays one immutable receipt; changed direction/device/location/photo conflicts',async()=>{
  const x=await subject();clockAt(todayInKualaLumpur()+'T09:00:10+08:00');
  const receipt=await captureEmployeeClock(x.ctx,x.intent);
  vi.setSystemTime(new Date(todayInKualaLumpur()+'T09:02:00+08:00'));
  expect(await captureEmployeeClock(x.ctx,x.intent)).toEqual(receipt);
  for(const altered of [{action:'out' as const},{deviceToken:randomUUID()},{lat:3.00001},{accuracy:11},{photo:await sharp({create:{width:40,height:30,channels:3,background:'#934'}}).jpeg().toBuffer()}]) await expect(captureEmployeeClock(x.ctx,{...x.intent,...altered})).rejects.toBeInstanceOf(ClockConflictError);
  expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(1);
  const punches=await owner.db.select().from(schema.attendancePunch);expect(punches).toHaveLength(1);expect(punches[0].clockCaptureId).toBe(receipt.id);expect(punches[0].punchAt).toBe('09:00:10');
  expect(await eventTypesFor(b.tenantId,receipt.id)).toEqual(['attendance.clock.captured']);
 });
 it('serializes racing first IN and records same-minute OUT using true server seconds',async()=>{
  const x=await subject();clockAt(todayInKualaLumpur()+'T09:00:10+08:00');
  const results=await Promise.allSettled([captureEmployeeClock(x.ctx,x.intent),captureEmployeeClock(x.ctx,{...x.intent,requestId:randomUUID()})]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  vi.setSystemTime(new Date(todayInKualaLumpur()+'T09:00:40+08:00'));
  await captureEmployeeClock(x.ctx,{...x.intent,action:'out',requestId:randomUUID()});
  const today=await ownClockToday(x.ctx,x.intent.deviceToken,{lat:3,lng:101,accuracy:10});
  expect(today.clockedIn).toBe(false);expect(today.workedSeconds).toBe(30);expect(today.captures).toHaveLength(2);
  const [day]=await owner.db.select().from(schema.attendance);expect(day.workedMinutes).toBe(0);
 });
 it('two same-minute pairs retain the latest OUT seconds without changing payable minute arithmetic',async()=>{
  const x=await subject();const date=todayInKualaLumpur();clockAt(date+'T09:00:10+08:00');
  await captureEmployeeClock(x.ctx,x.intent);
  for(const [action,seconds] of [['out','40'],['in','50'],['out','55']] as const){
    vi.setSystemTime(new Date(date+'T09:00:'+seconds+'+08:00'));
    await captureEmployeeClock(x.ctx,{...x.intent,action,requestId:randomUUID()});
  }
  const today=await ownClockToday(x.ctx,x.intent.deviceToken,{lat:3,lng:101,accuracy:10});
  expect(today.workedSeconds).toBe(35);expect(today.clockedIn).toBe(false);expect(today.captures).toHaveLength(4);
  const [day]=await owner.db.select().from(schema.attendance);
  expect(day.workedMinutes).toBe(0);expect(day.otMinutes).toBe(0);
  expect(day.checkOutAt,'the authoritative last clock-out must retain its actual server seconds').toBe('09:00:55');
 });
 it('new same-day capture cannot overwrite an approved clock correction from the retained punch trail',async()=>{
  const x=await subject(),date=todayInKualaLumpur();clockAt(date+'T09:00:10+08:00');
  await captureEmployeeClock(x.ctx,x.intent);vi.setSystemTime(new Date(date+'T10:00:10+08:00'));
  await captureEmployeeClock(x.ctx,{...x.intent,action:'out',requestId:randomUUID()});
  const request=await requestAttendanceCorrection(x.ctx,{employmentId:x.h.employmentId,date,checkIn:'08:00',checkOut:'11:00',reason:'Synthetic correction review'});
  await decideAttendanceCorrection(x.admin,{correctionId:request.correctionId,decision:'approved'});
  const [corrected]=await owner.db.select().from(schema.attendance).where(eq(schema.attendance.employmentId,x.h.employmentId));
  expect(corrected.checkInAt).toBe('08:00:00');expect(corrected.checkOutAt).toBe('11:00:00');
  vi.setSystemTime(new Date(date+'T12:00:10+08:00'));
  await expect(captureEmployeeClock(x.ctx,{...x.intent,requestId:randomUUID()})).rejects.toThrow('approved clock correction');
  expect(await owner.db.select().from(schema.attendance).where(eq(schema.attendance.employmentId,x.h.employmentId))).toEqual([corrected]);
  expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(2);
  expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(2);
 });
 it('photo reads obey subject RLS and purge keeps receipt/digests with an audited unavailable marker',async()=>{
  const x=await subject(), receipt=await captureEmployeeClock(x.ctx,x.intent), stranger=await subject();
  expect((await clockCapturePhoto(x.ctx,receipt.id,false))?.bytes).toBeInstanceOf(Buffer);
  expect(await clockCapturePhoto(stranger.ctx,receipt.id,false)).toBeNull();
  const foreign=await seedBase();expect(await clockCapturePhoto(adminCtx(foreign),receipt.id,false)).toBeNull();
  await expect(purgeClockPhoto(x.ctx,receipt.id)).rejects.toThrow();
  await purgeClockPhoto(x.admin,receipt.id);
  const [after]=await owner.db.select().from(schema.attendanceClockCapture).where(eq(schema.attendanceClockCapture.id,receipt.id));
  expect(after.photoBytes).toBeNull();expect(after.thumbnailBytes).toBeNull();expect(after.photoPurgedAt).toBeInstanceOf(Date);expect(after.photoDigest).toMatch(/^[a-f0-9]{64}$/);expect(after.requestId).toBe(x.intent.requestId);
  expect((await clockCapturePhoto(x.ctx,receipt.id,false))?.purgedAt).toBeInstanceOf(Date);
  await expect(purgeClockPhoto(x.ctx,receipt.id)).rejects.toThrow();
  await purgeClockPhoto(x.admin,receipt.id);expect((await eventTypesFor(b.tenantId,receipt.id)).filter(t=>t==='attendance.clock.photo-purged')).toHaveLength(1);
  await expect(withTenant(x.ctx,tx=>tx.execute(sql`update attendance_clock_capture set photo_digest=${'0'.repeat(64)} where id=${receipt.id}::uuid`))).rejects.toThrow();
 });
 it('legacy manual same-minute and future anchors keep existing ordering guards without partial evidence',async()=>{
  const x=await subject();const date=todayInKualaLumpur();clockAt(date+'T09:00:10+08:00');
  await checkIn(x.admin,{employmentId:x.h.employmentId,date,time:'09:00'});
  await expect(captureEmployeeClock(x.ctx,{...x.intent,action:'out'})).rejects.toThrow();
  expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(0);
  const [day]=await owner.db.select().from(schema.attendance);expect(day.checkInAt).toBe('09:00:00');expect(day.checkOutAt).toBeNull();
  await owner.db.update(schema.attendancePunch).set({punchAt:'10:00:00'}).where(eq(schema.attendancePunch.attendanceId,day.id));
  await expect(captureEmployeeClock(x.ctx,{...x.intent,action:'out',requestId:randomUUID()})).rejects.toThrow('previous attendance punch');
  expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(0);
 });
 it('direct app-role insert rejects foreign-tenant employment, independently of service checks',async()=>{
  const x=await subject();const receipt=await captureEmployeeClock(x.ctx,x.intent);
  const [row]=await owner.db.select().from(schema.attendanceClockCapture).where(eq(schema.attendanceClockCapture.id,receipt.id));
  const foreign=await seedBase();const other=await hireEmployee(adminCtx(foreign),{person:{fullName:'Synthetic foreign subject',primaryEmail:randomUUID()+'@test.local'},companyId:foreign.companyId,departmentId:foreign.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
  await expect(withTenant(x.ctx,tx=>tx.insert(schema.attendanceClockCapture).values({...row,id:randomUUID(),requestId:randomUUID(),employmentId:other.employmentId}))).rejects.toThrow();
  expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(1);
 });
 it('revoked device cannot make a new action but an exact accepted replay returns its historical receipt',async()=>{
  const x=await subject(),receipt=await captureEmployeeClock(x.ctx,x.intent);await revokeDevice(x.admin,{deviceId:x.device.deviceId});
  expect(await captureEmployeeClock(x.ctx,x.intent)).toEqual(receipt);
  await expect(captureEmployeeClock(x.ctx,{...x.intent,action:'out',requestId:randomUUID()})).rejects.toThrow('registered');
 });
});

describe('r378 correction originals and rejection facts',()=>{
 it('freezes originals at submission, preserves them when live clocks change, and records trimmed rejection',async()=>{
  const x=await subject(),date=todayInKualaLumpur();await checkIn(x.admin,{employmentId:x.h.employmentId,date,time:'09:00'});
  const request=await requestAttendanceCorrection(x.ctx,{employmentId:x.h.employmentId,date,checkIn:'09:05',checkOut:'18:00',reason:'Forgot the clock'});
  const [before]=await owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id,request.correctionId));
  expect(before.originalClockSnapshot).toMatchObject({version:1,originalCheckIn:'09:00:00',originalCheckOut:null});
  const requested=await latestEventPayload(b.tenantId,request.correctionId,'attendance-correction.requested');expect(requested?.originalClockSnapshot).toEqual(before.originalClockSnapshot);
  await owner.db.update(schema.attendance).set({checkInAt:'10:00'}).where(eq(schema.attendance.employmentId,x.h.employmentId));
  await expect(decideAttendanceCorrection(x.admin,{correctionId:request.correctionId,decision:'rejected',rejectReason:'   '})).rejects.toBeInstanceOf(MissingAttendanceRejectReasonError);
  await expect(decideAttendanceCorrection(x.admin,{correctionId:request.correctionId,decision:'rejected',rejectReason:'x'.repeat(1001)})).rejects.toBeInstanceOf(MissingAttendanceRejectReasonError);
  await decideAttendanceCorrection(x.admin,{correctionId:request.correctionId,decision:'rejected',rejectReason:'  Please correct the date  '});
  const [row]=await myAttendanceCorrections(x.ctx,x.h.employmentId,{date,limit:20});expect(row.rejectReason).toBe('Please correct the date');expect(row.originalClockSnapshot).toEqual(before.originalClockSnapshot);expect(row.decidedAt).toBeInstanceOf(Date);
  const rejected=await latestEventPayload(b.tenantId,request.correctionId,'attendance-correction.rejected');expect(rejected?.rejectReason).toBe(row.rejectReason);
  const [day]=await owner.db.select().from(schema.attendance);expect(day.checkInAt).toBe('10:00:00');
  await expect(owner.db.update(schema.attendanceCorrection).set({originalClockSnapshot:null}).where(eq(schema.attendanceCorrection.id,request.correctionId))).rejects.toThrow();
 });
 it('observes genuinely missing attendance distinctly from legacy NULL and keeps OT-only NULL',async()=>{
  const x=await subject(),date=todayInKualaLumpur();
  const request=await requestAttendanceCorrection(x.ctx,{employmentId:x.h.employmentId,date,checkIn:'09:00',checkOut:'18:00',reason:'Missing attendance'});
  const [row]=await owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id,request.correctionId));expect(row.originalClockSnapshot).toMatchObject({version:1,attendanceId:null,originalCheckIn:null,originalCheckOut:null});
  await decideAttendanceCorrection(x.admin,{correctionId:request.correctionId,decision:'rejected',rejectReason:'Record not supported'});
  const future=todayInKualaLumpur(new Date(Date.now()+2*86400000));
  const ot=await requestAttendanceCorrection(x.ctx,{employmentId:x.h.employmentId,date:future,requestedOtMinutes:210,plannedStartTime:'22:00',plannedEndTime:'01:30',reason:'Night work'});
  const [otRow]=await owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id,ot.correctionId));expect(otRow.originalClockSnapshot).toBeNull();expect(otRow.requestedOtMinutes).toBe(210);expect(otRow.otReasonCategory).toBeNull();
 });
});

describe('r378 actual image decoding and duration presentation',()=>{
 it('decodes actual PNG bytes, strips metadata, embeds compact JPEG and thumbnail with bounded pixels',async()=>{
  const png=await sharp({create:{width:1200,height:800,channels:3,background:'#456'}}).withMetadata({exif:{IFD0:{Artist:'Synthetic fixture'}}}).png().toBuffer();
  const image=await decodeClockPhoto(png,'image/png');
  const full=await sharp(image.photoBytes).metadata(),thumb=await sharp(image.thumbnailBytes).metadata();expect(full.format).toBe('jpeg');expect(full.width).toBe(640);expect(full.height).toBe(427);expect(full.exif).toBeUndefined();expect(thumb.width).toBe(96);expect(image.photoSize).toBe(image.photoBytes.length);
  await expect(decodeClockPhoto(png,'image/jpeg')).rejects.toThrow('Invalid');await expect(decodeClockPhoto(Buffer.alloc(CLOCK_PHOTO_MAX_BYTES+1),'image/jpeg')).rejects.toThrow('2 MB');await expect(decodeClockPhoto(png.subarray(0,40),'image/png')).rejects.toThrow();
 });
 it.each([[150,'2h30m'],[120,'2h'],[45,'45m'],[0,'0m']])('formats recorded %i minutes as %s', (minutes,expected)=>expect(formatMinutesToHM(minutes)).toBe(expected));
 it('strictly derives overnight windows while equal/incomplete/malformed times remain invalid',()=>{
  expect(plannedOvertimeMinutes('22:00','01:30')).toBe(210);expect(plannedOvertimeMinutes('18:00','20:30')).toBe(150);for(const [start,end] of [['18:00','18:00'],['','20:00'],['24:00','01:00'],['9:00','10:00']])expect(plannedOvertimeMinutes(start,end)).toBeNull();expect(()=>formatMinutesToHM(1.5)).toThrow();
 });
});
