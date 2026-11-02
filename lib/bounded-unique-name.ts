/** UTF-16 length bound without splitting a Unicode code point. */
export function boundedNamePrefix(value:string,length:number):string {
 return value.slice(0,length).replace(/[\uD800-\uDBFF]$/u,'');
}

/** Allocate a distinct bounded name without truncating away its distinguishing suffix.
 * Callers own case folding, database uniqueness and any retry after a concurrent insert. */
export function boundedUniqueName(base:string,taken:ReadonlySet<string>,maxLength:number,suffix:(n:number)=>string,attempts=1000,normalize:(value:string)=>string=value=>value):string {
  for(let n=2;n<attempts+2;n++) {
    const tail=suffix(n);
    if(tail.length>=maxLength)throw new Error('No unique name available');
    const candidate=boundedNamePrefix(base,maxLength-tail.length)+tail;
    if(!taken.has(normalize(candidate)))return candidate;
  }
  throw new Error('No unique name available');
}
