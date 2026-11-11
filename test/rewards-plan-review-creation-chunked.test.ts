/**
 * Creating a plan's reviews holds the exclusive Access lock one company at a time (staging, 11 November 2026).
 *
 * createRewardPlanReviews used to create every company's review in one transaction, and each review re-read every
 * employee's OneHR result and architecture and wrote each entry with its own statements, all under the tenant's
 * exclusive Access lock: about 25 s at 71 companies of roughly 900 employees. It now checks the confirmed preview once
 * under the shared lock and creates each company in its own transaction, and a review writes its entries set-wise.
 *
 * Real PostgreSQL through the repository harness. A three-company plan (200 employees in the first company, one company
 * already reviewed) is created while an independent pg_locks sampler times every exclusive hold of the tenant's Access
 * key. The entries are compared with the per-entry owners the old loop called, the events with their old order, and a
 * stale preview still refuses.
 */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import postgres from 'postgres';
import {withTenant,type SessionContext} from '../db/client';
import {businessUnit,company,department,jobGrade} from '../db/schema';
import {hireEmployee} from '../core/org';
import {createRewardUnit} from '../packs/rewards/service';
import {createRewardPlanReviews,previewRewardPlanCreation} from '../packs/rewards/plan-configuration';
import {onehrRewardResultTx} from '../packs/performance/service';
import {rewardArchitectureForSourceTx} from '../packs/rewards/architecture-source';
import {deriveConfidentialityTx,sourceWithFloor} from '../packs/rewards/confidentiality';
import type {RewardSource} from '../packs/rewards/model';
import {createApprovedRewardPlan} from './rewards-setup-fixture';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const YEAR=2026,SNAPSHOT='2026-01-01',LARGE=200,SMALL=15,MAX_EXCLUSIVE_HOLD_MS=1000;
let raw:postgres.Sql;
beforeAll(async()=>{await migrateTestDb();raw=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:2,onnotice:()=>{}});});
beforeEach(resetDb);
afterAll(async()=>{await raw.end({timeout:5});await closeAll();});

function exclusiveSampler(tenantId:string){
 const holds=new Map<string,{first:number;last:number}>();let sampling=true;
 const loop=(async()=>{while(sampling){
  const rows=await raw<{pid:number;xact:string}[]>`select l.pid,a.xact_start::text as xact from pg_catalog.pg_locks l join pg_catalog.pg_stat_activity a on a.pid=l.pid
   cross join (select hashtextextended(${'access-configuration:'+tenantId},0) as k) target
   where l.locktype='advisory' and l.granted and l.objsubid=1 and l.mode='ExclusiveLock' and a.xact_start is not null
    and l.database=(select oid from pg_catalog.pg_database where datname=current_database())
    and l.classid::bigint=((target.k>>32)&4294967295) and l.objid::bigint=(target.k&4294967295)`;
  const now=performance.now();for(const r of rows){const id=r.pid+'|'+r.xact;const h=holds.get(id)??{first:now,last:now};h.last=now;holds.set(id,h);}
  await pause(5);
 }})();
 return async()=>{sampling=false;await loop;return [...holds.values()].map(h=>Math.round(h.last-h.first));};
}

type Target={companyId:string;businessUnitId:string;departmentId:string};
async function target(b:Base,n:number):Promise<Target>{
 const companyId=n===0?b.companyId:(await owner.db.insert(company).values({tenantId:b.tenantId,legalName:`Fictional review company ${n+1} Sdn Bhd`}).returning({id:company.id}))[0]!.id;
 const departmentId=n===0?b.deptA:(await owner.db.insert(department).values({tenantId:b.tenantId,companyId,name:'Fictional operations '+(n+1)}).returning({id:department.id}))[0]!.id;
 const [unit]=await owner.db.insert(businessUnit).values({tenantId:b.tenantId,companyId,code:'REVIEW-BU-'+(n+1),name:'Fictional business unit '+(n+1)}).returning({id:businessUnit.id});
 return {companyId,businessUnitId:unit!.id,departmentId};
}
async function hire(b:Base,t:Target,gradeId:string,count:number,label:string){
 for(let n=0;n<count;n++)await hireEmployee(adminCtx(b),{person:{fullName:`Fictional ${label} employee ${n+1}`,primaryEmail:randomUUID()+'@example.invalid'},
  companyId:t.companyId,departmentId:t.departmentId,businessUnitId:t.businessUnitId,gradeId,employeeCode:`${label}-${n+1}`,employmentType:'full_time',hiredOn:'2025-01-01'});
}
async function rewardEvents(tenantId:string){
 return [...await raw<{event_type:string;aggregate_id:string;payload:{companyId?:string}}[]>`select event_type,aggregate_id::text as aggregate_id,payload from domain_event
  where tenant_id=${tenantId}::uuid and (event_type='rewards-setup.review.skipped' or event_type='reward-unit.created') order by chain_seq nulls last,occurred_at,id`];
}

it('creates each company in its own short exclusive transaction with the entries, events and refusals of one transaction',async()=>{
 const b=await seedBase();await setModule(b.tenantId,'rewards','active');
 const [grade]=await owner.db.insert(jobGrade).values({tenantId:b.tenantId,code:'12',name:'Fictional grade 12',rank:12}).returning({id:jobGrade.id});
 const targets=[await target(b,0),await target(b,1),await target(b,2)];
 await hire(b,targets[0]!,grade!.id,LARGE,'LARGE');await hire(b,targets[1]!,grade!.id,SMALL,'SMALL');await hire(b,targets[2]!,grade!.id,SMALL,'DONE');
 const maker:SessionContext=adminCtx(b);
 const plan=await createApprovedRewardPlan(maker,{year:YEAR,companyId:targets[0]!.companyId,businessUnitId:targets[0]!.businessUnitId,snapshotDate:SNAPSHOT},undefined,
  targets.map(t=>({companyId:t.companyId,businessUnitId:t.businessUnitId})));
 // The third company is already reviewed, so the plan has two companies to create and one to skip.
 const existing=await createRewardUnit(maker,{name:plan.name,year:YEAR,companyId:targets[2]!.companyId,businessUnitId:targets[2]!.businessUnitId,snapshotDate:SNAPSHOT,approvedPlanVersionId:plan.versionId});
 const preview=await previewRewardPlanCreation(maker,plan.versionId);
 expect(preview.rows.map(row=>[row.companyId,row.status])).toEqual([[targets[0]!.companyId,'ready'],[targets[1]!.companyId,'ready'],[targets[2]!.companyId,'skip']]);
 const before=await rewardEvents(b.tenantId);
 const stop=exclusiveSampler(b.tenantId),started=performance.now();
 const result=await createRewardPlanReviews(maker,plan.versionId,preview.digest);
 const elapsedMs=Math.round(performance.now()-started),holds=await stop();
 console.log('[rewards-plan-review-creation]',JSON.stringify({employees:[LARGE,SMALL,SMALL],elapsedMs,exclusiveHoldsMs:holds}));
 // One exclusive transaction per company row, each within the bound; the preview check holds the lock shared.
 expect(holds).toHaveLength(3);
 expect(Math.max(...holds)).toBeLessThanOrEqual(MAX_EXCLUSIVE_HOLD_MS);
 expect(result.created).toHaveLength(2);
 expect(result.skipped.map(row=>[row.companyId,row.reason,row.existingUnitId])).toEqual([[targets[2]!.companyId,'already-reviewed',existing]]);
 // Events: the two creations then the skip, in the plan's company order, exactly as one transaction wrote them.
 const added=(await rewardEvents(b.tenantId)).slice(before.length);
 expect(added.map(event=>event.event_type==='reward-unit.created'?['created',event.aggregate_id]:['skipped',event.payload.companyId])).toEqual([
  ['created',result.created[0]],['created',result.created[1]],['skipped',targets[2]!.companyId]]);
 // Every entry carries what the per-entry owners return for it: OneHR result, architecture and confidentiality floor.
 for(const [index,unitId] of result.created.entries()){
  const entries=await raw<{employment_id:string;source:RewardSource;facts:{confidentiality:string}}[]>`select employment_id::text as employment_id,source,facts from reward_entry where unit_id=${unitId}::uuid order by employment_id`;
  expect(entries).toHaveLength(index===0?LARGE:SMALL);
  const expected=await withTenant(maker,async tx=>{
   const floors=await deriveConfidentialityTx(tx,unitId,entries.map(entry=>entry.employment_id),SNAPSHOT),out=[];
   for(const entry of entries){
    const [onehr,architecture]=[await onehrRewardResultTx(tx,entry.employment_id,YEAR,unitId),await rewardArchitectureForSourceTx(tx,unitId,entry.employment_id,entry.source.positionId??null,SNAPSHOT)];
    const source=sourceWithFloor({...entry.source,onehr,architecture},floors.get(entry.employment_id));
    out.push({source,confidentiality:source.confidentialityFloor??'standard'});
   }
   return out;
  });
  expect(entries.map(entry=>({source:entry.source,confidentiality:entry.facts.confidentiality}))).toEqual(expected);
 }
 // The confirmed preview is now stale: every company is reviewed. A new preview creates nothing and skips all three.
 await expect(createRewardPlanReviews(maker,plan.versionId,preview.digest)).rejects.toThrow(/preview changed/);
 const after=await previewRewardPlanCreation(maker,plan.versionId);
 expect(after.rows.map(row=>row.reason)).toEqual(['already-reviewed','already-reviewed','already-reviewed']);
 expect(await createRewardPlanReviews(maker,plan.versionId,after.digest)).toMatchObject({created:[],skipped:[{companyId:targets[0]!.companyId},{companyId:targets[1]!.companyId},{companyId:targets[2]!.companyId}]});
},600_000);
