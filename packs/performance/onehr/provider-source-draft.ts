/** Trusted native-owner replay. No callback, source facts or transaction enters model/browser data. */
import type {SessionContext,Tx} from '../../../db/client';
import {withAiAdmissionCheck,preparePrivateAiTask} from '../../../core/ai-governance';
import {ProviderWorkloadUnavailableError} from '../../../lib/ai/provider-workload-policy';
import {withPerformanceTenant} from '../../../core/module-gate';
import {draftInputDigest} from '../../../lib/ai/draft-input';
import {generateDraft,type ResolvedAiConfig} from '../../../lib/ai';
import type {GenerateArgs} from '../../../lib/ai/types';
import {assessmentAiFeatureEnabledTx,type AssessmentAiFeature} from './ai-settings';
import {assertPerformanceProviderSourceTx} from './provider-source-authority';
export async function generatePerformanceSourceDraft(cfg:ResolvedAiConfig,supplied:SessionContext,feature:AssessmentAiFeature|'assistant',args:GenerateArgs,replay:(tx:Tx)=>Promise<void>){
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))},captured=Object.freeze({...args});let expected:string|undefined;
 const bound=withAiAdmissionCheck(cfg,`performance_${feature}`,async(tx,request)=>{
  await assertPerformanceProviderSourceTx(tx,ctx);
  if(request.operation!=='draft'||request.inputDigest!==expected||feature!=='assistant'&&!await assessmentAiFeatureEnabledTx(tx,ctx,feature))throw Error('Current Performance source could not be confirmed.');
  await replay(tx);
 });
 let contract:string,payload:unknown;
 if(captured.system.startsWith('Select relevant supplied passages')){
  const passages:unknown=JSON.parse(captured.prompt);if(!Array.isArray(passages))throw new ProviderWorkloadUnavailableError('raw_performance_narrative');
  contract='performance_narrative_selection_v1';payload={task:'feedback_outline',passages:passages.map(value=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='index,text')throw new ProviderWorkloadUnavailableError('raw_performance_narrative');return {...value as {index:number;text:string},kind:'peer'};})};
 }else if(feature==='calib'&&captured.system.startsWith('Select a read-only calibration operation')){contract='performance_calibration_read_v1';payload=JSON.parse(captured.prompt);}
 else if(feature==='assistant'&&(captured.system.startsWith('Extract career profile')||captured.system.startsWith('Extract private assessment draft updates')||captured.system.startsWith('Extract KPI-setting'))){contract='performance_literal_command_v1';payload={kind:captured.system.startsWith('Extract career profile')?'career':captured.system.startsWith('Extract KPI-setting')?'setting':captured.system.includes('union of these protocols')?'journey':'review',payload:JSON.parse(captured.prompt)};}
 else{
  await withPerformanceTenant(ctx,async tx=>{await assertPerformanceProviderSourceTx(tx,ctx);if(feature!=='assistant'&&!await assessmentAiFeatureEnabledTx(tx,ctx,feature))throw Error('Current Performance source could not be confirmed.');await replay(tx);});
  throw new ProviderWorkloadUnavailableError('raw_performance_narrative_or_recommendation');
 }
 const task=await preparePrivateAiTask(bound,contract,async tx=>{await assertPerformanceProviderSourceTx(tx,ctx);await replay(tx);return payload;});
 try{if(task.operation!=='draft')throw new ProviderWorkloadUnavailableError('unsupported_performance_operation');expected=draftInputDigest(task.args as GenerateArgs);const raw=await generateDraft(task.configuration,task.args as GenerateArgs);
  if(contract==='performance_calibration_read_v1'){const selected:unknown=JSON.parse(raw),local=task.local as {query:{action:string}};if(!selected||typeof selected!=='object'||Array.isArray(selected)||Object.keys(selected).join(',')!=='action'||(selected as {action:unknown}).action!==local.query.action)throw new ProviderWorkloadUnavailableError('unsupported_calibration_read');return JSON.stringify(local.query);}
  if(contract==='performance_literal_command_v1'){const selected:unknown=JSON.parse(raw),local=task.local as {proposal:{commands:{action:string}[]}};if(!selected||typeof selected!=='object'||Array.isArray(selected)||Object.keys(selected).join(',')!=='action'||(selected as {action:unknown}).action!==local.proposal.commands[0].action)throw new ProviderWorkloadUnavailableError('unsupported_performance_command');return JSON.stringify(local.proposal);}
  return raw;
 }finally{task.dispose();}
}
