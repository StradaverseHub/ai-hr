
/** Today's loading placeholder (app/loading.tsx via ./today-skeleton.tsx). Server-safe: no hooks, only token classes.
 * The earlier Today's section and note pieces were retired with the old dashboard (owner decision, 12 Nov 2026). */

/** A section's placeholder while its owner reads: the heading and quiet hairline rows, no invented figures. */
export function TodaySectionSkeleton({title,rows=2}:{title?:string;rows?:number}){
 return <section aria-busy="true" data-today-skeleton className="min-w-0 space-y-3">
  {title?<h2 className="text-[0.9375rem] font-semibold">{title}</h2>:<div aria-hidden className="h-4 w-28 animate-pulse rounded-sm bg-muted/70 motion-reduce:animate-none"/>}
  <div aria-hidden className="space-y-2">
   {Array.from({length:rows},(_,i)=><div key={i} className="h-20 animate-pulse rounded-xl border border-border bg-muted/40 motion-reduce:animate-none"/>)}
  </div>
 </section>;
}
