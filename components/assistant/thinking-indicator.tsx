/** A small visible waiting label, never model reasoning or invented progress. */
export function ThinkingIndicator({label}:{label:string}){
 return <p role="status" aria-live="polite" aria-atomic="true" className="py-1 text-xs font-normal text-muted-foreground">{label}</p>;
}
