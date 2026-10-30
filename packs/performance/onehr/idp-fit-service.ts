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
import {idpFitContext,idpFitSourceSchema,type IdpFitSource} from './idp-fit-context';
import {plainIdpFit,talentIdpFit,type IdpFitInsight} from './idp-fit-model';
async function sourceTx(tx:Tx,reviewId:string,sessionId?:string){const [row]=await tx.execute<{value:unknown;visibility:string}>(sql`select value,md5(value::text) as visibility from (select app.assessment_idp_source(${reviewId}::uuid,${sessionId??null}::uuid) as value) s`);if(!row?.value)throw Error('This development plan is not assigned to you.');return {value:idpFitSourceSchema.parse(row.value),visibility:row.visibility};}
const finalSaved=(s:IdpFitSource)=>{const lines=s.kpis.filter(k=>!k.hrOwned);return lines.length>0&&lines.every(k=>k.locked);};
async function readingTx(tx:Tx,ctx:SessionContext,reviewId:string,sessionId?:string){
 const {value:source,visibility}=await sourceTx(tx,reviewId,sessionId),canGenerate=source.mine||!!sessionId&&finalSaved(source),cfg=canGenerate?await configTx(tx,ctx):null;
 const [cached]=canGenerate?await tx.select().from(assessmentSummary).where(and(eq(assessmentSummary.reviewId,reviewId),eq(assessmentSummary.contextId,sessionId??reviewId),eq(assessmentSummary.actorUserId,ctx.userId!),eq(assessmentSummary.kind,sessionId?'talent_idp':'idp'))):[];
 return {source,visibility,canGenerate,cfg,cached};
}
/** Already-read fit only: this does not generate, nor use a manager's private cache. */
export async function getAssessmentTalentIdpReadingTx(tx:Tx,ctx:SessionContext,reviewId:string,sessionId:string){
 const {source,canGenerate,cfg,cached}=await readingTx(tx,ctx,reviewId,sessionId);
 if(!['shared','closed'].includes(source.status))return null;
 if(!canGenerate)return talentIdpFit(plainIdpFit(redactPII(source.name.trim().split(/\s+/)[0]||'They'),idpFitContext(source).facts,false));
 if(cached?.fingerprint===fingerprint(source,cfg)&&!(cached.source==='plain'&&cfg&&Date.now()-cached.updatedAt.getTime()>=600000))return cached.data as IdpFitInsight;
 return null;
}
async function configTx(tx:Tx,ctx:SessionContext){try{return await assessmentAiConfigTx(tx,ctx,'idp');}catch{return null;}}
const fingerprint=(source:IdpFitSource,cfg:ResolvedAiConfig|null)=>createHash('sha256').update(JSON.stringify({v:3,operation:'native_outline_selection',source,writer:cfg?{provider:cfg.provider,model:cfg.model}:null})).digest('hex');
/** Other approvers get a fresh plain reading of saved facts, never the owner's draft-based AI cache. */
export async function getAssessmentIdpFit(ctx:SessionContext,reviewId:string,{generate=false,sessionId}:{generate?:boolean;sessionId?:string}={}){
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};
 z.uuid().parse(reviewId);if(sessionId)z.uuid().parse(sessionId);
 const {source,visibility,canGenerate,cfg,cached}=await withPerformanceTenant(ctx,tx=>readingTx(tx,ctx,reviewId,sessionId));
 const status=source.status;if(!['shared','closed'].includes(status))return {status,canGenerate:false,pending:false,source:null,data:null};
 const fp=fingerprint(source,cfg),retry=!!cached&&cached.source==='plain'&&!!cfg&&Date.now()-cached.updatedAt.getTime()>=600000;
 if(canGenerate&&cached?.fingerprint===fp&&!retry)return {status,canGenerate:true,pending:false,source:cached.source as 'plain'|'ai',data:cached.data as IdpFitInsight};
 if(canGenerate&&!generate)return {status,canGenerate:true,pending:true,source:null,data:null};
 const first=redactPII(source.name.trim().split(/\s+/)[0]||'They'),context=idpFitContext(source),{facts}=context;
 let data=plainIdpFit(first,facts,source.mine||!!sessionId&&canGenerate),kind:'plain'|'ai'='plain',reason='AI is not configured.';
 if(!canGenerate)return {status,canGenerate:false,pending:false,source:kind,data:sessionId?talentIdpFit(data):data};
 if(sessionId)data=talentIdpFit(data);
 if(cfg){try{data=await generatePerformanceNativeOutline(cfg,ctx,'idp',source.career?.aspirationLong?'career_fit':'idp_fit',data,[{index:0,kind:'summary',text:data.paragraph},{index:1,kind:'decision',text:data.verdict_why},...data.discuss.map((text,index)=>({index:index+2,kind:'discussion' as const,text}))],async tx=>{const fresh=await readingTx(tx,ctx,reviewId,sessionId);if(!fresh.canGenerate||fingerprint(fresh.source,cfg)!==fp)throw Error('Current native Performance evidence changed.');});kind='ai';}catch{reason='Development plan insight generation was unavailable.';}}
 await withPerformanceTenant(ctx,async tx=>{const fresh=await readingTx(tx,ctx,reviewId,sessionId);if(!fresh.canGenerate||fingerprint(fresh.source,fresh.cfg)!==fp)throw Error('Development plan facts or access changed. Refresh the insight.');
  if(sessionId)await tx.execute(sql`select app.assessment_talent_idp_summary_store(${reviewId}::uuid,${sessionId}::uuid,${visibility},${fp},${kind},${JSON.stringify(data)}::jsonb)`);
  else await tx.insert(assessmentSummary).values({tenantId:ctx.tenantId,reviewId,contextId:reviewId,actorUserId:ctx.userId!,kind:'idp',fingerprint:fp,source:kind,data}).onConflictDoUpdate({target:[assessmentSummary.reviewId,assessmentSummary.actorUserId,assessmentSummary.kind,assessmentSummary.contextId],set:{fingerprint:fp,source:kind,data,updatedAt:new Date()}});
 });
 if(cfg)await recordProposal(ctx,{type:'development_plan_insight',subject:{type:'performance-review',id:reviewId},facts:{fingerprint:fp,sessionId:sessionId??null,goals:facts.goals.length},proposal:{source:kind,verdict:data.verdict,operation:'native_outline_selection'},adjudication:kind==='ai'?{ok:true}:{ok:false,reason},provider:cfg.provider,model:cfg.model});
 return {status,canGenerate:true,pending:false,source:kind,data};
}
