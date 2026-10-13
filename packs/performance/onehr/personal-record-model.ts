import type { AnonymousFeedbackReport } from './feedback-report';
import { goalSchema, type PMBand } from './model';

export function agreementWords(pct:number):'consistent'|'most'|'some'|'few' {
 return pct>=90?'consistent':pct>=75?'most':pct>=40?'some':'few';
}

/** Historical records publish manager remarks at closure or after the planning year advances. */
export function personalPlan<T extends {status:string;planYear:number;goals:unknown;managerComment:string;conversation:string}>(plan:T,activePlanningYear:number|null) {
 const published=plan.status==='closed'||activePlanningYear!==null&&plan.planYear<activePlanningYear;
 return {...plan,goals:goalSchema.array().parse(plan.goals).map(g=>({...g,managerComment:published?g.managerComment:''})),managerComment:published?plan.managerComment:'',managerRemarksPublished:published};
}

/** The source record uses words and principle aggregates, never rater counts or raw scores. */
export function personalFeedback(report:AnonymousFeedbackReport|null) {
 if(!report)return null;
 const principles=(report.principles??[]).filter((p):p is {principle:string;agreementPct:number}=>p.agreementPct!==null)
  .map((p,index)=>({...p,index})).sort((a,b)=>b.agreementPct-a.agreementPct||a.index-b.index);
 const top=principles[0]?.agreementPct;
 const words=(p:typeof principles[number])=>({principle:p.principle,words:agreementWords(p.agreementPct)});
 const strong=principles.filter(p=>p.agreementPct===top).slice(0,2).map(words);
 const grow=[...principles].reverse().filter(p=>p.agreementPct!==top).slice(0,2).map(words);
 return {strong,grow,even:principles.length>0&&grow.length===0,
  statements:report.statements.map(s=>({id:s.id,principle:s.principle,text:s.text,words:s.agreementPct===null?null:agreementWords(s.agreementPct)})),
  comments:report.comments,remarks:report.remarks};
}

export type PersonalHistoryRating={id:string;name:string;performance:PMBand|null;talent:string|null};
/** Six history rows are considered before filtering rated rows, in oldest-to-newest order. */
export function personalTrend(rows:PersonalHistoryRating[]) {
 const rated=rows.slice(0,6).reverse().filter((r):r is PersonalHistoryRating&{performance:PMBand}=>r.performance!==null);
 if(rated.length<2)return null;
 return {first:rated[0],last:rated[rated.length-1],rows:rated};
}
