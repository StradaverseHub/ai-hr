/** Initialize Home's code in the app-route runtime before this worker reports ready.
 * This imports definitions only: no handler, session, tenant read or provider is invoked.
 * A failed import stays failed for this process; readiness must not disguise broken code.
 */
let homeModule:Promise<void>|undefined;
export function initializeHomeReadModule():Promise<void>{
 return homeModule??=loadHomeModule();
}
async function loadHomeModule():Promise<void>{
 const started=performance.now();
 const route=await import('../app/api/home/sharing-initial/route');
 if(typeof route.GET!=='function')throw Error('Home read module unavailable');
 const scope=globalThis as typeof globalThis&{__aihrHomeStartupReadiness?:{moduleMs:number;handlersInvoked:0}};
 scope.__aihrHomeStartupReadiness={moduleMs:performance.now()-started,handlersInvoked:0};
}
