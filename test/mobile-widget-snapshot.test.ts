import {describe,expect,it} from 'vitest';
import {projectAttendanceWidget,WIDGET_MAX_AGE} from '../mobile/lib/widget-snapshot';
import type {ClockResponse} from '../lib/mobile-api/contract';
const now=Date.parse('2026-11-02T04:26:00Z'),employment='00000000-0000-4000-8000-000000000001';
function reply():ClockResponse{return {enabled:true,employmentId:employment,state:{serverNow:new Date(now).toISOString(),date:'2026-11-02',clockedIn:true,openSince:'2026-11-02T01:02:00Z',workedSeconds:12240,geofencingRequired:true,attendancePhotoSetting:'required',deviceRequired:true,shift:{code:'SENSITIVE-SHIFT',start:'09:00',end:'18:00'},captures:[],legacy:[]}};}
function capture(direction:'in'|'out',recordedAt:string,date='2026-11-02'){return {direction,recordedAt,date,id:employment,requestId:employment,photoAvailable:true,locationName:'PRIVATE LOCATION'};}
describe('minimal confirmed attendance widget snapshot',()=>{
 it('projects confirmed open status in HR time and never shares policy, identity, location or a command',()=>{
  const value=projectAttendanceWidget(reply(),employment,now);
  expect(value).toEqual({status:'in',day:'2026-11-02',inTime:'09:02',outTime:'—',updated:'12:26',expiresAt:now+WIDGET_MAX_AGE});
  expect(JSON.stringify(value)).not.toMatch(/PRIVATE|SENSITIVE|employment|device|photo|location|request|shift|worked/);
 });
 it('sorts receipt instants independently, excludes other days and future receipts, and pairs the last completed visit',()=>{
  const r=reply();r.state!.clockedIn=false;r.state!.openSince=null;
  r.state!.captures=[capture('out','2026-11-02T04:00:00Z'),capture('in','2026-11-02T05:00:00Z'),capture('in','2026-11-02T01:02:00Z'),capture('in','2026-11-01T01:00:00Z','2026-11-01')];
  expect(projectAttendanceWidget(r,employment,now)).toMatchObject({status:'out',inTime:'09:02',outTime:'12:00'});
 });
 it('includes confirmed imported/corrected times and combines legacy clock-in with a mobile clock-out',()=>{
  const r=reply();r.state!.clockedIn=false;r.state!.openSince=null;r.state!.legacy=[{direction:'in',time:'08:55:00'},{direction:'out',time:'11:00:00'}];
  expect(projectAttendanceWidget(r,employment,now)).toMatchObject({inTime:'08:55',outTime:'11:00'});
  r.state!.captures=[capture('out','2026-11-02T04:00:00Z')];expect(projectAttendanceWidget(r,employment,now)).toMatchObject({inTime:'08:55',outTime:'12:00'});
 });
 it('orders confirmed overnight legacy times with the server shift and refuses malformed/future rows',()=>{
  const r=reply();r.state!.clockedIn=false;r.state!.openSince=null;r.state!.serverNow='2026-11-02T23:00:00Z';r.state!.shift={code:'NIGHT',start:'22:00',end:'06:00'};
  r.state!.legacy=[{direction:'in',time:'22:05'},{direction:'out',time:'06:01'},{direction:'out',time:'99:99'},{direction:'in',time:'07:30'}];
  expect(projectAttendanceWidget(r,employment,Date.parse(r.state!.serverNow))).toMatchObject({inTime:'22:05',outTime:'06:01'});
 });
 it('does not display a previous clock-out beside a new open visit',()=>{const r=reply();r.state!.captures=[capture('out','2026-11-02T00:01:00Z')];expect(projectAttendanceWidget(r,employment,now)?.outTime).toBe('—');});
 it('represents absent receipts with dashes instead of fabricated hours',()=>{const r=reply();r.state!.clockedIn=false;r.state!.openSince=null;expect(projectAttendanceWidget(r,employment,now)).toMatchObject({inTime:'—',outTime:'—'});});
 it.each(['wrong-scope','disabled','missing','stale','future','invalid'] as const)('refuses %s data',kind=>{
  const r=reply();let selected=employment;
  if(kind==='wrong-scope')selected='another';if(kind==='disabled')r.enabled=false;if(kind==='missing')r.state=null;
  if(kind==='stale')r.state!.serverNow=new Date(now-WIDGET_MAX_AGE-1).toISOString();if(kind==='future')r.state!.serverNow=new Date(now+60_001).toISOString();if(kind==='invalid')r.state!.serverNow='invalid';
  expect(projectAttendanceWidget(r,selected,now)).toBeNull();
 });
 it('expires relative to the server answer, not a delayed reception time',()=>{const r=reply();r.state!.serverNow=new Date(now-5*60_000).toISOString();expect(projectAttendanceWidget(r,employment,now)?.expiresAt).toBe(now+10*60_000);});
});
