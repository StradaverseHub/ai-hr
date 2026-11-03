import Link from 'next/link';
import {WhyAsk} from './why-ask';

/** AI v2 W5 — "Why?" on every figure: the small link and the explanation panel it opens in place.
 *
 * Presentational and server-safe, like the approver recommendation panel it follows
 * (components/ai-centre/leave-recommendation.tsx): the "Why?" link adds `why=…` to the page's own address with no
 * scroll and no prefetch, the page reads the explanation from the owner service as the person only when it is
 * asked for, and draws this panel under the figure, where focus moves (FocusOnMount). Every value it shows arrives
 * already formatted from the owner's own figures (components/why/views.ts); nothing here computes. Close is a link
 * back to the page without `why`. Token classes only, so each theme draws it with its own tokens. */

export type WhyFigure=Readonly<{label:string;value:string;strong?:boolean}>;
export type WhyTable=Readonly<{caption:string;head:readonly string[];rows:readonly Readonly<{label:string;cells:readonly string[];strong?:boolean}>[]}>;
export type WhySection=Readonly<{heading:string;lines:readonly string[]}>;
export type WhyPanelView=Readonly<{kind:'pay'|'deduction'|'leave'|'claim';title:string;lead?:string|null;table?:WhyTable|null;
 figures?:readonly WhyFigure[];sections?:readonly WhySection[];notes?:readonly string[];serviceNote:string;
 /** The question "Ask AI Centre about this" sends: what the panel explains, never a figure. */
 question:string}>;
export type WhyAskLabels=Readonly<{label:string;openingLabel:string}>;

const linkCls='inline-flex min-h-9 items-center font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11';

/** The "Why?" link beside a figure. `label` names the figure for assistive technology ("Why? Why is my EPF this amount?"):
 * the accessible name starts with the visible word, then says which figure it explains. */
export function WhyLink({href,text,label,expanded,controls,className}:{href:string;text:string;label?:string;expanded?:boolean;controls?:string;className?:string}){
 return <Link href={href} scroll={false} prefetch={false} data-why-link aria-label={label?`${text} ${label}`:undefined} aria-expanded={expanded??false} aria-controls={expanded?controls:undefined}
  className={`${linkCls} ${className??'text-sm'}`}>{text}</Link>;
}

export function WhyPanel({id,view,ask,closeHref,closeLabel}:{id:string;view:WhyPanelView;ask:WhyAskLabels|null;closeHref:string;closeLabel:string}){
 return <section id={id} tabIndex={-1} aria-labelledby={`${id}-title`} data-why-panel={view.kind}
  className="mt-2 w-full min-w-0 rounded-lg border border-border bg-muted/40 p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-4">
  <div className="flex items-start justify-between gap-3">
   <h3 id={`${id}-title`} className="min-w-0 break-words text-sm font-semibold leading-snug">{view.title}</h3>
   <Link href={closeHref} scroll={false} prefetch={false} data-why-close className="inline-flex min-h-9 shrink-0 items-center text-xs font-medium text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11">{closeLabel}</Link>
  </div>
  {view.lead&&<p data-why-lead className="mt-1 text-sm leading-relaxed">{view.lead}</p>}
  {view.table&&<div className="mt-3 overflow-x-auto">
   <table data-why-table className="w-full min-w-[18rem] text-xs sm:text-sm">
    <caption className="sr-only">{view.table.caption}</caption>
    <thead><tr className="text-muted-foreground">{view.table.head.map((cell,index)=><th key={index} scope="col" className={`py-1.5 font-medium ${index===0?'text-left':'text-right'}`}>{cell}</th>)}</tr></thead>
    <tbody className="divide-y divide-border">{view.table.rows.map((row,index)=><tr key={`${row.label}-${index}`} className={row.strong?'font-semibold':undefined}>
     <th scope="row" className="py-1.5 pr-3 text-left font-normal">{row.label}</th>
     {row.cells.map((cell,cellIndex)=><td key={cellIndex} className="py-1.5 pl-3 text-right tabular-nums whitespace-nowrap">{cell}</td>)}
    </tr>)}</tbody>
   </table>
  </div>}
  {view.figures&&view.figures.length>0&&<dl data-why-figures className="mt-3 divide-y divide-border">
   {view.figures.map((row,index)=><div key={`${row.label}-${index}`} className={`flex items-baseline justify-between gap-3 py-1.5 ${row.strong?'font-semibold':''}`}>
    <dt className={row.strong?undefined:'text-muted-foreground'}>{row.label}</dt><dd className="shrink-0 tabular-nums">{row.value}</dd>
   </div>)}
  </dl>}
  {(view.sections??[]).filter(section=>section.lines.length>0).map(section=><div key={section.heading} data-why-section className="mt-3">
   <h4 className="text-xs font-semibold">{section.heading}</h4>
   <ul className="mt-1 space-y-1 text-sm leading-relaxed text-muted-foreground">{section.lines.map((line,index)=><li key={index}>{line}</li>)}</ul>
  </div>)}
  {(view.notes??[]).map((note,index)=><p key={index} data-why-note className="mt-2 text-xs leading-relaxed text-muted-foreground">{note}</p>)}
  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
   <p data-why-source className="min-w-0 text-xs text-muted-foreground">{view.serviceNote}</p>
   {ask&&<WhyAsk question={view.question} label={ask.label} openingLabel={ask.openingLabel}/>}
  </div>
 </section>;
}
