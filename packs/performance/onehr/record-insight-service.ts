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
import {getAssessmentPersonalRecordTx} from './personal-record-service';
import {recordInsightKindSchema,personalRecordInsightFacts,type RecordInsightKind} from './record-insight-model';
async function sourceTx(tx:Tx,ctx:SessionContext,reviewId:string,kind:RecordInsightKind){
 const v=await getAssessmentPersonalRecordTx(tx,ctx,reviewId,kind==='present'?'current':kind==='cycle'?reviewId:undefined),facts=personalRecordInsightFacts(v,kind),cacheReviewId=kind==='present'?v.current!.id:reviewId;
 const [stamp]=await tx.execute<{value:string|null}>(sql`select app.assessment_record_visibility(${cacheReviewId}::uuid) as value`);if(!stamp?.value)throw Error('This personal record is not assigned to you.');
 return {...facts,cacheReviewId,visibility:stamp.value};
}
async function configTx(tx:Tx,ctx:SessionContext){try{return await assessmentAiConfigTx(tx,ctx,'review');}catch{return null;}}
const fingerprint=(source:unknown,cfg:ResolvedAiConfig|null)=>createHash('sha256').update(JSON.stringify({v:2,operation:'native_outline_selection',source,writer:cfg?{provider:cfg.provider,model:cfg.model}:null})).digest('hex');
/** The same personal-record projection owns both the screen and all model context; no reviewer cache is read. */
export async function getAssessmentRecordInsight(ctx:SessionContext,reviewId:string,rawKind:RecordInsightKind,{generate=false}:{generate?:boolean}={}){
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};
 z.uuid().parse(reviewId);const kind=recordInsightKindSchema.parse(rawKind),cacheKind=`record_${kind}`;
 const {source,cfg,cached}=await withPerformanceTenant(ctx,async tx=>{
  const source=await sourceTx(tx,ctx,reviewId,kind),cfg=await configTx(tx,ctx),[cached]=await tx.select().from(assessmentSummary).where(and(eq(assessmentSummary.reviewId,source.cacheReviewId),eq(assessmentSummary.contextId,source.cacheReviewId),eq(assessmentSummary.actorUserId,ctx.userId!),eq(assessmentSummary.kind,cacheKind)));
  return {source,cfg,cached};
 });
 if(kind==='trend'&&!source.source)return {pending:false,source:'plain' as const,data:null};
 const fp=fingerprint(source,cfg),retry=!!cached&&cached.source==='plain'&&!!cfg&&Date.now()-cached.updatedAt.getTime()>=600000;
 if(cached?.fingerprint===fp&&!retry)return {pending:false,source:cached.source as 'plain'|'ai',data:cached.data as {paragraph:string}};
 if(!generate)return {pending:true,source:null,data:null};
 const safe=redactPII(source.source);let data={paragraph:redactPII(source.plain??'')},origin:'plain'|'ai'='plain',reason='AI is not configured.';
 if(cfg&&(kind!=='cycle'||safe.trim().split('\n').length>1)){try{
  data=await generatePerformanceNativeOutline(cfg,ctx,'review',kind==='present'?'record_present':kind==='cycle'?'record_cycle':'record_trend',data,nativeParagraphOutline(data.paragraph,kind==='present'?'current':'history'),async tx=>{const fresh=await sourceTx(tx,ctx,reviewId,kind);if(fingerprint(fresh,cfg)!==fp)throw Error('Current native Performance evidence changed.');});origin='ai';
 }catch{reason='Personal record summary generation was unavailable.';}}
 await withPerformanceTenant(ctx,async tx=>{const fresh=await sourceTx(tx,ctx,reviewId,kind),freshCfg=await configTx(tx,ctx);if(fingerprint(fresh,freshCfg)!==fp)throw Error('Your record or released information changed. Refresh the summary.');
  await tx.execute(sql`select app.assessment_record_summary_store(${fresh.cacheReviewId}::uuid,${cacheKind},${fresh.visibility},${fp},${origin},${JSON.stringify(data)}::jsonb)`);
 });
 if(cfg)await recordProposal(ctx,{type:'personal_record_insight',subject:{type:'performance-review',id:source.cacheReviewId},facts:{fingerprint:fp,kind},proposal:{source:origin,operation:'native_outline_selection'},adjudication:origin==='ai'?{ok:true}:{ok:false,reason},provider:cfg.provider,model:cfg.model});
 return {pending:false,source:origin,data};
}
