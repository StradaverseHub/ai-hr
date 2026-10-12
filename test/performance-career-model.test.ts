import { describe, expect, it } from 'vitest';
import { resolveTechnicalProfile, technicalProfilePlan, demonstratedSkills, careerGap, careerRoutes } from '../packs/performance/onehr/career-model';
import type { Competency, Policy, Statement } from '../packs/performance/onehr/model';

type Profile=Policy['profiles'][number];
const skill=(id:string,title:string,level:number,future=false):Statement=>({id,principle:'Technical',text:`${title} at level ${level}`,skillTitle:title,skillLevel:level,future});
const profile=(id:string,overrides:Partial<Profile>={}):Profile=>({id,name:id,grade:'12',companyId:'company',department:'Engineering',jobTitle:'Engineer',track:'Engineering',sector:'Technology',competencies:[skill('a','Delivery',2)],...overrides});
const identity={companyId:'company',employmentId:'employment',department:'Engineering',title:'Engineer',grade:'12'};

describe('source technical architecture and career rules',()=>{
 it('uses exact role before self-pick, then title-grade and title with deterministic ties',()=>{
  const exact=profile('z'),other=profile('a',{department:'Operations'}),picked=profile('picked',{jobTitle:'Designer'});
  expect(resolveTechnicalProfile([other,exact,picked],identity,'picked')).toMatchObject({profile:{id:'z'},source:'roster'});
  expect(resolveTechnicalProfile([other,picked],identity,'picked')).toMatchObject({profile:{id:'picked'},source:'self'});
  expect(resolveTechnicalProfile([profile('b',{department:'Finance'}),other],identity)).toMatchObject({profile:{id:'a'},source:'title_grade'});
  expect(resolveTechnicalProfile([other],{...identity,grade:'13'})).toMatchObject({source:'title'});
  expect(resolveTechnicalProfile([profile('private',{companyId:'other'})],identity)).toBeNull();
 });
 it('keeps explicit current skill levels before deriving unique future levels',()=>{
  const level2=skill('two','Delivery',2),level3=skill('three','Delivery',3),level4=skill('four','Delivery',4);
  const planned=technicalProfilePlan(profile('role',{competencies:[level2,level3]}),[level2,level3,level4]);
  expect(planned.map(s=>[s.id,s.future])).toEqual([['two',false],['three',false],['four',true]]);
  expect(technicalProfilePlan(profile('ceiling',{competencies:[level4]}),[level4])).toEqual([level4]);
 });
 it('uses reviewed manager answers for career evidence, while self planning can use submitted claims',()=>{
  const rated=(s:Statement,self:'yes'|'no',manager:'yes'|'no'|null):Competency=>({...s,self,manager,managerRemark:''});
  const rows=[{status:'reviewed',competencies:[rated(skill('a','Delivery',2),'no','yes'),rated(skill('b','Design',3),'yes','no')]},{status:'submitted',competencies:[rated(skill('c','Delivery',4),'yes',null)]}];
  expect(demonstratedSkills(rows)).toEqual({Delivery:2});expect(demonstratedSkills(rows,true)).toEqual({Delivery:4});
 });
 it('separates missing evidence, proficiency gaps and met requirements',()=>{
  const target=profile('target',{competencies:[skill('a','Delivery',3),skill('b','Design',2),skill('c','Analysis',1)]});
  expect(careerGap({Delivery:2,Design:2},target)).toMatchObject({total:3,met:1,stretch:1,missing:1,pct:33,rows:[{title:'Analysis',have:null,state:'missing'},{title:'Delivery',have:2,state:'stretch'},{title:'Design',have:2,state:'met'}]});
 });
 it('measures overlap against the current role, ranks readiness, applies pins/hides and never suggests a lower grade',()=>{
  const current=profile('current',{competencies:[skill('a','Delivery',2),skill('b','Design',2)]});
  const broad=profile('broad',{grade:'13',competencies:[skill('a','Delivery',3),skill('b','Design',3),skill('c','Analysis',2)]});
  const ready=profile('ready',{competencies:[skill('b','Design',2)]});
  const lower=profile('lower',{grade:'H'}),pinned=profile('pinned',{track:'Finance',competencies:[skill('c','Audit',2)]});
  const routes=careerRoutes(current,[broad,ready,lower,pinned],{Design:2},[{fromProfileId:'current',toProfileId:'pinned',kind:'pinned'}]);
  expect(routes.map(r=>r.profile.id)).toEqual(['pinned','ready','broad']);
  expect(routes.find(r=>r.profile.id==='broad')).toMatchObject({overlap:100,readiness:0,group:'longer'});
  expect(routes.find(r=>r.profile.id==='ready')).toMatchObject({overlap:50,readiness:100,group:'closest'});
  expect(careerRoutes(current,[ready],{},[{fromProfileId:'current',toProfileId:'ready',kind:'hidden'}])).toEqual([]);
  expect(careerRoutes(current,[ready],{})).toMatchObject([{readiness:null,group:'related'}]);
 });
});
