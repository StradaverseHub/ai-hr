/** AI v2 Phase 1, W3 — Today's "Done for you" counts over real outcome records and their row-level security.
 *
 *  1. A person counts only their own runs; a colleague's record is invisible to them whatever scope is asked for.
 *  2. A group administrator counts other people's answered turns only for companies in the current scope.
 *  3. A routed or refused turn (private to its asker) is never counted, not even for the asker; nor is a fallback.
 *  4. Records before the window, and records of another tenant, are not counted.
 *  5. The result is four numbers: no id, no person, no word of any question or reply. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {writeOutcomeRecord} from '../core/outcome-record/record';
import {summariseOutcomeRecords} from '../core/outcome-record/summary';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let base:Base,companyB:string;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-today-summary-passphrase');
 await resetDb();base=await seedBase();for(const code of ['assistant','claims'])await setModule(base.tenantId,code,'active');
 const [b]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Fictional Second Sdn Bhd'}).returning({id:schema.company.id});
 companyB=b.id;
});

async function person(b:Base,role:'employee'|'hr_admin',name:string):Promise<SessionContext>{
 const admin=adminCtx(b);
 const hired=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,role);await grantAssistant(admin,{appUserId:userId});
 return{...await entitledCtx(b,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]};
}
const DAY=86_400_000,now=Date.now(),since=new Date(now-7*DAY);
const run=(asker:string,p:Partial<{companyId:string|null;agentIdentity:string;outcomeKind:'answered'|'suggested'|'fallback'|'refused';privateToAsker:boolean;at:number}>={})=>({
 runId:randomUUID(),runKind:'turn' as const,companyId:p.companyId??null,startedAt:new Date(p.at??now-DAY),finishedAt:new Date(p.at??now-DAY),
 authority:{kind:'person' as const,askedByUserId:asker},agentIdentity:p.agentIdentity??'teras.assistant',reads:[],checks:[],
 replay:{model:null,provider:null,instructionSet:null,specVersion:null,specDigest:null,toolCatalogue:null},
 outcomeKind:p.outcomeKind??'answered',outcome:{mode:'answer'},humanInvolvement:'none' as const,notice:'not_applicable' as const,
 ...(p.privateToAsker?{privateToAsker:true}:{})});

describe('Today outcome summary',()=>{
 it('counts by authority and scope under row-level security, never a private turn',async()=>{
  const employee=await person(base,'employee','Fictional Today Employee');
  const colleague=await person(base,'employee','Fictional Today Colleague');
  const group=await person(base,'hr_admin','Fictional Today Group Administrator');
  await writeOutcomeRecord(employee,run(employee.userId!,{companyId:base.companyId}));
  await writeOutcomeRecord(colleague,run(colleague.userId!,{companyId:companyB}));
  await writeOutcomeRecord(colleague,run(colleague.userId!,{companyId:base.companyId,outcomeKind:'suggested'}));
  await writeOutcomeRecord(colleague,run(colleague.userId!,{companyId:base.companyId,outcomeKind:'fallback'}));
  await writeOutcomeRecord(colleague,run(colleague.userId!,{companyId:base.companyId,outcomeKind:'refused',privateToAsker:true}));
  await writeOutcomeRecord(colleague,run(colleague.userId!,{companyId:base.companyId,agentIdentity:'worker.approver_recommendation',outcomeKind:'suggested'}));
  await writeOutcomeRecord(colleague,run(colleague.userId!,{companyId:base.companyId,at:now-10*DAY}));

  expect(await summariseOutcomeRecords(employee,{since,companyIds:[base.companyId,companyB]})).toEqual({answeredForYou:1,answeredForOthers:0,leaveChecks:0,preparedForYou:0});
  // The colleague's private turn and fallback are not counted, nor the run from before the window.
  expect(await summariseOutcomeRecords(colleague,{since,companyIds:[base.companyId]})).toEqual({answeredForYou:2,answeredForOthers:0,leaveChecks:1,preparedForYou:0});
  // The group administrator sees other people's answered turns in scope only; the recommender's run belongs to
  // the approver who asked, and the private turn is never visible.
  expect(await summariseOutcomeRecords(group,{since,companyIds:[base.companyId]})).toEqual({answeredForYou:0,answeredForOthers:2,leaveChecks:0,preparedForYou:0});
  expect(await summariseOutcomeRecords(group,{since,companyIds:[companyB]})).toEqual({answeredForYou:0,answeredForOthers:1,leaveChecks:0,preparedForYou:0});
  expect(await summariseOutcomeRecords(group,{since,companyIds:[base.companyId,companyB]})).toEqual({answeredForYou:0,answeredForOthers:3,leaveChecks:0,preparedForYou:0});
  expect(await summariseOutcomeRecords(group,{since,companyIds:[]})).toEqual({answeredForYou:0,answeredForOthers:0,leaveChecks:0,preparedForYou:0});

  const other=await seedBase();await setModule(other.tenantId,'assistant','active');
  const foreignAdmin={...await entitledCtx(other,['hr_admin']),userId:other.adminUserId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
  expect(await summariseOutcomeRecords(foreignAdmin,{since,companyIds:[base.companyId,companyB]})).toEqual({answeredForYou:0,answeredForOthers:0,leaveChecks:0,preparedForYou:0});
 });

 it('returns numbers only, and nothing for an agent or a session without a login',async()=>{
  const employee=await person(base,'employee','Fictional Today Shape');
  await writeOutcomeRecord(employee,run(employee.userId!,{companyId:base.companyId}));
  const summary=await summariseOutcomeRecords(employee,{since,companyIds:[base.companyId]});
  expect(Object.keys(summary).sort()).toEqual(['answeredForOthers','answeredForYou','leaveChecks','preparedForYou']);
  expect(Object.values(summary).every(value=>Number.isInteger(value))).toBe(true);
  expect(await summariseOutcomeRecords({...employee,userId:undefined} as SessionContext,{since,companyIds:[base.companyId]})).toEqual({answeredForYou:0,answeredForOthers:0,leaveChecks:0,preparedForYou:0});
 });
});
