export type MovementPayrollWindow={from:string;until:string|null};
export type MovementPayrollDecision={id:string;date:string;fields:readonly string[]};
/** Union only intervals changed by removing the original decision and/or inserting its replacement.
 * A later deliberate value bounds that field; inherited fields continue until their own next decision. */
export function movementPayrollWindows(decisions:readonly MovementPayrollDecision[],changes:readonly {date:string;fields:readonly string[]}[],excludedId?:string):MovementPayrollWindow[]{
 const windows:MovementPayrollWindow[]=[];
 for(const change of changes)for(const field of new Set(change.fields)){
  const until=decisions.filter(decision=>decision.id!==excludedId&&decision.date>change.date&&decision.fields.includes(field)).map(decision=>decision.date).sort()[0]??null;
  windows.push({from:change.date,until});
 }
 windows.sort((a,b)=>a.from.localeCompare(b.from));
 const merged:MovementPayrollWindow[]=[];
 for(const window of windows){
  const last=merged.at(-1);
  if(last&&(last.until===null||window.from<=last.until))last.until=last.until===null||window.until===null?null:last.until>window.until?last.until:window.until;
  else merged.push({...window});
 }
 return merged;
}
