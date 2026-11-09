import {EventEmitter,once} from 'node:events';
import {Agent,createServer,request as httpRequest} from 'node:http';
import {PassThrough} from 'node:stream';
import {gzipSync} from 'node:zlib';
import {afterEach,expect,it,vi} from 'vitest';
import {acquireDriverResource,closedChromiumEnvironment,closePerformanceDbPools,createDriverContexts,
 createDriverFailures,createDriverSockets,createDriverWork,createProtectedClaimCustody,createProtectedLockSampler,createProtectedWorkAdmission,drainDriverLanes,lockSampleEvidence,observeDriverBrowser,
 openDriverResponse,protectedLockObserverCounts,settleDriverBrowser,settleDriverLanes,settleDriverResources,startDriverInterval} from '../scripts/performance/driver-shutdown.mjs';

function deferred<T=void>(){
 let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
}
const disposition=(work:Promise<unknown>)=>work.then(value=>({ok:true,value}),reason=>({ok:false,reason}));
afterEach(()=>vi.useRealTimers());

it('closes the child environment and refuses the parent remote selection without revealing it',()=>{
 const ambient={TZ:'Asia/Kuala_Lumpur',HOME:'/inherited',DATABASE_URL:'db',AUTH_SESSION_KEY:'session',
  AI_CONFIG_SECRET:'encryption',OPENAI_API_KEY:'provider',GH_TOKEN:'github',HTTP_PROXY:'proxy',LD_PRELOAD:'loader',
  SSH_AUTH_SOCK:'ssh',PLAYWRIGHT_BROWSERS_PATH:'/registry',XDG_CACHE_HOME:'/cache',PLAYWRIGHT_CHROMIUM_EXECUTABLE:'/selector'};
 expect(closedChromiumEnvironment(ambient,'/actual-runner')).toEqual({PATH:'/usr/bin:/bin',HOME:'/actual-runner',
  LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'Asia/Kuala_Lumpur'});
 expect(closedChromiumEnvironment({TZ:'UTC'},'/actual-runner')).toHaveProperty('TZ','UTC');
 expect(closedChromiumEnvironment({},'/actual-runner')).not.toHaveProperty('TZ');
 expect(()=>closedChromiumEnvironment({...ambient,SELENIUM_REMOTE_URL:'private-remote-selector'},'/actual-runner'))
  .toThrow(/^Remote Chromium launch is outside the owned development driver$/);
 expect(()=>closedChromiumEnvironment({TZ:'Europe/Paris'},'/actual-runner')).toThrow('Unsupported Chromium time zone');
 expect(ambient.HOME).toBe('/inherited');
});

it('retains the first temporal rejection and waits for the other admitted lane',async()=>{
 const slower=deferred(),firstFailure=deferred();
 const failures=createDriverFailures(),contexts=createDriverContexts(failures),nativeClose=deferred();
 const firstContext=contexts.register({close:vi.fn(()=>nativeClose.promise)});
 const secondContext=contexts.register({close:vi.fn()});
 const joined=settleDriverLanes([secondContext,firstContext],(context:typeof firstContext)=>
  contexts.withContext(context,()=>context===firstContext?firstFailure.promise:slower.promise),failures);
 const result=disposition(joined);
 let settled=false;void result.then(()=>{settled=true;});
 firstFailure.reject(undefined);
 await failures.whenFailed;
 expect(failures.primary()).toEqual({failed:true,reason:undefined});
 expect(firstContext.close).toHaveBeenCalledTimes(1);
 expect(contexts.hasPendingClose()).toBe(true);
 expect(settled).toBe(false);
 slower.reject(Error('later lane failed'));
 expect(await result).toEqual({ok:false,reason:undefined});
 const closeFailure=Error('native context close failed');
 nativeClose.reject(closeFailure);
 await contexts.closeAll();
 expect(failures.privateFailures().secondary).toEqual([{stage:'context-close',reason:closeFailure}]);
 expect(contexts.summary()).toEqual({acquired:2,attempted:2,settled:1,failed:1});
});

it('keeps normal browser work waiting for its actual local close',async()=>{
 const failures=createDriverFailures(),contexts=createDriverContexts(failures),nativeClose=deferred(),started=deferred();
 const context=contexts.register({close:vi.fn(()=>{started.resolve();return nativeClose.promise;})});
 let settled=false;
 const result=contexts.withContext(context,()=>42).then(value=>{settled=true;return value;});
 await started.promise;
 expect(settled).toBe(false);
 expect(contexts.hasPendingClose()).toBe(true);
 nativeClose.resolve();
 expect(await result).toBe(42);
 expect(contexts.hasPendingClose()).toBe(false);
});

it('retains actually admitted work while later admission is closed',async()=>{
 const owned=createDriverWork(),operation=deferred();
 const run=vi.fn(()=>operation.promise);
 const pending=owned.run(run);
 owned.seal();
 expect(()=>owned.run(()=>undefined)).toThrow('Driver work admission is closed');
 let drained=false;const drain=owned.drain().then(()=>{drained=true;});
 await Promise.resolve();
 expect(run).toHaveBeenCalledTimes(1);
 expect(drained).toBe(false);
 operation.resolve();
 await Promise.all([pending,drain]);
 expect(drained).toBe(true);
});

it('settles a pending periodic native operation before another phase or either pool ends',async()=>{
 vi.useFakeTimers();
 const query=deferred(),sample=vi.fn(()=>query.promise),failures=createDriverFailures();
 const preflight=startDriverInterval(250,sample,(reason:unknown)=>failures.record('sample',reason));
 await vi.advanceTimersByTimeAsync(750);
 expect(sample).toHaveBeenCalledTimes(1);
 const stop=preflight.stop(),audit={end:vi.fn()},observer={end:vi.fn()};
 const loaded=vi.fn();
 const next=stop.then(()=>startDriverInterval(1000,loaded,(reason:unknown)=>failures.record('sample',reason)));
 const cleanup=stop.then(()=>closePerformanceDbPools(audit,observer,failures));
 await vi.advanceTimersByTimeAsync(3000);
 expect(sample).toHaveBeenCalledTimes(1);
 expect(loaded).not.toHaveBeenCalled();
 expect(audit.end).not.toHaveBeenCalled();
 expect(observer.end).not.toHaveBeenCalled();
 query.resolve();
 expect(await cleanup).toEqual({audit:'settled',observer:'settled'});
 expect(audit.end).toHaveBeenCalledWith({timeout:5});
 expect(observer.end).toHaveBeenCalledWith({timeout:5});
 await vi.advanceTimersByTimeAsync(1000);
 expect(loaded).toHaveBeenCalledTimes(1);
 await (await next).stop();
});

it('keeps admitted slow-pilot and progress work owned through independent teardown',async()=>{
 vi.useFakeTimers();
 const failures=createDriverFailures(),diagnostics=createDriverWork(),slow=deferred(),progress=deferred();
 const slowWork=diagnostics.run(()=>slow.promise);
 const interval=startDriverInterval(30000,()=>progress.promise,(reason:unknown)=>failures.record('progress',reason));
 await vi.advanceTimersByTimeAsync(30000);
 const progressStop=interval.stop();diagnostics.seal();
 const native={end:vi.fn()},observer={end:vi.fn()},browser=vi.fn(),https=vi.fn();
 const close=settleDriverResources(failures,{browser,https,async database(){
  await Promise.all([progressStop,diagnostics.drain()]);
  return closePerformanceDbPools(native,observer,failures);
 }});
 expect(browser).toHaveBeenCalledTimes(1);
 expect(https).toHaveBeenCalledTimes(1);
 expect(native.end).not.toHaveBeenCalled();
 progress.resolve();await progressStop;
 expect(observer.end).not.toHaveBeenCalled();
 slow.resolve();await slowWork;await close;
 expect(native.end).toHaveBeenCalledTimes(1);
 expect(observer.end).toHaveBeenCalledTimes(1);
});

it('distinguishes a complete empty sample, a late drain, missing work and an actual failure',()=>{
 const window={startMs:100,endMs:200};
 const empty={state:'complete',startedMs:101,completedMs:199,locks:0,blockingAppSessions:0};
 const late={state:'complete',startedMs:150,completedMs:201,locks:0,blockingAppSessions:0};
 const outside={state:'complete',startedMs:99,completedMs:175,locks:0,blockingAppSessions:0};
 expect(lockSampleEvidence([empty,late,outside],window)).toMatchObject({completed:3,qualified:1,failures:0,validEmpty:1,pass:true});
 expect(lockSampleEvidence([late],window)).toMatchObject({completed:1,qualified:0,validEmpty:0,pass:false});
 expect(lockSampleEvidence([],window)).toMatchObject({completed:0,qualified:0,failures:0,pass:false});
 expect(lockSampleEvidence([empty,{state:'failed',startedMs:130,completedMs:150,code:'57014'}],window))
  .toMatchObject({completed:1,qualified:1,failures:1,pass:false});
});

it('requires valid lock counts and rejects an observed blocking session even without advisory rows',()=>{
 const window={startMs:100,endMs:200};
 const clean={state:'complete',startedMs:110,completedMs:120,locks:1,blockingAppSessions:0};
 const blocked={...clean,startedMs:190,completedMs:210,locks:0,blockingAppSessions:1};
 expect(lockSampleEvidence([clean],window)).toMatchObject({coveragePass:true,blockingSamples:0,pass:true});
 expect(lockSampleEvidence([clean,blocked],window)).toMatchObject({coveragePass:true,blockingSamples:1,validEmpty:0,pass:false});
 expect(lockSampleEvidence([{...clean,blockingAppSessions:undefined}],window))
  .toMatchObject({coveragePass:false,invalidBlockingCounts:1,pass:false});
});

it('requires the exact held stats observer identity and actual app visibility on every protected observation',()=>{
 const expected={pid:20,backendStart:'123.45',databaseOid:'54321'};
 const row={...expected,login:'ai_hr_workload_observer',role:'ai_hr_workload_observer',database:'ai_hr_test_w1',
  address:'127.0.0.1',port:5433,readOnly:'on',trackActivities:'on',canReadStats:true,invisibleAppSessions:0,
  appSessions:3,blockingAppSessions:1};
 expect(protectedLockObserverCounts(row,expected)).toEqual({appSessions:3,blockingAppSessions:1});
 for(const change of [{pid:21},{backendStart:'124.45'},{databaseOid:'54322'},{database:'ai_hr_dev'},
  {role:'postgres'},{readOnly:'off'},{canReadStats:false},{trackActivities:'off'},{invisibleAppSessions:1}]){
  expect(()=>protectedLockObserverCounts({...row,...change},expected)).toThrow('observer identity or visibility differed');
 }
});

const protectedObservation=(appSessions:number,blockingAppSessions:number)=>({settlement:'settled' as const,appSessions,blockingAppSessions});

it('seals protected zero only after real opening, in-work observation and terminal closure',async()=>{
 vi.useFakeTimers();
 let now=100;
 const observe=vi.fn().mockResolvedValueOnce(protectedObservation(0,0))
  .mockResolvedValueOnce(protectedObservation(2,0)).mockResolvedValueOnce(protectedObservation(0,0));
 const sampler=createProtectedLockSampler({phase:'preflight',deadline:1800,observe,onFailure:vi.fn(),now:()=>now});
 await sampler.start();
 expect(sampler.evidence()).toMatchObject({state:'incomplete',blockingSamples:null,pass:false});
 now+=250;await vi.advanceTimersByTimeAsync(250);
 now+=150;
 const result=await sampler.close(true);
 expect(result).toMatchObject({state:'complete',coveragePass:true,pass:true,blockingSamples:0,maxGapUs:500000,
  observedGapUs:250000,window:{startUs:0,endUs:400000},missedTicks:0});
 expect(result.samples.map(row=>row.position)).toEqual(['opening','periodic','closing']);
 expect([result,result.window,result.samples,...result.samples].every(Object.isFrozen)).toBe(true);
 expect(sampler.close(false)).toBe(sampler.close(true));
});

it('refuses a protected window whose only visible app sessions occur at its endpoints',async()=>{
 vi.useFakeTimers();
 let now=100;
 const observe=vi.fn(async()=>protectedObservation(2,0));
 const sampler=createProtectedLockSampler({phase:'preflight',deadline:1800,observe,onFailure:vi.fn(),now:()=>now});
 await sampler.start();now+=100;
 expect(await sampler.close(true)).toMatchObject({state:'incomplete',reason:'app-unobserved',blockingSamples:null,pass:false});
 expect(observe).toHaveBeenCalledTimes(2);
});

it('refuses an otherwise complete protected window with observed blocking at its closing sample',async()=>{
 vi.useFakeTimers();
 let now=100;
 const observe=vi.fn().mockResolvedValue(protectedObservation(2,0))
  .mockResolvedValueOnce(protectedObservation(2,0)).mockResolvedValueOnce(protectedObservation(2,0)).mockResolvedValueOnce(protectedObservation(2,1));
 const sampler=createProtectedLockSampler({phase:'preflight',deadline:1800,observe,onFailure:vi.fn(),now:()=>now});
 await sampler.start();now+=250;await vi.advanceTimersByTimeAsync(250);
 now+=100;
 expect(await sampler.close(true)).toMatchObject({state:'complete',coveragePass:true,blockingSamples:1,pass:false});
});

it('fails conservative protected gaps in both fixed cadences even when each sample reports zero',async()=>{
 vi.useFakeTimers();
 for(const [phase,interval] of [['preflight',250],['loaded',1000]] as const){
  let now=100;
  const late=deferred<ReturnType<typeof protectedObservation>>();
  const observe=vi.fn().mockResolvedValueOnce(protectedObservation(2,0)).mockImplementationOnce(()=>late.promise);
  const sampler=createProtectedLockSampler({phase,deadline:4000,observe,onFailure:vi.fn(),now:()=>now});
  await sampler.start();now+=interval;await vi.advanceTimersByTimeAsync(interval);
  now+=interval+1;late.resolve(protectedObservation(2,0));
  await vi.advanceTimersByTimeAsync(0);
  now+=1;
  expect(await sampler.close(true)).toMatchObject({phase,intervalMs:interval,maxGapUs:interval*2000,
   observedGapUs:interval*2000+1000,state:'incomplete',reason:'coverage-gap',blockingSamples:null,pass:false});
 }
});

it('preserves a pending protected observer failure through the closing barrier',async()=>{
 vi.useFakeTimers();
 let now=100;
 const late=deferred<ReturnType<typeof protectedObservation>|{settlement:'settled';failed:true;reason:unknown}|{settlement:'stopped'}>(),onFailure=vi.fn();
 const observe=vi.fn().mockResolvedValueOnce(protectedObservation(2,0))
  .mockResolvedValueOnce(protectedObservation(2,0)).mockImplementationOnce(()=>late.promise);
 const sampler=createProtectedLockSampler({phase:'preflight',deadline:1800,observe,onFailure,now:()=>now});
 await sampler.start();
 now+=250;await vi.advanceTimersByTimeAsync(250);
 now+=250;await vi.advanceTimersByTimeAsync(250);
 now+=250;await vi.advanceTimersByTimeAsync(250);
 const closed=sampler.close(true);
 let returned=false;void closed.then(()=>{returned=true;});
 await Promise.resolve();expect(returned).toBe(false);
 const original=Error('private observer failure');late.resolve({settlement:'settled',failed:true,reason:original});
 expect(await closed).toMatchObject({state:'incomplete',reason:'observer-failed',observedBlockingSamples:0,
  blockingSamples:null,missedTicks:1,pass:false});
 expect(onFailure).toHaveBeenCalledExactlyOnceWith(original);
 expect(observe).toHaveBeenCalledTimes(3);
});

it('refuses protected opening blocking or invalid counts before any periodic work is admitted',async()=>{
 vi.useFakeTimers();
 for(const [counts,reason] of [[protectedObservation(2,1),'opening-blocking'],
  [protectedObservation(0,1),'sample-invalid']] as const){
  const observe=vi.fn(async()=>counts),onFailure=vi.fn();
  const sampler=createProtectedLockSampler({phase:'preflight',deadline:1800,observe,onFailure,now:()=>100});
  await expect(sampler.start()).rejects.toThrow('Protected lock opening observation');
  await vi.advanceTimersByTimeAsync(1000);
  expect(await sampler.close(false)).toMatchObject({state:'incomplete',reason,blockingSamples:null,pass:false});
  expect(observe).toHaveBeenCalledTimes(1);expect(onFailure).toHaveBeenCalledTimes(1);
 }
});

it('retains a pending native query at the existing deadline without renewing the observation window',async()=>{
 vi.useFakeTimers();
 let now=100;
 const late=deferred<ReturnType<typeof protectedObservation>|{settlement:'settled';failed:true;reason:unknown}|{settlement:'stopped'}>(),onFailure=vi.fn();
 const observe=vi.fn().mockResolvedValueOnce(protectedObservation(2,0)).mockImplementationOnce(()=>late.promise);
 const sampler=createProtectedLockSampler({phase:'preflight',deadline:600,observe,onFailure,now:()=>now});
 await sampler.start();now=350;await vi.advanceTimersByTimeAsync(250);
 now=600;await vi.advanceTimersByTimeAsync(250);
 expect(onFailure).toHaveBeenCalledTimes(1);
 const closed=sampler.close(true);
 let returned=false;void closed.then(()=>{returned=true;});
 await Promise.resolve();expect(returned).toBe(false);
 late.resolve({settlement:'stopped'});
 expect(await closed).toMatchObject({reason:'deadline',state:'incomplete',cutoffUs:500000,observerSettlement:'stopped',blockingSamples:null,pass:false});
 expect(observe).toHaveBeenCalledTimes(2);
});

it('refuses a delayed protected query before the actual observer invocation',async()=>{
 let now=100;
 const observe=vi.fn(),onFailure=vi.fn();
 const sampler=createProtectedLockSampler({phase:'preflight',deadline:200,observe,onFailure,now:()=>now});
 const opened=sampler.start();now=200;
 await expect(opened).rejects.toThrow('Protected lock opening observation refused');
 expect(observe).not.toHaveBeenCalled();
 expect(await sampler.close(false)).toMatchObject({reason:'deadline',state:'incomplete',blockingSamples:null,pass:false});
 expect(onFailure).toHaveBeenCalledTimes(1);
});

it('closes protected business admission at the first periodic blocker and keeps the positive count',async()=>{
 vi.useFakeTimers();
 let now=100;
 const failures=createDriverFailures(),sealIngress=vi.fn(),assertIngress=vi.fn();
 const gate=createProtectedWorkAdmission({assertIngress,sealIngress,noteFailure:failures.notePrimary,noteSealFailure:vi.fn()});
 const observe=vi.fn().mockResolvedValueOnce(protectedObservation(2,0)).mockResolvedValueOnce(protectedObservation(2,1));
 const sampler=createProtectedLockSampler({phase:'preflight',deadline:1800,observe,onFailure:gate.close,now:()=>now});
 await sampler.start();gate.requireOpen();
 now+=250;await vi.advanceTimersByTimeAsync(250);
 expect(failures.primary().reason).toMatchObject({message:'Protected lock observation found blocking'});
 expect(()=>gate.requireOpen()).toThrow('Protected workload admission is closed');
 gate.close(Error('later error'));
 expect(sealIngress).toHaveBeenCalledTimes(1);expect(assertIngress).toHaveBeenCalledTimes(1);
 expect(await sampler.close(false)).toMatchObject({reason:'blocking-observed',observedBlockingSamples:1,blockingSamples:null,pass:false});
 expect(observe).toHaveBeenCalledTimes(2);
});

it('keeps local protected admission closed when the owned ingress seal itself refuses',()=>{
 const failures=createDriverFailures(),first=Error('first native failure'),later=Error('owner seal refused');
 const gate=createProtectedWorkAdmission({assertIngress:vi.fn(),sealIngress(){throw later;},
  noteFailure:failures.notePrimary,noteSealFailure:reason=>failures.record('native-ingress-seal',reason)});
 gate.close(first);
 expect(()=>gate.requireOpen()).toThrow('Protected workload admission is closed');
 expect(failures.privateFailures()).toEqual({primary:{failed:true,reason:first},secondary:[{stage:'native-ingress-seal',reason:later}]});
});

it('signals only the owned opening or terminal observer and waits for its actual stop disposition',async()=>{
 vi.useFakeTimers();
 for(const position of ['opening','closing']){
  let now=100,lease:{activeUntilMs:number;signal:AbortSignal}|undefined;
  const native=deferred<{settlement:'stopped'|'uncertain'}>(),onFailure=vi.fn();
  const observe=vi.fn().mockImplementation((owned:typeof lease)=>{lease=owned;return native.promise;});
  if(position==='closing')observe.mockResolvedValueOnce(protectedObservation(2,0)).mockResolvedValueOnce(protectedObservation(2,0));
  const sampler=createProtectedLockSampler({phase:'preflight',deadline:600,observe,onFailure,now:()=>now});
  const opened=disposition(sampler.start());
  if(position==='closing'){expect((await opened).ok).toBe(true);now=350;await vi.advanceTimersByTimeAsync(250);}
  const pending=position==='opening'?opened:sampler.close(true);
  let returned=false;void pending.then(()=>{returned=true;});
  await Promise.resolve();await Promise.resolve();
  expect(lease?.activeUntilMs).toBe(600);expect(lease?.signal.aborted).toBe(false);
  now=600;await vi.advanceTimersByTimeAsync(position==='opening'?500:250);
  expect(lease?.signal.aborted).toBe(true);expect(returned).toBe(false);
  expect(onFailure).toHaveBeenCalledTimes(1);
  const settlement=position==='opening'?'stopped':'uncertain';
  native.resolve({settlement});await pending;
  expect(await sampler.close(false)).toMatchObject({reason:'deadline',observerSettlement:settlement,blockingSamples:null,pass:false});
 }
});

it('rounds a fractional excess outward in both protected observation gaps',async()=>{
 vi.useFakeTimers();
 for(const [phase,interval] of [['preflight',250],['loaded',1000]] as const){
  let now=100;
  const late=deferred<ReturnType<typeof protectedObservation>>();
  const observe=vi.fn().mockResolvedValueOnce(protectedObservation(2,0)).mockImplementationOnce(()=>late.promise);
  const sampler=createProtectedLockSampler({phase,deadline:4000,observe,onFailure:vi.fn(),now:()=>now});
  now=100.0004;await sampler.start();
  now=100+interval;await vi.advanceTimersByTimeAsync(interval);
  now=100+2*interval+0.0006;late.resolve(protectedObservation(2,0));
  await vi.advanceTimersByTimeAsync(0);
  now+=1;
  expect(await sampler.close(true)).toMatchObject({observedGapUs:interval*2000+1,reason:'coverage-gap',blockingSamples:null,pass:false});
 }
});

it('seals an impossible gap before a held periodic or closing sample settles',async()=>{
 vi.useFakeTimers();
 for(const position of ['periodic','closing']){
  let now=100,signal:AbortSignal|undefined;
  const held=deferred<{settlement:'stopped'|'uncertain'}>();
  const observe=vi.fn().mockResolvedValueOnce(protectedObservation(2,0));
  if(position==='closing')observe.mockResolvedValueOnce(protectedObservation(2,0));
  observe.mockImplementationOnce((lease:{signal:AbortSignal})=>{signal=lease.signal;return held.promise;});
  const failures=createDriverFailures(),sealIngress=vi.fn();
  const gate=createProtectedWorkAdmission({assertIngress:vi.fn(),sealIngress,noteFailure:failures.notePrimary,noteSealFailure:vi.fn()});
  const sampler=createProtectedLockSampler({phase:'preflight',deadline:10000,observe,onFailure:gate.close,now:()=>now});
  await sampler.start();now=350;await vi.advanceTimersByTimeAsync(250);
  let closed=position==='closing'?sampler.close(true):undefined;
  await Promise.resolve();await Promise.resolve();
  const exact=position==='closing'?850:600;
  now=exact;await vi.advanceTimersByTimeAsync(exact-350);
  expect(signal?.aborted).toBe(false);
  if(position==='periodic')expect(()=>sampler.requireOpen()).not.toThrow();
  now=exact+0.0006;await vi.advanceTimersByTimeAsync(1);
  expect(signal?.aborted).toBe(true);
  expect(sealIngress).toHaveBeenCalledTimes(1);
  expect(()=>gate.requireOpen()).toThrow('Protected workload admission is closed');
  closed??=sampler.close(true);
  let returned=false;void closed.then(()=>{returned=true;});
  await Promise.resolve();expect(returned).toBe(false);
  const settlement=position==='closing'?'uncertain':'stopped';
  held.resolve({settlement});
  expect(await closed).toMatchObject({state:'incomplete',reason:'coverage-gap',observerSettlement:settlement,blockingSamples:null,pass:false});
 }
});

it('retains pre-dispatch custody and refuses a second ambiguous claim mutation',()=>{
 const claims=createProtectedClaimCustody(),employmentId='00000000-0000-0000-0000-000000000001';
 const browser=claims.register('browser',{actorIndex:0,employmentId,marker:'PERF_BROWSER_DRAFT'});
 const http=claims.register('http',{actorIndex:0,employmentId,marker:'PERF_HTTP_PREFLIGHT'});
 expect(claims.publicFacts()).toEqual([
  {scope:'browser',stage:'create',disposition:'not-dispatched'},{scope:'http',stage:'create',disposition:'not-dispatched'},
 ]);
 browser.begin('create');
 const failedSend=vi.fn(()=>{
  expect(claims.publicFacts()[0]).toEqual({scope:'browser',stage:'create',disposition:'unconfirmed'});
  throw Error('transport disposition is unproved');
 });
 expect(failedSend).toThrow('transport disposition is unproved');
 expect(browser.canRestore()).toBe(false);
 expect(()=>browser.begin('create')).toThrow('mutation state refused');
 expect(failedSend).toHaveBeenCalledTimes(1);
 http.begin('create');http.verify('create','00000000-0000-0000-0000-000000000002');
 expect(http.canRestore()).toBe(true);
 expect(()=>http.reserveRestore(employmentId)).toThrow('restoration state refused');
 http.reserveRestore('00000000-0000-0000-0000-000000000002');
 expect(()=>http.reserveRestore('00000000-0000-0000-0000-000000000002')).toThrow('restoration state refused');
 http.begin('delete');
 expect(http.canRestore()).toBe(false);
 expect(()=>http.begin('delete')).toThrow('mutation state refused');
 expect(claims.privateUnconfirmed()).toMatchObject([
  {scope:'browser',marker:'PERF_BROWSER_DRAFT',pending:'create',draft:null},
  {scope:'http',marker:'PERF_HTTP_PREFLIGHT',pending:'delete',draft:'00000000-0000-0000-0000-000000000002'},
 ]);
 expect(claims.publicFacts()).toEqual([
  {scope:'browser',stage:'create',disposition:'unconfirmed'},{scope:'http',stage:'delete',disposition:'unconfirmed'},
 ]);
 http.verify('delete');
 expect(http.canRestore()).toBe(false);
 expect(claims.publicFacts()[1]).toEqual({scope:'http',stage:'delete',disposition:'restored'});
});

it('keeps the original claim failure when its one authorized restitution fails',async()=>{
 const failures=createDriverFailures(),claims=createProtectedClaimCustody();
 const claim=claims.register('same-company',{actorIndex:5,employmentId:'00000000-0000-0000-0000-000000000001',marker:'PERF_BOUNDARY_0'});
 const original=Error('original failed action'),restoration=Error('private failed delete');
 claim.begin('create',5);claim.verify('create','00000000-0000-0000-0000-000000000002');
 expect(()=>claim.begin('foreign-own',5)).toThrow('mutation state refused');
 claim.begin('foreign-own',0);claim.verify('foreign-own');
 expect(claim.canRestore()).toBe(true);
 failures.notePrimary(original);
 const restore=vi.fn(()=>{claim.reserveRestore('00000000-0000-0000-0000-000000000002');claim.begin('delete',5);throw restoration;});
 await failures.attempt('claim-restoration',restore);
 expect(restore).toHaveBeenCalledTimes(1);
 expect(claim.canRestore()).toBe(false);
 expect(failures.privateFailures()).toEqual({primary:{failed:true,reason:original},secondary:[{stage:'claim-restoration',reason:restoration}]});
 expect(claims.publicFacts()).toEqual([{scope:'same-company',stage:'delete',disposition:'unconfirmed'}]);
});

it('retains actual startup and cleanup outcomes and keeps raw reasons private',async()=>{
 const failures=createDriverFailures(),states={observer:'absent',agent:'absent'};
 const original=undefined,secret=Error('fictional-private-reason'),observer={end:vi.fn()};
 failures.notePrimary(original);
 const acquired=acquireDriverResource(states,'observer',()=>observer);
 expect(()=>acquireDriverResource(states,'agent',()=>{throw secret;})).toThrow(secret);
 expect(states).toEqual({observer:'acquired',agent:'failed'});
 failures.notePrimary(Error('later outcome'));
 const evidence=failures.evidence(()=>{throw secret;});
 expect(evidence).toEqual({state:'failed',reason:secret});
 const close=vi.fn(async()=>{throw secret;});
 const https=vi.fn(async()=>{}),database=vi.fn(async()=>closePerformanceDbPools(undefined,acquired,failures));
 const outcomes=await settleDriverResources(failures,{browser:close,https,database});
 expect(outcomes.map(value=>value.state)).toEqual(['failed','settled','settled']);
 expect(https).toHaveBeenCalledTimes(1);
 expect(database).toHaveBeenCalledTimes(1);
 expect(observer.end).toHaveBeenCalledWith({timeout:5});
 expect(outcomes[2]).toMatchObject({value:{audit:'absent',observer:'settled'}});
 expect(failures.privateFailures().primary).toEqual({failed:true,reason:original});
 expect(failures.privateFailures().secondary[0].reason).toBe(secret);
 expect(JSON.stringify(failures.publicFailures())).not.toContain(secret.message);
});

it('attempts the other actual pool when the first end rejects',async()=>{
 const failures=createDriverFailures(),error=Error('first pool refused');
 const audit={end:vi.fn().mockRejectedValue(error)},observer={end:vi.fn()};
 expect(await closePerformanceDbPools(audit,observer,failures)).toEqual({audit:'failed',observer:'settled'});
 expect(audit.end).toHaveBeenCalledWith({timeout:5});
 expect(observer.end).toHaveBeenCalledWith({timeout:5});
 expect(failures.privateFailures().secondary).toEqual([{stage:'audit-pool-end',reason:error}]);
});

it('shares a pending context close and never retries its real rejection',async()=>{
 const failures=createDriverFailures(),contexts=createDriverContexts(failures),close=deferred();
 const actual={close:vi.fn(()=>close.promise)},error=Error('close refused');
 contexts.register(actual);
 const one=contexts.close(actual);
 expect(contexts.close(actual)).toBe(one);
 expect(actual.close).toHaveBeenCalledTimes(1);
 close.reject(error);
 expect(await one).toEqual({state:'failed',reason:error});
 expect(await contexts.closeAll()).toEqual([{state:'failed',reason:error}]);
 expect(actual.close).toHaveBeenCalledTimes(1);
 expect(contexts.summary()).toEqual({acquired:1,attempted:1,settled:0,failed:1});
});

it('starts every context close before browser close and retains an earlier disconnect',async()=>{
 const failures=createDriverFailures(),contexts=createDriverContexts(failures),order:string[]=[];
 const pending=deferred();
 const a={close:vi.fn(()=>{order.push('context A');return pending.promise;})};
 const b={close:vi.fn(()=>{order.push('context B');})};
 contexts.register(a);
 const browser=Object.assign(new EventEmitter(),{contexts:()=>[a,b],isConnected:()=>false,
  close:vi.fn(()=>{order.push('browser');pending.resolve();})});
 const tracked=observeDriverBrowser(browser,failures);
 expect(await settleDriverBrowser(browser,tracked,contexts,failures)).toMatchObject({close:'settled',
  unexpectedDisconnect:true,contexts:{acquired:2,attempted:2,settled:2,failed:0}});
 expect(order).toEqual(['context A','context B','browser']);
 expect(failures.publicFailures().secondary.map(row=>row.stage)).toEqual(['browser-disconnected']);
});

it('reaches the owned browser close after failed lane work and preserves sibling restoration',async()=>{
 const failures=createDriverFailures(),contexts=createDriverContexts(failures);
 const lanes=createDriverWork(),requests=createDriverWork(),order:string[]=[];
 const body=deferred(),restore=deferred(),nativeClose=deferred(),browserStarted=deferred();
 const a=contexts.register({close:vi.fn(()=>{order.push('context A');return nativeClose.promise;})});
 const b=contexts.register({close:vi.fn(()=>{order.push('context B');})});
 const browser=Object.assign(new EventEmitter(),{contexts:()=>[a,b],isConnected:()=>true,
  close:vi.fn(()=>{order.push('browser');browserStarted.resolve();})});
 const tracked=observeDriverBrowser(browser,failures);
 const group=disposition(lanes.run(()=>settleDriverLanes([a,b],(context:typeof a)=>contexts.withContext(context,async()=>{
  if(context===a)return body.promise;
  await restore.promise;
  await requests.run(async()=>{order.push('restoration');});
 }),failures)));
 const primary=Error('first browser body failed');
 body.reject(primary);
 await failures.whenFailed;
 let completed=false;
 const cleanup=drainDriverLanes(lanes,requests).then(()=>settleDriverBrowser(browser,tracked,contexts,failures))
  .then(result=>{completed=true;return result;});
 expect(order).toEqual(['context A']);
 expect(browser.close).not.toHaveBeenCalled();
 restore.resolve();
 await browserStarted.promise;
 expect(await group).toEqual({ok:false,reason:primary});
 expect(order).toEqual(['context A','restoration','context B','browser']);
 expect(()=>requests.run(()=>undefined)).toThrow('Driver work admission is closed');
 expect(completed).toBe(false);
 expect(contexts.hasPendingClose()).toBe(true);
 nativeClose.resolve();
 expect(await cleanup).toEqual({close:'settled',unexpectedDisconnect:false,
  contexts:{acquired:2,attempted:2,settled:2,failed:0}});
 expect(a.close).toHaveBeenCalledTimes(1);
 expect(b.close).toHaveBeenCalledTimes(1);
 expect(browser.close).toHaveBeenCalledTimes(1);
});

it('keeps a disconnect from its own browser close distinct from a runtime disconnect',async()=>{
 const failures=createDriverFailures(),contexts=createDriverContexts(failures);
 const browser=Object.assign(new EventEmitter(),{contexts:()=>[],isConnected:()=>true,
  close:vi.fn(()=>{browser.emit('disconnected');})});
 const tracked=observeDriverBrowser(browser,failures);
 expect(await settleDriverBrowser(browser,tracked,contexts,failures)).toMatchObject({close:'settled',unexpectedDisconnect:false});
 expect(failures.failed()).toBe(false);
});

function responseFixture(encoding?:'gzip'){
 const failures=createDriverFailures(),observed=vi.fn();
 const request=Object.assign(new EventEmitter(),{end:vi.fn(),destroy:vi.fn(),socket:undefined});
 const response=Object.assign(new PassThrough(),{complete:false,statusCode:200,
  headers:encoding?{'content-encoding':encoding}:{}});
 const headers=vi.fn(),body=Buffer.from('fictional request');
 const opened=openDriverResponse({start:()=>request,body,startedMs:0,onHeaders:headers,observeSocket:observed,recordFailure:failures.record});
 const result=disposition(opened.result);
 request.emit('response',response);
 return {failures,observed,request,response,headers,body,opened,result};
}

it('keeps decoded response success separate from the request and decoder terminal witnesses',async()=>{
 const {request,response,headers,body,opened,result}=responseFixture('gzip');
 let terminal=false;void opened.terminal.then(()=>{terminal=true;});
 const wire=gzipSync('fictional body');
 response.complete=true;
 response.end(wire);
 expect(await result).toMatchObject({ok:true,value:{content:'fictional body',status:200,wireBytes:wire.length,decodedBytes:14}});
 expect(request.end).toHaveBeenCalledExactlyOnceWith(body);
 expect(headers).toHaveBeenCalledTimes(1);
 expect(terminal).toBe(false);
 request.emit('close');
 await opened.terminal;
 expect(terminal).toBe(true);
});

it('owns the raw gzip source error and drains both streams and the actual request close',async()=>{
 const {request,response,opened,result}=responseFixture('gzip');
 const error=Error('raw response failed');
 response.emit('error',error);
 expect(await result).toEqual({ok:false,reason:error});
 expect(response.destroyed).toBe(true);
 expect(request.destroy).toHaveBeenCalledTimes(1);
 let terminal=false;void opened.terminal.then(()=>{terminal=true;});
 await Promise.resolve();expect(terminal).toBe(false);
 request.emit('close');await opened.terminal;expect(terminal).toBe(true);
});

it.each(['aborted','early close'] as const)('refuses an HTTP response with %s before its body completed',async how=>{
 const {request,response,opened,result}=responseFixture('gzip');
 if(how==='aborted')response.emit('aborted');else response.destroy();
 expect(await result).toMatchObject({ok:false,reason:{code:'ERR_STREAM_PREMATURE_CLOSE'}});
 expect(request.destroy).toHaveBeenCalledTimes(1);
 request.emit('close');await opened.terminal;
});

it('refuses an actually truncated gzip stream and owns its native decoder close',async()=>{
 const {request,response,opened,result}=responseFixture('gzip');
 response.complete=true;
 response.end(gzipSync('fictional compressed response').subarray(0,8));
 expect(await result).toMatchObject({ok:false,reason:{code:'Z_BUF_ERROR'}});
 expect(request.destroy).toHaveBeenCalledTimes(1);
 request.emit('close');await opened.terminal;
});

it('preserves a request failure before headers and handles absent acquisition separately',async()=>{
 const failures=createDriverFailures(),observeSocket=vi.fn(),onHeaders=vi.fn();
 const request=Object.assign(new EventEmitter(),{end:vi.fn(),destroy:vi.fn(),socket:undefined});
 const options={body:undefined,startedMs:0,onHeaders,observeSocket,recordFailure:failures.record};
 const transport=openDriverResponse({...options,start:()=>request}),result=disposition(transport.result);
 const abort=Object.assign(Error('owned request timeout'),{code:'ABORT_ERR'});
 request.emit('error',abort);request.emit('close');
 expect(await result).toEqual({ok:false,reason:abort});
 await transport.terminal;
 expect(request.end).toHaveBeenCalledTimes(1);
 expect(onHeaders).not.toHaveBeenCalled();
 const absent=openDriverResponse({...options,start:()=>{throw null;}});
 expect(await disposition(absent.result)).toEqual({ok:false,reason:null});
 await absent.terminal;
 expect(observeSocket).not.toHaveBeenCalled();
});

it('refuses the original decoded-size ceiling while settling the owned response',async()=>{
 const {request,response,opened,result}=responseFixture();
 response.write(Buffer.alloc(12*1024*1024+1));
 expect(await result).toMatchObject({ok:false,reason:{message:'Decoded response exceeded the 12MiB measurement ceiling'}});
 expect(request.destroy).toHaveBeenCalledTimes(1);
 request.emit('close');await opened.terminal;
});

function testSocket(){return Object.assign(new EventEmitter(),{destroyed:false,destroy:vi.fn()});}

it('waits for the real close event of a reused socket after synchronous agent destroy',async()=>{
 const failures=createDriverFailures(),sockets=createDriverSockets(failures),socket=testSocket();
 sockets.observe(socket);sockets.observe(socket);
 const agent={requests:{},sockets:{local:[socket]},freeSockets:{local:[socket]},destroy:vi.fn(()=>{socket.destroyed=true;})};
 let finished=false;const close=sockets.closeAgent(agent).then(result=>{finished=true;return result;});
 await Promise.resolve();
 expect(agent.destroy).toHaveBeenCalledTimes(1);
 expect(socket.destroyed).toBe(true);
 expect(finished).toBe(false);
 socket.emit('close');
 expect(await close).toEqual({state:'settled',queued:0,assigned:1,closed:1,pending:0});
});

it('retains unexpected queued requests and late socket assignment as separate failures',async()=>{
 const failures=createDriverFailures(),sockets=createDriverSockets(failures),socket=testSocket(),late=testSocket();
 const queued={destroy:vi.fn()};sockets.observe(socket);
 const agent={requests:{local:[queued]},sockets:{local:[socket]},freeSockets:{},destroy:vi.fn()};
 const close=sockets.closeAgent(agent);
 sockets.observe(late);
 expect(queued.destroy).toHaveBeenCalledTimes(1);
 expect(late.destroy).toHaveBeenCalledTimes(1);
 socket.emit('close');late.emit('close');
 expect(await close).toMatchObject({queued:1,assigned:2,closed:2,pending:0});
 expect(failures.publicFailures().secondary.map(row=>row.stage)).toEqual(['agent-queue','late-socket']);
});

it('drains a real loopback request and socket after its raw gzip response is cut short',async()=>{
 const failures=createDriverFailures(),sockets=createDriverSockets(failures),cut=deferred();
 const wire=gzipSync('fictional loopback response');
 let serverRequests=0;
 const server=createServer((_request,response)=>{
  serverRequests++;
  response.writeHead(200,{'Content-Encoding':'gzip','Content-Length':wire.length});
  response.write(wire.subarray(0,8));
  const socket=response.socket;
  void cut.promise.then(()=>socket?.destroy());
 });
 const agent=new Agent({keepAlive:true});
 try{
  const listening=once(server,'listening');
  server.listen(0,'127.0.0.1');
  await listening;
  const address=server.address();
  if(!address||typeof address==='string')throw Error('Missing owned loopback fixture address');
  const opened=openDriverResponse({body:undefined,startedMs:0,onHeaders:()=>cut.resolve(),observeSocket:sockets.observe,
   recordFailure:failures.record,start:()=>httpRequest({hostname:'127.0.0.1',port:address.port,path:'/',agent,signal:AbortSignal.timeout(1500)})});
  expect(await disposition(opened.result)).toMatchObject({ok:false,reason:{code:'ERR_STREAM_PREMATURE_CLOSE'}});
  await opened.terminal;
  expect(await sockets.closeAgent(agent)).toEqual({state:'settled',queued:0,assigned:1,closed:1,pending:0});
  expect(serverRequests).toBe(1);
 }finally{
  cut.resolve();agent.destroy();server.closeAllConnections();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
 }
});
