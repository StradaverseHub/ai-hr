/** Fixed30s development prefix lifecycle; no database, SQL or authority.
 * The native owner supplies its one real transaction callback and socket close. */
type Clock={now:()=>number;schedule:(work:()=>void,ms:number)=>()=>void};
const actual:Clock={now:()=>Number(process.hrtime.bigint())/1e6,schedule:(work,ms)=>{const timer=setTimeout(work,ms);return()=>clearTimeout(timer);}};
export const catalogueReplayPrefixMs=30000;
export async function ownCatalogueReplayPrefix<T>(
 execute:(active:()=>void,callback:<V>(work:()=>Promise<V>)=>Promise<V>)=>Promise<T>,
 close:()=>Promise<void>,verifyQuiescent:(active:()=>void)=>Promise<void>,clock:Clock=actual,closeObserver:()=>Promise<void>=async()=>{},
):Promise<T>{
 const started=clock.now();let stopped=false,expired=false,callbackWork:Promise<unknown>|undefined,callbackCount=0,closeWork:Promise<void>|undefined,observerClose:Promise<void>|undefined;
 const failures:unknown[]=[];const remember=(error:unknown)=>{if(!failures.includes(error))failures.push(error);};
 const closeOwned=()=>{if(!closeWork){closeWork=Promise.resolve().then(close);void closeWork.catch(()=>{});}return closeWork;};
 const closeObservation=()=>{if(!observerClose){observerClose=Promise.resolve().then(closeObserver);void observerClose.catch(()=>{});}return observerClose;};
 const active=()=>{if(expired||clock.now()-started>=catalogueReplayPrefixMs){expired=true;throw Error('Catalogue replay prefix30s deadline exhausted');}if(stopped)throw Error('Catalogue replay prefix work closed');};
 const callback=<V>(work:()=>Promise<V>)=>{
  active();if(callbackCount++)throw Error('Only one owned native replay transaction callback permitted');
  const owned=Promise.resolve().then(()=>{active();return work();});callbackWork=owned;void owned.catch(()=>{});return owned;
 };
 const cancel=clock.schedule(()=>{expired=true;stopped=true;void closeOwned().catch(()=>{});void closeObservation().catch(()=>{});},catalogueReplayPrefixMs);
 let value:T|undefined,returned=false;
 try{
  active();value=await execute(active,callback);returned=true;assertCallback();await callbackWork;active();
 }catch(error){remember(error);}finally{
  stopped=true;
  try{await closeOwned();}catch(error){remember(error);}
  // begin() may reject at its transport-close race BEFORE the callback/finally.
  try{await callbackWork;}catch(error){remember(error);}
 }
 function assertCallback(){if(callbackCount!==1||!callbackWork)throw Error('Actual native replay callback ownership missing');}
 // A successful frontend close does not establish backend death. Verification
 // uses its separate fixed native observer only while the original30s remain.
 if(!failures.length&&!expired){
  try{await verifyQuiescent(()=>{if(expired||clock.now()-started>=catalogueReplayPrefixMs)throw Error('Catalogue replay backend proof exceeded30s');});}catch(error){remember(error);}
 }
 try{await closeObservation();}catch(error){remember(error);}
 cancel();if(expired||clock.now()-started>=catalogueReplayPrefixMs)remember(Error('Catalogue replay prefix exceeded fixed30s envelope'));
 if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,'Catalogue replay prefix and settlement refused');
 if(!returned)throw Error('Catalogue replay prefix produced no result');return value!;
}
