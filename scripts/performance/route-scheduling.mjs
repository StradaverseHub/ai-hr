/** Disjoint role lanes cover the route pool without concentrating every actor on its first pages.
 * Group HR owns balanced lanes that wrap independently, so routes visited during the ramp
 * repeat during the hold. Protocol v2 retains at least seven group-HR or three other navigation slots. */
export function navigationRoutesForIteration(pool,{role,ordinal,actors,iteration,groupReadSlots=7}) {
 if(!Array.isArray(pool)||pool.length===0||pool.some(path=>typeof path!=='string'||!path.startsWith('/'))
  ||!['employee','manager','companyHR','groupHR'].includes(role)
  ||![ordinal,actors,iteration].every(Number.isSafeInteger)||actors<1||ordinal<0||ordinal>=actors||iteration<0)
  throw new RangeError('Invalid route lane');
 if(!Number.isSafeInteger(groupReadSlots)||groupReadSlots<7||groupReadSlots>12)throw new RangeError('Invalid group read budget');
 const count=role==='groupHR'?groupReadSlots:3;
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
export function firstGroupNavigationRoutes(pools,roleCounts,groupReadSlots=7){
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
  for(const route of navigationRoutesForIteration(pools.groupHR,{role:'groupHR',ordinal,actors,iteration:0,groupReadSlots})){
   if(routes.size>=groupReadSlots)break;
   routes.add(route);
  }
  return [...routes];
 });
}


export const navigationProtocol='steady-role-coverage-v2';
const roles=['employee','manager','companyHR','groupHR'];
/** Actual slot admission, shared by the HTTP driver and capacity model. Successful navigation
 * must have STARTED in the steady window; ramp visits and failed requests never discharge it.
 * Reservations prevent concurrent actors consuming the same still-pending obligation. */
export function createSteadyRouteScheduler({pools,roleCounts,steadyStart,steadyUntil,groupReadSlots=7}){
 if(!Number.isFinite(steadyStart)||!Number.isFinite(steadyUntil)||steadyUntil<=steadyStart)throw new RangeError('Invalid steady window');
 const first=firstGroupNavigationRoutes(pools,roleCounts,groupReadSlots),states=new Map(),leases=new Map();
 if(first.some(routes=>routes.length>12))throw new RangeError('Declared first-cycle priorities exceed bounded steady navigation capacity');
 const slots=(role,ordinal=0,iteration=1)=>{
  if(!roles.includes(role)||!Number.isSafeInteger(iteration)||iteration<0||!Number.isSafeInteger(ordinal)||ordinal<0||ordinal>=roleCounts.get(role))throw new RangeError('Invalid role slot');
  return role==='groupHR'?Math.max(groupReadSlots,iteration===0?first[ordinal].length:0):3;
 };
 for(const role of roles){
  const actors=roleCounts.get(role);
  navigationRoutesForIteration(pools[role],{role,actors,ordinal:0,iteration:0,groupReadSlots});
  if(new Set(pools[role]).size!==pools[role].length)throw new RangeError('Duplicate role route');
  const priority=role==='groupHR'?first.flat():[];
  states.set(role,{pending:new Set([...priority,...pools[role]]),inflight:new Set(),completed:new Set()});
 }
 return Object.freeze({
  slots,
  reserve({role,ordinal,actors,iteration,slot,startedMs}){
   if(!Number.isFinite(startedMs))throw new RangeError('Invalid slot start');
   const lane=navigationRoutesForIteration(pools[role],{role,ordinal,actors,iteration,groupReadSlots});
   if(actors!==roleCounts.get(role)||!Number.isSafeInteger(slot)||slot<0||slot>=slots(role,ordinal,iteration))throw new RangeError('Invalid role slot');
   const state=states.get(role),steady=startedMs>=steadyStart&&startedMs<steadyUntil;
   const pending=steady?[...state.pending].find(route=>!state.inflight.has(route)):undefined;
   // Preserve reviewed first-cycle priorities during ramp as well. Unlike the old batch
   // override this does not advance or remove any steady per-role obligation.
   const route=pending??(role==='groupHR'&&iteration===0?first[ordinal][slot]??lane[slot%lane.length]:lane[slot%lane.length]);
   if(pending!==undefined)state.inflight.add(route);
   const lease=Object.freeze({route});leases.set(lease,{role,route,steady,reserved:pending!==undefined});return lease;
  },
  complete(lease,success){
   const item=leases.get(lease);if(!item||typeof success!=='boolean')throw new RangeError('Unknown navigation reservation');
   leases.delete(lease);const state=states.get(item.role);
   if(item.reserved)state.inflight.delete(item.route);
   if(success&&item.steady){state.pending.delete(item.route);state.completed.add(item.route);}
  },
  snapshot(){return roles.map(role=>{const state=states.get(role);return{role,required:pools[role].length,completed:state.completed.size,pending:[...state.pending],inflight:[...state.inflight]};});}
 });
}

/** Planning model only, never a performance receipt. Models actual actor ramp positions,
 * completed read slots and every retained native action/pause. Storage verification and
 * persistence-observer overhead is not predictable here; observed strict gates still decide.
 * Home adds its parallel API replay bound after its document GET, not a zero-cost visit. */
export function modelSteadyRouteCapacity({pools,users,thinkTimeMs,steadyHoldMs,groupReadSlots=7,getMs=1000,postMs=500}){
 if(![1000,5000].includes(thinkTimeMs)||![30000,300000].includes(steadyHoldMs)
  ||!Number.isFinite(getMs)||getMs<0||getMs>1000||!Number.isFinite(postMs)||postMs<0||postMs>500
  ||!Array.isArray(users)||users.length!==500||new Set(users.map(u=>u.index)).size!==500
  ||users.some((u,i)=>!roles.includes(u.role)||u.index!==i))throw new RangeError('Invalid capacity fixture');
 const counts=new Map();for(const user of users)counts.set(user.role,(counts.get(user.role)??0)+1);
 const scheduler=createSteadyRouteScheduler({pools,roleCounts:counts,steadyStart:10000,steadyUntil:10000+steadyHoldMs,groupReadSlots});
 const ordinals=new Map(),actors=users.map((user,i)=>{const ordinal=ordinals.get(user.role)??0;ordinals.set(user.role,ordinal+1);return{user,ordinal,now:i*20,iteration:0,slot:0,lease:null};});
 const steps={payrollProcess:0,payrollExport:0,ordinaryMutations:0,clockingActions:0},iterations=Object.fromEntries(roles.map(role=>[role,0]));
 while(true){
  let actor;for(const candidate of actors)if(candidate.now<10000+steadyHoldMs&&(!actor||candidate.now<actor.now))actor=candidate;
  if(!actor)break;
  const {user,ordinal}=actor;
  if(actor.lease){scheduler.complete(actor.lease,true);actor.lease=null;actor.now+=thinkTimeMs;actor.slot++;
   if(actor.slot===scheduler.slots(user.role,ordinal,actor.iteration)){
    if(user.role==='groupHR'&&actor.iteration===0){actor.now+=postMs+thinkTimeMs+getMs+thinkTimeMs;steps.payrollProcess++;steps.payrollExport++;}
    else {const actions=user.role==='employee'&&user.index%2===1?2:3;actor.now+=actions*(postMs+thinkTimeMs);steps.ordinaryMutations+=actions;
     if(user.role==='companyHR'&&user.index%50===1){actor.now+=2*(postMs+thinkTimeMs);steps.clockingActions+=2;}}
    actor.iteration++;iterations[user.role]++;actor.slot=0;
   }
  }else{
   actor.lease=scheduler.reserve({role:user.role,ordinal,actors:counts.get(user.role),iteration:actor.iteration,slot:actor.slot,startedMs:actor.now});
   actor.now+=getMs+(actor.lease.route==='/'&&['employee','manager'].includes(user.role)?getMs:0);
  }
 }
 // Requests admitted before the end may finish after it; complete those actual modeled
 // admissions without scheduling another slot or charging an unexecuted mutation cycle.
 for(const actor of actors)if(actor.lease)scheduler.complete(actor.lease,true);
 const rows=scheduler.snapshot();return{kind:'PLANNING_ONLY',groupReadSlots,rows,feasible:rows.every(row=>row.pending.length===0),iterations,steps};
}

/** Bounded workload revision: refuse if the declared route obligations outgrow this
 * protocol. Never drop a route, extend the hold, or consume the mutation slots as reads. */
export function planSteadyRouteCoverage(input){
 for(let groupReadSlots=7;groupReadSlots<=12;groupReadSlots++){
  const plan=modelSteadyRouteCapacity({...input,groupReadSlots});if(plan.feasible)return{protocol:navigationProtocol,...plan};
 }
 throw new RangeError('Declared per-role routes exceed bounded steady navigation capacity');
}
