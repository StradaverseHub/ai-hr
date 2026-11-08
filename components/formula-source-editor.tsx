'use client';
import {useLayoutEffect,useRef,type RefObject} from 'react';
import {useTranslations} from 'next-intl';
export type SourceMark={start:number;end:number;severity:'error'|'warning'};
export function FormulaSource({source,onChange,disabled,inputRef,marks=[],label}:{source:string;onChange:(source:string)=>void;disabled:boolean;inputRef:RefObject<HTMLTextAreaElement|null>;marks?:readonly SourceMark[];label?:string}){
 const t=useTranslations('payFormula'),pre=useRef<HTMLPreElement>(null);
 useLayoutEffect(() => {
   const input = inputRef.current;
   if (!input) return;
   let measuredWidth = input.clientWidth;
   const resize = () => {
     input.style.height = 'auto';
     const height = Math.min(264, Math.max(96, input.scrollHeight));
     input.style.height = height + 'px';
     if (pre.current) pre.current.scrollTop = input.scrollTop;
   };
   resize();
   if (typeof ResizeObserver === 'undefined') return;
   const observer = new ResizeObserver(() => {
     if (input.clientWidth !== measuredWidth) {
       measuredWidth = input.clientWidth;
       resize();
     }
   });
   observer.observe(input);
   return () => observer.disconnect();
 }, [source, inputRef]);
const pieces=source.split(/('.*$|"(?:[^"]|"")*"|\{#[A-Za-z]+\}|\b(?:Dim|As|Decimal|String|Boolean|Date|If|Then|ElseIf|Else|End|Return|And|Or|Not|True|False)\b|\b\d+(?:\.\d+)?\b)/gm);
 return <div className="relative rounded-lg border border-input bg-background"><pre ref={pre} aria-hidden="true" style={{scrollbarGutter:'stable'}} className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap [overflow-wrap:anywhere] p-3 font-mono text-sm leading-6">{(()=>{let offset=0;return pieces.flatMap((piece,index)=>{const tone=piece.startsWith("'")?'text-muted-foreground':piece.startsWith('"')?'text-emerald-700 dark:text-emerald-400':piece.startsWith('{#')?'text-primary':/^(Dim|As|If|Then|Else|ElseIf|End|Return|And|Or|Not|Decimal|String|Boolean|Date|True|False)$/.test(piece)?'font-semibold text-primary':'';
  // Split each highlighted piece at diagnostic boundaries so a problem is underlined exactly where it is.
  const start=offset,end=offset+piece.length;offset=end;const cuts=new Set([start,end]);for(const mark of marks){if(mark.start>start&&mark.start<end)cuts.add(mark.start);if(mark.end>start&&mark.end<end)cuts.add(mark.end);}
  const points=[...cuts].sort((a,b)=>a-b);return points.slice(0,-1).map((from,part)=>{const to=points[part+1],mark=marks.find(m=>m.start<=from&&to<=m.end&&m.start<m.end);return <span key={index+'-'+part} data-formula-mark={mark?.severity} className={tone+(mark?mark.severity==='error'?' underline decoration-destructive decoration-wavy decoration-2 underline-offset-4':' underline decoration-amber-500 decoration-dashed decoration-2 underline-offset-4':'')}>{source.slice(from,to)}</span>;});});})()}{'\n'}</pre><textarea ref={inputRef} aria-label={label??t('source')} value={source} spellCheck={false} wrap="soft" rows={3} disabled={disabled} onChange={event=>onChange(event.target.value)} onScroll={event=>{if(pre.current){pre.current.scrollTop=event.currentTarget.scrollTop;pre.current.scrollLeft=event.currentTarget.scrollLeft;}}} className="relative block min-h-24 max-h-[264px] w-full resize-none overflow-x-hidden overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] bg-transparent p-3 font-mono text-sm leading-6 text-transparent caret-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" style={{WebkitTextFillColor:'transparent',scrollbarGutter:'stable'}}/></div>;
}
