/** Fictional saved-chat data for a disposable hosted CI database; never submits a prompt. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {client,type createDb,type Grant} from '../../db/client';
import {assistantExchange} from '../../db/schema';
import {allowedCompanies} from '../../core/read';
import {assistantConversationScopeDigest} from '../../core/assistant-conversation-context';
import {resolveWorkosPrincipal,withEntitlements} from '../../lib/session';
import {sealAssistantDisclosure} from '../../lib/ai/assistant-disclosure';

type FixtureStore=ReturnType<typeof createDb>;
type PrincipalByIdentity={app_user_id:string;tenant_id:string;person_id:string|null;grants:Grant[]|null};
export type AssistantHistoryActor={index:number;tenantId:string;userId:string;personId:string;issuer:string;subject:string};
/** PRIVATE fixture expectations only. Public evidence must contain counts, never this object. */
export type AssistantHistoryFixture={version:1;userIndex:number;threads:20;exchanges:160;conversationScope:string;rootIds:string[];leafIds:string[];rootTitles:string[];selectedQuestions:[string,string];defaultCompanyScopeOnly:true;rowsVerified:true};
function assertOwnedFixtureStore(store:FixtureStore){
 assert.equal(process.env.GITHUB_ACTIONS,'true','Saved history fixtures require hosted CI.');
 assert.equal(process.env.AUTH_PROVIDER,'internal','Saved history fixtures require the internal fixture identity owner.');
 for(const connection of [store.client,client]){
  assert.deepEqual(connection.options.host,['127.0.0.1']);assert.deepEqual(connection.options.port,[5433]);
  assert.match(connection.options.database,/^ai_hr_(dev|test(?:_[a-z0-9_]+)?)$/);
 }
 assert.equal(store.client.options.database,client.options.database,'Fixture identity and data must use the same disposable database.');
}
/** Call after all real fixture grants/reporting lines exist, before serializing PRIVATE fixture.json.
 * The browser context must have no company_scope cookie: default selection is all canonical allowed companies. */
export async function seedAssistantHistoryFixture(store:FixtureStore,actor:AssistantHistoryActor):Promise<AssistantHistoryFixture>{
 assertOwnedFixtureStore(store);assert(Number.isSafeInteger(actor.index)&&actor.index>=0,'Invalid fixture actor index.');
 const [database]=await store.client<{name:string}[]>`select current_database() as name`;assert.equal(database.name,store.client.options.database);
 const context=await withEntitlements(await resolveWorkosPrincipal(()=>client<PrincipalByIdentity[]>`select * from app.principal_by_identity(${actor.issuer},${actor.subject})`,actor.subject));
 assert.equal(context.tenantId,actor.tenantId);assert.equal(context.userId,actor.userId);assert.equal(context.personId,actor.personId);
 const existing=await store.db.select({id:assistantExchange.id}).from(assistantExchange).where(and(eq(assistantExchange.tenantId,actor.tenantId),eq(assistantExchange.appUserId,actor.userId))).limit(1);
 assert.equal(existing.length,0,'Fixture actor history must start empty.');
 const conversationScope=JSON.stringify((await allowedCompanies(context)).map(company=>company.id).sort());
 const scopeDigest=assistantConversationScopeDigest(context,conversationScope),now=Date.now(),day=86400000;
 const rootIds=Array.from({length:20},()=>randomUUID()),leafIds=Array.from({length:20},()=>randomUUID());
 const rootTitles=rootIds.map((_,index)=>`PERF saved ${actor.index} root ${String(index).padStart(2,'0')}`),questions=rootIds.map((_,index)=>`PERF saved ${actor.index} follow-up ${String(index).padStart(2,'0')}`);
 const rows:Array<typeof assistantExchange.$inferInsert>=[],plan={version:1 as const,mode:'social' as const,code:'greeting' as const},answer=JSON.stringify(plan);
 for(let index=0;index<20;index++)for(const [id,question,askedAt,parent]of [[rootIds[index],rootTitles[index],new Date(now-3*day-index*1000),null],[leafIds[index],questions[index],new Date(now-10000-index*1000),rootIds[index]]]as const){
  const receipt=sealAssistantDisclosure({tenantId:actor.tenantId,userId:actor.userId,exchangeId:id,question,answer},[],plan,{threadId:rootIds[index],scopeDigest});assert(receipt,'Canonical fixture receipt could not be sealed.');
  rows.push({id,tenantId:actor.tenantId,appUserId:actor.userId,question,answer,disclosureReceipt:receipt,stop:'end',continuesExchangeId:parent,askedAt});
 }
 for(let index=0;index<120;index++)rows.push({tenantId:actor.tenantId,appUserId:actor.userId,question:`PERF saved ${actor.index} older scan filler ${index}`,answer:null,disclosureReceipt:null,stop:'other',askedAt:new Date(now-day-index*1000)});
 assert.equal(rows.length,160);await store.db.insert(assistantExchange).values(rows);
 // Check the committed fixture here. The hosted native test and the browser
 // independently read it through the application's authorization and receipt owners.
 const written=await store.db.select({id:assistantExchange.id}).from(assistantExchange)
  .where(and(eq(assistantExchange.tenantId,actor.tenantId),eq(assistantExchange.appUserId,actor.userId)));
 assert.equal(written.length,160);
 const ids=new Set(written.map(row=>row.id));assert([...rootIds,...leafIds].every(id=>ids.has(id)));
 return {version:1,userIndex:actor.index,threads:20,exchanges:160,conversationScope,rootIds,leafIds,rootTitles,selectedQuestions:[rootTitles[0],questions[0]],defaultCompanyScopeOnly:true,rowsVerified:true};
}
