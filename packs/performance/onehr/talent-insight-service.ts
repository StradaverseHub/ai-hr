import {generatePerformanceNativeOutline} from './provider-source-draft';
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
import {performanceWrittenRemarks} from './written-remarks-model';
import {getAssessmentTalentPositionTx} from './service';
import {talentSourceSchema,talentInsightCase,plainTalentInsight,type TalentInsight} from './talent-insight-model';
import {getAssessmentTalentIdpReadingTx} from './idp-fit-service';
export async function getAssessmentTalentEvidenceTx(tx:Tx,ctx:SessionContext,reviewId:string,sessionId:string){
 const [row]=await tx.execute<{value:unknown;visibility:string}>(sql`select value,md5(value::text) as visibility from (select app.assessment_talent_source(${reviewId}::uuid,${sessionId}::uuid) as value) s`);
 if(!row?.value)throw Error('This person is not in your Talent Box.');
 const source=talentSourceSchema.parse(row.value);
 return {visibility:row.visibility,source,fit:source.plan?await getAssessmentTalentIdpReadingTx(tx,ctx,reviewId,sessionId):null,position:await getAssessmentTalentPositionTx(tx,ctx,reviewId,sessionId),remarks:performanceWrittenRemarks((await getAssessmentInsightSourceTx(tx,ctx,reviewId,sessionId)).facts)};
}
async function configTx(tx:Tx,ctx:SessionContext){try{return await assessmentAiConfigTx(tx,ctx,'review');}catch{return null;}}
const fingerprint=(source:unknown,cfg:ResolvedAiConfig|null)=>createHash('sha256').update(JSON.stringify({v:2,operation:'native_outline_selection',source,writer:cfg?{provider:cfg.provider,model:cfg.model}:null})).digest('hex');
/** One actor, person and BG cohort. No private manager drafts or another actor's cached insight. */
export async function getAssessmentTalentInsight(ctx:SessionContext,reviewId:string,sessionId:string,{generate=false}:{generate?:boolean}={}){
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};
 z.uuid().parse(reviewId);z.uuid().parse(sessionId);
 const {source,cfg,cached}=await withPerformanceTenant(ctx,async tx=>{const source=await getAssessmentTalentEvidenceTx(tx,ctx,reviewId,sessionId),cfg=await configTx(tx,ctx),[cached]=await tx.select().from(assessmentSummary).where(and(eq(assessmentSummary.reviewId,reviewId),eq(assessmentSummary.contextId,sessionId),eq(assessmentSummary.actorUserId,ctx.userId!),eq(assessmentSummary.kind,'talent')));return {source,cfg,cached};});
 const fp=fingerprint(source,cfg),retry=!!cached&&cached.source==='plain'&&!!cfg&&Date.now()-cached.updatedAt.getTime()>=600000;
 if(cached?.fingerprint===fp&&!retry)return {pending:false,source:cached.source as 'plain'|'ai',data:cached.data as TalentInsight};
 if(!generate)return {pending:true,source:null,data:null};
 const built=talentInsightCase(source.source,source.position,source.remarks,source.fit);
 let data=plainTalentInsight(built.facts),kind:'plain'|'ai'='plain',reason='AI is not configured.';
 if(cfg){try{
  data=await generatePerformanceNativeOutline(cfg,ctx,'review','talent',data,[{index:0,kind:'summary',text:data.insight},{index:1,kind:'decision',text:data.decision}],async tx=>{const fresh=await getAssessmentTalentEvidenceTx(tx,ctx,reviewId,sessionId);if(fingerprint(fresh,cfg)!==fp)throw Error('Current native Performance evidence changed.');});kind='ai';
 }catch{reason='Talent insight generation was unavailable.';}}
 await withPerformanceTenant(ctx,async tx=>{const fresh=await getAssessmentTalentEvidenceTx(tx,ctx,reviewId,sessionId),freshCfg=await configTx(tx,ctx);if(fingerprint(fresh,freshCfg)!==fp)throw Error('Talent facts or access changed. Refresh the insight.');await tx.execute(sql`select app.assessment_talent_summary_store(${reviewId}::uuid,${sessionId}::uuid,${source.visibility},${fp},${kind},${JSON.stringify(data)}::jsonb)`);});
 if(cfg)await recordProposal(ctx,{type:'talent_insight',subject:{type:'performance-review',id:reviewId},facts:{fingerprint:fp,sessionId},proposal:{source:kind,operation:'native_outline_selection'},adjudication:kind==='ai'?{ok:true}:{ok:false,reason},provider:cfg.provider,model:cfg.model});
 return {pending:false,source:kind,data};
}
