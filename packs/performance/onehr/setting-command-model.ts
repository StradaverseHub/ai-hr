import { z } from 'zod';
import { kpiSchema, type KPI } from './model';
import type { KpiLibraryTemplate } from './import-model';
import { spreadScoring,type KpiLibraryChoice } from './setting-default-model';

const span=z.object({start:z.number().int().min(0),end:z.number().int().min(1)}).strict();
const reference={id:z.uuid(),target:span};
export const settingCommandsSchema=z.object({commands:z.array(z.discriminatedUnion('action',[
 z.object({action:z.literal('add_kpi'),...reference}).strict(),
 z.object({action:z.literal('remove_kpi'),...reference}).strict(),
 z.object({action:z.literal('set_weight'),...reference,value:span}).strict(),
 z.object({action:z.literal('set_target'),...reference,value:span}).strict(),
 z.object({action:z.literal('set_number'),...reference,field:z.enum(['rate1','rate2','rate3','rate4','rate5','threshold','target','multiple','excellence']),value:span}).strict(),
])).max(50)}).strict();
export type SettingCommandFacts={text:string;kpis:KPI[];library:KpiLibraryChoice[];moderatorEmploymentId:string|null};
const normal=(s:string)=>s.trim().normalize('NFKC').toLocaleLowerCase('en');
/** Targets use the administrator's ladder shape. The provider never calculates a target or weight. */
export function applyLibraryTarget(kpi:KPI,template:KpiLibraryTemplate|undefined,value:number):KPI['scoring'] {
 if(value<=0)throw Error('The base target must be positive.');
 return spreadScoring(kpi.scoring,template?.spread,value);
}
/** Only literal actor values and eligible catalogue definitions may enter the scorecard. */
export function adjudicateSettingCommands(raw:string,facts:SettingCommandFacts){
 try{
  const proposal=settingCommandsSchema.parse(JSON.parse(raw)),kpis=structuredClone(facts.kpis),used=new Set<string>();
  if(kpis.some(k=>k.hrOwned||['approved','proposed'].includes(k.setting)))throw Error('This scorecard is not editable in chat.');
  const extract=(s:z.infer<typeof span>)=>{if(s.end>facts.text.length||s.start>=s.end)throw Error('Invalid message span.');return facts.text.slice(s.start,s.end).trim();};
  const number=(s:z.infer<typeof span>)=>{const text=extract(s).replaceAll(',','').replace(/%$/,'');if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)||!Number.isFinite(Number(text)))throw Error('Use a literal finite number.');return Number(text);};
  for(const c of proposal.commands){
   const key=`${c.id}:${c.action==='set_number'?c.field:c.action}`;
   if(used.has(key)||used.has(`${c.id}:remove_kpi`)||c.action==='remove_kpi'&&[...used].some(k=>k.startsWith(`${c.id}:`)))throw Error('Conflicting updates.');used.add(key);
   const candidates=c.action==='add_kpi'?facts.library:kpis;
   const target=candidates.find(k=>k.id===c.id),label=extract(c.target);
   if(!target||normal(target.title)!==normal(label)||candidates.filter(k=>normal(k.title)===normal(label)).length!==1)throw Error('Name one eligible KPI exactly.');
   if(c.action==='add_kpi'){
    const item=facts.library.find(k=>k.id===c.id)!;
    if(kpis.some(k=>k.libraryId===item.id||k.title===item.title))throw Error('This library KPI is already selected.');
    kpis.push(kpiSchema.parse({id:crypto.randomUUID(),libraryId:item.id,title:item.title,category:item.category,description:item.description,unit:item.unit,weightBp:item.weightBp??0,scoring:item.defaultScoring??item.scoring,numberSource:item.numberSource??'library',moderatorEmploymentId:facts.moderatorEmploymentId,setting:'draft',settingRemark:'',actual:null,note:'',approvedActual:null,moderationRemark:'',locked:false}));
   }else{
    const k=kpis.find(k=>k.id===c.id)!;
    if(c.action==='remove_kpi'){kpis.splice(kpis.indexOf(k),1);continue;}
    const value=number(c.value);
    if(c.action==='set_weight'){if(value<=0||value>100)throw Error('Weight must be above zero and at most 100%.');k.weightBp=Math.round(value*100);}
    else if(c.action==='set_target')k.scoring=applyLibraryTarget(k,facts.library.find(l=>l.id===k.libraryId),value);
    else if(k.scoring.mechanism==='A'){
     if(c.field==='target'){k.scoring.target=value;continue;}
     if(!/^rate[1-5]$/.test(c.field))throw Error('Use a threshold supported by this mechanism.');
     k.scoring.rates[Number(c.field.slice(4))-1]=value;
    }else{
     if(!['threshold','target',...(k.scoring.variant==='excellence'?['excellence']:['multiple'])].includes(c.field))throw Error('Use a number supported by this mechanism.');
     Object.assign(k.scoring,{[c.field]:c.field==='multiple'?Math.trunc(value):value});
    }
   }
  }
  const checked=kpiSchema.array().max(100).parse(kpis);
  return {ok:true as const,kpis:checked,proposal,changed:JSON.stringify(checked)!==JSON.stringify(facts.kpis)};
 }catch(error){return {ok:false as const,reason:error instanceof Error?error.message:'Invalid setting command.'};}
}
