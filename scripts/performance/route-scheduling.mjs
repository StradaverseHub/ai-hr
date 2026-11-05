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

/** Cover the routes that only Group HR can reach in the first cycle of this fixture.
 * Slow runs can finish just one cycle, so distribute the remaining routes before any
 * repeated Group HR navigation. Later cycles keep their normal rotation. */
export function firstGroupNavigationRoutes(pools,roleCounts){
 const covered=new Set();
 for(const role of ['employee','manager','companyHR']){
  const actors=roleCounts.get(role)??0;
  for(let ordinal=0;ordinal<actors;ordinal++)
   for(const route of navigationRoutesForIteration(pools[role],{role,ordinal,actors,iteration:0}))covered.add(route);
 }
 const actors=roleCounts.get('groupHR')??0;
 const remaining=pools.groupHR.filter(route=>!covered.has(route));
 return Array.from({length:actors},(_,ordinal)=>{
  const required=remaining.slice(Math.floor(ordinal*remaining.length/actors),Math.floor((ordinal+1)*remaining.length/actors));
  const routes=new Set(required);
  for(const route of navigationRoutesForIteration(pools.groupHR,{role:'groupHR',ordinal,actors,iteration:0})){
   if(routes.size>=6)break;
   routes.add(route);
  }
  return [...routes];
 });
}
