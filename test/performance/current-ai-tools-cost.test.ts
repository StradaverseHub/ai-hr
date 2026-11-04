/** Current More tools owner timings; fictional data, no model/provider calls, no decisions cached. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as schema from '../../db/schema';
import {MODULE_CATALOG} from '../../packs/catalog';
import {availablePersonnelReviewNavigation} from '../../core/assistant-actions/personnel-review-navigation';
import {hireEmployee} from '../../core/org';
import {grantAssistant} from '../../core/assistant-grant';
import {loadAiWorkspace} from '../../core/ai-workspace';
import {moduleActionEntryAccess,allowedModuleActionEntries} from '../../core/assistant-actions/module-action-entries';
import {MODULE_ACTION_ENTRY_OF,type ModuleActionEntry} from '../../lib/assistant-actions/module-action-entries';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule} from '../harness';
beforeAll(migrateTestDb);afterAll(async()=>{vi.unstubAllEnvs();await closeAll();});
it('measures the current tools read and its native entry checks as HR and employee',async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-tools-cost-012345678901234567890123');
 await resetDb();const b=await seedBase();
 await owner.db.insert(schema.tenantModule).values(MODULE_CATALOG.filter(m=>!m.isCore&&(m.packBacked||m.code==='system_testing'||m.code==='system_explorer')).map(m=>({tenantId:b.tenantId,moduleCode:m.code,status:'active' as const}))).onConflictDoNothing();
 await setModule(b.tenantId,'assistant','active');
 const observations:unknown[]=[];
 for(const role of ['hr_admin','employee'] as const){
  const person=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional AI Tools '+role,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  const userId=await createAppUser(b.tenantId,person.personId,role);await grantAssistant(adminCtx(b),{appUserId:userId});
  const ctx={...await entitledCtx(b,[role]),userId,personId:person.personId,roles:[role],grants:[{role,companyId:null}]};
  for(let run=0;run<3;run++){
   let started=performance.now();const workspace=await loadAiWorkspace(ctx,{includeHistory:false,includeGovernance:false});
   expect(workspace.access.allowed).toBe(true);expect(workspace.jobModules).toContain('rewards');
   const workspaceMs=performance.now()-started;
   const entries=[...new Set(workspace.jobModules.flatMap(module=>{const entry=MODULE_ACTION_ENTRY_OF[module];return [...(entry?[entry]:[]),...(module==='rewards'?['rewards_cancel','rewards_calendar','rewards_return'] as const:[])];}))] as ModuleActionEntry[];
   const reads=[];
   for(const entry of entries){started=performance.now();const access=await moduleActionEntryAccess(ctx,entry);reads.push({entry,access,elapsedMs:performance.now()-started});}
   started=performance.now();const actual=await allowedModuleActionEntries(ctx,workspace.jobModules);const combinedEntriesMs=performance.now()-started;
   // Each offer still comes from its own fresh native gate; compare the same stable fictional fixture.
   expect(actual).toEqual(reads.filter(row=>row.access==='allowed').map(row=>row.entry));
   started=performance.now();const navigation=await availablePersonnelReviewNavigation(ctx);const personnelNavigationMs=performance.now()-started;
   observations.push({role,run,workspaceMs,combinedEntriesMs,personnelNavigationMs,personnelNavigationCount:navigation.length,reads});
   if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'current-ai-tools-cost.json'),JSON.stringify({kind:'CURRENT_TOOLS_NATIVE_READ_DIAGNOSTIC',browserTiming:false,largeDataset:false,providerCalls:0,observations},null,2));
  }
 }
},180000);
