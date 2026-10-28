/**
 * TEMPORARY CI DIAGNOSTIC (not for merge): where does the BG CEO's calibration read spend its time after 0667?
 * Same fixture as test/onehr-service-talent-box.test.ts. Each variant swaps hot-path function definitions inside this
 * worker's own database (test/env.ts gives each worker its own database), measures, and restores 0667.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
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
const file=(name:string)=>readFileSync(new URL(`../db/migrations/${name}`,import.meta.url),'utf8');
/** The CREATE [OR REPLACE] FUNCTION app.<name>(...) AS $$ ... $$; statement that starts on `line` of `name`. */
function statement(name:string,fn:string,line:number){
 const text=file(name),re=new RegExp(`CREATE (?:OR REPLACE )?FUNCTION app\\.${fn}\\([\\s\\S]*?AS \\$\\$[\\s\\S]*?\\$\\$;`,'g');
 for(const m of text.matchAll(re)){const at=text.slice(0,m.index).split('\n').length;if(at===line)return m[0].replace(/^CREATE FUNCTION/,'CREATE OR REPLACE FUNCTION');}
 throw Error(`${fn} not found at ${name}:${line}`);
}
const U='0667_onehr_unit_exclusion.sql';
const current={participates:statement(U,'assessment_review_participates',444),manager:statement(U,'onehr_manager',471),moderator:statement(U,'onehr_moderator',476),header:statement(U,'onehr_review_header',482),inputs:statement(U,'onehr_assessment_inputs',621),seats:statement(U,'onehr_calibration_seat_users',629),reviewer:statement(U,'onehr_calibration_reviewer',648)};
const pre0667=[statement('0540_performance_journey_parity.sql','assessment_review_participates',40),statement('0529_onehr_native.sql','onehr_manager',22),statement('0540_performance_journey_parity.sql','onehr_moderator',345),statement('0529_onehr_native.sql','onehr_review_header',33),statement('0540_performance_journey_parity.sql','onehr_assessment_inputs',370),statement('0663_onehr_leader_seats.sql','onehr_calibration_seat_users',439),statement('0663_onehr_leader_seats.sql','onehr_calibration_reviewer',461)];
function swap(text:string,from:string,to:string){if(!text.includes(from))throw Error(`missing: ${from}`);return text.split(from).join(to);}
const G=(c:string)=>`(EXISTS(SELECT 1 FROM performance_assessment_unit_exclusion ux WHERE ux.tenant_id=app.current_tenant_id() AND ux.cycle_id=${c} AND ux.ended_at IS NULL) OR EXISTS(SELECT 1 FROM performance_assessment_unit_exclusion_pin up WHERE up.tenant_id=app.current_tenant_id() AND up.cycle_id=${c}))`;
const offset0=[swap(current.inputs,') AS ok) pm',') AS ok OFFSET 0) pm')];
const guards=[
 swap(swap(current.inputs,') AS ok) pm',') AS ok OFFSET 0) pm'),'(pm.ok OR app.onehr_effective_reviewer(r.review_id))',`(pm.ok OR ${G('r.cycle_id')} AND app.onehr_effective_reviewer(r.review_id))`),
 swap(swap(current.participates,'(NOT app.assessment_unit_excluded(r.cycle_id,r.employment_id) OR',`(NOT ${G('r.cycle_id')} OR NOT app.assessment_unit_excluded(r.cycle_id,r.employment_id) OR`),'OR app.onehr_effective_reviewer(r.id) OR',`OR ${G('r.cycle_id')} AND app.onehr_effective_reviewer(r.id) OR`),
 swap(current.reviewer,'AND NOT app.onehr_user_unit_excluded(s.cycle_id,u.id)',`AND (NOT ${G('s.cycle_id')} OR NOT app.onehr_user_unit_excluded(s.cycle_id,u.id))`),
 swap(current.seats,'AND NOT app.assessment_unit_excluded(s.cycle_id,e.id)',`AND (NOT ${G('s.cycle_id')} OR NOT app.assessment_unit_excluded(s.cycle_id,e.id))`),
 swap(current.manager,'AND NOT app.assessment_unit_excluded(r.cycle_id,e.id))',`AND (NOT ${G('r.cycle_id')} OR NOT app.assessment_unit_excluded(r.cycle_id,e.id)))`),
 swap(current.moderator,'AND NOT app.assessment_unit_excluded(r.cycle_id,m.id)',`AND (NOT ${G('r.cycle_id')} OR NOT app.assessment_unit_excluded(r.cycle_id,m.id))`),
];
const restore=Object.values(current);
const variants:Record<string,string[]>={current:[],pre0667,offset0,guards};
class Rollback extends Error {}

describe('DIAG 0667 hot path (temporary)',()=>{
 let b:Base,a:SessionContext,cycleA:string,bgCeo:SessionContext,subjects:Hired[];
 const hire=(name:string,companyId:string,departmentId:string)=>hireEmployee(a,{person:{fullName:name,primaryEmail:`${randomUUID()}@diag.test`},companyId,departmentId,employmentType:'full_time',hiredOn:`${year-2}-01-01`});
 async function userCtx(personId:string):Promise<SessionContext>{const userId=await createAppUser(b.tenantId,personId,'manager');return {tenantId:b.tenantId,userId,personId,roles:['manager'],grants:[{role:'manager',companyId:null}],entitlements:a.entitlements};}
 async function reviewOf(cycleId:string,e:Hired){const [r]=await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,cycleId),eq(schema.performanceReview.employmentId,e.employmentId)));return r.id;}
 async function fixture(){
  await resetDb();b=await seedBase();await setModule(b.tenantId,'performance','active');a=await entitledCtx(b);
  subjects=[];for(let i=0;i<10;i++)subjects.push(await hire(`Box subject ${i}`,b.companyId,i<5?b.deptA:b.deptB));
  await hire('BU chief executive',b.companyId,b.deptA);const bg=await hire('BG chief executive',b.companyId,b.deptA);await hire('Group chief',b.companyId,b.deptA);
  const {id:coB}=await createCompany(a,{legalName:'Box Other Sdn Bhd'});const deptB=await createDepartment(a,{companyId:coB,name:'Other dept'});await hire('Other company subject',coB,deptB.id);
  const [grade]=await owner.db.insert(schema.jobGrade).values({tenantId:b.tenantId,code:'12',name:'Grade 12'}).returning();
  await owner.db.update(schema.employment).set({gradeId:grade.id}).where(eq(schema.employment.tenantId,b.tenantId));
  const {cycleId}=await perf.createCycle(a,{name:'Box annual',companyId:b.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`});
  const policy=defaultPolicy(framework);policy.talentBox={moveCap:{enabled:true,pct:20}};await perf.configureOnehrCycle(a,cycleId,null,policy);await perf.openCycle(a,{cycleId});cycleA=cycleId;
  bgCeo=await userCtx(bg.personId);
  const id=await perf.createOnehrCalibration(a,cycleA,{name:'bg box',companyId:b.companyId,tier:'bg',reviewerUserIds:[bgCeo.userId!],reviewIds:await Promise.all(subjects.map(p=>reviewOf(cycleA,p))),pbtAchievement:null,mode:'after'});
  const [rev]=await owner.db.select({reviewer:schema.performanceReview.reviewerEmploymentId}).from(schema.performanceReview).where(eq(schema.performanceReview.cycleId,cycleA));
  return {id,reviewerIsNull:rev.reviewer==null};
 }
 async function apply(ddl:string[]){for(const s of ddl)await owner.db.execute(sql.raw(s));}
 /** One owner transaction: swap definitions, become the app role with the BG CEO's context, run the reads, roll back. */
 async function profile(label:string,id:string,ddl:string[],jit=true){
  let out:unknown=null;
  try{await owner.db.transaction(async tx=>{
   for(const s of ddl)await tx.execute(sql.raw(s));
   await tx.execute(sql.raw(`set local track_functions='all'`));if(!jit)await tx.execute(sql.raw('set local jit=off'));
   await tx.execute(sql.raw('set local role ai_hr_app'));
   await tx.execute(sql`select set_config('app.tenant_id', ${bgCeo.tenantId}, true), set_config('app.user_id', ${bgCeo.userId!}, true), set_config('app.roles', 'manager', true), set_config('app.grants', ${JSON.stringify(bgCeo.grants)}, true)`);
   const t0=performance.now();
   for(let i=0;i<2;i++)await perf.getOnehrCalibrationTx(tx,bgCeo,id,'both','all');
   const t1=performance.now();
   for(let i=0;i<2;i++)await perf.getOnehrCalibrationTx(tx,bgCeo,id,'both','roster');
   const t2=performance.now();
   const view=await perf.getOnehrCalibrationTx(tx,bgCeo,id,'both','roster');
   const t3=performance.now();
   await perf.saveOnehrCalibrationTx(tx,bgCeo,id,view.session.revision,{reviewId:view.rows[0].entry.reviewId,axis:'performance',performance:'ME',potential:null,performanceNote:'',potentialNote:''},true,false,{enforceMoveCap:true});
   const t4=performance.now();
   const fns=await tx.execute<{f:string;calls:number;total:string;self:string}>(sql.raw(`select funcname as f, calls, round(total_time::numeric,1)::text as total, round(self_time::numeric,1)::text as self from pg_stat_xact_user_functions order by self_time desc limit 30`));
   const sum=await tx.execute<{calls:string;self:string}>(sql.raw(`select sum(calls)::text as calls, round(sum(self_time)::numeric,1)::text as self from pg_stat_xact_user_functions`));
   out={label,jit,allViewsMs:Math.round(t1-t0),rosterViewsMs:Math.round(t2-t1),dryRunMoveMs:Math.round(t4-t3),totalCalls:sum[0]?.calls,totalSelfMs:sum[0]?.self,top:fns.map(r=>`${r.f} calls=${r.calls} total=${r.total} self=${r.self}`)};
   throw new Rollback();
  });}catch(e){if(!(e instanceof Rollback))throw e;}
  console.log(`DIAG-PROFILE ${JSON.stringify(out)}`);return out;
 }
 /** The chat test's body, end to end through the app pool, with the variant committed in this worker database. */
 async function chatScenario(id:string){
  const ids=await Promise.all(subjects.map(s=>reviewOf(cycleA,s)));
  const chat=async(text:string)=>perf.sendCalibrationMessage(bgCeo,id,'both',(await perf.getCalibrationConversation(bgCeo,id,'both')).revision,randomUUID(),text);
  const band=async(reviewId:string)=>(await perf.getOnehrCalibration(bgCeo,id)).rows.find(r=>r.entry.reviewId===reviewId)?.entry.performance;
  const t0=performance.now();
  await chat('Set performance: Box subject 0: ME: Verified delivery in the calibration meeting.');
  await chat('Set performance: Box subject 1: ME: Verified delivery in the calibration meeting.');
  expect([await band(ids[0]),await band(ids[1])]).toEqual(['ME','ME']);
  await expect(chat('Set performance: Box subject 2: ME: Verified delivery in the calibration meeting.')).rejects.toThrow(/used up: 2 of 2/);
  expect(await band(ids[2])).toBeNull();
  await chat('Set performance: Box subject 0: AE: A correction inside the category.');
  expect(await band(ids[0])).toBe('AE');
  return Math.round(performance.now()-t0);
 }
 afterAll(async()=>{await apply(restore);await closeAll();});

 it('profiles the BG CEO read and the chat scenario under each variant',async()=>{
  const {id,reviewerIsNull}=await fixture();
  console.log(`DIAG-FIXTURE reviewerIsNull=${reviewerIsNull} preStarts=${JSON.stringify(pre0667.map(s=>s.slice(0,80)))}`);
  for(const round of [1,2])for(const [label,ddl] of Object.entries(variants))await profile(`${label}#${round}`,id,ddl);
  await profile('current-jitoff',id,[],false);
  for(const round of [1,2])for(const [label,ddl] of Object.entries(variants)){
   await apply(restore);await apply(ddl);const {id:fresh}=await fixture();
   const ms=await chatScenario(fresh);console.log(`DIAG-CHAT ${label}#${round} ms=${ms}`);
  }
  await apply(restore);
 },900_000);
});
