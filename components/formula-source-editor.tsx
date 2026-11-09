'use client';
import {useLayoutEffect,useRef,type RefObject} from 'react';
import {useTranslations} from 'next-intl';
/** Whitespace-only indentation: preserves authored tokens, strings and comments in either dialect. */
export function formatFormulaIndentation(source:string){
 const stack:('if'|'select'|'case')[]=[];
 return source.split('\n').map(line=>{
  const text=line.trimStart(),code=text.replace(/"(?:[^"]|"")*"|'[^\n]*/g,'').trim();
  if(/^End\s+Select\b/i.test(code)){if(stack.at(-1)==='case')stack.pop();if(stack.at(-1)==='select')stack.pop();}
  else if(/^End\s+If\b/i.test(code)){if(stack.at(-1)==='if')stack.pop();}
  else if(/^Case\b/i.test(code)&&stack.at(-1)==='case')stack.pop();
  const branch=/^(?:ElseIf|Else(?:\s+If)?)\b/i.test(code);
  const result=text?'    '.repeat(Math.max(0,stack.length-(branch?1:0)))+text:'';
  if(/^Select\s+Case\b/i.test(code))stack.push('select');
  else if(/^Case\b/i.test(code))stack.push('case');
  else if(/^If\b.*\bThen\s*$/i.test(code))stack.push('if');
  return result;
 }).join('\n');
}
export type SourceMark={start:number;end:number;severity:'error'|'warning'};
export function FormulaSource({source,onChange,disabled,inputRef,marks=[],label,formatLabel}:{source:string;onChange:(source:string)=>void;disabled:boolean;inputRef:RefObject<HTMLTextAreaElement|null>;marks?:readonly SourceMark[];label?:string;formatLabel?:string}){
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
const pieces=source.split(/('.*$|"(?:[^"]|"")*"|\{#[A-Za-z]+\}|\b(?:Dim|As|Decimal|String|Boolean|Date|If|Then|ElseIf|Else|End|Return|Select|Case|AndAlso|OrElse|And|Or|Not|True|False)\b|\b\d+(?:\.\d+)?\b)/gm);
 const replaceSelection=(text:string)=>{const input=inputRef.current;if(!input)return;const start=input.selectionStart,end=input.selectionEnd;onChange(source.slice(0,start)+text+source.slice(end));requestAnimationFrame(()=>{input.focus();input.setSelectionRange(start+text.length,start+text.length);});};
 return <div className="space-y-2">{formatLabel&&<button type="button" disabled={disabled} className="text-sm text-primary underline underline-offset-4 disabled:opacity-50" onClick={()=>{const input=inputRef.current,start=input?.selectionStart??0,end=input?.selectionEnd??start;const next=formatFormulaIndentation(source),position=(offset:number)=>{const before=source.slice(0,offset),lineIndex=before.split('\n').length-1,oldLine=source.split('\n')[lineIndex],lines=next.split('\n'),column=offset-(before.lastIndexOf('\n')+1),oldIndent=oldLine.length-oldLine.trimStart().length,newIndent=lines[lineIndex].length-lines[lineIndex].trimStart().length;return lines.slice(0,lineIndex).reduce((sum,line)=>sum+line.length+1,0)+(column<=oldIndent?Math.min(column,newIndent):column-oldIndent+newIndent);};onChange(next);requestAnimationFrame(()=>{inputRef.current?.focus();inputRef.current?.setSelectionRange(position(start),position(end));});}}>{formatLabel}</button>}<div className="relative rounded-lg border border-input bg-background"><pre ref={pre} aria-hidden="true" style={{scrollbarGutter:'stable'}} className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap [overflow-wrap:anywhere] p-3 font-mono text-sm leading-6">{(()=>{let offset=0;return pieces.flatMap((piece,index)=>{const tone=piece.startsWith("'")?'text-muted-foreground':piece.startsWith('"')?'text-emerald-700 dark:text-emerald-400':piece.startsWith('{#')?'text-primary':/^(Dim|As|If|Then|Else|ElseIf|End|Return|Select|Case|AndAlso|OrElse|And|Or|Not|Decimal|String|Boolean|Date|True|False)$/.test(piece)?'font-semibold text-primary':'';
  // Split each highlighted piece at diagnostic boundaries so a problem is underlined exactly where it is.
  const start=offset,end=offset+piece.length;offset=end;const cuts=new Set([start,end]);for(const mark of marks){if(mark.start>start&&mark.start<end)cuts.add(mark.start);if(mark.end>start&&mark.end<end)cuts.add(mark.end);}
  const points=[...cuts].sort((a,b)=>a-b);return points.slice(0,-1).map((from,part)=>{const to=points[part+1],mark=marks.find(m=>m.start<=from&&to<=m.end&&m.start<m.end);return <span key={index+'-'+part} data-formula-mark={mark?.severity} className={tone+(mark?mark.severity==='error'?' underline decoration-destructive decoration-wavy decoration-2 underline-offset-4':' underline decoration-amber-500 decoration-dashed decoration-2 underline-offset-4':'')}>{source.slice(from,to)}</span>;});});})()}{'\n'}</pre><textarea ref={inputRef} aria-label={label??t('source')} value={source} spellCheck={false} wrap="soft" rows={3} disabled={disabled} onChange={event=>onChange(event.target.value)} onKeyDown={event=>{if(!formatLabel||event.key!=='Enter'||event.shiftKey||event.ctrlKey||event.metaKey||event.altKey||event.nativeEvent.isComposing)return;event.preventDefault();const before=source.slice(0,event.currentTarget.selectionStart),line=before.slice(before.lastIndexOf('\n')+1),indent=line.match(/^[ \t]*/)?.[0]??'',opens=/^(?:If\b.*\bThen|Select\s+Case\b.*|Case\b.*|ElseIf\b.*\bThen|Else(?:\s+If\b.*\bThen)?)\s*$/i.test(line.trim());replaceSelection('\n'+indent+(opens?'    ':''));}} onScroll={event=>{if(pre.current){pre.current.scrollTop=event.currentTarget.scrollTop;pre.current.scrollLeft=event.currentTarget.scrollLeft;}}} className="relative block min-h-24 max-h-[264px] w-full resize-none overflow-x-hidden overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] bg-transparent p-3 font-mono text-sm leading-6 text-transparent caret-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" style={{WebkitTextFillColor:'transparent',scrollbarGutter:'stable'}}/></div></div>;
}
