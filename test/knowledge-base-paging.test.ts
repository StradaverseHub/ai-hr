/** Native Knowledge Base paging must count only audience/archive/search-authorized metadata. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {client,type SessionContext} from '../db/client';
import {kbDocument} from '../db/schema';
import * as kb from '../core/knowledge-base';
import {paginateRows,parsePageQuery,type PageState} from '../lib/pagination';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.restoreAllMocks());
type Options=NonNullable<Parameters<typeof kb.listDocuments>[1]>;type Query={page?:string;size?:string};type Rows=Awaited<ReturnType<typeof kb.listDocuments>>;
const readPage=(ctx:SessionContext,opts:Options,query:Query={})=>{const proposed=(kb as unknown as {listDocumentsPage?:(ctx:SessionContext,opts:Options,query:Query)=>Promise<{rows:Rows;state:PageState}>}).listDocumentsPage;return proposed?proposed(ctx,opts,query):kb.listDocuments(ctx,opts).then(rows=>paginateRows(rows,parsePageQuery(query)));};
it('pages a large library after canonical audience/archival/search filters and preserves localized metadata only',async()=>{
 await resetDb();const b=await seedBase(),admin=await entitledCtx(b);const userId=await createAppUser(b.tenantId,null,'employee');const employee:SessionContext={...await entitledCtx(b,['employee']),userId,personId:null,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 const category='fictional-native-page';
 const docs:Array<typeof kbDocument.$inferInsert>=Array.from({length:2101},(_,i)=>({id:randomUUID(),tenantId:b.tenantId,kind:'article',audience:i%2?'employee':'all',category,title:'Fictional guide '+String(i).padStart(5,'0'),body:'Fictional full article '.repeat(50),i18n:i%2?null:{ms:{title:'Translated guide '+String(i).padStart(5,'0'),body:'Fictional full translated article '.repeat(50)}},createdByUserId:b.adminUserId}));
 docs.push({tenantId:b.tenantId,kind:'article',audience:'hr_admin',category,title:'HR-only hidden guide',body:'Fictional restricted body'},{tenantId:b.tenantId,kind:'article',audience:'manager',category,title:'Manager-only hidden guide',body:'Fictional restricted body'},{tenantId:b.tenantId,kind:'article',audience:'employee',category,title:'Archived guide',body:'Fictional archived body',archivedAt:new Date()});
 for(let offset=0;offset<docs.length;offset+=200)await owner.db.insert(kbDocument).values(docs.slice(offset,offset+200));
 const opts={category,locale:'ms'},fullBegan=performance.now(),reference=await kb.listDocuments(employee,opts),fullMs=performance.now()-fullBegan;expect(reference).toHaveLength(2101);
 const nativeBegin=client.begin.bind(client);let metadataReads=0,bounded=true;
 vi.spyOn(client,'begin').mockImplementation(((...args:unknown[])=>{const i=args.findIndex(arg=>typeof arg==='function'),callback=args[i]as(native:typeof client)=>unknown;args[i]=(native:typeof client)=>callback(new Proxy(native,{get(target,key,receiver){if(key==='unsafe')return(...query:unknown[])=>{if(typeof query[0]==='string'&&query[0].includes('from "kb_document"')&&!query[0].includes('count(*)')){metadataReads++;bounded&&=query[0].includes(' limit ')&&!query[0].includes('"body"')&&!query[0].includes('"content"');}return Reflect.apply(target.unsafe,target,query);};return Reflect.get(target,key,receiver);}}));return Reflect.apply(nativeBegin,client,args);})as typeof client.begin);
 const began=performance.now(),first=await readPage(employee,opts),elapsedMs=performance.now()-began;
 const evidence:Record<string,unknown>={kind:'NATIVE_KNOWLEDGE_LIBRARY_PAGE_COMPONENT_ONLY',releaseEligible:false,retainedDocs:docs.length,authorizedTotal:reference.length,shownRows:first.rows.length,fullMs,elapsedMs,metadataReads,nativeBoundedMetadata:bounded,providerCalls:0,limitations:'Native retained library only; not actual browser navigation or500-user acceptance.'};
 try{
  expect(first).toEqual(paginateRows(reference,parsePageQuery()));expect(first.rows[0].title).toBe('Translated guide 00000');expect(first.rows[1].title).toBe('Fictional guide 00001');
  expect(first.rows.every(row=>!('body'in row)&&!('content'in row)&&!('i18n'in row))).toBe(true);
  expect(metadataReads).toBe(1);expect(bounded,'Library rows must be natively bounded after authorization rather than rendered from an unbounded full list').toBe(true);
  for(const query of [{page:'1'},{page:'2',size:'50'},{size:'all'},{page:'9999'},{page:'-1',size:'invalid'}])expect(await readPage(employee,opts,query)).toEqual(paginateRows(reference,parsePageQuery(query)));
  for(const filter of [{audience:'hr_admin' as const},{audience:'manager' as const},{audience:'employee' as const},{search:'guide 0001'},{includeArchived:true}]){const options={...opts,...filter};expect(await readPage(employee,options)).toEqual(paginateRows(await kb.listDocuments(employee,options),parsePageQuery()));}
  expect((await readPage(admin,{category})).state.total).toBe(2103);expect((await readPage(employee,{category,audience:'hr_admin'})).state.total).toBe(0);expect((await readPage(employee,{category,includeArchived:true})).state.total).toBe(2102);
  const foreign=await seedBase();expect((await readPage(await entitledCtx(foreign),{category})).state.total).toBe(0);
  evidence.exactRowsPagerAndLocalizedFallback=true;evidence.currentAudienceArchiveAndSearchCounts=true;evidence.noBodyOrBytes=true;evidence.foreignTenantRefused=true;
 }finally{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'knowledge-base-paging.json'),JSON.stringify(evidence,null,2));}
},300000);
