/** The clock accepts out-first and repeated directions. Removal may not create a new orphaned out. */
export function removalPreservesSequence<T extends {id:string;direction:'in'|'out'}>(ordered:T[],targetId:string):boolean{
  function orphaned(rows:T[]){let open=false;const ids=new Set<string>();for(const row of rows){if(row.direction==='in')open=true;else if(open)open=false;else ids.add(row.id);}return ids;}
  const before=orphaned(ordered),after=orphaned(ordered.filter(row=>row.id!==targetId));
  return [...after].every(id=>before.has(id));
}
export const LOCATION_CAPTURE_STATUSES=['recorded','denied','unavailable','timeout','unsupported'] as const;
export type LocationCaptureStatus=typeof LOCATION_CAPTURE_STATUSES[number];
