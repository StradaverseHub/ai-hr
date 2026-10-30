/** Native-only workflow doors. No assessment values, participants or record IDs leave this owner.
 * These links are handoffs, never proposals or evidence that an action was performed. */
import 'server-only';
import type {SessionContext} from '../../db/client';
import {getPerformanceAreaFacts,PERFORMANCE_AREA_TABS,performanceTabState} from '../../packs/performance/service';
import {readPerformanceModuleActionChoices} from './module-action-server';

export async function readPerformanceNativeHandoffs(supplied:SessionContext){
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 try{
  // Same fresh principal, Assistant grant, entitlement and pause guards as the acknowledgement door.
  // An empty choices list is valid: assigned leader work does not require an own acknowledgement.
  if((await readPerformanceModuleActionChoices(ctx)).kind!=='choices')return [];
  const facts=await getPerformanceAreaFacts(ctx);
  return PERFORMANCE_AREA_TABS.filter(tab=>tab.strip!=='home'&&performanceTabState(facts,tab.id)==='open')
   .map(({id,href,labelKey})=>({id,href,labelKey}));
 }catch{return [];}
}
