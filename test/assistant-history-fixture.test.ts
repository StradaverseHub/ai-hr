/** Hosted native proof of the exact representative history fixture; browser timing is a separate gate. */
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {desc,eq} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {client,type Grant} from '../db/client';
import {appExternalIdentity,assistantExchange,roleAssignment} from '../db/schema';
import {hireEmployee} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {loadOwnAssistantChat,listOwnAssistantChats} from '../core/assistant-threads';
import {resolveWorkosPrincipal,withEntitlements} from '../lib/session';
import {internalIssuer} from '../lib/internal-auth/config';
import {seedAssistantHistoryFixture,type AssistantHistoryActor,type AssistantHistoryFixture} from '../scripts/performance/assistant-history-fixture';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Principal={app_user_id:string;tenant_id:string;person_id:string|null;grants:Grant[]|null};
const current=async(actor:AssistantHistoryActor)=>withEntitlements(await resolve(actor));
const resolve=(actor:AssistantHistoryActor)=>resolveWorkosPrincipal(()=>client<Principal[]>`select * from app.principal_by_identity(${actor.issuer},${actor.subject})`,actor.subject);
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
it('seeds four real identity-bound principals with twenty retained authenticated two-turn chats each',async()=>{
 vi.stubEnv('AUTH_PROVIDER','internal');vi.stubEnv('AUTH_PUBLIC_ORIGIN','https://localhost:3443');vi.stubEnv('AUTH_SESSION_KEY','a'.repeat(64));vi.stubEnv('AI_CONFIG_SECRET','fictional-native-sealed-history-key');
 await resetDb();const bases:Base[]=[],actors:AssistantHistoryActor[]=[];
 for(let tenant=0;tenant<2;tenant++){
  const b=await seedBase();bases.push(b);await setModule(b.tenantId,'assistant','active');
  for(const role of ['employee','companyHR']){
   const employment=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional saved history '+actors.length,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
   const userId=await createAppUser(b.tenantId,employment.personId,'employee');
   if(role==='companyHR')await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:userId,role:'hr_admin',companyId:b.companyId});
   await grantAssistant(adminCtx(b),{appUserId:userId});
   const actor={index:actors.length,tenantId:b.tenantId,userId,personId:employment.personId,issuer:internalIssuer(b.tenantId),subject:randomUUID()};
   await owner.db.insert(appExternalIdentity).values({issuer:actor.issuer,subject:actor.subject,appUserId:userId});actors.push(actor);
  }
 }
 const fixtures:AssistantHistoryFixture[]=[],directory=mkdtempSync(join(tmpdir(),'aihr-owned-history-'));
 try{
  const path=join(directory,'fixture.json');
  writeFileSync(path,JSON.stringify({tenants:bases.map(base=>({tenantId:base.tenantId})),users:actors.map(actor=>({...actor,tenant:bases.findIndex(base=>base.tenantId===actor.tenantId),role:actor.index%2===0?'employee':'companyHR'}))}),{mode:0o600});
  const child=spawnSync(process.execPath,['--conditions=react-server','--import','tsx','scripts/performance/assistant-history-seed.mjs'],{encoding:'utf8',timeout:120000,env:{...process.env,NODE_ENV:'development',DATABASE_URL:process.env.TEST_DATABASE_URL,MIGRATION_DATABASE_URL:process.env.TEST_MIGRATION_DATABASE_URL,PERF_PRIVATE_DIR:directory}});
  if(child.status!==0){
   // Keep the standalone stack out of Vitest's assertion stack parser.
   // Report only the error summary and module frames, never the child environment.
   const diagnostic=(child.stderr??'').split('\n')
    .filter(line=>/^\s*(?:[A-Za-z]+Error[: ]|at )/.test(line))
    .slice(0,12).join('\n');
   console.error('Saved history child failed',child.status,child.signal,child.error?.code,diagnostic);
  }
  expect(child.status).toBe(0);
  const result=JSON.parse(readFileSync(path,'utf8')).assistantHistory as Record<number,AssistantHistoryFixture>;
  fixtures.push(...actors.map(actor=>result[actor.index]));expect(fixtures.every(value=>value?.nativeVerified===true)).toBe(true);
 }finally{rmSync(directory,{recursive:true,force:true});}
 for(const actor of actors){
  const fixture=fixtures[actor.index];
  const recent=await owner.db.select({id:assistantExchange.id}).from(assistantExchange).where(eq(assistantExchange.appUserId,actor.userId)).orderBy(desc(assistantExchange.askedAt),desc(assistantExchange.id)).limit(100);
  expect(fixture.rootIds.every(id=>!recent.some(row=>row.id===id))).toBe(true);
  const all=await owner.db.select({askedAt:assistantExchange.askedAt}).from(assistantExchange).where(eq(assistantExchange.appUserId,actor.userId));expect(all).toHaveLength(160);
  expect(all.every(row=>row.askedAt.getTime()>Date.now()-30*86400000&&row.askedAt.getTime()<=Date.now())).toBe(true);
 }
 const own=await current(actors[0]);
 await expect(loadOwnAssistantChat(own,{exchangeId:fixtures[1].leafIds[0]},fixtures[0].conversationScope)).rejects.toThrow();
 await expect(loadOwnAssistantChat(own,{exchangeId:fixtures[2].leafIds[0]},fixtures[0].conversationScope)).rejects.toThrow();
 await expect(loadOwnAssistantChat(own,{exchangeId:fixtures[0].leafIds[0]},'[]')).rejects.toThrow();
 await revokeAssistant(adminCtx(bases[0]),{appUserId:actors[0].userId});await expect(listOwnAssistantChats(await current(actors[0]),{},fixtures[0].conversationScope)).rejects.toThrow();
 vi.stubEnv('GITHUB_ACTIONS','false');await expect(seedAssistantHistoryFixture(owner,actors[0])).rejects.toThrow('hosted CI');
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'assistant-history-fixture.json'),JSON.stringify({kind:'NATIVE_REPRESENTATIVE_SAVED_HISTORY_FIXTURE_ONLY',releaseEligible:false,actors:4,tenants:2,threadsPerActor:20,exchangesPerActor:160,totalExchanges:640,selectedTurnsPerActor:2,rootsOutsideRecent100:true,retentionUnder30Days:true,standaloneServerRuntimeVerified:true,principalAndEntitlements:'canonical internal identity resolution',scope:'canonical allowedCompanies, default browser selection only',crossUserRefused:true,crossTenantRefused:true,wrongScopeRefused:true,revokedGrantRefused:true,nonCiSeedRefused:true,providerCalls:0,browserAcceptance:false},null,2));
},300000);
