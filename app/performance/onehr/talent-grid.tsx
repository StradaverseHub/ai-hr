'use client';
import type { ReactNode } from 'react';
import { potentialBands,talentCell9,talentCell,type PMBand,type PotentialBand } from '@/packs/performance/onehr/model';
export type TalentGridPerson={id:string;name:string;performance:PMBand|null;potential:PotentialBand|null};
export function TalentGrid({rows,labels,onSelect,onPick,selected,compact=false,highlight,height,lastViewed=null,performanceAxis,potentialAxis}:{rows:TalentGridPerson[];labels:Record<string,string>;onSelect?:(id:string)=>void;onPick?:(cell:string)=>void;selected?:string;compact?:boolean;highlight?:string;height?:number;lastViewed?:string|null;performanceAxis?:ReactNode;potentialAxis?:ReactNode}) {
 const performance=['low','mid','high'] as const,dense=compact||!!height&&height<232;
 const placed=rows.filter(r=>talentCell(r)!=null).length;
 const tone=(category:string)=>category==='PIP/Improvement'?'bg-amber-50 dark:bg-amber-500/10':category==='Super Star'?'bg-primary/15':category==='Star'?'bg-primary/10':'bg-muted/30';
 return <section style={height?{height}:undefined} className="min-w-0 space-y-2" aria-label={labels.title}>
  <div className="flex min-w-0 items-stretch gap-1">{potentialAxis&&<div className="flex w-11 shrink-0 items-center justify-center">{potentialAxis}</div>}<div style={height?{height:height-(performanceAxis?52:24),gridTemplateRows:'1rem repeat(3,minmax(0,1fr))'}:undefined} className="grid min-w-0 flex-1 grid-cols-[2.5rem_repeat(3,minmax(0,1fr))] gap-1">
   <div className="col-start-2 col-span-3 grid grid-cols-3 gap-1 text-center text-xs font-medium">{performance.map(p=><span key={p}>{labels[p]??p}</span>)}</div>
   {[...potentialBands].reverse().map(pot=><div key={pot} className="contents"><span className="flex items-center justify-center text-xs font-medium">{pot}</span>{performance.map(perf=>{
    const key=`${perf}|${pot}`,members=rows.filter(r=>talentCell(r)===key),category=talentCell9(perf,pot),active=selected===key,marked=highlight===category;
    const faces=lastViewed&&members.some(m=>m.id===lastViewed)?[...members.filter(m=>m.id===lastViewed),...members.filter(m=>m.id!==lastViewed)]:members;
    return <div key={key} className={`min-w-0 rounded-md border ${dense?'p-1':'p-2'} ${height?'overflow-hidden':compact?'min-h-14':'min-h-20'} ${tone(category)} ${active||marked?'border-primary ring-1 ring-primary':'border-border'} ${highlight&&!marked?'opacity-50':''}`}>
     <button type="button" onClick={()=>onPick?.(key)} aria-pressed={active} aria-label={`${labels[perf]??perf} ${labels.performance}, ${pot} ${labels.potential}: ${members.length}`} className={`flex ${dense?'min-h-6':'min-h-8'} w-full items-center justify-between gap-1 text-left`}>
      {!compact&&<span className="text-[11px] font-medium leading-tight">{category}</span>}<span className="text-lg font-semibold tabular-nums">{members.length}</span>{!compact&&(!height||height>=280)&&<span className="ml-1 text-xs text-muted-foreground">{placed?Math.round(members.length/placed*100):0}%</span>}
     </button>
     {!compact&&(!height||height>=280)&&<ul className="flex flex-wrap gap-1">{faces.slice(0,3).map(m=><li key={m.id}>{onSelect?<button type="button" onClick={()=>onSelect(m.id)} aria-label={m.name} className="flex size-7 items-center justify-center rounded-full border border-border bg-card text-[10px] font-semibold text-primary hover:border-primary" title={m.name}>{m.name.split(/\s+/).map(part=>part[0]).filter(Boolean).slice(0,2).join('')}</button>:<a href={`#assessment-${m.id}`} className="block truncate text-xs text-primary" title={m.name}>{m.name}</a>}</li>)}</ul>}
    </div>;
   })}</div>)}
  </div>
  </div><div className="text-center">{performanceAxis??<p className="text-xs font-medium text-muted-foreground">{labels.performance} →</p>}</div><p className="sr-only">{labels.potential} ↑</p>
  {rows.length>placed&&<p className="text-xs text-muted-foreground">{labels.unrated}: {rows.length-placed}</p>}
 </section>;
}
