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
import {getAssessmentInsightSourceTx} from './insight-source';
import {writtenAxisSchema,writtenSourceSchema,potentialWrittenRemarks,performanceWrittenRemarks,writtenRemarksSource,plainWrittenRemarks,type WrittenAxis} from './written-remarks-model';
async function sourceTx(tx:Tx,ctx:SessionContext,reviewId:string,sessionId:string,axis:WrittenAxis){
 const [row]=await tx.execute<{value:unknown}>(sql`select app.assessment_written_source(${reviewId}::uuid,${sessionId}::uuid,${axis}) as value`);
 if(!row?.value)throw Error('These written remarks are not assigned to you.');
 const s=writtenSourceSchema.parse(row.value);
 const entries=axis==='pot'?potentialWrittenRemarks(s):performanceWrittenRemarks((await getAssessmentInsightSourceTx(tx,ctx,reviewId,sessionId)).facts);
 return {name:s.name,tier:s.tier,entries};
}
// The source uses the competency assistance switch for both written-remarks summaries.
async function configTx(tx:Tx,ctx:SessionContext){try{return await assessmentAiConfigTx(tx,ctx,'tc');}catch{return null;}}
const fingerprint=(source:unknown,cfg:ResolvedAiConfig|null)=>createHash('sha256').update(JSON.stringify({v:2,operation:'native_outline_selection',source,writer:cfg?{provider:cfg.provider,model:cfg.model}:null})).digest('hex');
/** Summary cache and full text share one live authorization check, scoped to the requested cohort and actor. */
export async function getAssessmentWrittenRemarks(ctx:SessionContext,reviewId:string,sessionId:string,rawAxis:WrittenAxis,{generate=false}:{generate?:boolean}={}){
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};
 z.uuid().parse(reviewId);z.uuid().parse(sessionId);const axis=writtenAxisSchema.parse(rawAxis),kind=`${axis}_remarks`;
 const {source,cfg,cached}=await withPerformanceTenant(ctx,async tx=>{
  const source=await sourceTx(tx,ctx,reviewId,sessionId,axis),cfg=await configTx(tx,ctx),[cached]=await tx.select().from(assessmentSummary).where(and(eq(assessmentSummary.reviewId,reviewId),eq(assessmentSummary.actorUserId,ctx.userId!),eq(assessmentSummary.contextId,sessionId),eq(assessmentSummary.kind,kind)));
  return {source,cfg,cached};
 });
 const entries=source.entries;
 if(!entries.length)return {entries,pending:false,source:'plain' as const,data:{paragraph:plainWrittenRemarks(entries)}};
 const fp=fingerprint(source,cfg),retry=!!cached&&cached.source==='plain'&&!!cfg&&Date.now()-cached.updatedAt.getTime()>=600000;
 if(cached?.fingerprint===fp&&!retry)return {entries,pending:false,source:cached.source as 'plain'|'ai',data:cached.data as {paragraph:string}};
 if(!generate)return {entries,pending:true,source:null,data:null};
 const safe=entries.map(e=>({...e,text:redactPII(e.text),who:redactPII(e.who),on:e.on?redactPII(e.on):null,src:e.src?redactPII(e.src):undefined,move:e.move?redactPII(e.move):null}));
 let data={paragraph:plainWrittenRemarks(safe)},origin:'plain'|'ai'='plain',reason='AI is not configured.';
 if(cfg){try{
  const sections=nativeParagraphOutline(data.paragraph,'remark');
  data=await generatePerformanceNativeOutline(cfg,ctx,'tc',axis==='pm'?'written_performance':'written_potential',data,sections,async tx=>{const fresh=await sourceTx(tx,ctx,reviewId,sessionId,axis);if(fingerprint(fresh,cfg)!==fp)throw Error('Current native Performance evidence changed.');});origin='ai';
 }catch{reason='Written remarks summary generation was unavailable.';}}
 await withPerformanceTenant(ctx,async tx=>{
  const fresh=await sourceTx(tx,ctx,reviewId,sessionId,axis),freshCfg=await configTx(tx,ctx);if(fingerprint(fresh,freshCfg)!==fp)throw Error('Written remarks or access changed. Refresh the summary.');
  await tx.insert(assessmentSummary).values({tenantId:ctx.tenantId,reviewId,contextId:sessionId,actorUserId:ctx.userId!,kind,fingerprint:fp,source:origin,data}).onConflictDoUpdate({target:[assessmentSummary.reviewId,assessmentSummary.actorUserId,assessmentSummary.kind,assessmentSummary.contextId],set:{fingerprint:fp,source:origin,data,updatedAt:new Date()}});
 });
 if(cfg)await recordProposal(ctx,{type:'written_remarks',subject:{type:'performance-review',id:reviewId},facts:{fingerprint:fp,sessionId,axis},proposal:{source:origin,operation:'native_outline_selection'},adjudication:origin==='ai'?{ok:true}:{ok:false,reason},provider:cfg.provider,model:cfg.model});
 return {entries,pending:false,source:origin,data};
}
