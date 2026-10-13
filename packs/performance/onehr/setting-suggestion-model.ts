import { kpiSchema,type KPI } from './model';
import { spreadScoring,type KpiLibraryChoice } from './setting-default-model';
import { sourceFigure } from './source-numeric';

export function hasLibrarySpread(item:KpiLibraryChoice){
 return item.scoring.mechanism==='A'?!!item.spread?.rate:item.spread?.threshold!=null||item.scoring.variant==='excellence'&&item.spread?.excellence!=null;
}
/** Source _pm_parse_kpi_set: whitelist, deduplicate, cap eight and normalize weights on the server. */
export function adjudicateSettingSuggestion(raw:string,library:KpiLibraryChoice[],moderatorEmploymentId:string|null){
 try{
  const start=raw.indexOf('['),end=raw.lastIndexOf(']');if(start<0||end<start)return null;
  const data:unknown=JSON.parse(raw.slice(start,end+1));if(!Array.isArray(data)||data.length>1000)return null;
  const picks:{item:KpiLibraryChoice;weight:number;base:number|null}[]=[],seen=new Set<string>();
  const numeric=(value:unknown)=>typeof value==='number'?value:typeof value==='string'&&value.trim()?Number(value):NaN;
  for(const value of data){
   if(!value||typeof value!=='object'||Array.isArray(value))continue;
   const pick=value as Record<string,unknown>,item=library.find(item=>item.id===pick.id),weight=numeric(pick.weightage),base=numeric(pick.target);
   if(!item||seen.has(item.id)||seen.has(`title:${item.title}`)||!Number.isFinite(weight)||weight<=0)continue;
   picks.push({item,weight,base:Number.isFinite(base)&&base>0?base:null});seen.add(item.id);seen.add(`title:${item.title}`);if(picks.length===8)break;
  }
  if(!picks.length)return null;
  const total=picks.reduce((n,p)=>n+p.weight,0);if(!Number.isFinite(total)||total<=0)return null;
  const weights=picks.map(p=>sourceFigure(p.weight*100/total,2)!);
  const drift=sourceFigure(100-weights.reduce((n,w)=>n+w,0),2)!;
  // The source explicitly absorbs rounding drift into the final selected line.
  weights[weights.length-1]=sourceFigure(weights[weights.length-1]+drift,2)!;
  const aiBases=new Map<string,number>();
  const kpis:KPI[]=picks.map(({item,base},index)=>{
   const id=crypto.randomUUID(),generated=base!=null&&hasLibrarySpread(item);
   const scoring=generated?spreadScoring(item.scoring,item.spread,base):item.defaultScoring??item.scoring;
   if(generated)aiBases.set(id,base);
   return kpiSchema.parse({id,libraryId:item.id,title:item.title,category:item.category,description:item.description,unit:item.unit,weightBp:Math.round(weights[index]*100),scoring,numberSource:generated?'ai':item.numberSource??'library',moderatorEmploymentId,setting:'draft',settingRemark:'',actual:null,note:'',approvedActual:null,moderationRemark:'',locked:false});
  });
  return {kpis,aiBases};
 }catch{return null;}
}
