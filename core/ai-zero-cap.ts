/** A configured zero request, token or concurrency cap stops every new call: the scope is paused by it.
 *  Blank (null) is no cap. Pure so the AI management screen and its attention list read one predicate. */
export type ZeroCapSubject = {daily:{limit:number|null};tokens:{limit:number|null};maxConcurrent:number|null};
export const isZeroCapped = (u:ZeroCapSubject):boolean => u.daily.limit===0 || u.tokens.limit===0 || u.maxConcurrent===0;
