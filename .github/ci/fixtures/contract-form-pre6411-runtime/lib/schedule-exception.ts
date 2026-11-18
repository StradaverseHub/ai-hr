/** Pure dated decision; a missing revision always preserves prior behavior (Off). */
export function exceptionRevisionOn(revisions:readonly {id:string;effectiveFrom:string;enabled:boolean}[]|undefined,date:string) {
 return (revisions??[]).filter(r=>r.effectiveFrom<=date).reduce<{id:string;effectiveFrom:string;enabled:boolean}|null>((a,b)=>!a||b.effectiveFrom>a.effectiveFrom?b:a,null);
}
