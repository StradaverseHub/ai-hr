/** Real native saved-chat reads: trace SQL only; every principal, grant and receipt owner executes. */
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
 const evidence:Record<string,unknown>={kind:'NATIVE_CHAT_ROOT_READ_COUNT_COMPONENT_ONLY',releaseEligible:false,authenticatedChats:20,retainedExchanges:160,rootsOutsideRecentScan:true,rootTitlesAndOrderExact:true,historyReads:queryCount,elapsedMs,providerCalls:0,controls,controlsComplete:false,limitations:'native component query count, not browser navigation latency or500-user capacity'};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'assistant-chat-list-root-batch.json'),JSON.stringify(evidence,null,2));};
 save();expect(queryCount,'Listing a page must use one scan and at most one bounded root lookup').toBeLessThanOrEqual(2);
 // Seed valid retained boundary states rather than changing immutable transcript identity.
 const foreign=await seedBase(),otherUser=await createAppUser(b.tenantId,null,'employee');
 for(const [index,label]of ['retired','expired','corrupt','other-scope','missing','other-user','foreign-tenant'].entries()){
  const rootId=randomUUID(),leafId=randomUUID(),answer=JSON.stringify(plan),privateTitle='Fictional hidden '+label+' root';
  const tenantId=label==='foreign-tenant'?foreign.tenantId:b.tenantId,ownerId=label==='foreign-tenant'?foreign.adminUserId:label==='other-user'?otherUser:userId;
  if(label!=='missing'){
   const rootRow:typeof assistantExchange.$inferInsert={id:rootId,tenantId,appUserId:ownerId,question:privateTitle,answer,stop:'end',askedAt:new Date(now-(label==='expired'?31:2)*86400000),disclosureReceipt:sealAssistantDisclosure({tenantId,userId:ownerId,exchangeId:rootId,question:privateTitle,answer},[],plan,{threadId:rootId,scopeDigest:label==='other-scope'?assistantConversationScopeDigest(ctx,'other-scope'):scopeDigest})};
   if(label==='retired')Object.assign(rootRow,{contentRetiredAt:new Date(),question:'',answer:null,disclosureReceipt:null,toolCalls:[],error:null});
   if(label==='corrupt')rootRow.answer='Fictional unauthenticated terminal';
   await owner.db.insert(assistantExchange).values(rootRow);
  }
  const leafQuestion='Fictional own '+label+' leaf';
  await owner.db.insert(assistantExchange).values({id:leafId,tenantId:b.tenantId,appUserId:userId,question:leafQuestion,answer,disclosureReceipt:sealAssistantDisclosure({tenantId:b.tenantId,userId,exchangeId:leafId,question:leafQuestion,answer},[],plan,{threadId:rootId,scopeDigest}),stop:'end',askedAt:new Date(now+index)});
  const scoped=await listOwnAssistantChats(ctx,{},scope);expect(scoped.chats.find(chat=>chat.threadId===rootId)?.title).toBe(leafQuestion);expect(scoped.chats.some(chat=>chat.title===privateTitle)).toBe(false);controls.push(label+' root title withheld');save();
 }
 await owner.client.unsafe('revoke select on public.assistant_exchange from ai_hr_app');
 try{await expect(listOwnAssistantChats(ctx,{},scope)).rejects.toThrow('Saved chat unavailable.');controls.push('database SELECT failure refused');}
 finally{await owner.client.unsafe('grant select on public.assistant_exchange to ai_hr_app');}
 // Actual current authority still owns every new read.
 await revokeAssistant(admin,{appUserId:userId});await expect(listOwnAssistantChats(ctx,{},scope)).rejects.toThrow('Saved chat unavailable.');
 evidence.revokedGrantRefused=true;evidence.controlsComplete=true;save();
 expect(queryCount,'Listing a page must use one scan and at most one bounded root lookup').toBeLessThanOrEqual(2);
},300000);
