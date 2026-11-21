/** Admin Today's morning summary read (core/digest/own-digest.ts readMorningSummary) at the shape of a real group
 * (docs/SCALE-AND-RELEASE-RULES.md rule 3): the fictional 71-company, 1,000-employment fixture
 * (test/helpers/ai-centre-scale-fixture.ts), read as a group administrator ("All companies"), an HR administrator
 * granted every company one by one ("All companies" by grants) and an HR administrator of one company.
 *
 * The read is keyed by the viewer's own login, so it must stay ONE statement in ONE transaction whatever the number of
 * companies, and its prepared digest must be exactly what the previous reader (core/digest/daily-digest.ts
 * latestDailyDigest, which the Needs you setup finding still uses) answers for the same person. */
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>undefined}),headers:async()=>new Headers()}));
import type {SessionContext} from '../db/client';
import {ensureAgentPrincipal} from '../core/agent-principal';
import {setJobTypeEnablement} from '../core/mandates/mandates';
import {latestDailyDigest} from '../core/digest/daily-digest';
import {delegateOwnJob,readMorningSummary} from '../core/digest/own-digest';
import {runDueDailyDigests} from '../core/digest/run';
import {closeAll,entitledCtx,migrateTestDb,resetDb,seedBase,setModule,owner,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {isIdentityStatement,observeStatements} from './helpers/statement-observer';

let b:Base,fixture:ScaleFixture;
const personas=()=>Object.entries(fixture.personas) as [string,SessionContext][];
const JOB={jobType:'daily_digest'};

async function measured(ctx:SessionContext){
 const {result,statements,transactions}=await observeStatements(()=>readMorningSummary(ctx));
 return {result,transactions,business:statements.filter(s=>!isIdentityStatement(s.sql)).length};
}

beforeAll(async()=>{
 await migrateTestDb();await resetDb();
 b=await seedBase();
 for(const code of ['assistant','claims','notifications','attendance','lifecycle','payroll'])await setModule(b.tenantId,code,'active');
 fixture=await buildScaleFixture(b,{employments:1000,events:3000});
 await setJobTypeEnablement(fixture.personas.group,{jobType:'daily_digest',enabled:true});
},300_000);
afterAll(closeAll);

describe('morning summary read at group scale',()=>{
 it('is one statement for every persona, before a grant and after, and matches the previous reader',async()=>{
  for(const [name,ctx] of personas()){
   const before=await measured(ctx);
   expect(before.result,name).toEqual({offered:true,stopped:false,mandate:null,prepared:null});
   expect([before.transactions,before.business],name).toEqual([1,1]);
  }
  // The one-company administrator's summary is prepared by the sweep (the group-wide digests are the nightly job's own
  // cost, measured in test/review/review-stress-recommender-digest-scale.test.ts); the other two are granted afterwards.
  const single=fixture.personas.single;
  const granted=new Map<string,string>([['single',(await delegateOwnJob(single,JOB)).id]]);
  const principalId=await ensureAgentPrincipal(owner.db,b.tenantId);
  expect(await runDueDailyDigests({tenantId:b.tenantId,principalId,entitlements:(await entitledCtx(b)).entitlements!})).toMatchObject({due:1,prepared:1,failed:0});
  for(const name of ['group','multi'] as const)granted.set(name,(await delegateOwnJob(fixture.personas[name],JOB)).id);
  for(const [name,ctx] of personas()){
   const after=await measured(ctx);
   expect([after.transactions,after.business],name).toEqual([1,1]);
   expect(after.result.mandate?.id,name).toBe(granted.get(name));
   // Equivalence with the previous reader: same record, same time, same digest, or none for both.
   const previous=await latestDailyDigest(ctx);
   expect(after.result.prepared,name).toEqual(previous);
   if(name==='single'){
    expect(previous,name).not.toBeNull();
    expect(after.result.prepared!.digest.setup!.companies+after.result.prepared!.digest.setup!.unknown,name).toBe(1);
   }
  }
 },180_000);
});
