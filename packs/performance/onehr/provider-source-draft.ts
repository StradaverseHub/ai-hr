/** Trusted native-owner replay. No callback, source facts or transaction enters model/browser data. */
import type {SessionContext,Tx} from '../../../db/client';
import {withAiAdmissionCheck} from '../../../core/ai-governance';
import {draftInputDigest} from '../../../lib/ai/draft-input';
import {generateDraft,type ResolvedAiConfig} from '../../../lib/ai';
import type {GenerateArgs} from '../../../lib/ai/types';
import {assessmentAiFeatureEnabledTx,type AssessmentAiFeature} from './ai-settings';
import {assertPerformanceProviderSourceTx} from './provider-source-authority';
export function generatePerformanceSourceDraft(cfg:ResolvedAiConfig,supplied:SessionContext,feature:AssessmentAiFeature|'assistant',args:GenerateArgs,replay:(tx:Tx)=>Promise<void>){
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))},captured=Object.freeze({...args}),expected=draftInputDigest(captured);
 const bound=withAiAdmissionCheck(cfg,`performance_${feature}`,async(tx,request)=>{
  await assertPerformanceProviderSourceTx(tx,ctx);
  if(request.operation!=='draft'||request.inputDigest!==expected||feature!=='assistant'&&!await assessmentAiFeatureEnabledTx(tx,ctx,feature))throw Error('Current Performance source could not be confirmed.');
  await replay(tx);
 });
 return generateDraft(bound,captured);
}
