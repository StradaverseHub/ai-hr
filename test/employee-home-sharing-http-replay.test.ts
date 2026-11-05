import {EventEmitter} from 'node:events';
import {expect,it,vi} from 'vitest';
import {createHomeHttpReplay} from '../scripts/performance/home-http.mjs';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';

const base='https://example.invalid',cohort='/api/home/sharing-initial';
const user={role:'employee',employmentId:'fixture-own'},foreign={...user,employmentId:'fixture-foreign'};
const date=todayInKualaLumpur();
const headers={'cache-control':'private, no-store','content-type':'application/x-ndjson'};
const frames=(value:unknown[])=>value.map(frame=>JSON.stringify(frame)+'\n').join('');
const team={version:1,employmentId:user.employmentId,page:{scope:'off',date,totalPeople:0,items:[],nextCursor:null}};
const celebrations={version:1,employmentId:user.employmentId,page:{scope:'off',from:date,to:addDaysIso(date,7),total:0,items:[],nextCursor:null}};
const success=[
 {version:1,card:'celebrations',status:200,value:celebrations},
 {version:1,card:'team',status:200,value:team},
];
const denied=[{version:1,card:'team',status:403},{version:1,card:'celebrations',status:403}];
function fixture(){
 const page=new EventEmitter();
 const report={boundaries:[]};
 const request=vi.fn();
 const replay=createHomeHttpReplay({base,request,report});
 const observe=(path:string)=>page.emit('request',{method:()=> 'GET',url:()=>base+path+'?employmentId='+user.employmentId});
 return {page,report,request,replay,observe};
}

it('discovers the actual shared request, validates both frames, and separately checks foreign denial',async()=>{
 const {page,report,request,replay,observe}=fixture();
 const stop=replay.track(page,user,'/');
 observe(cohort);
 observe('/api/home/team');
 stop();
 request.mockImplementation(async(_actor,path)=>{
  if(path.startsWith(cohort)){
   return {headers,content:frames(path.includes(foreign.employmentId)?denied:success)};
  }
  return {headers:{...headers,'content-type':'application/json'},content:JSON.stringify(
   path.includes(foreign.employmentId)?{error:'employmentUnavailable'}:team)};
 });
 await replay.read(user);
 await replay.boundary(user,foreign);
 expect(request.mock.calls.map(([,path,,status])=>[path,status])).toEqual([
  [cohort+'?employmentId='+user.employmentId,200],
  ['/api/home/team?employmentId='+user.employmentId,200],
  ['/api/home/team?employmentId='+foreign.employmentId,403],
  [cohort+'?employmentId='+foreign.employmentId,200],
 ]);
 expect(report.boundaries).toEqual([
  {kind:'foreign-own-home-subject',role:'employee',passed:true},
  {kind:'foreign-own-home-sharing-cohort',role:'employee',passed:true},
 ]);
 expect(report).toMatchObject({homeApiTraffic:{sharingFrames:{'employee:team':1,'employee:celebrations':1}}});
});

it.each([
 ['missing',frames(success.slice(0,1))],
 ['duplicate',frames([success[0],success[0]])],
 ['partial',frames(success).slice(0,-1)],
 ['failed card',frames([success[0],denied[0]])],
])('rejects a %s card even when the HTTP response succeeds',async(_reason,content)=>{
 const {page,request,replay,observe}=fixture();
 const stop=replay.track(page,user,'/');
 observe(cohort);
 stop();
 request.mockResolvedValue({headers,content});
 await expect(replay.read(user)).rejects.toThrow();
});
