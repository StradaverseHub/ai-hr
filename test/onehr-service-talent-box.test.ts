/**
 * P1 WP-D — the Talent Box writer against real RLS (every call is the persona's app-role session via the service).
 * Pins: APR-011 reason on every changed band at BU, BG and Group (C4); the source's movement ceiling, enforced in the
 * writer and on the leader's chat move (D-P1-11); the generic leader form needing the same reason; the Group box over both axes with its own per-person lock; BU closing after the BG lock; no self move; no
 * move outside the reviewer's session.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { createCompany, createDepartment } from '../core/admin';
import { hireEmployee } from '../core/org';
import * as perf from '../packs/performance/service';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

const year=Number(todayInKualaLumpur().slice(0,4));
type Hired={employmentId:string;personId:string};

describe('Talent Box moves (real RLS)',()=>{
 let b:Base,a:SessionContext,coB:string,cycleA:string,cycleB:string;
 let buCeo:SessionContext,bgCeo:SessionContext,chief:SessionContext,chiefPerson:Hired,subjects:Hired[],subjectB:Hired,reviewerB:SessionContext;
 const hire=(name:string,companyId:string,departmentId:string)=>hireEmployee(a,{person:{fullName:name,primaryEmail:`${randomUUID()}@talent-box.test`},companyId,departmentId,employmentType:'full_time',hiredOn:`${year-2}-01-01`});
 async function userCtx(personId:string):Promise<SessionContext>{const userId=await createAppUser(b.tenantId,personId,'manager');return {tenantId:b.tenantId,userId,personId,roles:['manager'],grants:[{role:'manager',companyId:null}],entitlements:a.entitlements};}
 async function cycle(name:string,companyId:string,cap:number|null){
  const {cycleId}=await perf.createCycle(a,{name,companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`});
  const policy=defaultPolicy(framework);if(cap!=null)policy.talentBox={moveCap:{enabled:true,pct:cap}};
  await perf.configureOnehrCycle(a,cycleId,null,policy);await perf.openCycle(a,{cycleId});return cycleId;
 }
 async function reviewOf(cycleId:string,e:Hired){const [r]=await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,cycleId),eq(schema.performanceReview.employmentId,e.employmentId)));return r.id;}
 async function session(cycleId:string,tier:'hod'|'bu'|'bg'|'group',companyId:string|null,reviewer:SessionContext,people:Hired[]){
  return perf.createOnehrCalibration(a,cycleId,{name:`${tier} box ${randomUUID().slice(0,6)}`,companyId,tier,reviewerUserIds:[reviewer.userId!],reviewIds:await Promise.all(people.map(p=>reviewOf(cycleId,p))),pbtAchievement:null,mode:'after'});
 }
 const revision=async(ctx:SessionContext,id:string)=>(await perf.getOnehrCalibration(ctx,id)).session.revision;
 const move=async(ctx:SessionContext,id:string,reviewId:string,bands:{performance?:'UA'|'BE'|'ME'|'AE'|'OU';potential?:'Low'|'Mid'|'High'},note='Discussed in the calibration meeting.')=>
  perf.moveAssessmentTalentBox(ctx,id,await revision(ctx,id),{reviewId,performance:bands.performance??null,potential:bands.potential??null,performanceNote:note,potentialNote:note});

 beforeEach(async()=>{
  await resetDb();b=await seedBase();await setModule(b.tenantId,'performance','active');a=await entitledCtx(b);
  subjects=[];for(let i=0;i<10;i++)subjects.push(await hire(`Box subject ${i}`,b.companyId,i<5?b.deptA:b.deptB));
  const bu=await hire('BU chief executive',b.companyId,b.deptA),bg=await hire('BG chief executive',b.companyId,b.deptA);chiefPerson=await hire('Group chief',b.companyId,b.deptA);
  ({id:coB}=await createCompany(a,{legalName:'Box Other Sdn Bhd'}));const deptB=await createDepartment(a,{companyId:coB,name:'Other dept'});
  subjectB=await hire('Other company subject',coB,deptB.id);const otherReviewer=await hire('Other company reviewer',coB,deptB.id);
  const [grade]=await owner.db.insert(schema.jobGrade).values({tenantId:b.tenantId,code:'12',name:'Grade 12'}).returning();
  await owner.db.update(schema.employment).set({gradeId:grade.id}).where(eq(schema.employment.tenantId,b.tenantId));
  cycleA=await cycle('Box annual',b.companyId,20);cycleB=await cycle('Other annual',coB,null);
  buCeo=await userCtx(bu.personId);bgCeo=await userCtx(bg.personId);chief=await userCtx(chiefPerson.personId);reviewerB=await userCtx(otherReviewer.personId);
 });
 afterAll(closeAll);

 it('demands a reason for every changed band on the box at BU, BG and Group, and leaves an unchanged move free',async()=>{
  const reviewId=await reviewOf(cycleA,subjects[0]);
  for(const [tier,ctx] of [['bu',buCeo],['bg',bgCeo],['group',chief]] as const){
   const id=await session(cycleA,tier,tier==='group'?null:b.companyId,ctx,[subjects[0]]);
   await expect(move(ctx,id,reviewId,{performance:'ME'},''),tier).rejects.toThrow(/Explain each changed band/);
   await expect(move(ctx,id,reviewId,{potential:'High'},'   '),tier).rejects.toThrow(/Explain each changed band/);
   expect((await perf.getOnehrCalibration(ctx,id)).rows[0].entry,tier).toMatchObject({performance:null,potential:null});
   await move(ctx,id,reviewId,{performance:'UA',potential:'Low'},'');// the defaults it already sits on: nothing is decided
   expect(await revision(ctx,id),tier).toBe(1);
   await move(ctx,id,reviewId,{performance:'ME',potential:'High'});
   expect((await perf.getOnehrCalibration(ctx,id)).rows[0].entry,tier).toMatchObject({performance:'ME',potential:'High',performanceNote:'Discussed in the calibration meeting.',potentialNote:'Discussed in the calibration meeting.'});
  }
  // HOD keeps its own path: the box writer is not theirs.
  const hod=await session(cycleA,'hod',b.companyId,buCeo,[subjects[1]]);
  await expect(move(buCeo,hod,await reviewOf(cycleA,subjects[1]),{performance:'ME'})).rejects.toThrow(/belongs to the Talent Box/);
 });

 it('demands the same reason on the generic calibration form at BU and BG, leaves an unchanged band free, and does not cap the form',async()=>{
  const reviewId=await reviewOf(cycleA,subjects[0]);
  const save=async(ctx:SessionContext,id:string,bands:{performance?:'UA'|'BE'|'ME'|'AE'|'OU';potential?:'Low'|'Mid'|'High'},note='')=>
   perf.saveOnehrCalibration(ctx,id,await revision(ctx,id),{reviewId,axis:'both',performance:bands.performance??null,potential:bands.potential??null,performanceNote:note,potentialNote:note});
  // One BG scope per person per cycle: the BG checks run on a session over all ten (20% → 2 category changes).
  const ids=await Promise.all(subjects.map(s=>reviewOf(cycleA,s))),bg=await session(cycleA,'bg',b.companyId,bgCeo,subjects);
  const entry=async(ctx:SessionContext,id:string,r=reviewId)=>(await perf.getOnehrCalibration(ctx,id)).rows.find(x=>x.entry.reviewId===r)!.entry;
  for(const [tier,ctx] of [['bu',buCeo],['bg',bgCeo]] as const){
   const id=tier==='bu'?await session(cycleA,'bu',b.companyId,ctx,[subjects[0]]):bg;
   await expect(save(ctx,id,{performance:'ME'}),tier).rejects.toThrow(/Explain each changed band/);
   await expect(save(ctx,id,{potential:'High'},'  '),tier).rejects.toThrow(/Explain each changed band/);
   expect(await entry(ctx,id),tier).toMatchObject({performance:null,potential:null});
   await save(ctx,id,{performance:'UA',potential:'Low'});// the bands it already shows: no reason needed
   await save(ctx,id,{performance:'ME',potential:'High'},'Discussed in the calibration meeting.');
   expect(await entry(ctx,id),tier).toMatchObject({performance:'ME',potential:'High',performanceNote:'Discussed in the calibration meeting.'});
  }
  // The ceiling belongs to the box and its chat, not to the form: the box spends the unit's allowance (2 of 2) until
  // it refuses a move, and the form then saves that same change with its reason.
  let refused:string|null=null;
  for(const id of ids.slice(1)){try{await move(bgCeo,bg,id,{performance:'ME'});}catch(e){expect(String(e)).toMatch(/used up: 2 of 2/);refused=id;break;}}
  expect(refused,'the box refused a move once the allowance was used').not.toBeNull();
  await perf.saveOnehrCalibration(bgCeo,bg,await revision(bgCeo,bg),{reviewId:refused!,axis:'performance',performance:'ME',potential:null,performanceNote:'Form decision with its reason.',potentialNote:''});
  expect((await entry(bgCeo,bg,refused!)).performance).toBe('ME');
 });

 it('allows the Nth category change in a unit, refuses the next, and gives the allowance back when someone returns',async()=>{
  const id=await session(cycleA,'bg',b.companyId,bgCeo,subjects);// 10 people at 20% → 2 category changes
  const ids=await Promise.all(subjects.map(s=>reviewOf(cycleA,s)));
  expect((await perf.getOnehrCalibration(bgCeo,id)).talentBox).toMatchObject({grid:9,cap:{pct:20,units:{[b.companyId]:{headcount:10,used:0,cap:2,left:2}}}});
  await move(bgCeo,id,ids[0],{performance:'ME'});// UA/Low (PIP) → ME/Low (Solid Core)
  await move(bgCeo,id,ids[1],{performance:'ME'});
  await move(bgCeo,id,ids[0],{performance:'AE'});// still Solid Core: a correction inside a category is free
  await expect(move(bgCeo,id,ids[2],{performance:'ME'})).rejects.toThrow(/limit .* used up: 2 of 2 \(20% of 10 people\)/);
  await move(bgCeo,id,ids[2],{performance:'BE'});// UA → BE stays PIP/Improvement
  expect((await perf.getOnehrCalibration(bgCeo,id)).talentBox.cap?.units[b.companyId]).toMatchObject({used:2,left:0});
  await move(bgCeo,id,ids[1],{performance:'UA'});// back to the origin category
  await move(bgCeo,id,ids[2],{performance:'ME'});
  expect((await perf.getOnehrCalibration(bgCeo,id)).rows.find(r=>r.entry.reviewId===ids[2])?.entry.performance).toBe('ME');
  // Without the policy block there is no ceiling (the source ships it paused).
  const other=await session(cycleB,'bu',coB,reviewerB,[subjectB]);
  expect((await perf.getOnehrCalibration(reviewerB,other)).talentBox.cap).toBeNull();
 });

 it('holds the box ceiling on a BG CEO’s chat move (the box and its chat share one move), within and past the allowance',async()=>{
  const id=await session(cycleA,'bg',b.companyId,bgCeo,subjects);// 10 people at 20% → 2 category changes
  const ids=await Promise.all(subjects.map(s=>reviewOf(cycleA,s)));
  const chat=async(text:string)=>perf.sendCalibrationMessage(bgCeo,id,'both',(await perf.getCalibrationConversation(bgCeo,id,'both')).revision,randomUUID(),text);
  const band=async(reviewId:string)=>(await perf.getOnehrCalibration(bgCeo,id)).rows.find(r=>r.entry.reviewId===reviewId)?.entry.performance;
  await chat('Set performance: Box subject 0: ME: Verified delivery in the calibration meeting.');// PIP → Solid Core
  await chat('Set performance: Box subject 1: ME: Verified delivery in the calibration meeting.');
  expect([await band(ids[0]),await band(ids[1])]).toEqual(['ME','ME']);
  await expect(chat('Set performance: Box subject 2: ME: Verified delivery in the calibration meeting.')).rejects.toThrow(/limit .* used up: 2 of 2 \(20% of 10 people\)/);
  expect(await band(ids[2])).toBeNull();
  await chat('Set performance: Box subject 0: AE: A correction inside the category.');// free, as on the box
  expect(await band(ids[0])).toBe('AE');
  // One count: the box sees the chat's moves and refuses the third as well.
  await expect(move(bgCeo,id,ids[2],{performance:'ME'})).rejects.toThrow(/used up: 2 of 2/);
 });

 it('moves and locks both axes at Group, refusing a person’s locked call, and closes BU once BG locks',async()=>{
  const [r0,r1]=await Promise.all([reviewOf(cycleA,subjects[0]),reviewOf(cycleA,subjects[1])]);
  const group=await session(cycleA,'group',null,chief,[subjects[0],subjects[1]]);
  let v=await perf.getOnehrCalibration(chief,group);expect(v.axes).toEqual({pm:true,pot:true});expect(v.rows.every(r=>r.canWrite.pot)).toBe(true);
  await move(chief,group,r0,{potential:'High'});
  await perf.lockOnehrCalibration(chief,group,await revision(chief,group),'','potential',r0);
  await expect(move(chief,group,r0,{potential:'Mid'})).rejects.toThrow(/locked/);
  await move(chief,group,r1,{potential:'Mid'});
  await perf.lockOnehrCalibration(chief,group,await revision(chief,group),'','both');
  v=await perf.getOnehrCalibration(chief,group);
  expect(v.session.performanceLockedAt).toBeTruthy();expect(v.session.potentialLockedAt).toBeTruthy();expect(v.session.lockedAt).toBeTruthy();
  expect(v.rows.find(r=>r.entry.reviewId===r1)?.entry).toMatchObject({potential:'Mid',performanceLockedAt:expect.any(Date),potentialLockedAt:expect.any(Date)});
  await expect(move(chief,group,r1,{potential:'High'})).rejects.toThrow(/locked/);
  // Precedence: the BU box closes on a person once their BG call is locked.
  const bu=await session(cycleA,'bu',b.companyId,buCeo,[subjects[2]]),bg=await session(cycleA,'bg',b.companyId,bgCeo,[subjects[2]]),r2=await reviewOf(cycleA,subjects[2]);
  await move(buCeo,bu,r2,{performance:'ME'});
  await perf.lockOnehrCalibration(bgCeo,bg,await revision(bgCeo,bg),'');
  await expect(move(buCeo,bu,r2,{performance:'AE'})).rejects.toThrow(/BU calibration is closed after BG locks/);
 });

 it('refuses a self move and any move outside the reviewer’s own session',async()=>{
  const group=await session(cycleA,'group',null,chief,[subjects[0],chiefPerson]);
  await expect(move(chief,group,await reviewOf(cycleA,chiefPerson),{performance:'OU'})).rejects.toThrow(/cannot be calibrated by you/);
  expect((await perf.getOnehrCalibration(chief,group)).rows.map(r=>r.name)).toEqual(['Box subject 0']);
  const bu=await session(cycleA,'bu',b.companyId,buCeo,[subjects[0]]),other=await session(cycleB,'bu',coB,reviewerB,[subjectB]),rB=await reviewOf(cycleB,subjectB);
  // Another company's session is not visible to this BU CEO at all.
  await expect(perf.moveAssessmentTalentBox(buCeo,other,1,{reviewId:rB,performance:'OU',potential:null,performanceNote:'Outside my scope.',potentialNote:''})).rejects.toThrow(/not found|removed/);
  // Nor can a person from another company be named inside their own session.
  await expect(perf.moveAssessmentTalentBox(buCeo,bu,1,{reviewId:rB,performance:'OU',potential:null,performanceNote:'Outside my scope.',potentialNote:''})).rejects.toThrow(/cannot be calibrated by you/);
  expect((await perf.getOnehrCalibration(reviewerB,other)).rows[0].entry.performance).toBeNull();
 });
});
