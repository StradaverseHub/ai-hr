import {describe,expect,it} from 'vitest';
import {homeSharingPageInput,validateHomeTeamPage,validateHomeCelebrationPage} from '../lib/employee-home-sharing';
import {todayInKualaLumpur} from '../lib/hr-date';
const id='62063128-fdc5-4a0e-87d7-1892257dbb10';
const today=todayInKualaLumpur(),to=new Date(Date.parse(today+'T12:00:00Z')+7*86400000).toISOString().slice(0,10);
const member={employmentId:id,name:'Fictional colleague',presence:null};
const team=()=>({scope:'direct',date:today,totalEmployments:1,items:[member],nextCursor:null});
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
  for(const raw of [{...team(),personId:id},{...team(),date:to},{...team(),totalEmployments:0},
   {...team(),scope:'off'},{...team(),items:[{...member,reason:'private'}]},
   {...team(),items:[{...member,presence:'office'}]},{...team(),items:[{...member,presence:'wfh'}]},
   {...team(),items:[member,member],totalEmployments:2},{...team(),nextCursor:'foreign'}])expect(()=>validateHomeTeamPage(raw,today)).toThrow();
 });
 it('allows no birthday age/year or extra personal fields and rejects dates outside the coming week',()=>{
  expect(validateHomeCelebrationPage(celebrations())).toEqual(celebrations());
  for(const raw of [{...celebrations(),birthYear:2000},{...celebrations(),scope:'off'},
   {...celebrations(),items:[{...event,years:26}]},{...celebrations(),items:[{...event,date:'2000-01-01'}]},
   {...celebrations(),items:[{...event,dateOfBirth:'2000-01-01'}]},
   {...celebrations(),items:[{...event,kind:'anniversary',years:0}]},
   {...celebrations(),nextCursor:today+'|birthday|00000000-0000-0000-0000-000000000000'}])expect(()=>validateHomeCelebrationPage(raw)).toThrow();
 });
});
