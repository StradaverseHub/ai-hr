import {AsyncLocalStorage} from 'node:async_hooks';

/** Server-only correlation, never a browser/model grant. Nested work keeps the original generation. */
const activities=new AsyncLocalStorage<Readonly<{tenantId:string;generation:number;functions:readonly string[]}>>();
export const aiCentreActivity=(tenantId:string)=>{
 const current=activities.getStore();
 return current?.tenantId===tenantId?current:undefined;
};
export const runAiCentreActivity=<T>(tenantId:string,generation:number,work:()=>Promise<T>,functions:readonly string[]=[]):Promise<T>=>
 activities.run(Object.freeze({tenantId,generation,functions:Object.freeze([...functions])}),work);

/** Human withdrawals, undo, required notifications and audit/retention are deliberately excluded. */
export function aiCentreEvent(eventType:string):boolean{
 return eventType.startsWith('automatic-chase.')||[
  'readiness.nudge-raised','claim-request.triage-queried','teras-loop.action.applied',
  'teras-loop.request.sent','teras-loop.cut-off-reminder',
 ].includes(eventType);
}
