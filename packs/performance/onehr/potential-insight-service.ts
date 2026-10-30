import {generatePerformanceNativeOutline} from './provider-source-draft';
import {nativeParagraphOutline} from '../../../lib/ai/native-insight-outline';
import {createHash} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../../db/client';
import {assessmentSummary} from '../../../db/schema';
import {withPerformanceTenant} from '../../../core/module-gate';
import {recordProposal} from '../../../core/agent-proposal';
import {redactPII,type ResolvedAiConfig} from '../../../lib/ai';
import {assessmentAiConfigTx} from './ai-settings';
import {potentialInsightSourceSchema,potentialInsightFacts,plainPotentialInsight,type PotentialInsight} from './potential-insight-model';
async function sourceTx(tx:Tx,reviewId:string,sessionId:string){
 const [row]=await tx.execute<{value:unknown}>(sql`select app.assessment_potential_source(${reviewId}::uuid,${sessionId}::uuid) as value`);
 if(!row?.value)throw Error('This potential review is not assigned to you.');
 return potentialInsightSourceSchema.parse(row.value);
}
async function configTx(tx:Tx,ctx:SessionContext){try{return await assessmentAiConfigTx(tx,ctx,'tc');}catch{return null;}}
const fingerprint=(source:unknown,cfg:ResolvedAiConfig|null)=>createHash('sha256').update(JSON.stringify({v:2,operation:'native_outline_selection',source,writer:cfg?{provider:cfg.provider,model:cfg.model}:null})).digest('hex');
/** No tier notes or private drafts: this evidence remains the same across the viewer's permitted cohorts. */
export async function getAssessmentPotentialInsight(ctx:SessionContext,reviewId:string,sessionId:string,{generate=false}:{generate?:boolean}={}){
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};
 z.uuid().parse(reviewId);z.uuid().parse(sessionId);
 const {source,cfg,cached}=await withPerformanceTenant(ctx,async tx=>{
  const source=await sourceTx(tx,reviewId,sessionId),cfg=await configTx(tx,ctx),[cached]=source.valid?await tx.select().from(assessmentSummary).where(and(eq(assessmentSummary.reviewId,reviewId),eq(assessmentSummary.contextId,reviewId),eq(assessmentSummary.actorUserId,ctx.userId!),eq(assessmentSummary.kind,'pot'))):[];
  return {source,cfg,cached};
 });
 const facts=potentialInsightFacts(source);
 if(!facts.valid)return {pending:false,source:'plain' as const,data:{paragraph:plainPotentialInsight(facts)}};
 const fp=fingerprint(source,cfg),retry=!!cached&&cached.source==='plain'&&!!cfg&&Date.now()-cached.updatedAt.getTime()>=600000;
 if(cached?.fingerprint===fp&&!retry)return {pending:false,source:cached.source as 'plain'|'ai',data:cached.data as PotentialInsight};
 if(!generate)return {pending:true,source:null,data:null};
 const safeSource={...source,managerSections:Object.fromEntries(Object.entries(source.managerSections??{}).map(([k,v])=>[k,redactPII(v)])),name:redactPII(source.name),principles:source.principles.map(p=>({...p,name:redactPII(p.name),description:redactPII(p.description),comments:p.comments.map(redactPII)})),remarks:source.remarks.map(redactPII),competencyRemark:redactPII(source.competencyRemark),managerRemark:redactPII(source.managerRemark),competencies:source.competencies.map(c=>({...c,text:redactPII(c.text),skillTitle:c.skillTitle?redactPII(c.skillTitle):undefined,principle:redactPII(c.principle),managerRemark:redactPII(c.managerRemark??'')}))};
 const safe=potentialInsightFacts(safeSource);let data:PotentialInsight={paragraph:plainPotentialInsight(safe)},kind:'plain'|'ai'='plain',reason='AI is not configured.';
 if(cfg&&safe.source){
  try{data=await generatePerformanceNativeOutline(cfg,ctx,'tc','potential',data,nativeParagraphOutline(data.paragraph),async tx=>{const fresh=await sourceTx(tx,reviewId,sessionId);if(fingerprint(fresh,cfg)!==fp)throw Error('Current native Performance evidence changed.');});kind='ai';
  }catch{reason='Potential insight generation was unavailable.';}
 }
 await withPerformanceTenant(ctx,async tx=>{
  const fresh=await sourceTx(tx,reviewId,sessionId),freshCfg=await configTx(tx,ctx);
  if(fingerprint(fresh,freshCfg)!==fp)throw Error('Potential facts or access changed. Refresh the insight.');
  await tx.insert(assessmentSummary).values({tenantId:ctx.tenantId,reviewId,contextId:reviewId,actorUserId:ctx.userId!,kind:'pot',fingerprint:fp,source:kind,data}).onConflictDoUpdate({target:[assessmentSummary.reviewId,assessmentSummary.actorUserId,assessmentSummary.kind,assessmentSummary.contextId],set:{fingerprint:fp,source:kind,data,updatedAt:new Date()}});
 });
 if(cfg)await recordProposal(ctx,{type:'potential_insight',subject:{type:'performance-review',id:reviewId},facts:{fingerprint:fp},proposal:{source:kind,operation:'native_outline_selection'},adjudication:kind==='ai'?{ok:true}:{ok:false,reason},provider:cfg.provider,model:cfg.model});
 return {pending:false,source:kind,data};
}
