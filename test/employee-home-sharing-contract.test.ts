import {describe,expect,it} from 'vitest';
import {homeSharingPageInput,validateHomeTeamPage,validateHomeCelebrationPage,validateHomeCelebrationResponse,validateHomeTeamCalendar,validateHomeTeamResponse} from '../lib/employee-home-sharing';
import {todayInKualaLumpur} from '../lib/hr-date';
const id='62063128-fdc5-4a0e-87d7-1892257dbb10';
const today=todayInKualaLumpur(),to=new Date(Date.parse(today+'T12:00:00Z')+7*86400000).toISOString().slice(0,10);
const member={employmentId:id,name:'Fictional colleague',presence:null};
const team=()=>({scope:'direct',date:today,totalPeople:1,items:[member],nextCursor:null});
const event={employmentId:id,name:'Fictional colleague',date:today,kind:'birthday',years:null};
const celebrations=()=>({scope:'direct',from:today,to,total:1,items:[event],nextCursor:null});
describe('Home sharing transport boundaries',()=>{
 it('accepts only bounded opaque cursors and an actual civil date',()=>{
  expect(homeSharingPageInput(undefined)).toEqual({after:null,limit:20});expect(homeSharingPageInput(id,50)).toEqual({after:id,limit:50});
  for(const limit of [0,51,1.5,Infinity,NaN])expect(()=>homeSharingPageInput(undefined,limit)).toThrow();
  for(const after of ['', 'someone@example.invalid','company=all','2026-02-31|birthday|'+id])expect(()=>homeSharingPageInput(after,20,'celebration')).toThrow();
 });
 it('refuses private fields, claimed office/WFH status, scope-off disclosures, and a mismatched calendar day',()=>{
  expect(validateHomeTeamPage(team(),today)).toEqual(team());
  for(const raw of [{...team(),personId:id},{...team(),date:to},{...team(),totalPeople:0},
   {...team(),scope:'off'},{...team(),items:[{...member,reason:'private'}]},
   {...team(),items:[{...member,presence:'office'}]},{...team(),items:[{...member,presence:'wfh'}]},
   {...team(),items:[member,member],totalPeople:2},{...team(),nextCursor:'foreign'}])expect(()=>validateHomeTeamPage(raw,today)).toThrow();
 });
 it('allows no birthday age/year or extra personal fields and rejects dates outside the coming week',()=>{
  expect(validateHomeCelebrationPage(celebrations())).toEqual(celebrations());
  for(const raw of [{...celebrations(),birthYear:2000},{...celebrations(),scope:'off'},
   {...celebrations(),items:[{...event,years:26}]},{...celebrations(),items:[{...event,date:'2000-01-01'}]},
   {...celebrations(),items:[{...event,dateOfBirth:'2000-01-01'}]},
   {...celebrations(),items:[{...event,kind:'anniversary',years:0}]},
   {...celebrations(),nextCursor:today+'|birthday|00000000-0000-0000-0000-000000000000'}])expect(()=>validateHomeCelebrationPage(raw)).toThrow();
 });
 it('binds a team envelope to its selected subject and refuses missing/extra fields',()=>{
  expect(validateHomeTeamResponse({version:1,employmentId:'own',page:team()},'own').page).toEqual(team());
  for(const value of [{version:1,employmentId:'foreign',page:team()},{version:1,employmentId:'own',page:team(),salary:1000},
   {version:1,employmentId:'own',page:{...team(),items:[{...member,presence:'full_day'}]}}])expect(()=>validateHomeTeamResponse(value,'own')).toThrow();
 });
 it('binds celebration transport to the selected own employment and rejects personal content at both boundaries',()=>{
  const response={version:1,employmentId:'own',page:celebrations()};
  expect(validateHomeCelebrationResponse(response,'own')).toEqual(response);
  for(const value of [{...response,employmentId:'foreign'},{...response,greetingBody:'Private'},
   {...response,page:{...celebrations(),items:[{...event,birthYear:2000}]}},
   {...response,page:{...celebrations(),items:[{...event,personId:id}]}},
   {...response,page:{...celebrations(),items:[{...event,years:26}]}}])
   expect(()=>validateHomeCelebrationResponse(value,'own')).toThrow();
 });
 it('never interprets unavailable calendar coverage as zero or serializes richer peer rows',()=>{
  const day={date:today,available:false,totalPeople:null,items:[],nextCursor:null};
  const calendar={scope:'department',from:today,to:today,days:[day]};
  expect(validateHomeTeamCalendar(calendar,today,today)).toEqual(calendar);
  for(const days of [[{...day,totalPeople:0}],[{...day,items:[{employmentId:id,name:'Fictional'}]}],
   [{...day,available:true,totalPeople:1,items:[{employmentId:id,name:'Fictional',personId:id}]}],
   [{...day,available:true,totalPeople:6,items:[{employmentId:id,name:'Fictional'}],nextCursor:null}]])
   expect(()=>validateHomeTeamCalendar({...calendar,days},today,today)).toThrow();
 });
});
