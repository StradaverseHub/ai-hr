/** AI v2 Phase 2, P2-5 — the production model behind "Read the values" (core/handbook/extract.ts PolicyValueModel).
 *
 * One draft request through the governed gateway, under the reviewed-contract machinery every provider call uses: the
 * tenant's own configuration for the AI Centre (hr_assistant), its admission (pauses, allowances, token ceiling, spend
 * caps), the closed contract handbook_policy_values_v1 (lib/ai/provider-workload-policy.ts: the policy text and the
 * closed list of settings and target codes, refused when the text carries a personal identifier), and the source
 * replayed at admission. The caller's administrator authority is checked again at admission.
 *
 * THE CONTRACT IS PENDING. It has no owner review record, so the gateway refuses to dispatch it and "Read the values"
 * says AI Centre cannot read values yet (core/handbook/policies.ts model_unavailable). Nothing here lifts that gate.
 * The reply is untrusted text: ./extract.ts adjudicates it, and a person confirms every value. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {generateDraft} from '../../lib/ai';
import type {GenerateArgs} from '../../lib/ai/types';
import {resolveActiveAiConfig} from '../ai-config';
import {preparePrivateAiTask,withAiAdmissionCheck} from '../ai-governance';
import type {PolicyValueModel} from './extract';

export const HANDBOOK_CONTRACT='handbook_policy_values_v1';

export function gatewayPolicyValueModel(supplied:SessionContext):PolicyValueModel{
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 return Object.freeze({async propose(input){
  const source=Object.freeze({text:input.text,settings:input.settings.map(s=>Object.freeze({setting:s.setting,meaning:s.meaning,targets:[...s.targets]}))});
  const configured=await withTenant(ctx,tx=>resolveActiveAiConfig(tx,ctx,'hr_assistant'));
  if(!configured)throw new Error('AI Centre has no provider configured.');
  const bound=withAiAdmissionCheck(configured,'hr_assistant',async tx=>{
   const [row]=Array.from(await tx.execute(sql`select app.is_admin() as ok`) as unknown as {ok:boolean|null}[]);
   if(row?.ok!==true)throw new Error('Only an administrator reads a policy\'s values.');
  });
  const task=await preparePrivateAiTask(bound,HANDBOOK_CONTRACT,async()=>source);
  try{
   if(task.operation!=='draft')throw new Error('The prepared AI request could not be confirmed.');
   return await generateDraft(task.configuration,task.args as GenerateArgs);
  }finally{task.dispose();}
 }});
}
