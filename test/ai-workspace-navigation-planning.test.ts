/** Real app-role navigation reads; observers delegate to the actual provider/configuration owner. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {loadAiWorkspace} from '../core/ai-workspace';
import * as provider from '../core/ai-provider-snapshot';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';

beforeAll(migrateTestDb);afterAll(closeAll);
it('defers unused planner configuration on navigation while retaining actual access and the default planner',async()=>{
 await resetDb();const base=await seedBase(),ctx=adminCtx(base);
 await setModule(base.tenantId,'assistant','active');
 await grantAssistant(ctx,{appUserId:ctx.userId!});
 // No implementation replacement: every observed call performs the real principal check,
 // restricted native configuration resolver and environment fallback. No model is invoked.
 const observer=vi.spyOn(provider,'resolveAiProviderSnapshotTx');
 const measurements:{phase:string;reads:number;elapsedMs:number;providerReads:number}[]=[];
 const options={includeHistory:false,includeGovernance:false,includePlanning:false};
 const common=(value:Awaited<ReturnType<typeof loadAiWorkspace>>)=>{
  const {planningPermit:_,planningAvailability:__,...rest}=value;return rest;
 };
 try{
  const reference=await loadAiWorkspace(ctx,{includeHistory:false,includeGovernance:false});
  expect(reference.access).toEqual({allowed:true});
  for(const phase of ['original','navigation','restored']as const){
   const before=observer.mock.calls.length,start=performance.now();
   for(let index=0;index<15;index++){
    const value=await loadAiWorkspace(ctx,phase==='navigation'?options:{includeHistory:false,includeGovernance:false});
    expect(common(value)).toEqual(common(reference));
   }
   measurements.push({phase,reads:15,elapsedMs:performance.now()-start,providerReads:observer.mock.calls.length-before});
  }
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'ai-workspace-navigation-planning.json'),JSON.stringify({kind:'NATIVE_AI_WORKSPACE_NAVIGATION_COMPONENT_ONLY',releaseEligible:false,measurements,modelCalls:0},null,2));
  expect(measurements.find(row=>row.phase==='navigation')!.providerReads,'Ask navigation must not resolve configuration for an unused planner').toBe(0);
  expect(measurements.filter(row=>row.phase!=='navigation').every(row=>row.providerReads===15)).toBe(true);
  const navigation=await loadAiWorkspace(ctx,options);
  expect(navigation.planningPermit).toBeNull();expect(navigation.planningAvailability).toBe('resting');
  await revokeAssistant(ctx,{appUserId:ctx.userId!});
  expect((await loadAiWorkspace(ctx,options)).access).toEqual({allowed:false,reason:'no_grant'});
  expect((await loadAiWorkspace({...ctx,userId:crypto.randomUUID()},options)).access.allowed).toBe(false);
  expect(await owner.client`select id from ai_model_run`).toEqual([]);
 }finally{observer.mockRestore();}
});
