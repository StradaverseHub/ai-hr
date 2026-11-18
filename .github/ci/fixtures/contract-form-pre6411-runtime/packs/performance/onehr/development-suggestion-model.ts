import type { AnonymousFeedbackReport } from './feedback-report';
import type { Competency } from './model';
export type DevelopmentItem={id:string;kind:'leadership'|'technical';label:string;detail:string;note:string;source:string};
export type SuggestedDevelopmentGoal={area:string;title:string;itemIds:string[];onJob:string;fromOthers:string;formalLearning:string};
/** Source pm_idp_gaps: one weakest descriptor per principle below 60%; only reviewed technical gaps. */
export function developmentItems(report:AnonymousFeedbackReport|null,competencies:Competency[],status:string){
 const items:DevelopmentItem[]=[],future:DevelopmentItem[]=[],seen=new Set<string>();
 const weak=(report?.statements??[]).filter(s=>s.agreementPct!=null&&s.agreementPct<60).sort((a,b)=>a.agreementPct!-b.agreementPct!);
 for(const statement of weak){if(seen.has(statement.principle))continue;seen.add(statement.principle);const pct=statement.agreementPct!;items.push({id:`lp:${items.length}`,kind:'leadership',label:statement.principle,detail:statement.text,note:`${pct}% agreement`,source:`Leadership behaviour: ${pct}% agreement in the released feedback report.`});if(items.length===14)break;}
 if(status==='reviewed')for(const [index,skill] of competencies.entries()){
  if((skill.manager??skill.self)==='yes')continue;
  const entry:DevelopmentItem={id:`tc:${index}`,kind:'technical',label:skill.skillTitle??skill.principle,detail:skill.text.slice(0,400),note:skill.future?'next level':'not demonstrated',source:skill.future?'Assigned next-level competency, a stretch rather than a recorded shortfall.':'A competency the line manager’s review left as not yet demonstrated.'};
  (skill.future?future:items).push(entry);
 }
 return {items,future,pool:items.length?items:future,stretchOnly:!items.length&&future.length>0};
}
/** Source _pm_parse_idp_goals: cite only this request's supplied items; dates are deliberately discarded. */
export function parseDevelopmentSuggestions(raw:string,validIds:ReadonlySet<string>,maxGoals:number):SuggestedDevelopmentGoal[]{
 try{
  const first=raw.indexOf('['),last=raw.lastIndexOf(']');if(first<0||last<first)return [];
  const data:unknown=JSON.parse(raw.slice(first,last+1));if(!Array.isArray(data))return [];
  const clean=(value:unknown,cap:number)=>(typeof value==='string'||typeof value==='number')?String(value).trim().slice(0,cap):'';
  const goals:SuggestedDevelopmentGoal[]=[];
  for(const value of data){
   if(!value||typeof value!=='object'||Array.isArray(value))continue;
   const row=value as Record<string,unknown>,ids=Array.isArray(row.item_ids)?row.item_ids.filter((id):id is string=>typeof id==='string'&&validIds.has(id)):[],area=clean(row.area,200),title=clean(row.title,120);
   if(!ids.length||!area&&!title)continue;
   goals.push({area:area||title,title:title||area,itemIds:ids,onJob:clean(row.experience,1000),fromOthers:clean(row.exposure,1000),formalLearning:clean(row.education,1000)});
   if(goals.length>=maxGoals)break;
  }
  return maxGoals>0?goals:[];
 }catch{return [];}
}
