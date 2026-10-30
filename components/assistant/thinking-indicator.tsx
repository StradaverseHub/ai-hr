/** A waiting state, never model reasoning or invented progress. The label remains visible when
 * animation is disabled; decorative dots do not add repeated screen-reader announcements. */
export function ThinkingIndicator({label}:{label:string}){
 return <div role="status" aria-live="polite" aria-atomic="true" className="inline-flex min-h-8 items-center gap-2.5 text-sm font-medium text-muted-foreground">
  <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-1">
   {[0,150,300].map(delay=><span key={delay} className="size-1.5 rounded-full bg-current motion-safe:animate-pulse motion-reduce:animate-none" style={{animationDelay:`${delay}ms`}}/>)}
  </span>
  <span>{label}</span>
 </div>;
}
