import { and,asc,inArray,isNull,sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext,Tx } from '../../../db/client';
import { performanceAttachment } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { bandFor,kpiSchema,pmBands,policySchema,scoreKPI,scorecard,type KPI,type PMBand } from './model';
import { sourceGroupedFigure } from './source-numeric';
import type { InsightFacts,InsightRow } from './performance-insight-model';
const sourceSchema=z.object({reviewId:z.uuid(),cycleId:z.uuid(),companyId:z.uuid(),name:z.string(),revision:z.number().int(),reviewerKind:z.enum(['manager','calibrator']),kpis:z.array(kpiSchema),submitted:z.boolean(),selfRemark:z.string(),reviewerRemarks:z.array(z.object({actorUserId:z.uuid().nullable(),author:z.string(),remark:z.string(),role:z.string(),legacy:z.boolean()})),bands:z.object({aBands:policySchema.shape.aBands,bBands:policySchema.shape.bBands}),evidenceEnabled:z.boolean(),names:z.record(z.string(),z.string()),fileLinks:z.array(z.object({attachmentId:z.uuid(),kpiId:z.uuid()})),trail:z.array(z.object({tier:z.string(),label:z.string(),by:z.string(),from:z.enum(pmBands).nullable(),band:z.enum(pmBands).nullable(),note:z.string()}))});
const figure=(value:number,unit:string)=>sourceGroupedFigure(value)+(unit?(unit==='%'?'':' ')+unit:'');
export async function getAssessmentInsightSource(ctx:SessionContext,reviewId:string,contextId=reviewId){
 return withPerformanceTenant(ctx,tx=>getAssessmentInsightSourceTx(tx,ctx,reviewId,contextId));
}
export async function getAssessmentInsightSourceTx(tx:Tx,ctx:SessionContext,reviewId:string,contextId=reviewId){
 z.uuid().parse(reviewId);z.uuid().parse(contextId);
  const [row]=await tx.execute<{value:unknown}>(sql`select app.assessment_insight_source(${reviewId}::uuid,${contextId}::uuid) as value`);if(!row?.value)throw Error('This assessment insight is not assigned to you.');
  const source=sourceSchema.parse(row.value),ids=[...new Set(source.fileLinks.map(l=>l.attachmentId))];
  const attachments=source.evidenceEnabled&&ids.length?await tx.select({id:performanceAttachment.id,fileName:performanceAttachment.fileName,sizeBytes:performanceAttachment.sizeBytes,evidenceId:performanceAttachment.evidenceId}).from(performanceAttachment).where(and(inArray(performanceAttachment.id,ids),isNull(performanceAttachment.removedAt))).orderBy(asc(performanceAttachment.id)):[];
  const visibleFiles=new Map(attachments.map(f=>[f.id,f]));
  const minima=source.kpis[0]?.scoring.mechanism==='B'?source.bands.bBands.find(b=>b.companyId===source.companyId)?.minima:[1,2,3,4,5];
  const band=(value:number,k:KPI):PMBand|null=>bandFor(scoreKPI(value,k.scoring),k.scoring.mechanism==='A'?[1,2,3,4,5]:minima??[]);
  const rows:InsightRow[]=source.kpis.filter(k=>!k.hrOwned&&k.actual!=null).map(k=>{
   const unit=k.unit.trim(),scoring=k.scoring,target=scoring.mechanism==='A'?scoring.rates[2]:scoring.target;
   let from=k.actual!;const moderation:InsightRow['moderation']=[];
   if(source.reviewerKind==='calibrator'&&k.locked)for(const step of k.approvalChain??[]){if(!step.at||step.actual==null)continue;const changed=Math.abs(from-step.actual)>Math.max(Math.abs(from)*.0005,1e-9);if(changed)moderation.push({by:source.names[step.employmentId]??'Their manager',from,to:step.actual,from_res:figure(from,unit),to_res:figure(step.actual,unit),why:step.remark.trim()});from=step.actual;}
   const modValue=moderation.length?k.approvedActual:null;
   return {id:k.id,kpi:k.title,band:band(k.actual!,k),rating:scoreKPI(k.actual!,k.scoring),mod_band:k.approvedActual==null?band(k.actual!,k):band(k.approvedActual,k),value:k.actual!,result:figure(k.actual!,unit),target:target==null?null:sourceGroupedFigure(target),target_raw:target,unit,direction:scoring.method==='more'?'higher is better':'lower is better',weight:k.weightBp/100,mech:scoring.mechanism,scale:scoring.mechanism==='A'?scoring.rates.map(n=>n==null?'':sourceGroupedFigure(n)).join(' · '):`Threshold ${sourceGroupedFigure(scoring.threshold!)} · Target ${sourceGroupedFigure(scoring.target!)} · ${scoring.variant==='excellence'?'Excellence '+sourceGroupedFigure(scoring.excellence!):'Multiplier '+scoring.multiple+'%'}`,note:k.note,file_list:source.fileLinks.filter(link=>link.kpiId===k.id&&visibleFiles.has(link.attachmentId)).map(link=>({id:link.attachmentId,name:visibleFiles.get(link.attachmentId)!.fileName,note:''})),moderation,mod_value:modValue,mod_result:modValue==null?null:figure(modValue,unit),locked:k.locked,approvers:source.reviewerKind==='calibrator'?(k.approvalChain??[]).filter(step=>step.at).map(step=>source.names[step.employmentId]??'Their manager'):[]};
  });
  const self=scorecard(source.kpis,source.bands,source.companyId,false),manager=scorecard(source.kpis,source.bands,source.companyId,true),complete=source.kpis.length>0&&source.kpis.every(k=>k.actual!=null);
  const facts:InsightFacts={rows,remark:source.selfRemark,reviewer_kind:source.reviewerKind,overall:complete?{value:manager.score??self.score,label:manager.band??self.band}:null,self_overall:complete?{value:self.score,label:self.band}:null,mgr_remarks:source.reviewerRemarks.map(({author,remark,role})=>({author,remark,role})),trail:source.trail,hr:source.kpis.filter(k=>k.hrOwned&&k.actual!=null).map(k=>({kpi:k.title,band:band(k.approvedActual??k.actual!,k)}))};
  return {reviewId,contextId,cycleId:source.cycleId,revision:source.revision,name:source.name,submitted:source.submitted,facts,attachments:attachments.map(file=>({...file,canRemove:false}))};
}
