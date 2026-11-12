import type {ReactNode} from 'react';
import Link from 'next/link';

/** Today (AI v2 Phase 1, W3): the presentational pieces every section shares. Server-safe: no hooks, no client
 * module functions, only token classes, so Classic, Monolith and Atelier each draw it with their own tokens.
 * Every value shown is passed in by a section that read it from its owner as the viewer. */

/** One section: a heading with its count, an optional "could not load" line, then its cards or its empty state. */
export function TodaySection({id,title,count,empty,emptyText,unavailable,children,footer}:{
 id:string;title:string;count?:number;empty:boolean;emptyText:string;unavailable?:string|null;children?:ReactNode;footer?:ReactNode;
}){
 return <section aria-labelledby={id} data-today-section={id} className="min-w-0 space-y-3">
  <div className="flex items-baseline gap-2">
   <h2 id={id} className="text-[0.9375rem] font-semibold">{title}</h2>
   {count!==undefined&&count>0&&<span data-today-count className="text-xs font-medium tabular-nums text-muted-foreground">{count}</span>}
  </div>
  {unavailable&&<p data-today-unavailable role="status" className="rounded-lg border border-border bg-muted/50 p-3 text-sm text-muted-foreground">{unavailable}</p>}
  {empty?<p data-today-empty className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">{emptyText}</p>
   :<ul className="space-y-2">{children}</ul>}
  {footer}
 </section>;
}

/** A card that tells, rather than asks: what was done, or what is being watched. At most one link. */
export function TodayNote({kind,label,title,body,href,cta}:{kind:string;label:string;title:string;body?:string|null;href?:string;cta?:string}){
 return <li><article data-today-note={kind} className="rounded-xl border border-border bg-card p-4">
  <p className="text-xs font-medium text-muted-foreground">{label}</p>
  <h3 className="mt-1 break-words text-sm font-semibold leading-snug">{title}</h3>
  {body&&<p className="mt-1 text-sm leading-relaxed text-muted-foreground">{body}</p>}
  {href&&cta&&<Link href={href} className="mt-2 inline-flex min-h-9 items-center text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11">
   {cta}<span className="sr-only"> · {title}</span></Link>}
 </article></li>;
}

/** A section's placeholder while its owner reads: the heading and quiet hairline rows, no invented figures. */
export function TodaySectionSkeleton({title,rows=2}:{title?:string;rows?:number}){
 return <section aria-busy="true" data-today-skeleton className="min-w-0 space-y-3">
  {title?<h2 className="text-[0.9375rem] font-semibold">{title}</h2>:<div aria-hidden className="h-4 w-28 animate-pulse rounded-sm bg-muted/70 motion-reduce:animate-none"/>}
  <div aria-hidden className="space-y-2">
   {Array.from({length:rows},(_,i)=><div key={i} className="h-20 animate-pulse rounded-xl border border-border bg-muted/40 motion-reduce:animate-none"/>)}
  </div>
 </section>;
}
