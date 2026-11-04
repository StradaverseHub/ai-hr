/** A small visible waiting label, never model reasoning or invented progress. Three dots pulse beside it so the wait
 * visibly moves (owner, staging acceptance 3 November 2026: "should have animation that shows its moving"); they are
 * decoration only, hidden from assistive technology, so the status announces the label once. Under reduced motion the
 * dots stay still and the label still says it is working. */
export function ThinkingIndicator({label}:{label:string}){
 return <p role="status" aria-live="polite" aria-atomic="true" data-thinking className="inline-flex items-center gap-2 py-1 text-xs font-normal text-muted-foreground">
  <span aria-hidden data-thinking-dots className="inline-flex items-center gap-1">
   {[0,1,2].map(dot=><span key={dot} className="size-1.5 rounded-full bg-current opacity-60 motion-safe:animate-[thinking-dot_1.2s_ease-in-out_infinite]" style={{animationDelay:`${dot*160}ms`}}/>)}
  </span>
  <span>{label}</span>
 </p>;
}
