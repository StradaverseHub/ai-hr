import {EventEmitter} from 'node:events';
import {afterEach,expect,it,vi} from 'vitest';
import {createHomeHttpReplay} from '../scripts/performance/home-http.mjs';
import {homeCalendarGrid} from '../lib/employee-home-calendar';

const base='https://localhost:3443';
const user={role:'employee',employmentId:'62063128-fdc5-4a0e-87d7-1892257dbb10'};
const previous='2026-11-01',current='2026-11-02';
const team=(date=current)=>({version:1,employmentId:user.employmentId,page:{scope:'off',date,totalPeople:0,items:[],nextCursor:null}});
function replay(value:unknown,{path='/api/home/team',finishAt}: {path?:string;finishAt?:string}={}){
 const page=new EventEmitter(),report={boundaries:[]};
 const request=vi.fn(async()=>{
  if(finishAt)vi.setSystemTime(new Date(finishAt));
  return {content:JSON.stringify(value),headers:{'content-type':'application/json','cache-control':'private, no-store'}};
 });
 // Keep the original driver's fixture day to reproduce the captured failure; live responses must
 // follow the request clock even when a long fixture/build phase used the preceding business day.
 const options={base,fixture:{today:previous,month:'2026-11'},request,report};
 const helper=createHomeHttpReplay(options);
 const stop=helper.track(page,user,'/'),url=new URL(path,base);url.searchParams.set('employmentId',user.employmentId);
 page.emit('request',{method:()=> 'GET',url:()=>url.href});stop();
 return {helper,request};
}
afterEach(()=>vi.useRealTimers());
function now(instant='2026-11-01T16:00:10Z'){vi.useFakeTimers();vi.setSystemTime(new Date(instant));}
function calendar(month:string,today:string){
 const dates=homeCalendarGrid(month,1);
 return {version:1,employmentId:user.employmentId,month,today,weekStartsOn:1,payrollEnabled:false,
  days:dates.map(date=>({date,canRequestLeave:false,entries:[]})),
  team:{scope:'off',from:dates[0],to:dates[dates.length-1],days:dates.map(date=>({date,available:false,totalPeople:null,items:[],nextCursor:null}))}};
}

it('replays a native-valid live Home team response after fixture creation crossed Kuala Lumpur midnight',async()=>{
 now();const {helper,request}=replay(team());
 await expect(helper.read(user)).resolves.toBeUndefined();expect(request).toHaveBeenCalledTimes(1);
});
it('rejects the stale fixture day when the entire request occurs on the next HR day',async()=>{
 now();await expect(replay(team(previous)).helper.read(user)).rejects.toThrow();
});
it.each([previous,current])('accepts either actual request-boundary day across midnight: %s',async date=>{
 now('2026-11-01T15:59:59.990Z');
 await expect(replay(team(date),{finishAt:'2026-11-01T16:00:00.010Z'}).helper.read(user)).resolves.toBeUndefined();
});
it.each(['2026-10-31','2026-11-03'])('rejects a live date outside the bounded request interval: %s',async date=>{
 now();await expect(replay(team(date)).helper.read(user)).rejects.toThrow();
});
it('retains an explicit historical team date captured from the real browser',async()=>{
 now();await expect(replay(team('2026-10-30'),{path:'/api/home/team?date=2026-10-30'}).helper.read(user)).resolves.toBeUndefined();
 await expect(replay(team(),{path:'/api/home/team?date=2026-10-30'}).helper.read(user)).rejects.toThrow();
});
it('does not turn a multi-day clock jump into a permissive response-date window',async()=>{
 now();await expect(replay(team(),{finishAt:'2026-11-03T16:00:10Z'}).helper.read(user)).rejects.toThrow();
});
it.each([
 {...team(),employmentId:'00000000-0000-0000-0000-000000000000'},
 {...team(),page:{...team().page,nextCursor:'not-a-cursor'}},
 {...team(),page:{...team().page,totalPeople:1}},
])('retains native subject, cursor and scope-off disclosure checks: %j',async value=>{
 now();await expect(replay(value).helper.read(user)).rejects.toThrow();
});
it.each([
 {path:'/api/home/time-off',value:{version:1,employmentId:user.employmentId,asOf:current,canApply:false,balances:[]}},
 {path:'/api/home/greeting-message',value:{version:1,employmentId:user.employmentId,displayDate:current,message:null}},
])('uses the live request day for $path',async({path,value})=>{
 now();await expect(replay(value,{path}).helper.read(user)).resolves.toBeUndefined();
 const stale=Object.hasOwn(value,'asOf')?{...value,asOf:previous}:{...value,displayDate:previous};
 await expect(replay(stale,{path}).helper.read(user)).rejects.toThrow();
});
it('uses the live default calendar month after a month boundary',async()=>{
 now('2026-11-30T16:00:10Z');
 await expect(replay(calendar('2026-12','2026-12-01'),{path:'/api/home/calendar'}).helper.read(user)).resolves.toBeUndefined();
 await expect(replay(calendar('2026-11','2026-12-01'),{path:'/api/home/calendar'}).helper.read(user)).rejects.toThrow();
});
it('keeps explicit calendar months exact while still refusing a stale today marker',async()=>{
 now();const path='/api/home/calendar?month=2026-10';
 await expect(replay(calendar('2026-10',current),{path}).helper.read(user)).resolves.toBeUndefined();
 await expect(replay(calendar('2026-11',current),{path}).helper.read(user)).rejects.toThrow();
 await expect(replay(calendar('2026-10',previous),{path}).helper.read(user)).rejects.toThrow();
});
