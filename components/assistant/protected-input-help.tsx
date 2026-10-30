"use client";
import {useTranslations} from 'next-intl';
const examples={payRule:['10% of basic','per day: 50','per hour: 12.50','fixed','quantity: 3 rate: 25','value: 120 cap: 100'],report:[],layout:['format as a paragraph','format as bullets'],performance:['remark: ','aspiration: ','log evidence: ','add KPI: ','remove KPI: ','weight for '],calibration:['distribution','framework','curve gaps']} as const;
/** Templates fill an ordinary human-owned input only; no request or effect is dispatched here. */
export function ProtectedInputHelp({kind,onChoose,choices,disabled=false}:{disabled?:boolean;kind:keyof typeof examples;onChoose?:(value:string)=>void;choices?:readonly string[]}){
 const t=useTranslations('assistant.protectedInput');
 return <div className="space-y-2 py-2"><p className="text-xs leading-relaxed text-muted-foreground">{t(kind)}</p>{onChoose&&<div className="flex flex-wrap gap-2">{(choices??examples[kind]).map(value=><button key={value} type="button" disabled={disabled} onClick={()=>onChoose(value)} className="min-h-11 max-w-full break-words rounded-md border px-3 py-2 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{value}</button>)}</div>}</div>;
}
