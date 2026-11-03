/** AI v2 Phase 2 P2-6 — the Ask read ai_quality_summary (core/semantic-model/entities-quality.ts).
 *
 * The AI quality page's figures as the model may read them: core/learning/quality.ts aiQuality, run as the caller (HR and
 * group administrators, for the companies they administer; anyone else is refused before any read), projected to the
 * declared fields. Percentages are the page's own (to one decimal place, from the service's counts), so the model never
 * works one out. No redacted example, correction, name, person or id is passed on; nothing here decides what the person
 * may see, the harness discloses by the entity's classes. Read only. */
import type {SessionContext} from '../../db/client';
import {provenance,refuse,type ExplainerOutcome} from '../explainers/outcome';
import {LearningRefused} from './access';
import {aiQuality} from './quality';
import type {Share} from './quality-math';
import {isQualityPeriod} from './types';

export const TOP_GAPS=5;
const percent=(value:Share)=>Object.freeze({percent:value.share===null?null:Math.round(value.share*1000)/10,count:value.part,of:value.whole});

export async function askAiQuality(ctx:SessionContext,input:Readonly<Record<string,unknown>>):Promise<ExplainerOutcome>{
 let view:Awaited<ReturnType<typeof aiQuality>>;
 try{view=await aiQuality(ctx,{period:isQualityPeriod(input.period)?input.period:'last30'});}
 catch(error){if(error instanceof LearningRefused)return refuse('not_permitted','AI quality is for HR and group administrators only.');throw error;}
 const {figures}=view;
 return{ok:true,period:{name:view.period,from:view.periodFrom,to:view.today},companies:view.companies.length,
  helpful:percent(figures.helpful),confirmedUnchanged:percent(figures.prepared.unchanged),edited:percent(figures.prepared.edited),discarded:percent(figures.prepared.discarded),
  openGaps:{intents:figures.gaps.openIntents,questions:percent(figures.gaps.openQuestions)},
  topGaps:view.gaps.slice(0,TOP_GAPS).map(row=>({kind:row.kind,area:row.area,count:row.count,status:row.status??'mixed'})),
  openProposals:view.proposals.filter(row=>row.state==='open').length,
  provenance:provenance('core/learning/quality.ts#aiQuality','Not applicable: counts of what people did with AI Centre\'s work, not a versioned rule.','/assistant',
   'The AI quality page\'s figures for the companies this administrator administers; no examples, names or people, and no ratio of HR staff to employees.')};
}
