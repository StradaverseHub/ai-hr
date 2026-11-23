/** Wall-clock milliseconds per part of the locked batch opening (production, 23 November 2026: one opening held the
 * exclusive payroll-history and Access locks for up to 40 s, blocking every payroll page, while its two set-wise
 * queries, timed read-only as the database superuser, took under 0.2 s). Ids and durations only, never names or amounts.
 * No database or framework imports, so it stays unit-testable. */
export type TaxBasisLaps=Record<string,number>;
export const TAX_BASIS_SLOW_LOCKED_MS=2000;
export async function lap<T>(laps:TaxBasisLaps|undefined,name:string,fn:()=>Promise<T>):Promise<T>{
 if(!laps)return fn();
 const started=performance.now();
 try{return await fn();}finally{laps[name]=(laps[name]??0)+Math.round(performance.now()-started);}
}
/** One stderr line (the worker's journal) when the exclusive payroll-history lock was held longer than TAX_BASIS_SLOW_LOCKED_MS. */
export function reportSlowTaxBasisOpening(previewId:string,outcome:string,heldMs:number,totalMs:number,laps:TaxBasisLaps,log:(line:string)=>void=console.error){
 if(heldMs<TAX_BASIS_SLOW_LOCKED_MS)return;
 log(`Tax-basis batch opening held the payroll-history lock for ${heldMs} ms (total ${totalMs} ms, outcome ${outcome}, preview ${previewId}): ${JSON.stringify(laps)}`);
}
