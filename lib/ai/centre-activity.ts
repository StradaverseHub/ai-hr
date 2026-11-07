import {AsyncLocalStorage} from 'node:async_hooks';

/** Server-only correlation, never a browser/model grant. Requirements only narrow an intent.
 * The private set survives nested helpers; callers receive immutable snapshots, never the owner. */
type Activity=Readonly<{tenantId:string;generation:number;functions:Set<string>}>;
const activities=new AsyncLocalStorage<Activity>();
export const aiCentreActivity=(tenantId:string)=>{
 const current=activities.getStore();
 return current?.tenantId===tenantId?Object.freeze({tenantId:current.tenantId,generation:current.generation,
  functions:Object.freeze([...current.functions])}):undefined;
};
/** Record only function checks that have succeeded through the actual SQL owner. Recording a key
 * cannot grant access; every later admission/result/effect still checks the complete live set. */
export function trackAiCentreFunctions(tenantId:string,keys:readonly string[]):void{
 const current=activities.getStore();
 if(current?.tenantId===tenantId)for(const key of keys)current.functions.add(key);
}
export async function runAiCentreActivity<T>(tenantId:string,generation:number,work:()=>Promise<T>,functions:readonly string[]=[]):Promise<T>{
 const prior=activities.getStore();
 if(prior?.tenantId===tenantId&&prior.generation!==generation)throw Error('The AI activity generation changed.');
 const current=prior?.tenantId===tenantId?prior:Object.freeze({tenantId,generation,functions:new Set<string>()});
 for(const key of functions)current.functions.add(key);
 return activities.run(current,work);
}

/** Human withdrawals, undo, required notifications and audit/retention are deliberately excluded. */
export function aiCentreEvent(eventType:string):boolean{
 return eventType.startsWith('automatic-chase.')||[
  'readiness.nudge-raised','claim-request.triage-queried','teras-loop.action.applied',
  'teras-loop.request.sent','teras-loop.cut-off-reminder',
 ].includes(eventType);
}
