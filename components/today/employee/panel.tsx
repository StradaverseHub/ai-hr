import type {ReactNode} from 'react';
import Link from 'next/link';
import {dateTimeFormatter} from '@/lib/date-time-formatter';
import {cn} from '@/lib/utils';

/** Employee Today's shared presentational pieces. Server-safe; token classes only (bg-card, border-border,
 * text-muted-foreground, primary), so the page follows the app's theme and its light/dark mode. */

export const PANEL='min-w-0 rounded-2xl border border-border bg-card p-5 text-card-foreground';
export const EYEBROW='m-0 text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground';
export const LINK='inline-flex min-h-9 items-center text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11';
export const BUTTON='inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/** An HR calendar day (yyyy-mm-dd) is a day, not an instant: formatted as UTC so no offset moves it. */
export function hrDay(locale:string,iso:string,style:'short'|'long'|'day'|'weekday'|'narrow'='short'):string{
 const options:Intl.DateTimeFormatOptions=style==='long'?{weekday:'short',day:'numeric',month:'long',timeZone:'UTC'}
  :style==='day'?{day:'numeric',month:'short',timeZone:'UTC'}:style==='weekday'?{weekday:'short',timeZone:'UTC'}
  :style==='narrow'?{weekday:'narrow',timeZone:'UTC'}:{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'};
 return dateTimeFormatter(locale,options).format(new Date(`${iso}T00:00:00Z`));
}

/** One bento panel: its labelled heading row, then its body. `id` names the heading for the section's label. */
export function Panel({id,title,action,className,children,tone}:{id:string;title:ReactNode;action?:ReactNode;className?:string;children:ReactNode;tone?:'lead'}){
 return <section aria-labelledby={id} data-today-panel={id} className={cn(PANEL,'flex flex-col gap-3',tone==='lead'&&'border-primary/25 bg-primary/5',className)}>
  <div className="flex items-center justify-between gap-3">
   <h2 id={id} className={EYEBROW}>{title}</h2>
   {action}
  </div>
  {children}
 </section>;
}

/** A panel's own "could not load" note, used by its error boundary and when its read fails. */
export function PanelNote({children}:{children:ReactNode}){
 return <p role="status" data-today-unavailable className="m-0 rounded-lg border border-border bg-muted/50 p-3 text-sm text-muted-foreground">{children}</p>;
}

/** A panel's placeholder while its owner reads: its heading and quiet rows, no invented figures. */
export function PanelSkeleton({title,className,rows=2}:{title:string;className?:string;rows?:number}){
 return <section aria-busy="true" data-today-skeleton className={cn(PANEL,'flex flex-col gap-3',className)}>
  <p className={EYEBROW}>{title}</p>
  <div aria-hidden className="space-y-2">{Array.from({length:rows},(_,i)=><div key={i} className="h-8 animate-pulse rounded-lg bg-muted/60 motion-reduce:animate-none"/>)}</div>
 </section>;
}

export function PanelLink({href,children,label}:{href:string;children:ReactNode;label?:string}){
 return <Link href={href} className={LINK}>{children}{label&&<span className="sr-only"> · {label}</span>}</Link>;
}
