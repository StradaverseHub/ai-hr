'use client';
import { useState } from 'react';
import { pmBands, potentialBands, talentCategory, talentCell9, type PMBand, type PotentialBand } from '@/packs/performance/onehr/model';
export function TalentGrid({rows,labels}:{rows:{id:string;name:string;performance:PMBand|null;potential:PotentialBand|null}[];labels:Record<string,string>}) {
 const [columns,setColumns]=useState<9|15>(9);
 const performance=columns===15?[...pmBands]:['low','mid','high'] as const;
 const group=(p:PMBand)=>columns===15?p:['UA','BE'].includes(p)?'low':p==='ME'?'mid':'high';
 const tone=(label:string)=>label==='PIP/Improvement'?'bg-amber-50 dark:bg-amber-500/10':label==='Super Star'?'bg-emerald-100 dark:bg-emerald-500/20':label==='Star'?'bg-emerald-50 dark:bg-emerald-500/10':'bg-muted/30';
 const unrated=rows.filter(r=>!r.performance||!r.potential).length;
 return <section className="space-y-3 p-5" aria-label={labels.title}>
  <header className="flex items-center justify-between gap-3"><h2 className="font-semibold">{labels.title}</h2><div className="flex rounded-md border border-border p-1" aria-label={labels.layout}>{([9,15] as const).map(n=><button key={n} type="button" aria-pressed={columns===n} onClick={()=>setColumns(n)} className={`min-h-11 rounded px-3 text-sm ${columns===n?'bg-foreground text-background':'hover:bg-muted'}`}>{n}</button>)}</div></header>
  <div className="overflow-x-auto"><table className="w-full min-w-[36rem] table-fixed border-collapse text-sm"><caption className="sr-only">{labels.title}</caption><thead><tr><th scope="col" className="w-16 p-2 text-xs font-medium text-muted-foreground">{labels.potential}</th>{performance.map(p=><th scope="col" key={p} className="p-2 font-semibold">{labels[p]??p}</th>)}</tr></thead><tbody>{[...potentialBands].reverse().map(pot=><tr key={pot}><th scope="row" className="p-2 text-xs font-medium">{pot}</th>{performance.map(perf=>{const members=rows.filter(r=>r.performance&&group(r.performance)===perf&&r.potential===pot),category=columns===15?talentCategory(perf as PMBand,pot)!:talentCell9(perf as 'low'|'mid'|'high',pot);return <td key={perf} className={`h-28 border border-border p-2 align-top ${tone(category)}`}><p className="mb-2 text-xs font-medium text-muted-foreground">{category} · {members.length}</p><ul className="space-y-1">{members.map(m=><li key={m.id}><a href={`#assessment-${m.id}`} className="block truncate rounded border border-border bg-card px-2 py-1 text-xs hover:border-primary" title={m.name}>{m.name}</a></li>)}</ul></td>;})}</tr>)}</tbody></table></div>
  <p className="text-center text-xs font-medium text-muted-foreground">{labels.performance} →</p>{unrated>0&&<p className="text-xs text-muted-foreground">{labels.unrated}: {unrated}</p>}
 </section>;
}
