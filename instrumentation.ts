/** Initialize the shared Home read module before Next declares this worker ready.
 * No handler is invoked: no session, tenant data, HTTP warmup or provider call. */
export async function register(){
 if(process.env.NEXT_RUNTIME!=='nodejs'||process.env.NODE_ENV!=='production')return;
 const started=performance.now();
 const home=await import('./app/api/home/sharing-initial/route');
 if(typeof home.GET!=='function')throw Error('Home read module did not initialize');
 (globalThis as typeof globalThis & {__aihrStartupReadiness?:{moduleMs:number;handlersInvoked:number}})
  .__aihrStartupReadiness={moduleMs:performance.now()-started,handlersInvoked:0};
}
