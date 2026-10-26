import {publishAssessmentCatalogueTx} from './catalogue-default-service';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type SessionContext, type Tx } from '../../../db/client';
import { assignment, assessmentCareerProfile, department, employment, onehrCycle, onehrReview, person, position } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { todayInKualaLumpur } from '../../../lib/hr-date';
import { loadAssessmentAdminCycleTx as load, auditAssessmentAdminTx as event } from './admin-context';
import { importArchitecture, type architectureSheets } from './architecture-model';
import { resolveTechnicalProfile, technicalProfilePlan } from './career-model';
import { careerSchema, policySchema, type Policy } from './model';
import { onehrLabel } from './person-labels';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stableId=(cycleId:string,key:string)=>{const h=digest([cycleId,key]);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
async function save(tx:Tx,ctx:SessionContext,cycleId:string,revision:number,previous:Policy,policy:Policy){
 // Company and employment references must stay inside this administrator's native scope.
 for(const p of policy.profiles){
  if(p.companyId){const [scope]=await tx.execute<{ok:boolean}>(sql`select app.onehr_admin(${p.companyId}::uuid) as ok`);if(!scope?.ok)throw Error('A profile company is outside your scope.');}
  for(const id of p.employmentIds??[]){const [e]=await tx.select({id:employment.id,companyId:employment.companyId}).from(employment).where(eq(employment.id,id));if(!e||p.companyId&&e.companyId!==p.companyId)throw Error('A profile assignment is outside its company.');}
 }
 await publishAssessmentCatalogueTx(tx,ctx,cycleId,previous,policy);
 await tx.update(onehrCycle).set({policy,revision:revision+1}).where(eq(onehrCycle.cycleId,cycleId));
}
export async function importAssessmentArchitecture(ctx:SessionContext,cycleId:string,sheets:Record<typeof architectureSheets[number],string>,token?:string){
 return withPerformanceTenant(ctx,async tx=>{
  const v=await load(tx,cycleId),result=importArchitecture(v.policy,sheets,v.cycle.companyId,key=>stableId(cycleId,key));
  const current=digest({revision:v.config.revision,policy:v.policy,sheets});
  if(token&&token!==current)throw Error('The catalogue changed. Preview the workbook again.');
  if(token){await save(tx,ctx,cycleId,v.config.revision,v.policy,result.policy);await event(tx,ctx,cycleId,'architecture-imported',{skills:result.skills,profiles:result.profiles,links:result.links,skipped:result.skipped,digest:digest(result.policy)});}
  return {token:current,skills:result.skills,profiles:result.profiles,links:result.links,skipped:result.skipped,applied:!!token};
 });
}
const profileInput=policySchema.shape.profiles.element.omit({id:true,employmentIds:true}).strict();
export async function saveAssessmentCatalogueProfile(ctx:SessionContext,cycleId:string,expected:number,id:string|null,raw:unknown){
 const input=profileInput.parse(raw);if(id)z.uuid().parse(id);
 return withPerformanceTenant(ctx,async tx=>{
  const v=await load(tx,cycleId);if(v.config.revision!==expected)throw Error('The catalogue changed. Reload before saving.');
  if(id&&!v.policy.profiles.some(p=>p.id===id))throw Error('Profile not found.');
  const previous=v.policy.profiles.find(p=>p.id===id);
  const key=(p:{department?:string;jobTitle?:string;name:string;grade:string;companyId:string|null})=>JSON.stringify([p.companyId,(p.department??'').trim().toUpperCase(),(p.jobTitle??p.name).trim().toUpperCase(),p.grade.trim().toUpperCase()]);
  if(v.policy.profiles.some(p=>p.id!==id&&key(p)===key(input)))throw Error('That company, department, title and grade already has a profile.');
  const next={...previous,...input,id:id??crypto.randomUUID(),...(previous?.employmentIds?{employmentIds:previous.employmentIds}:{})};
  const policy=policySchema.parse({...v.policy,profiles:[...v.policy.profiles.filter(p=>p.id!==id),next]});
  await save(tx,ctx,cycleId,v.config.revision,v.policy,policy);await event(tx,ctx,cycleId,'catalogue-profile-saved',{profileId:next.id,active:next.active!==false,digest:digest(next)});
  return next.id;
 });
}
export async function setAssessmentCareerRoute(ctx:SessionContext,cycleId:string,expected:number,fromProfileId:string,toProfileId:string,kind:'pinned'|'hidden'|'automatic'){
 z.uuid().parse(fromProfileId);z.uuid().parse(toProfileId);z.enum(['pinned','hidden','automatic']).parse(kind);
 return withPerformanceTenant(ctx,async tx=>{
  const v=await load(tx,cycleId);if(v.config.revision!==expected)throw Error('The catalogue changed. Reload before saving.');
  const routes=(v.policy.careerRoutes??[]).filter(r=>r.fromProfileId!==fromProfileId||r.toProfileId!==toProfileId);
  const policy=policySchema.parse({...v.policy,careerRoutes:[...routes,...(kind==='automatic'?[]:[{fromProfileId,toProfileId,kind}])]});
  await save(tx,ctx,cycleId,v.config.revision,v.policy,policy);await event(tx,ctx,cycleId,'career-route-saved',{fromProfileId,toProfileId,kind});
 });
}
/** A preview and its apply use the same resolver, snapshots and started-assessment guard. */
export async function generateAssessmentProfiles(ctx:SessionContext,cycleId:string,token?:string){
 return withPerformanceTenant(ctx,async tx=>{
  const v=await load(tx,cycleId);if(!v.policy.modules.tm)throw Error('Competency assessment is disabled.');
  // ADR-0142: person row when readable (HR), else the label projection (performance partner).
  const reviews=await tx.select({row:onehrReview,name:onehrLabel.labelOrPerson(person.fullName,employment.id)}).from(onehrReview).innerJoin(employment,eq(employment.id,onehrReview.employmentId)).leftJoin(person,eq(person.id,employment.personId)).where(and(eq(onehrReview.cycleId,cycleId),sql`(${person.id} is not null or ${onehrLabel.visible(employment.id)})`)).orderBy(asc(onehrReview.reviewId)).for('update',{of:onehrReview});
  const report:{reviewId:string;name:string;profile:string|null;status:'assign'|'started'|'manual'|'empty'|'unmapped'|'not_part';count:number}[]=[],plans=new Map<string,{profileId:string;profileMatch:string;competencies:ReturnType<typeof technicalProfilePlan>}>();
  for(const {row:r,name} of reviews){
   const [guards]=await tx.execute<{self:boolean;participates:boolean;started:boolean}>(sql`select exists(select 1 from employment e where e.id=${r.employmentId}::uuid and app.is_self_person(e.person_id)) as self, app.assessment_review_participates(${r.reviewId}::uuid) as participates,app.assessment_competency_started(${r.reviewId}::uuid) as started`);
   const base={reviewId:r.reviewId,name,profile:null,count:0};
   if(!guards.participates){report.push({...base,status:'not_part'});continue;}
   if(guards.self||r.profileMatch==='assigned'){report.push({...base,status:'manual'});continue;}
   if(guards.started){report.push({...base,status:'started'});continue;}
   const [role]=await tx.select({department:department.name,title:position.title}).from(assignment).innerJoin(department,eq(department.id,assignment.departmentId)).leftJoin(position,eq(position.id,assignment.positionId)).where(and(eq(assignment.employmentId,r.employmentId),isNull(assignment.supersededAt),sql`${assignment.validFrom}<=${todayInKualaLumpur()}::date and (${assignment.validTo} is null or ${assignment.validTo}>${todayInKualaLumpur()}::date)`)).orderBy(desc(assignment.validFrom),asc(assignment.id)).limit(1);
   const [career]=await tx.select().from(assessmentCareerProfile).where(eq(assessmentCareerProfile.employmentId,r.employmentId));
   const picked=resolveTechnicalProfile(v.policy.profiles,{companyId:r.companyId,employmentId:r.employmentId,department:role?.department??'',title:role?.title??'',grade:r.grade},career?careerSchema.parse(career.career).selfProfileId:null);
   if(!picked){report.push({...base,status:'unmapped'});continue;}
   const competencies=technicalProfilePlan(picked.profile,v.policy.skills??[]);
   if(!competencies.length){report.push({...base,profile:picked.profile.name,status:'empty'});continue;}
   report.push({...base,profile:picked.profile.name,status:'assign',count:competencies.length});plans.set(r.reviewId,{profileId:picked.profile.id,profileMatch:picked.source,competencies});
  }
  const current=digest({revision:v.config.revision,reviews:reviews.map(r=>({id:r.row.reviewId,revision:r.row.revision})),report,plans:[...plans]});
  if(token&&token!==current)throw Error('The people, catalogue or assessments changed. Preview generation again.');
  if(token){
   for(const [id,p] of plans)await tx.update(onehrReview).set({profileId:p.profileId,profileMatch:p.profileMatch,competencies:p.competencies.map(s=>({...s,self:null,manager:null,selfRemark:'',managerRemark:''})),revision:sql`${onehrReview.revision}+1`}).where(eq(onehrReview.reviewId,id));
   await event(tx,ctx,cycleId,'competency-profiles-generated',{people:plans.size,statements:report.reduce((n,r)=>n+r.count,0),skipped:report.filter(r=>r.status!=='assign').length});
  }
  return {token:current,rows:report,applied:!!token};
 });
}
