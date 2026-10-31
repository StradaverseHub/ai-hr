/** Replay subject-bound Home GETs observed in the real browser; never invent an API/auth bypass. */
import assert from 'node:assert/strict';
import {validateEmployeeHomeSummary} from '../../lib/employee-home-summary.ts';
import {validateEmployeeHomeToday} from '../../lib/employee-home-today.ts';
import {validateHomeCalendar} from '../../lib/employee-home-calendar.ts';
import {validateHomeTeamResponse,validateHomeCelebrationResponse} from '../../lib/employee-home-sharing.ts';
const paths=new Set(['summary','today','calendar','team','celebrations','time-off','tasks','notices','greeting-message'].map(name=>'/api/home/'+name));
export function createHomeHttpReplay({base,fixture,request,report}){
 const templates=new Map();report.homeApiTraffic={templates:[],completed:{}};
 function track(page,user,path){
  if(path!=='/'||!['employee','manager'].includes(user.role))return()=>{};
  const observed=new Set(),listener=req=>{
   const url=new URL(req.url());
   if(req.method()==='GET'&&url.origin===base&&paths.has(url.pathname)&&url.searchParams.get('employmentId')===user.employmentId){url.searchParams.set('employmentId','__PERF_SUBJECT__');observed.add(url.pathname+url.search);}
  };
  page.on('request',listener);
  return()=>{
   page.off('request',listener);assert(observed.size>0,'Home browser did not issue subject-bound reads');
   const own=templates.get(user.role)??new Set();for(const path of observed)own.add(path);templates.set(user.role,own);
   report.homeApiTraffic.templates=[...templates].map(([role,urls])=>({role,requests:[...urls].map(path=>{const url=new URL(path,base);return{path:url.pathname,queryKeys:[...url.searchParams.keys()].sort()};})}));
  };
 }
 async function read(user,record=true){
  const observed=templates.get(user.role);assert(observed?.size,'no verified Home request templates for role');
  await Promise.all([...observed].map(async path=>{
   const url=new URL(path,base);url.searchParams.set('employmentId',user.employmentId);
   const response=await request(user,url.pathname+url.search,undefined,200,record),value=JSON.parse(response.content);
   assert(String(response.headers['content-type']).includes('application/json'));assert(String(response.headers['cache-control']).includes('no-store'));
   assert.equal(value.version,1);assert.equal(value.employmentId,user.employmentId);assert(!Object.hasOwn(value,'error'));
   if(Object.hasOwn(value,'asOf'))assert.equal(value.asOf,fixture.today);
   if(url.pathname.endsWith('/summary'))validateEmployeeHomeSummary(value,user.employmentId);
   else if(url.pathname.endsWith('/today')){validateEmployeeHomeToday(value,user.employmentId);assert.equal(value.businessDate,fixture.today);}
   else if(url.pathname.endsWith('/calendar'))validateHomeCalendar(value,user.employmentId,url.searchParams.get('month')??fixture.month);
   else if(url.pathname.endsWith('/team'))validateHomeTeamResponse(value,user.employmentId,url.searchParams.get('date')??fixture.today);
   else if(url.pathname.endsWith('/celebrations'))validateHomeCelebrationResponse(value,user.employmentId);
   else if(url.pathname.endsWith('/time-off')){assert(Array.isArray(value.balances));assert.equal(typeof value.canApply,'boolean');}
   else if(url.pathname.endsWith('/tasks')){assert.equal(value.grain,'account');assert(Array.isArray(value.items));assert(Number.isSafeInteger(value.total)&&value.total>=value.items.length);}
   else if(url.pathname.endsWith('/notices')){assert(Array.isArray(value.items));assert(Number.isSafeInteger(value.total)&&value.total>=value.items.length);}
   else if(url.pathname.endsWith('/greeting-message')){assert.equal(value.displayDate,fixture.today);assert(value.message===null||typeof value.message==='string'&&value.message.trim());}
   const key=user.role+':'+url.pathname;report.homeApiTraffic.completed[key]=(report.homeApiTraffic.completed[key]??0)+1;
  }));
 }
 async function boundary(actor,target){
  const observed=templates.get(actor.role);assert(observed?.size);
  const url=new URL([...observed][0],base);url.searchParams.set('employmentId',target.employmentId);
  const response=await request(actor,url.pathname+url.search,undefined,403,false);
  assert.equal(JSON.parse(response.content).error,'employmentUnavailable');
  report.boundaries.push({kind:'foreign-own-home-subject',role:actor.role,passed:true});
 }
 return{track,read,boundary};
}
