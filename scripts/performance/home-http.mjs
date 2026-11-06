/** Replay subject-bound Home GETs observed in the real browser; never invent an API/auth bypass. */
import assert from 'node:assert/strict';
import {validateEmployeeHomeSummary} from '../../lib/employee-home-summary.ts';
import {validateEmployeeHomeToday} from '../../lib/employee-home-today.ts';
import {validateHomeCalendar} from '../../lib/employee-home-calendar.ts';
import {validateHomeTeamResponse,validateHomeCelebrationResponse} from '../../lib/employee-home-sharing.ts';
import {DEFAULT_HOME_SHARING_CARDS,HOME_SHARING_MAX_FRAME_BYTES,HOME_SHARING_STREAM} from '../../lib/employee-home-sharing-cohort.ts';
import {todayInKualaLumpur} from '../../lib/hr-date.ts';
import {calendarWindowDates} from '../../lib/calendar-window.ts';
const sharingPath='/api/home/sharing-initial';
const paths=new Set(['summary','today','calendar','team','celebrations','time-off','tasks','notices','greeting-message','sharing-initial'].map(name=>'/api/home/'+name));
function sharingFrames(response,expectedStatus,url){
 const selected=url.searchParams.getAll('card');
 const expectedCards=selected.length?selected:DEFAULT_HOME_SHARING_CARDS;
 assert.equal(String(response.headers['content-type']).split(';')[0],HOME_SHARING_STREAM);
 assert(String(response.headers['cache-control']).includes('no-store'));
 const lines=response.content.split('\n');
 assert.equal(lines.pop(),'','Home sharing stream ended mid-frame');
 assert.equal(lines.length,expectedCards.length,'Home sharing stream did not deliver all requested card frames');
 const cards=new Map();
 for(const line of lines){
  assert(Buffer.byteLength(line)+1<=HOME_SHARING_MAX_FRAME_BYTES,'Home sharing frame exceeded its wire limit');
  const frame=JSON.parse(line);
  assert(expectedCards.includes(frame.card)&&!cards.has(frame.card),'Home sharing frame key was unexpected or repeated');
  assert.deepEqual(Object.keys(frame).sort(),expectedStatus===200?['card','status','value','version']:['card','status','version']);
  assert.equal(frame.version,1);assert.equal(frame.status,expectedStatus);
  cards.set(frame.card,frame.value);
 }
 return cards;
}

export function createHomeHttpReplay({base,request,report}){
 const templates=new Map();report.homeApiTraffic={templates:[],completed:{},sharingFrames:{}};
 function track(page,user,path){
  // HR's dashboard is server-rendered; only personal Home emits these subject-bound APIs.
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
   const startedOn=todayInKualaLumpur();
   const response=await request(user,url.pathname+url.search,undefined,200,record),finishedOn=todayInKualaLumpur();
   // Fixture creation and production builds can cross HR midnight. Only the actual request's
   // boundary days are live; a clock jump must not admit an arbitrary historical/future response.
   const liveDays=calendarWindowDates(startedOn,finishedOn,2);
   const liveDate=(date,label)=>{assert(liveDays.includes(date),label+' outside live HR request dates '+liveDays.join('..'));return date;};
   const key=user.role+':'+url.pathname;
   if(url.pathname===sharingPath){
    const cards=sharingFrames(response,200,url);
    for(const [card,value] of cards){
     assert.equal(value.version,1);assert.equal(value.employmentId,user.employmentId);
     if(card==='team')validateHomeTeamResponse(value,user.employmentId,liveDate(value.page?.date,'team.date'));
     else if(card==='celebrations')validateHomeCelebrationResponse(value,user.employmentId);
     else if(card==='notices'){assert(Array.isArray(value.items));assert(Number.isSafeInteger(value.total)&&value.total>=value.items.length);}
     else if(card==='timeOff'){assert(Array.isArray(value.balances));assert.equal(typeof value.canApply,'boolean');liveDate(value.asOf,'asOf');}
     else assert.fail('Unknown Home card');
     const frameKey=user.role+':'+card;
     report.homeApiTraffic.sharingFrames[frameKey]=(report.homeApiTraffic.sharingFrames[frameKey]??0)+1;
    }
    report.homeApiTraffic.completed[key]=(report.homeApiTraffic.completed[key]??0)+1;
    return;
   }
   const value=JSON.parse(response.content);
   assert(String(response.headers['content-type']).includes('application/json'));assert(String(response.headers['cache-control']).includes('no-store'));
   assert.equal(value.version,1);assert.equal(value.employmentId,user.employmentId);assert(!Object.hasOwn(value,'error'));
   if(Object.hasOwn(value,'asOf'))liveDate(value.asOf,'asOf');
   if(url.pathname.endsWith('/summary'))validateEmployeeHomeSummary(value,user.employmentId);
   else if(url.pathname.endsWith('/today')){validateEmployeeHomeToday(value,user.employmentId);liveDate(value.businessDate,'businessDate');}
   else if(url.pathname.endsWith('/calendar')){
    const month=url.searchParams.get('month');
    if(month===null)assert(liveDays.some(date=>date.slice(0,7)===value.month),'Calendar month outside live HR request dates');
    validateHomeCalendar(value,user.employmentId,month??value.month);liveDate(value.today,'calendar.today');
   }
   else if(url.pathname.endsWith('/team'))validateHomeTeamResponse(value,user.employmentId,url.searchParams.get('date')??liveDate(value.page?.date,'team.date'));
   else if(url.pathname.endsWith('/celebrations'))validateHomeCelebrationResponse(value,user.employmentId);
   else if(url.pathname.endsWith('/time-off')){assert(Array.isArray(value.balances));assert.equal(typeof value.canApply,'boolean');}
   else if(url.pathname.endsWith('/tasks')){assert.equal(value.grain,'account');assert(Array.isArray(value.items));assert(Number.isSafeInteger(value.total)&&value.total>=value.items.length);}
   else if(url.pathname.endsWith('/notices')){assert(Array.isArray(value.items));assert(Number.isSafeInteger(value.total)&&value.total>=value.items.length);}
   else if(url.pathname.endsWith('/greeting-message')){liveDate(value.displayDate,'displayDate');assert(value.message===null||typeof value.message==='string'&&value.message.trim());}
   report.homeApiTraffic.completed[key]=(report.homeApiTraffic.completed[key]??0)+1;
  }));
 }
 async function boundary(actor,target){
  const observed=templates.get(actor.role);assert(observed?.size);
  const paths=[...observed];
  const standalone=paths.find(path=>new URL(path,base).pathname!==sharingPath);
  const sharing=paths.find(path=>new URL(path,base).pathname===sharingPath);
  if(standalone){
   const url=new URL(standalone,base);url.searchParams.set('employmentId',target.employmentId);
   const response=await request(actor,url.pathname+url.search,undefined,403,false);
   assert.equal(JSON.parse(response.content).error,'employmentUnavailable');
   report.boundaries.push({kind:'foreign-own-home-subject',role:actor.role,passed:true});
  }
  if(sharing){
   const url=new URL(sharing,base);url.searchParams.set('employmentId',target.employmentId);
   const response=await request(actor,url.pathname+url.search,undefined,200,false);
   sharingFrames(response,403,url);
   report.boundaries.push({kind:'foreign-own-home-sharing-cohort',role:actor.role,passed:true});
  }
 }
 return{track,read,boundary};
}
