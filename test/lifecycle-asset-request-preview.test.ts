/** Native retained-history preview: identical current owner/RLS/order, fewer rows materialized. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {itAssetCatalogue,itAssetRequest} from '../db/schema';
import {listAssetRequests} from '../packs/lifecycle/service';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';

beforeAll(migrateTestDb);afterAll(closeAll);
it('reads only the five existing Lifecycle hub preview rows from a large owned history',async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'lifecycle','active');const ctx=await entitledCtx(b);
 const [catalogue]=await owner.db.insert(itAssetCatalogue).values({tenantId:b.tenantId,itemCode:'PERF_PREVIEW',itemName:'Fictional preview item',category:'hardware'}).returning();
 const rows=Array.from({length:1002},(_,index)=>({id:randomUUID(),tenantId:b.tenantId,number:'AR-PERF-'+String(index).padStart(8,'0'),catalogueId:catalogue.id,companyId:b.companyId,requesterUserId:b.adminUserId,fullName:'Fictional historical requester',justification:'Fictional retained request detail '.repeat(60)}));
 for(let offset=0;offset<rows.length;offset+=250)await owner.db.insert(itAssetRequest).values(rows.slice(offset,offset+250));
 const otherUser=await createAppUser(b.tenantId,null,'employee');
 await owner.db.insert(itAssetRequest).values({tenantId:b.tenantId,number:'ZZ-OTHER-REQUESTER',catalogueId:catalogue.id,companyId:b.companyId,requesterUserId:otherUser,fullName:'Fictional other requester'});
 const originalBegan=performance.now(),reference=await listAssetRequests(ctx,{mine:true}),originalMs=performance.now()-originalBegan;
 const began=performance.now(),preview=await listAssetRequests(ctx,{mine:true,...{limit:5}}),elapsedMs=performance.now()-began;
 const evidence:Record<string,unknown>={kind:'NATIVE_LIFECYCLE_HUB_PREVIEW_COMPONENT_ONLY',releaseEligible:false,fixtureOwnedRequests:rows.length,defaultReadRows:reference.length,previewRows:preview.length,defaultReadBytes:Buffer.byteLength(JSON.stringify(reference)),previewBytes:Buffer.byteLength(JSON.stringify(preview)),originalMs,elapsedMs,providerCalls:0,limitations:'Retained owner fixture; no create-throughput, browser timing or500-user claim.'};
 try{
  expect(reference).toHaveLength(1000);
  expect(preview.slice(0,5).map(row=>row.id)).toEqual(rows.slice(-5).reverse().map(row=>row.id));
  expect(preview.slice(0,5)).toEqual(reference.slice(0,5));
  expect(preview.some(row=>row.requesterUserId!==b.adminUserId)).toBe(false);
  expect(preview,'The hub must not fetch its entire1000-row history before slicing five').toHaveLength(5);
  const filtered=await listAssetRequests(ctx,{mine:true,status:'requested',...{limit:5}});expect(filtered).toEqual(preview);
  const foreign=await seedBase();await setModule(foreign.tenantId,'lifecycle','active');expect(await listAssetRequests(await entitledCtx(foreign),{mine:true,...{limit:5}})).toEqual([]);
  for(const limit of [0,-1,1.5,1001,NaN])await expect(listAssetRequests(ctx,{mine:true,...{limit}})).rejects.toThrow();
  evidence.exactRowsAndOrdering=true;evidence.nativeMineAndForeignScopePreserved=true;evidence.invalidLimitsRefused=true;
 }finally{
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'lifecycle-asset-request-preview.json'),JSON.stringify(evidence,null,2));
 }
},300000);
