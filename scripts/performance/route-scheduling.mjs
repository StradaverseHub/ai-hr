/** Disjoint role lanes cover the route pool without concentrating every actor on its first pages.
 * The two group-HR actors need six navigation slots per complete mutation cycle to cover66 routes
 * at5s activity during the unchanged5m hold. Other roles retain three; every activity pause remains. */
export function navigationRoutesForIteration(pool,{role,ordinal,actors,iteration}) {
 if(!Array.isArray(pool)||pool.length===0||pool.some(path=>typeof path!=='string'||!path.startsWith('/'))
  ||!['employee','manager','companyHR','groupHR'].includes(role)
  ||![ordinal,actors,iteration].every(Number.isSafeInteger)||actors<1||ordinal<0||ordinal>=actors||iteration<0)
  throw new RangeError('Invalid route lane');
 const count=role==='groupHR'?6:3,offset=(iteration*actors+ordinal)*count;
 if(!Number.isSafeInteger(offset))throw new RangeError('Invalid route lane');
 return Array.from({length:count},(_,step)=>pool[(offset+step)%pool.length]);
}
