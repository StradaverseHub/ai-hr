/** WP11: core/module-agent-orchestrator.ts (a test-only parallel of the production read job) was deleted.
 * Tests that exercised a bounded sequential own read now use this helper: the PRODUCTION plan capture
 * (captureTypedModulePlan, as runGovernedReadJob uses) and the PRODUCTION Assistant read carrier. It adds
 * no authority, union or cache; it is not a job and records nothing. */
import type {SessionContext} from '../db/client';
import {withAssistantRead,type AssistantReadSession} from '../core/assistant-read-session';
import {captureTypedModulePlan} from '../lib/ai/module-agent-routing';
export async function runModuleReadPlan(ctx:SessionContext,proposed:unknown,existing?:AssistantReadSession){
 const plan=captureTypedModulePlan(proposed);
 return withAssistantRead(ctx,null,async read=>{
  const results:Awaited<ReturnType<AssistantReadSession['moduleWork']>>[]=[];
  for(const module of plan.modules)results.push(await read.moduleWork(module));
  return {version:1 as const,results,effects:[] as const};
 },existing);
}
