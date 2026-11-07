/** Optional isolated-run observer. Closed labels only; never receives identity, query or values. */
export function markHomeRead(stage:'handler'|'session'|'read-start'|'read-finish'|'read-failure',card?:string){
 try{
  (globalThis as typeof globalThis & {__aihrPerfHomeStage?:(stage:string,card?:string)=>void}).__aihrPerfHomeStage?.(stage,card);
 }catch{/* Observation must never change a reader's result. */}
}
