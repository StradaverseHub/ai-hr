/** Entry time does not decide which event governs today. Same-day candidates require a named target. */
export function latestApplicableMovementCandidates<T extends {id:string;effectiveDate:string;status:string}>(rows:readonly T[],today:string):T[]{
 const applicable=rows.filter(row=>row.status==='applied'&&row.effectiveDate<=today);
 const latest=applicable.reduce<string|null>((date,row)=>date===null||row.effectiveDate>date?row.effectiveDate:date,null);
 return latest===null?[]:applicable.filter(row=>row.effectiveDate===latest);
}
