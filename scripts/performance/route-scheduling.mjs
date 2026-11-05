/** Disjoint role lanes cover the route pool without concentrating every actor on its first pages.
 * Group HR owns balanced lanes that wrap independently, so routes visited during the ramp
 * repeat during the hold. Each cycle retains six group-HR or three other navigation slots. */
export function navigationRoutesForIteration(pool,{role,ordinal,actors,iteration}) {
 if(!Array.isArray(pool)||pool.length===0||pool.some(path=>typeof path!=='string'||!path.startsWith('/'))
  ||!['employee','manager','companyHR','groupHR'].includes(role)
  ||![ordinal,actors,iteration].every(Number.isSafeInteger)||actors<1||ordinal<0||ordinal>=actors||iteration<0)
  throw new RangeError('Invalid route lane');
 const count=role==='groupHR'?6:3;
 if(role==='groupHR'&&actors<=pool.length){
  const start=Math.floor(ordinal*pool.length/actors),end=Math.floor((ordinal+1)*pool.length/actors);
  const offset=iteration*count;
  if(!Number.isSafeInteger(offset))throw new RangeError('Invalid route lane');
  return Array.from({length:count},(_,step)=>pool[start+(offset+step)%(end-start)]);
 }
 const offset=(iteration*actors+ordinal)*count;
 if(!Number.isSafeInteger(offset))throw new RangeError('Invalid route lane');
 return Array.from({length:count},(_,step)=>pool[(offset+step)%pool.length]);
}
