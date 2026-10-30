import {preparePrivateAiTask,withAiAdmissionCheck} from '../../../core/ai-governance';
import {draftInputDigest} from '../../../lib/ai/draft-input';
import {assertPerformanceProviderSourceTx} from './provider-source-authority';
import {createHash} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../../db/client';
import {assessmentSummary} from '../../../db/schema';
import {withPerformanceTenant} from '../../../core/module-gate';
import {recordProposal} from '../../../core/agent-proposal';
import {redactPII,generateDraft,type ResolvedAiConfig} from '../../../lib/ai';
import {assessmentAiConfigTx,assessmentAiFeatureEnabledTx} from './ai-settings';
import {competencySchema} from './model';
import {competencyInsightFacts,plainCompetencyInsight,type CompetencyInsight} from './competency-insight-model';
const sourceSchema=z.object({name:z.string(),status:z.string(),remark:z.string(),competencies:z.array(competencySchema.pick({text:true,skillTitle:true,principle:true,future:true,self:true,selfRemark:true}))});
async function sourceTx(tx:Tx,reviewId:string){
 const [row]=await tx.execute<{value:unknown}>(sql`select app.assessment_competency_source(${reviewId}::uuid) as value`);
 if(!row?.value)throw Error('This competency assessment is not assigned to you.');
 return sourceSchema.parse(row.value);
}
async function configTx(tx:Tx,ctx:SessionContext){try{return await assessmentAiConfigTx(tx,ctx,'tc');}catch{return null;}}
const fingerprint=(value:z.infer<typeof sourceSchema>,cfg:ResolvedAiConfig|null)=>createHash('sha256').update(JSON.stringify({v:1,value,writer:cfg?{provider:cfg.provider,model:cfg.model}:null})).digest('hex');
/** Cache reads never call a provider; only the assigned line manager may summarize submitted self-assessments. */
export async function getAssessmentCompetencyInsight(ctx:SessionContext,reviewId:string,{generate=false}:{generate?:boolean}={}){
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};
 z.uuid().parse(reviewId);
 const initial=await withPerformanceTenant(ctx,async tx=>{
  const source=await sourceTx(tx,reviewId),cfg=await configTx(tx,ctx),[cached]=await tx.select().from(assessmentSummary).where(and(eq(assessmentSummary.reviewId,reviewId),eq(assessmentSummary.contextId,reviewId),eq(assessmentSummary.actorUserId,ctx.userId!),eq(assessmentSummary.kind,'tc')));
  return {source,cfg,cached};
 });
 const {source,cfg,cached}=initial,status=source.status;
 if(!['submitted','reviewed'].includes(status))return {status,pending:false,source:null,data:null};
 const fp=fingerprint(source,cfg),retry=!!cached&&cached.source==='plain'&&!!cfg&&Date.now()-cached.updatedAt.getTime()>=600000;
 if(cached?.fingerprint===fp&&!retry)return {status,pending:false,source:cached.source as 'plain'|'ai',data:cached.data as CompetencyInsight};
 if(!generate)return {status,pending:true,source:null,data:null};
 const first=redactPII(source.name.trim().split(/\s+/)[0]||'They');
 const rows=source.competencies.map(c=>({...c,text:redactPII(c.text),skillTitle:c.skillTitle?redactPII(c.skillTitle):undefined,principle:redactPII(c.principle),selfRemark:redactPII(c.selfRemark??'')}));
 const facts=competencyInsightFacts(rows,redactPII(source.remark));
 let data=plainCompetencyInsight(first,facts),kind:'plain'|'ai'='plain',reason='AI is not configured.';
 if(cfg&&facts.source&&data.discuss.length){
  let expected:string|undefined;
  const replay=async(tx:Tx)=>{await assertPerformanceProviderSourceTx(tx,ctx);if(!await assessmentAiFeatureEnabledTx(tx,ctx,'tc')||fingerprint(await sourceTx(tx,reviewId),cfg)!==fp)throw Error('Current native Performance evidence changed.');};
  const bound=withAiAdmissionCheck(cfg,'performance_tc',async(tx,request)=>{await replay(tx);if(request.operation!=='draft'||request.inputDigest!==expected)throw Error('Current native Performance request changed.');});
  try{
   // The canonical descriptor is the sole request constructor. It consumes source text locally,
   // fingerprints it for replay, and emits only ordinal, source kind and coarse length band.
   const task=await preparePrivateAiTask(bound,'performance_narrative_selection_v1',async tx=>{await replay(tx);return {task:'assessment_narrative',passages:data.discuss.map((text,index)=>({index,kind:'evidence',text}))};});
   try{if(task.operation!=='draft')throw Error('Protected discussion unavailable.');expected=draftInputDigest(task.args);const selected:unknown=JSON.parse(await generateDraft(task.configuration,task.args));
    if(!selected||typeof selected!=='object'||Array.isArray(selected)||Object.keys(selected).join(',')!=='items'||!Array.isArray((selected as {items:unknown}).items))throw Error('Unsupported discussion references.');
    const indices=(selected as {items:unknown[]}).items;if(!indices.length||indices.length>3||new Set(indices).size!==indices.length||indices.some(index=>typeof index!=='number'||!Number.isSafeInteger(index)||index<0||index>=data.discuss.length))throw Error('Unsupported discussion references.');
    data={...data,discuss:indices.map(index=>data.discuss[index as number])};kind='ai';
   }finally{task.dispose();}
  }catch{reason='Competency insight generation was unavailable.';}
 }
 await withPerformanceTenant(ctx,async tx=>{
  const fresh=await sourceTx(tx,reviewId),freshCfg=await configTx(tx,ctx);
  if(fingerprint(fresh,freshCfg)!==fp)throw Error('Competency facts or access changed. Refresh the insight.');
  await tx.insert(assessmentSummary).values({tenantId:ctx.tenantId,reviewId,contextId:reviewId,actorUserId:ctx.userId!,kind:'tc',fingerprint:fp,source:kind,data}).onConflictDoUpdate({target:[assessmentSummary.reviewId,assessmentSummary.actorUserId,assessmentSummary.kind,assessmentSummary.contextId],set:{fingerprint:fp,source:kind,data,updatedAt:new Date()}});
 });
 if(cfg)await recordProposal(ctx,{type:'competency_insight',subject:{type:'performance-review',id:reviewId},facts:{fingerprint:fp,competencies:facts.total},proposal:{source:kind,verdict:data.verdict},adjudication:kind==='ai'?{ok:true}:{ok:false,reason},provider:cfg.provider,model:cfg.model});
 return {status,pending:false,source:kind,data};
}
