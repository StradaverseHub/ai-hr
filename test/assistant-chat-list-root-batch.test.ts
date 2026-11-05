/** Real native saved-chat reads: trace SQL only; every principal, grant and receipt owner executes. */
import {eq} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {client,type SessionContext} from '../db/client';
import {assistantExchange} from '../db/schema';
import {hireEmployee} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {assistantConversationScopeDigest} from '../core/assistant-conversation-context';
import {listOwnAssistantChats} from '../core/assistant-threads';
import {sealAssistantDisclosure} from '../lib/ai/assistant-disclosure';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';

beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
it('reads twenty authenticated root titles outside the scan with a bounded native query count',async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-native-chat-list-key');
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'assistant','active');
 const admin=adminCtx(b),employment=await hireEmployee(admin,{person:{fullName:'Fictional bounded chat actor',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,employment.personId,'employee');await grantAssistant(admin,{appUserId:userId});
 const ctx:SessionContext={...await entitledCtx(b,['employee']),userId,personId:employment.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 const scope='native-root-batch-fixture',scopeDigest=assistantConversationScopeDigest(ctx,scope),plan={version:1 as const,mode:'social' as const,code:'greeting' as const},now=Date.now();
 const rootIds=Array.from({length:20},()=>randomUUID()),leafIds=Array.from({length:20},()=>randomUUID());
 const rows=[];
 for(let index=0;index<20;index++){
  const rootId=rootIds[index],leafId=leafIds[index],answer=JSON.stringify(plan);
  for(const [id,question,askedAt,parent]of [[rootId,'Fictional root '+index,new Date(now-3*86400000-index*1000),null],[leafId,'Fictional follow-up '+index,new Date(now-10000-index*1000),rootId]]as const){
   const receipt=sealAssistantDisclosure({tenantId:b.tenantId,userId,exchangeId:id,question,answer},[],plan,{threadId:rootId,scopeDigest});expect(receipt).toBeTruthy();
   rows.push({id,tenantId:b.tenantId,appUserId:userId,question,answer,disclosureReceipt:receipt,stop:'end',continuesExchangeId:parent,askedAt});
  }
 }
 for(let index=0;index<120;index++)rows.push({id:randomUUID(),tenantId:b.tenantId,appUserId:userId,question:'Fictional older scan filler '+index,answer:null,disclosureReceipt:null,stop:'other',continuesExchangeId:null,askedAt:new Date(now-86400000-index*1000)});
 await owner.db.insert(assistantExchange).values(rows);
 // Observe real Drizzle/Postgres SQL through a call-through transaction proxy. No SQL,
 // parameters, results, authorization or crypto behavior is substituted by this tracer.
 const nativeBegin=client.begin.bind(client);let historyReads=0;
 vi.spyOn(client,'begin').mockImplementation(((...args:unknown[])=>{
  const callbackIndex=args.findIndex(arg=>typeof arg==='function');expect(callbackIndex).toBeGreaterThanOrEqual(0);
  const callback=args[callbackIndex]as(native:typeof client)=>unknown;
  args[callbackIndex]=(native:typeof client)=>callback(new Proxy(native,{get(target,key,receiver){
   if(key==='unsafe')return(...query:unknown[])=>{
    if(typeof query[0]==='string'&&query[0].includes('from "assistant_exchange"')&&query[0].includes('"disclosure_receipt"'))historyReads++;
    return Reflect.apply(target.unsafe,target,query);
   };
   return Reflect.get(target,key,receiver);
  }}));
  return Reflect.apply(nativeBegin,client,args);
 })as typeof client.begin);
 const began=performance.now(),listed=await listOwnAssistantChats(ctx,{},scope),elapsedMs=performance.now()-began,queryCount=historyReads;
 expect(listed.chats.map(chat=>({id:chat.threadId,leaf:chat.exchangeId,title:chat.title}))).toEqual(rootIds.map((id,index)=>({id,leaf:leafIds[index],title:'Fictional root '+index})));
 expect(listed.nextCursor).toBeTruthy();
 const controls:string[]=[];
 // A retained leaf never regains unavailable root text through the batched title read.
 await owner.db.update(assistantExchange).set({contentRetiredAt:new Date()}).where(eq(assistantExchange.id,rootIds[0]));
 await owner.db.update(assistantExchange).set({askedAt:new Date(now-31*86400000)}).where(eq(assistantExchange.id,rootIds[1]));
 await owner.db.update(assistantExchange).set({answer:'Fictional unauthenticated terminal'}).where(eq(assistantExchange.id,rootIds[2]));
 const scopeQuestion='Fictional root 3',scopeAnswer=JSON.stringify(plan);
 await owner.db.update(assistantExchange).set({disclosureReceipt:sealAssistantDisclosure({tenantId:b.tenantId,userId,exchangeId:rootIds[3],question:scopeQuestion,answer:scopeAnswer},[],plan,{threadId:rootIds[3],scopeDigest:assistantConversationScopeDigest(ctx,'other-scope')})}).where(eq(assistantExchange.id,rootIds[3]));
 await owner.db.delete(assistantExchange).where(eq(assistantExchange.id,rootIds[4]));
 const unavailable=await listOwnAssistantChats(ctx,{},scope);
 for(let index=0;index<5;index++)expect(unavailable.chats.find(chat=>chat.threadId===rootIds[index])?.title).toBe('Fictional follow-up '+index);
 controls.push('retired root','expired root','corrupt root receipt','other-scope root','missing root');
 const foreign=await seedBase(),otherUser=await createAppUser(b.tenantId,null,'employee');
 for(const [tenantId,ownerId,label]of [[b.tenantId,otherUser,'other-user'],[foreign.tenantId,foreign.adminUserId,'foreign-tenant']]as const){
  const rootId=randomUUID(),leafId=randomUUID(),answer=JSON.stringify(plan),question='Fictional hidden '+label+' root';
  await owner.db.insert(assistantExchange).values({id:rootId,tenantId,appUserId:ownerId,question,answer,disclosureReceipt:sealAssistantDisclosure({tenantId,userId:ownerId,exchangeId:rootId,question,answer},[],plan,{threadId:rootId,scopeDigest}),stop:'end',askedAt:new Date(now-2*86400000)});
  const leafQuestion='Fictional own '+label+' leaf';
  await owner.db.insert(assistantExchange).values({id:leafId,tenantId:b.tenantId,appUserId:userId,question:leafQuestion,answer,disclosureReceipt:sealAssistantDisclosure({tenantId:b.tenantId,userId,exchangeId:leafId,question:leafQuestion,answer},[],plan,{threadId:rootId,scopeDigest}),stop:'end',askedAt:new Date(now-1000)});
  const scoped=await listOwnAssistantChats(ctx,{},scope);expect(scoped.chats.find(chat=>chat.threadId===rootId)?.title).toBe(leafQuestion);expect(scoped.chats.some(chat=>chat.title===question)).toBe(false);controls.push(label+' root refused');
 }
 await owner.client.unsafe('revoke select on public.assistant_exchange from ai_hr_app');
 try{await expect(listOwnAssistantChats(ctx,{},scope)).rejects.toThrow('Saved chat unavailable.');controls.push('database SELECT failure refused');}
 finally{await owner.client.unsafe('grant select on public.assistant_exchange to ai_hr_app');}
 // Actual current authority still owns every new read.
 await revokeAssistant(admin,{appUserId:userId});await expect(listOwnAssistantChats(ctx,{},scope)).rejects.toThrow('Saved chat unavailable.');
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'assistant-chat-list-root-batch.json'),JSON.stringify({kind:'NATIVE_CHAT_ROOT_READ_COUNT_COMPONENT_ONLY',releaseEligible:false,authenticatedChats:20,retainedExchanges:160,rootsOutsideRecentScan:true,rootTitlesAndOrderExact:true,revokedGrantRefused:true,controls,historyReads:queryCount,elapsedMs,providerCalls:0,limitations:'native component query count, not browser navigation latency or500-user capacity'},null,2));
 expect(queryCount,'Listing a page must use one scan and at most one bounded root lookup').toBeLessThanOrEqual(2);
},300000);
