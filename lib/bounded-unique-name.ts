/** Allocate a distinct bounded name without truncating away its distinguishing suffix.
 * Callers own case folding, database uniqueness and any retry after a concurrent insert. */
export function boundedUniqueName(base:string,taken:ReadonlySet<string>,maxLength:number,suffix:(n:number)=>string,attempts=1000,normalize:(value:string)=>string=value=>value):string {
  for(let n=2;n<attempts+2;n++) {
    const tail=suffix(n);
    if(tail.length>=maxLength)throw new Error('No unique name available');
    const candidate=base.slice(0,maxLength-tail.length)+tail;
    if(!taken.has(normalize(candidate)))return candidate;
  }
  throw new Error('No unique name available');
}
