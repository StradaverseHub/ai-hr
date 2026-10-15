import { bandFor,scoreKPI,type KPI,type Policy } from './model';
import type { careerGap } from './career-model';
import type { DevelopmentItem } from './development-suggestion-model';

export type CareerDraftItem={id:string;area:string;detail:string;kind:'stretch'|'missing'|'performance'|'leadership'|'technical';note:string};
export type CareerDraftGoal={area:string;itemIds:string[];onJob:string;fromOthers:string;formalLearning:string};
/** Source target-gap + weak KPI pool, de-duplicated by area; generic released gaps are the fallback. */
export function careerDraftItems(targetGap:ReturnType<typeof careerGap>|null,kpis:KPI[],policy:Pick<Policy,'aBands'|'bBands'>,companyId:string,fallback:DevelopmentItem[]):CareerDraftItem[]{
 const items:CareerDraftItem[]=[];
 for(const row of targetGap?.rows??[]){
  if(row.state==='met')continue;
  items.push({id:`gap:${row.title}`,area:row.title,kind:row.state,note:`level ${row.required}`,detail:row.have==null?`${row.title} is not demonstrated yet; the chosen role needs level ${row.required}.`:`${row.title} is demonstrated at level ${row.have}; the chosen role needs level ${row.required}.`});
 }
 for(const kpi of kpis){
  if(kpi.actual==null)continue;
  const minima=kpi.scoring.mechanism==='A'?policy.aBands:policy.bBands.find(b=>b.companyId===companyId)?.minima;
  if(!minima)continue;
  let band;try{band=bandFor(scoreKPI(kpi.actual,kpi.scoring),minima);}catch{continue;}
  if(band!=='UA'&&band!=='BE')continue;
  items.push({id:`kpi:${kpi.id}`,area:kpi.title,kind:'performance',note:band,detail:`${kpi.title} came in at ${band} this period; propose capability-building actions to improve it.`});
 }
 if(!items.length)return fallback.map(item=>({id:item.id,area:item.label,detail:item.detail,kind:item.kind,note:item.note}));
 const seen=new Set<string>();return items.filter(item=>{const key=item.area.trim().toLowerCase();if(!key||seen.has(key))return false;seen.add(key);return true;});
}
/** The model may fill only actions for the deterministic areas. Its dates, role IDs and new areas are ignored. */
export function parseCareerActions(raw:string,items:CareerDraftItem[]):CareerDraftGoal[]{
 const rows=new Map<number,Record<string,unknown>>();
 try{
  const start=raw.indexOf('['),end=raw.lastIndexOf(']');if(start>=0&&end>=start){const data:unknown=JSON.parse(raw.slice(start,end+1));
   if(Array.isArray(data))for(const row of data){if(!row||typeof row!=='object'||Array.isArray(row))continue;const value=row as Record<string,unknown>,i=value.i;if(typeof i==='number'&&Number.isInteger(i)&&i>=0&&i<items.length)rows.set(i,value);}
  }
 }catch{/* Deterministic goal areas remain usable if action drafting fails. */}
 const clean=(value:unknown)=>typeof value==='string'?value.trim().slice(0,1000):'';
 return items.map((item,i)=>({area:item.area,itemIds:[item.id],onJob:clean(rows.get(i)?.experience),fromOthers:clean(rows.get(i)?.exposure),formalLearning:clean(rows.get(i)?.education)}));
}
/** Only the visible, blank longer-term line may be suggested; role, mobility and other fields have no writer here. */
export function parseCareerAspiration(raw:string):string{
 try{const start=raw.indexOf('{'),end=raw.lastIndexOf('}');if(start<0||end<start)return '';const value:unknown=JSON.parse(raw.slice(start,end+1));if(value&&typeof value==='object'&&!Array.isArray(value)){const text=(value as Record<string,unknown>).aspirationLong;return typeof text==='string'?text.trim().slice(0,4000):'';}}catch{}
 return '';
}
