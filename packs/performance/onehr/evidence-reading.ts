import { createHash } from 'node:crypto';
import { and,asc,eq,inArray,sql } from 'drizzle-orm';
import type { SessionContext,Tx } from '../../../db/client';
import { assessmentFileText,performanceAttachment,onehrReview } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { assessmentAiConfigTx,assessmentAiFeatureEnabledTx } from './ai-settings';
import { recordProposal } from '../../../core/agent-proposal';
import { AiImageReadError,readImage,supportsImageReading,type AiImageMime,type ResolvedAiConfig } from '../../../lib/ai';
import { getOnehrReviewTx } from './service';
import { getAssessmentInsightSourceTx } from './insight-source';
import { evidenceExtension,extractEvidenceText,type EvidenceText } from './evidence-extraction';
import {assertPerformanceProviderSourceTx} from './provider-source-authority';
import {withAiAdmissionCheck} from '../../../core/ai-governance';
import {captureImageInput,imageInputDigest} from '../../../lib/ai/image-input';
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const imageMimes:Record<string,AiImageMime>={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp'};
const unread=():EvidenceText=>({status:'unread',text:'',method:null});
async function context(ctx:SessionContext,reviewId:string,contextId?:string){return withPerformanceTenant(ctx,tx=>contextTx(tx,ctx,reviewId,contextId));}
async function contextTx(tx:Tx,ctx:SessionContext,reviewId:string,contextId?:string){
 await assertPerformanceProviderSourceTx(tx,ctx);
 if(contextId)return getAssessmentInsightSourceTx(tx,ctx,reviewId,contextId);
 const view=await getOnehrReviewTx(tx,ctx,reviewId);if(!view||!view.self&&!view.manager&&!view.moderator&&!view.admin)throw Error('This assessment is not assigned to you.');
 if(!view.policy.modules.evidence&&!view.moderator)throw Error('Supporting evidence is disabled.');
 const [record]=view.resultsSubmitted?await tx.select({proof:onehrReview.submittedProof}).from(onehrReview).where(eq(onehrReview.reviewId,reviewId)):[];
 const kpis=new Set(view.kpis.map(k=>k.id)),confirmed=new Set(record?.proof.filter(proof=>kpis.has(proof.kpiId)).map(proof=>proof.attachmentId)??[]),superseded=new Set(view.evidence.filter(e=>e.state==='shared'&&e.supersedesId).map(e=>e.supersedesId)),evidence=new Map(view.evidence.map(e=>[e.id,e]));
 // Download/history permissions also retain retracted evidence. Current AI context uses active entries,
 // while links captured at human result confirmation remain immutable review proof.
 return {...view,attachments:view.attachments.filter(file=>{if(!file.evidenceId||confirmed.has(file.id))return true;const entry=evidence.get(file.evidenceId);return entry&&(entry.state==='shared'&&!superseded.has(entry.id)||entry.state==='draft'&&entry.authorUserId===ctx.userId);})};
}
/** A chat turn can read only existing cached contents. Visibility is re-evaluated through native file RLS. */
export async function getAssessmentFileTexts(ctx:SessionContext,reviewId:string,contextId?:string){
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};
 return withPerformanceTenant(ctx,tx=>getAssessmentFileTextsTx(tx,ctx,reviewId,contextId));
}
/** Native assignment/evidence visibility and actual immutable-content binding in the caller Tx. */
export async function getAssessmentFileTextsTx(tx:Tx,ctx:SessionContext,reviewId:string,contextId?:string){
 const view=await contextTx(tx,ctx,reviewId,contextId),ids=view.attachments.map(a=>a.id);if(!ids.length)return new Map<string,EvidenceText>();
 const rows=await tx.select().from(assessmentFileText).where(inArray(assessmentFileText.attachmentId,ids)).orderBy(asc(assessmentFileText.attachmentId));
 // PG16 binary-string SHA256; no attachment bytes leave this query or enter a receipt.
 const current=await tx.select({id:performanceAttachment.id,hash:sql<string>`encode(sha256(${performanceAttachment.content}),'hex')`}).from(performanceAttachment).where(inArray(performanceAttachment.id,ids));
 const hashes=new Map(current.map(row=>[row.id,row.hash]));
 if(rows.some(row=>hashes.get(row.attachmentId)!==row.contentHash))throw Error('Current assessment evidence could not be confirmed.');
 return new Map(rows.map(row=>[row.attachmentId,{status:row.status as EvidenceText['status'],text:row.text,method:row.method as EvidenceText['method']}]));
}
/** Explicit summary generation reads files outside transactions. Images: four workers, eight files, one 22s deadline. */
export async function readAssessmentFileTexts(ctx:SessionContext,reviewId:string,{allowImages=false,budgetMs=30000,contextId}:{allowImages?:boolean;budgetMs?:number;contextId?:string}={}){
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};
 const view=await context(ctx,reviewId,contextId),sourceFingerprint=fingerprint(view),ids=view.attachments.map(a=>a.id),idSet=new Set(ids),end=Date.now()+Math.min(30000,Math.max(1,budgetMs));
 if(!ids.length)return new Map<string,EvidenceText>();
 const cached=await withPerformanceTenant(ctx,tx=>tx.select().from(assessmentFileText).where(inArray(assessmentFileText.attachmentId,ids)).orderBy(asc(assessmentFileText.attachmentId))),byId=new Map(cached.map(row=>[row.attachmentId,row]));
 const out=new Map<string,EvidenceText>(cached.map(row=>[row.attachmentId,{status:row.status as EvidenceText['status'],text:row.text,method:row.method as EvidenceText['method']}]));
 type Write={id:string;hash:string;value:EvidenceText;attempts:number};const writes:Write[]=[],images:typeof view.attachments=[];
 async function bytes(id:string,vision=false){
  return withPerformanceTenant(ctx,async tx=>{
   const current=await contextTx(tx,ctx,reviewId,contextId);
   if(fingerprint(current)!==sourceFingerprint||!current.attachments.some(file=>file.id===id))throw Error('Current assessment evidence could not be confirmed.');
   const [file]=await tx.select({id:performanceAttachment.id,name:performanceAttachment.fileName,content:performanceAttachment.content}).from(performanceAttachment).where(eq(performanceAttachment.id,id));
   if(!file)return null;
   const hash=createHash('sha256').update(file.content).digest('hex');
   let cfg:ResolvedAiConfig|null=null;if(vision)try{cfg=await assessmentAiConfigTx(tx,ctx,'pm');}catch{/* Manual file reading remains available when AI is unusable. */}
   if(cfg&&supportsImageReading(cfg.provider)){
    let expected:string|null=null;try{expected=imageInputDigest(captureImageInput({data:file.content,mimeType:imageMimes[evidenceExtension(file.name)]}));}catch{/* Invalid bytes retain the ordinary readImage refusal; they cannot acquire admission. */}
    cfg=withAiAdmissionCheck(cfg,'performance_pm',async(admissionTx,request)=>{
     if(request.operation!=='image'||request.inputDigest!==expected||!await assessmentAiFeatureEnabledTx(admissionTx,ctx,'pm'))throw Error('Current assessment image access could not be confirmed.');
     const fresh=await contextTx(admissionTx,ctx,reviewId,contextId);
     if(fingerprint(fresh)!==sourceFingerprint||!fresh.attachments.some(item=>item.id===id))throw Error('Current assessment image access could not be confirmed.');
     const [actual]=await admissionTx.select({name:performanceAttachment.fileName,hash:sql<string>`encode(sha256(${performanceAttachment.content}),'hex')`}).from(performanceAttachment).where(eq(performanceAttachment.id,id));
     if(!actual||actual.name!==file.name||actual.hash!==hash)throw Error('Current assessment image access could not be confirmed.');
    });
   }
   return {...file,cfg,hash};
  });
 }
 for(const file of view.attachments){
  const prior=byId.get(file.id);if(prior&&prior.status!=='retry')continue;
  if(imageMimes[evidenceExtension(file.fileName)]){images.push(file);out.set(file.id,unread());continue;}
  if(Date.now()>=end){out.set(file.id,unread());continue;}
  const source=await bytes(file.id);if(!source){out.delete(file.id);continue;}
  const value=await extractEvidenceText(source.name,source.content);out.set(file.id,value);writes.push({id:file.id,hash:source.hash,value,attempts:1});
 }
 if(allowImages&&images.length&&Date.now()<end){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.max(1,Math.min(22000,end-Date.now())));let next=0;
  try{await Promise.all(Array.from({length:Math.min(4,images.length)},async()=>{
   while(next<Math.min(8,images.length)){
    const file=images[next++];if(controller.signal.aborted)break;
    const source=await bytes(file.id,true);if(!source){out.delete(file.id);continue;}if(!source.cfg||!supportsImageReading(source.cfg.provider))continue;
    let value:EvidenceText;
    try{const text=await readImage(source.cfg,{data:source.content,mimeType:imageMimes[evidenceExtension(source.name)],signal:controller.signal});value={status:text?'ok':'no_text',text,method:'vision'};}
    catch(error){value={status:controller.signal.aborted?(byId.get(file.id)?.status==='retry'?'unreadable':'retry'):error instanceof AiImageReadError&&!error.retryable?'unreadable':'unread',text:'',method:'vision'};}
    await recordProposal(ctx,{type:'performance_file_transcription',subject:{type:'performance-attachment',id:file.id},facts:{attachmentId:file.id,contentHash:source.hash},proposal:{status:value.status,characters:Array.from(value.text).length},adjudication:value.status==='ok'||value.status==='no_text'?{ok:true}:{ok:false,reason:'Image transcription unavailable.'},provider:source.cfg.provider,model:source.cfg.model});
    out.set(file.id,value);if(value.status!=='unread')writes.push({id:file.id,hash:source.hash,value,attempts:byId.get(file.id)?.status==='retry'?2:1});
   }
  }));}finally{clearTimeout(timer);controller.abort();}
 }
 // A relationship or evidence retraction may change during parsing/provider work. Re-project before caching or returning.
 const fresh=await context(ctx,reviewId,contextId),freshIds=new Set(fresh.attachments.map(a=>a.id));
 for(const id of out.keys())if(!freshIds.has(id)||!idSet.has(id))out.delete(id);
 await withPerformanceTenant(ctx,async tx=>{
  const aiAllowed=(await assessmentAiFeatureEnabledTx(tx,ctx,'pm'));
  for(const write of writes.sort((a,b)=>a.id.localeCompare(b.id))){
   if(!freshIds.has(write.id)||!write.value.method)continue;
   if(write.value.method==='vision'&&!aiAllowed){out.set(write.id,unread());continue;}
   const [visible]=await tx.select({id:performanceAttachment.id}).from(performanceAttachment).where(eq(performanceAttachment.id,write.id));if(!visible){out.delete(write.id);continue;}
   // Concurrent reads share immutable contents; the first completed terminal read wins over a stale retry.
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`assessment-file-text:${write.id}`},0))`);
   const [existing]=await tx.select().from(assessmentFileText).where(eq(assessmentFileText.attachmentId,write.id)).for('update');if(existing&&existing.status!=='retry'){out.set(write.id,{status:existing.status as EvidenceText['status'],text:existing.text,method:existing.method as EvidenceText['method']});continue;}
   const fields={tenantId:ctx.tenantId,attachmentId:write.id,contentHash:write.hash,status:write.value.status,method:write.value.method,text:write.value.text,attempts:write.attempts,readAt:new Date()};
   if(existing)await tx.update(assessmentFileText).set(fields).where(and(eq(assessmentFileText.attachmentId,write.id),eq(assessmentFileText.contentHash,write.hash)));else await tx.insert(assessmentFileText).values(fields).onConflictDoNothing();
  }
 });
 return new Map([...out].sort(([a],[b])=>a.localeCompare(b)));
}
