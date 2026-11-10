import {EventEmitter,once} from 'node:events';
import {mkdirSync,mkdtempSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Agent,createServer,request as httpRequest} from 'node:http';
import {PassThrough} from 'node:stream';
import {gzipSync} from 'node:zlib';
import {afterEach,expect,it,vi} from 'vitest';
import {acquireDriverResource,buildDevelopmentMeasurement,closedChromiumEnvironment,closePerformanceDbPools,createDriverContexts,
 createDriverFailures,createDriverSockets,createDriverWork,createProtectedClaimCustody,createProtectedLockSampler,createProtectedWorkAdmission,developmentDockerContext,developmentLockWindowEvidence,developmentMeasuredPreflightLockWindowEvidence,developmentNativePreflightLockWindowEvidence,
 developmentPostgresBirthId,developmentPostgresSettlement,drainDriverLanes,lockSampleEvidence,observeDriverBrowser,
 MEASURED_PREFLIGHT_LOCK_ATTEMPT_MS,measuredPreflightLockAttemptMs,measuredPreflightLockTiming,measuredPreflightLockWitnesses,openDriverResponse,qualifyLockSampleCadence,settleDriverBrowser,
 settleDriverLanes,settleDriverResources,startDriverInterval,startMeasuredLockInterval,startMeasuredPreflightLockInterval,validateDevelopmentMeasurement} from '../scripts/performance/driver-shutdown.mjs';
import {protectedLockObserverObservedCounts} from '../scripts/performance/protected-lock-observer.mjs';

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

const legacyLockRow=(startedMs:number,completedMs:number,blockingAppSessions=0)=>
 ({state:'complete',startedMs,completedMs,locks:0,blockingAppSessions,holdersRequested:0,holdersObserved:0});

it.each([320,520])('settles serial probes after a %s ms overrun without hiding missed coverage',async duration=>{
 vi.useFakeTimers({now:0});
 const first=deferred(),second=deferred(),starts:number[]=[],rows:ReturnType<typeof legacyLockRow>[]=[];
 const onFailure=vi.fn();
 const sampler=startMeasuredLockInterval(250,async()=>{
  const start=Date.now();starts.push(start);
  await (starts.length===1?first.promise:second.promise);
  rows.push(legacyLockRow(start,Date.now()));
 },onFailure,Date.now);
 await vi.advanceTimersByTimeAsync(250+duration);
 expect(starts).toEqual([250]);
 first.resolve();
 await vi.advanceTimersByTimeAsync(2);
 expect(starts).toHaveLength(2);
 expect(starts[1]).toBeGreaterThanOrEqual(250+duration);
 expect(starts[1]).toBeLessThanOrEqual(252+duration);
 const stop=sampler.stop();
 const close=vi.fn(),settled=stop.then(close);
 await vi.advanceTimersByTimeAsync(3);
 expect(close).not.toHaveBeenCalled();
 second.resolve();await settled;
 const endMs=Date.now()+1;
 await vi.advanceTimersByTimeAsync(1000);
 expect(starts).toHaveLength(2);
 expect(rows.map(row=>row.startedMs)).toEqual(starts);
 expect(onFailure).not.toHaveBeenCalled();
 expect(qualifyLockSampleCadence('preflight',rows,{startMs:100,endMs})).toMatchObject({
  maxGapUs:500000,observedBlockingSamples:0,qualifiedSamples:2,
  ...(duration===320?{coveragePass:true,pass:true,blockingSamples:0}:
   {coveragePass:false,pass:false,blockingSamples:null,reason:'coverage-gap'}),
 });
});

it('qualifies the measured opening, interior and tail at each fixed lock cadence',()=>{
 for(const [phase,intervalMs] of [['preflight',250],['loaded',1000]] as const){
  const window={startMs:100,endMs:100+5*intervalMs};
  const samples=[legacyLockRow(99,101),...[1,2,3].map(tick=>
   legacyLockRow(100+tick*intervalMs,100+(tick+1)*intervalMs)),legacyLockRow(window.endMs-1,window.endMs+1)];
  expect(qualifyLockSampleCadence(phase,samples,window)).toEqual({
   phase,intervalMs,maxGapUs:intervalMs*2000,state:'complete',reason:null,coveragePass:true,pass:true,
   blockingSamples:0,observedBlockingSamples:0,qualifiedSamples:3,openingGapUs:intervalMs*2000,
   interiorGapUs:intervalMs*2000,tailGapUs:intervalMs*2000,
  });
 }
});

it.each([
 {stallMs:0,probeMs:269,gapUs:469000,pass:true},
 {stallMs:131,probeMs:170,gapUs:501000,pass:false},
 {stallMs:0,probeMs:301,gapUs:501000,pass:false},
])('uses the faster preflight attempts without changing coverage for a $gapUs µs real gap',async({stallMs,probeMs,gapUs,pass})=>{
 vi.useFakeTimers({now:0});
 const pending=deferred(),failed=vi.fn();
 let clockDebtMs=0,starts=0;
 const now=()=>Date.now()+clockDebtMs;
 const rows:(ReturnType<typeof legacyLockRow>&{dueMs:number;timerStartedMs:number;activityCompletedMs:number;advisoryStartedMs:number})[]=[];
 const sampler=startMeasuredLockInterval(MEASURED_PREFLIGHT_LOCK_ATTEMPT_MS,async(timing:{dueMs:number;timerStartedMs:number})=>{
  const startedMs=now();
  starts++;
  await Promise.resolve();
  const activityCompletedMs=now();
  const advisoryStartedMs=now();
  if(starts===2)await pending.promise;
  rows.push({...legacyLockRow(startedMs,now()),...timing,activityCompletedMs,advisoryStartedMs});
 },failed,now);
 await vi.advanceTimersByTimeAsync(200);
 expect(rows.map(row=>row.startedMs)).toEqual([200]);
 clockDebtMs=stallMs;
 await vi.advanceTimersByTimeAsync(200);
 await vi.advanceTimersByTimeAsync(probeMs);
 expect(starts).toBe(2);
 expect(rows).toHaveLength(1);
 const drain=sampler.stop();
 pending.resolve();await drain;
 const window={startMs:0,endMs:now()};
 await vi.advanceTimersByTimeAsync(1000);
 expect(rows.map(row=>row.startedMs)).toEqual([200,400+stallMs]);
 expect(failed).not.toHaveBeenCalled();
 expect(qualifyLockSampleCadence('preflight',rows,window)).toMatchObject({intervalMs:250,maxGapUs:500000,
  openingGapUs:200000,interiorGapUs:gapUs,tailGapUs:probeMs*1000,qualifiedSamples:2,observedBlockingSamples:0,
  pass,blockingSamples:pass?0:null,reason:pass?null:'coverage-gap'});
 expect(measuredPreflightLockTiming(rows,window)).toEqual({attemptIntervalMs:200,gapUs,openingGapUs:200000,
  tailGapUs:probeMs*1000,launchSpacingUs:(200+stallMs)*1000,serialWaitPastDueUs:0,timerAfterReadyUs:stallMs*1000,
  callbackToProbeUs:0,activityRoundTripUs:0,betweenProbesUs:0,advisoryRoundTripUs:probeMs*1000});
 expect(measuredPreflightLockTiming(Array(4097).fill(rows[0]),window)).toBeNull();
 expect(measuredPreflightLockTiming([...rows].reverse(),window)).toBeNull();
});

it('bounds the serial preflight attempts across the entire 600-second driver budget',async()=>{
 vi.useFakeTimers({now:0});
 const starts:{dueMs:number;timerStartedMs:number;attemptIntervalMs:number}[]=[];
 const sampler=startMeasuredLockInterval(measuredPreflightLockAttemptMs,(timing:typeof starts[number])=>{starts.push(timing);},vi.fn(),Date.now);
 await vi.advanceTimersByTimeAsync(600000);
 expect(starts).toHaveLength(4050);
 expect(starts[0]).toEqual({dueMs:125,timerStartedMs:125,attemptIntervalMs:125});
 expect(starts[2799]).toEqual({dueMs:350000,timerStartedMs:350000,attemptIntervalMs:125});
 expect(starts[2800]).toEqual({dueMs:350200,timerStartedMs:350200,attemptIntervalMs:200});
 expect(starts.at(-1)).toEqual({dueMs:600000,timerStartedMs:600000,attemptIntervalMs:200});
 await sampler.stop();
 await vi.advanceTimersByTimeAsync(1000);
 expect(starts).toHaveLength(4050);
});

it('uses one global cadence, opens a second slot only during an actual overrun and drains both',async()=>{
 vi.useFakeTimers({now:0});
 const first=deferred(),second=deferred(),recordFailure=vi.fn();
 const starts:{slot:number;dueMs:number;timerStartedMs:number;attemptIntervalMs:number}[]=[];
 const pending=new Set<number>();
 const sampler=startMeasuredPreflightLockInterval(4,2,async(slot:number,timing:Omit<typeof starts[number],'slot'>)=>{
  expect(pending.has(slot)).toBe(false);
  pending.add(slot);starts.push({slot,...timing});
  if(starts.length===1)await first.promise;
  if(starts.length===4)await second.promise;
  pending.delete(slot);
 },recordFailure,Date.now);
 await vi.advanceTimersByTimeAsync(375);
 expect(starts.map(row=>[row.slot,row.dueMs,row.timerStartedMs])).toEqual([[0,125,125],[1,250,250],[1,375,375]]);
 first.resolve();
 await vi.advanceTimersByTimeAsync(125);
 expect(starts.map(row=>[row.slot,row.dueMs,row.timerStartedMs])).toEqual([[0,125,125],[1,250,250],[1,375,375],[0,500,500]]);
 const drain=sampler.stop();
 expect(sampler.stop()).toBe(drain);
 expect(pending.size).toBe(1);
 second.resolve();
 await drain;
 await vi.advanceTimersByTimeAsync(1000);
 expect(starts).toHaveLength(4);
 expect(pending.size).toBe(0);
 expect(recordFailure).not.toHaveBeenCalled();
});

it('does not queue past two real in-flight observations or fill in skipped time',async()=>{
 vi.useFakeTimers({now:0});
 const first=deferred(),second=deferred();
 const calls:number[]=[];
 const sampler=startMeasuredPreflightLockInterval(10,2,async(slot:number)=>{
  calls.push(Date.now());
  await (slot===0?first.promise:second.promise);
 },vi.fn(),Date.now);
 await vi.advanceTimersByTimeAsync(750);
 expect(calls).toEqual([125,250]);
 const drained=sampler.stop();
 first.resolve();second.resolve();
 await drained;
 await vi.advanceTimersByTimeAsync(500);
 expect(calls).toEqual([125,250]);
});

it('does not use the rescue or exceed the old global start census when probes are healthy',async()=>{
 vi.useFakeTimers({now:0});
 const starts:{slot:number;timerStartedMs:number}[]=[];
 const sampler=startMeasuredPreflightLockInterval(4097,2,(slot:number,timing:{timerStartedMs:number})=>{
  starts.push({slot,...timing});
 },vi.fn(),Date.now);
 await vi.advanceTimersByTimeAsync(600000);
 await sampler.stop();
 expect(starts).toHaveLength(4050);
 expect(starts.every(row=>row.slot===0)).toBe(true);
 expect(starts.at(-1)?.timerStartedMs).toBe(600000);
});

it.each([
 {gapUs:587467,window:{startMs:0,endMs:700},slow:[legacyLockRow(0,15),legacyLockRow(125.532,587.467)],
  rescue:[legacyLockRow(250,260),legacyLockRow(375,385),legacyLockRow(500,510),legacyLockRow(625,635)]},
 {gapUs:538308,window:{startMs:0,endMs:800},slow:[legacyLockRow(125,422.329),legacyLockRow(423.549,663.308)],
  rescue:[legacyLockRow(250,255),legacyLockRow(375,390),legacyLockRow(500,510),legacyLockRow(625,630),legacyLockRow(750,760)]},
])('requires a real serial witness even with rescue probes for the observed $gapUs µs failure',({gapUs,window,slow,rescue})=>{
 const withApp=(row:ReturnType<typeof legacyLockRow>)=>({...row,appSessions:2});
 expect(developmentMeasuredPreflightLockWindowEvidence(slow.map(withApp),window,true)).toMatchObject({
  interiorGapUs:gapUs,coveragePass:false,pass:false,reason:'coverage-gap',
 });
 const rescued=[...slow,...rescue].map(withApp).sort((a,b)=>a.completedMs-b.completedMs);
 expect(developmentMeasuredPreflightLockWindowEvidence(rescued,window,true)).toMatchObject({maxGapUs:500000,pass:true,observedBlockingSamples:0});
 const blocked={...slow[0],blockingAppSessions:1,appSessions:2};
 const lockRows=[...rescued.filter(row=>row.startedMs!==blocked.startedMs),blocked].sort((a,b)=>a.completedMs-b.completedMs);
 expect(developmentMeasuredPreflightLockWindowEvidence(lockRows,window,true)).toMatchObject({pass:false,observedBlockingSamples:1,blockingSamples:1});
});

it('never discards an overlapping positive, broken probe, unclosed sampler or a gap over 500ms',()=>{
 const row=(start:number,end:number,blocking=0)=>({...legacyLockRow(start,end,blocking),appSessions:2});
 const window={startMs:0,endMs:690};
 const overlappingPositive=row(125,475,1);
 const samples=[row(0,15),row(250,260),row(375,385),overlappingPositive,row(500,510),row(625,635)];
 const witnesses=measuredPreflightLockWitnesses(samples,window);
 expect(witnesses).not.toContain(overlappingPositive);
 expect(qualifyLockSampleCadence('preflight',witnesses!,window)).toMatchObject({pass:true,observedBlockingSamples:0});
 expect(developmentMeasuredPreflightLockWindowEvidence(samples,window,true)).toMatchObject({
  pass:false,coveragePass:true,reason:'blocking-observed',blockingSamples:1,observedBlockingSamples:1,
 });
 expect(developmentMeasuredPreflightLockWindowEvidence(samples,window,false)).toMatchObject({pass:false,reason:'window-unsettled',observedBlockingSamples:1});
 const failed={state:'failed',startedMs:210,completedMs:220};
 expect(developmentMeasuredPreflightLockWindowEvidence([failed,...samples],window,true)).toMatchObject({pass:false,observedBlockingSamples:1});
 expect(measuredPreflightLockWitnesses([...samples,row(252,255)],window)).toBeNull();
 expect(developmentMeasuredPreflightLockWindowEvidence([...samples,row(252,255)],window,true)).toMatchObject({pass:false,observedBlockingSamples:1});
 expect(developmentMeasuredPreflightLockWindowEvidence([row(0,30),row(490,501),row(625,635)],window,true)).toMatchObject({
  pass:false,reason:'coverage-gap',interiorGapUs:501000,maxGapUs:500000,
 });
});

it('qualifies only actual bounded native envelopes inside the actor window at the unchanged 500ms limit',()=>{
 const row=(start:number,end:number,nativeOpenedCs:number,nativeClosedCs:number,blocking=0,appSessions=2)=>
  ({...legacyLockRow(start,end,blocking),appSessions,nativeOpenedCs,nativeClosedCs});
 const window={startMs:0,endMs:650,bootStartCs:200,bootEndCs:265};
 const first=row(5,20,201,201),second=row(134,574,246,250),third=row(580,600,259,260);
 const samples=[first,second,third];
 expect(developmentMeasuredPreflightLockWindowEvidence(samples,window,true)).toMatchObject({
  pass:false,reason:'coverage-gap',interiorGapUs:569000,
 });
 expect(developmentNativePreflightLockWindowEvidence(samples,window,true)).toMatchObject({
  pass:true,interiorGapUs:500000,maxGapUs:500000,openingGapUs:20000,tailGapUs:70000,qualifiedSamples:3,
 });
 const over=[first,{...second,nativeClosedCs:251},third];
 expect(developmentNativePreflightLockWindowEvidence(over,window,true)).toMatchObject({
  pass:false,reason:'coverage-gap',interiorGapUs:510000,maxGapUs:500000,
 });
 const outOfWindowPositive=row(602,670,264,265,1);
 expect(developmentNativePreflightLockWindowEvidence([...samples,outOfWindowPositive],window,true)).toMatchObject({
  pass:false,coveragePass:true,observedBlockingSamples:1,blockingSamples:1,qualifiedSamples:3,
 });
 const uncertainOpening=row(0,4,200,200);
 expect(developmentNativePreflightLockWindowEvidence([uncertainOpening,...samples],window,true)).toMatchObject({
  pass:true,qualifiedSamples:3,
 });
 expect(developmentNativePreflightLockWindowEvidence(samples,window,false)).toMatchObject({
  pass:false,reason:'window-unsettled',
 });
 expect(developmentNativePreflightLockWindowEvidence(samples.map(sample=>({...sample,appSessions:0})),window,true)).toMatchObject({
  pass:false,reason:'application-unobserved',
 });
 expect(developmentNativePreflightLockWindowEvidence([first,{...second,nativeClosedCs:245},outOfWindowPositive],window,true)).toMatchObject({
  pass:false,reason:'sample-unknown',observedBlockingSamples:1,
 });
 expect(developmentNativePreflightLockWindowEvidence([...samples,{state:'failed',startedMs:610,completedMs:620}],window,true)).toMatchObject({
  pass:false,reason:'sample-failed',
 });
});

const nativeWitnessModel=(start:number,end:number,nativeOpenedCs:number,nativeClosedCs:number)=>
 ({...legacyLockRow(start,end),appSessions:2,nativeOpenedCs,nativeClosedCs});

it.each([
 {name:'three apparent overlaps after outward rounding',samples:[
  nativeWitnessModel(10,259.8,101,126),nativeWitnessModel(135,265,113,126),
  nativeWitnessModel(260,275,126,127),nativeWitnessModel(385,400,138,140),
 ]},
 {name:'two distinct launches in the same server start bucket',samples:[
  nativeWitnessModel(10,260,125,126),nativeWitnessModel(135,267,125,126),nativeWitnessModel(385,399,138,139),
 ]},
])('selects actual disjoint witnesses despite $name',({samples})=>{
 const window={startMs:0,endMs:600,bootStartCs:100,bootEndCs:160};
 expect(measuredPreflightLockWitnesses(samples,window)).not.toBeNull();
 expect(developmentNativePreflightLockWindowEvidence(samples,window,true)).toMatchObject({
  pass:true,reason:null,coveragePass:true,observedBlockingSamples:0,qualifiedSamples:2,maxGapUs:500000,
 });
 const overlappingPositive={...samples[0],blockingAppSessions:1};
 expect(developmentNativePreflightLockWindowEvidence([overlappingPositive,...samples.slice(1)],window,true)).toMatchObject({
  pass:false,coveragePass:true,reason:'blocking-observed',blockingSamples:1,observedBlockingSamples:1,
 });
});

it('refuses an actual third in-flight probe or a 4097th real completion before selecting native witnesses',()=>{
 const window={startMs:0,endMs:600,bootStartCs:100,bootEndCs:160};
 const three=[nativeWitnessModel(10,400,101,102),nativeWitnessModel(135,405,113,114),nativeWitnessModel(260,410,126,127)];
 expect(measuredPreflightLockWitnesses(three,window)).toBeNull();
 expect(developmentNativePreflightLockWindowEvidence(three,window,true)).toMatchObject({
  pass:false,coveragePass:false,reason:'sample-order',
 });
 const overflow=Array.from({length:4097},(_,index)=>nativeWitnessModel(index*10,index*10+1,index,index));
 expect(developmentNativePreflightLockWindowEvidence(overflow,{...window,endMs:41000,bootEndCs:4200},true)).toMatchObject({
  pass:false,coveragePass:false,reason:'samples-unknown',
 });
});

it('does not admit an early monotonic timer callback as an observation',async()=>{
 vi.useFakeTimers({now:0});
 let debtMs=0;
 const sample=vi.fn();
 const sampler=startMeasuredLockInterval(measuredPreflightLockAttemptMs,sample,vi.fn(),()=>Date.now()+debtMs);
 debtMs=-1;
 await vi.advanceTimersByTimeAsync(125);
 expect(sample).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(1);
 expect(sample).toHaveBeenCalledExactlyOnceWith({dueMs:125,timerStartedMs:125,attemptIntervalMs:125});
 await sampler.stop();
});

it.each([
 {activityMs:344,advisoryMs:3,blocking:0,gapUs:472000,pass:true,reason:null},
 {activityMs:373,advisoryMs:3,blocking:0,gapUs:501000,pass:false,reason:'coverage-gap'},
 {activityMs:344,advisoryMs:3,blocking:1,gapUs:472000,pass:false,reason:'blocking-observed'},
])('keeps the strict gate for a $gapUs µs two-probe window with $blocking blocking',async({activityMs,advisoryMs,blocking,gapUs,pass,reason})=>{
 vi.useFakeTimers({now:0});
 const activity=deferred(),advisory=deferred();
 const rows:(ReturnType<typeof legacyLockRow>&{dueMs:number;timerStartedMs:number;attemptIntervalMs:number;activityCompletedMs:number;advisoryStartedMs:number})[]=[];
 let active=0,attempts=0;
 const failed=vi.fn();
 const sampler=startMeasuredLockInterval(measuredPreflightLockAttemptMs,async(timing:{dueMs:number;timerStartedMs:number;attemptIntervalMs:number})=>{
  expect(active++).toBe(0);
  const startedMs=Date.now(),second=++attempts===2;
  if(second)await activity.promise;
  const activityCompletedMs=Date.now(),advisoryStartedMs=Date.now();
  if(second)await advisory.promise;
  rows.push({...legacyLockRow(startedMs,Date.now(),second?blocking:0),...timing,activityCompletedMs,advisoryStartedMs});
  active--;
 },failed,Date.now);
 await vi.advanceTimersByTimeAsync(250+activityMs);
 expect(attempts).toBe(2);
 expect(rows).toHaveLength(1);
 activity.resolve();
 await vi.advanceTimersByTimeAsync(advisoryMs);
 const drain=sampler.stop();
 advisory.resolve();
 await drain;
 const window={startMs:0,endMs:Date.now()};
 const cadence=qualifyLockSampleCadence('preflight',rows,window);
 expect(cadence).toMatchObject({intervalMs:250,maxGapUs:500000,interiorGapUs:gapUs,pass,reason,observedBlockingSamples:blocking,qualifiedSamples:2});
 expect(measuredPreflightLockTiming(rows,window)).toMatchObject({attemptIntervalMs:125,gapUs,activityRoundTripUs:activityMs*1000,advisoryRoundTripUs:advisoryMs*1000});
 expect(failed).not.toHaveBeenCalled();
 expect(rows.map(row=>row.startedMs)).toEqual([125,250]);
});

it.each([
 {combinedMs:375,gapUs:500000,pass:true},
 {combinedMs:376,gapUs:501000,pass:false},
])('reports the actual combined statement duration at a $gapUs µs gap without changing qualification',({combinedMs,gapUs,pass})=>{
 const first=legacyLockRow(125,125);
 const second={...legacyLockRow(250,250+combinedMs),probeMode:'combined-statement',dueMs:250,timerStartedMs:250,attemptIntervalMs:125};
 const window={startMs:0,endMs:250+combinedMs};
 expect(qualifyLockSampleCadence('preflight',[first,second],window)).toMatchObject({
  intervalMs:250,maxGapUs:500000,interiorGapUs:gapUs,pass,qualifiedSamples:2,observedBlockingSamples:0,
  reason:pass?null:'coverage-gap',
 });
 expect(measuredPreflightLockTiming([first,second],window)).toEqual({
  probeMode:'combined-statement',attemptIntervalMs:125,gapUs,openingGapUs:125000,tailGapUs:combinedMs*1000,
  launchSpacingUs:125000,serialWaitPastDueUs:0,timerAfterReadyUs:0,callbackToProbeUs:0,combinedRoundTripUs:combinedMs*1000,
 });
 expect(measuredPreflightLockTiming([first,{...second,probeMode:'unknown'}],window)).toBeNull();
 expect(measuredPreflightLockTiming([first,{...second,activityCompletedMs:250}],window)).toBeNull();
 expect(measuredPreflightLockTiming([first,{...second,timerStartedMs:251}],window)).toBeNull();
});

it('refuses each missed coverage segment even when all observed lock counts are zero',()=>{
 const window={startMs:100,endMs:1200};
 for(const [segment,gapUs,samples] of [
  ['openingGapUs',501000,[legacyLockRow(590,601),legacyLockRow(700,720),legacyLockRow(900,920)]],
  ['interiorGapUs',500001,[legacyLockRow(200,220),legacyLockRow(690,700.0001),legacyLockRow(900,920)]],
  ['tailGapUs',501000,[legacyLockRow(200,220),legacyLockRow(450,460),legacyLockRow(699,710)]],
 ] as const){
  expect(qualifyLockSampleCadence('preflight',samples,window)).toMatchObject({
   state:'missed',reason:'coverage-gap',pass:false,coveragePass:false,blockingSamples:null,observedBlockingSamples:0,
   [segment]:gapUs,
  });
 }
});

it('refuses unknown, failed, duplicated or unordered lock evidence and leaves zero unqualified',()=>{
 const window={startMs:100,endMs:400};
 const first=legacyLockRow(110,120),second=legacyLockRow(220,230);
 for(const samples of [[],[first],[legacyLockRow(99,105),legacyLockRow(390,401)]])
  expect(qualifyLockSampleCadence('preflight',samples,window)).toMatchObject({
   state:'unknown',reason:'cadence-unobserved',blockingSamples:null,pass:false,
  });
 for(const [reason,samples] of [
  ['sample-failed',[first,{state:'failed',startedMs:170,completedMs:180},second]],
  ['sample-unknown',[first,{...second,blockingAppSessions:undefined}]],
  ['sample-unknown',[first,{...second,completedMs:NaN}]],
  ['sample-unknown',[first,{...second,locks:-1}]],
  ['sample-unknown',[first,legacyLockRow(220,219)]],
  ['sample-order',[first,legacyLockRow(119,220)]],
  ['sample-order',[second,first]],
  ['sample-order',[legacyLockRow(220,220),legacyLockRow(220,220)]],
 ] as const){
  expect(qualifyLockSampleCadence('preflight',samples,window)).toMatchObject({
   state:'unknown',reason,blockingSamples:null,pass:false,
  });
 }
 for(const open of [undefined,{startMs:100},{startMs:100,endMs:100}]){
  expect(qualifyLockSampleCadence('preflight',[first,second],open)).toMatchObject({
   state:'unknown',reason:'window-unknown',blockingSamples:null,pass:false,
  });
 }
 expect(qualifyLockSampleCadence('unregistered',[first,second],window)).toMatchObject({reason:'window-unknown',pass:false});
 expect(qualifyLockSampleCadence('preflight',Array(4097).fill(first),window)).toMatchObject({reason:'samples-unknown',pass:false});
});

it('retains known blocking even when it occurs in a late drain outside the cadence window',()=>{
 const window={startMs:100,endMs:400};
 const samples=[legacyLockRow(110,120),legacyLockRow(220,230),legacyLockRow(399,401,1)];
 expect(qualifyLockSampleCadence('preflight',samples,window)).toMatchObject({
  state:'complete',reason:'blocking-observed',qualifiedSamples:2,coveragePass:true,blockingSamples:1,pass:false,
 });
 expect(qualifyLockSampleCadence('preflight',[...samples,{state:'failed'}],window)).toMatchObject({
  state:'unknown',reason:'sample-failed',observedBlockingSamples:1,coveragePass:false,blockingSamples:null,pass:false,
 });
});

it('keeps abort, invisible app or empty sampling distinct from qualified zero',()=>{
 const first={...legacyLockRow(110,120),appSessions:2},second={...legacyLockRow(220,230),appSessions:2};
 const window={startMs:100,endMs:400};
 expect(developmentLockWindowEvidence('preflight',[first,second],window,true)).toMatchObject({
  state:'complete',blockingSamples:0,observedBlockingSamples:0,pass:true,
 });
 expect(developmentLockWindowEvidence('preflight',[first,second],window,false)).toMatchObject({
  state:'unknown',reason:'window-unsettled',blockingSamples:null,observedBlockingSamples:0,pass:false,
 });
 expect(developmentLockWindowEvidence('preflight',[first,second].map(row=>({...row,appSessions:0})),window,true)).toMatchObject({
  state:'unknown',reason:'application-unobserved',blockingSamples:null,observedBlockingSamples:0,pass:false,
 });
 expect(developmentLockWindowEvidence('preflight',[],window,true)).toMatchObject({
  state:'unknown',blockingSamples:null,observedBlockingSamples:null,pass:false,
 });
 expect(developmentLockWindowEvidence('preflight',[first,second,{...legacyLockRow(399,401,1),appSessions:2}],window,false)).toMatchObject({
  state:'unknown',blockingSamples:null,observedBlockingSamples:1,pass:false,
 });
});

function developmentMeasurementInput(){
 const suite='workflow-preflight',identity={candidateSha:'a'.repeat(40),controllerSha:'b'.repeat(40),
  runId:123,runAttempt:1,harnessSha256:'c'.repeat(64),scenarioSha256:'d'.repeat(64)};
 const observed=[{...legacyLockRow(110,120),appSessions:1},{...legacyLockRow(220,230),appSessions:1}];
 const preflight=developmentLockWindowEvidence('preflight',observed,{startMs:100,endMs:400},true);
 return {suite,identity,preflight,loaded:developmentLockWindowEvidence('loaded',[],null,false),workCompleted:true,clean:true,busyResponses:0,
  renderedCapture:{sha256:'e'.repeat(64),bytes:128},
  pages:{observedPages:2,closedPages:2,censusComplete:true,crash:0,aborted:2,transport:0,http5xx:0,pageError:0,consoleError:0},
  shutdown:{browser:{close:'settled'},http:{state:'settled',assigned:3,closed:3,pending:0,queued:0},
   diagnostics:'settled',database:{audit:'settled',observer:'settled'}}};
}

it('joins the exact development terminal receipt and refuses changed identity or inconsistent zeros',()=>{
 const input=developmentMeasurementInput(),expected={...input.identity,suite:input.suite};
 const receipt=buildDevelopmentMeasurement(input);
 expect(receipt).toMatchObject({complete:true,workCompleted:true,busyResponses:0,load:null,
  pageEvents:{qualifiedCrashes:0,aborted:2},locks:{preflight:{blockingSamples:0},loaded:{state:'not-applicable'}}});
 expect(validateDevelopmentMeasurement(receipt,expected)).toBe(true);
 for(const change of [
  (value:typeof receipt)=>value.identity.runId++,
  (value:typeof receipt)=>value.identity.harnessSha256='z'.repeat(64),
  (value:typeof receipt)=>value.pageEvents.censusComplete=false,
  (value:typeof receipt)=>value.locks.preflight.openingGapUs=500001,
  (value:typeof receipt)=>value.locks.preflight.observedBlockingSamples=1,
  (value:typeof receipt)=>value.busyResponses=1,
  (value:typeof receipt)=>value.settlement.observerPool='failed',
  (value:typeof receipt)=>Object.assign(value,{private:'forged'}),
 ]){
  const changed=structuredClone(receipt);change(changed);
  expect(validateDevelopmentMeasurement(changed,expected)).toBe(false);
 }
});

it('retains incomplete terminal receipts without promoting missing Pages, app traffic or cleanup',()=>{
 const input=developmentMeasurementInput(),expected={...input.identity,suite:input.suite};
 for(const change of [
  (value:typeof input)=>{value.pages.censusComplete=false;value.pages.observedPages=0;value.pages.closedPages=0;},
  (value:typeof input)=>{value.pages.crash=1;},
  (value:typeof input)=>{value.pages.http5xx=1;},
  (value:typeof input)=>{value.shutdown.http.pending=1;},
  (value:typeof input)=>{value.workCompleted=false;},
 ]){
  const changed=structuredClone(input);change(changed);const receipt=buildDevelopmentMeasurement(changed);
  expect(receipt.complete).toBe(false);expect(validateDevelopmentMeasurement(receipt,expected)).toBe(true);
  if(!changed.pages.censusComplete)expect(receipt.pageEvents).toMatchObject({observedCrashes:null,qualifiedCrashes:null});
 }
 const loaded=buildDevelopmentMeasurement({...input,suite:'whole-system'});
 expect(loaded.complete).toBe(false);expect(validateDevelopmentMeasurement(loaded,{...expected,suite:'whole-system'})).toBe(true);
});

it('seals a whole-system hold only after all 500 lanes arrived on time and completed',()=>{
 const load={holdMs:300000,windowElapsed:true,firstFullConcurrencyUs:10000000,launched:500,
  peakActive:500,completed:500,failed:0,activeAtSettlement:0,earlyLaneExits:0,iterations:500};
 const samples=Array.from({length:300},(_,i)=>({...legacyLockRow(110+i*1000,120+i*1000),appSessions:1}));
 const input={...developmentMeasurementInput(),suite:'whole-system',load,
  loaded:developmentLockWindowEvidence('loaded',samples,{startMs:100,endMs:300100},true)};
 const expected={...input.identity,suite:input.suite};
 const receipt=buildDevelopmentMeasurement(input);
 expect(receipt).toMatchObject({complete:true,load,locks:{loaded:{blockingSamples:0,qualifiedSamples:300}}});
 expect(receipt.load).not.toBe(load);
 expect(validateDevelopmentMeasurement(receipt,expected)).toBe(true);
 for(const change of [
  {holdMs:30000},{windowElapsed:false},{firstFullConcurrencyUs:10000001},{earlyLaneExits:1},
  {launched:499,completed:499,peakActive:499,firstFullConcurrencyUs:null},
  {completed:499,failed:1},{completed:499,activeAtSettlement:1},
 ]){
  const observed={...load,...change};
  const incomplete=buildDevelopmentMeasurement({...input,load:observed});
  expect(incomplete).toMatchObject({complete:false,load:observed,renderedCapture:null});
  expect(validateDevelopmentMeasurement(incomplete,expected)).toBe(true);
  expect(validateDevelopmentMeasurement({...receipt,load:observed},expected)).toBe(false);
 }
 for(const forged of [null,{...load,completed:501},{...load,firstFullConcurrencyUs:null},{...load,unknown:0}]){
  expect(buildDevelopmentMeasurement({...input,load:forged})).toMatchObject({complete:false,load:null,renderedCapture:null});
  expect(validateDevelopmentMeasurement({...receipt,load:forged},expected)).toBe(false);
 }
});

it('requires the bounded rendered capture binding only for a complete development terminal receipt',()=>{
 const input=developmentMeasurementInput(),expected={...input.identity,suite:input.suite};
 const receipt=buildDevelopmentMeasurement(input);
 expect(receipt.renderedCapture).toEqual(input.renderedCapture);
 expect(receipt.renderedCapture).not.toBe(input.renderedCapture);
 expect(validateDevelopmentMeasurement(receipt,expected)).toBe(true);
 for(const invalid of [null,{sha256:'e'.repeat(63)+'\n',bytes:128},{sha256:'e'.repeat(64),bytes:0},
  {sha256:'e'.repeat(64),bytes:4*1024**2+1},{...input.renderedCapture,payload:'not-allowed'}]){
  const changed=structuredClone(receipt);Object.assign(changed,{renderedCapture:invalid});
  expect(validateDevelopmentMeasurement(changed,expected)).toBe(false);
  expect(buildDevelopmentMeasurement({...input,renderedCapture:invalid})).toMatchObject({complete:false,renderedCapture:null});
 }
 const failed=buildDevelopmentMeasurement({...input,clean:false});
 expect(failed).toMatchObject({complete:false,renderedCapture:null});
 expect(validateDevelopmentMeasurement(failed,expected)).toBe(true);
 expect(validateDevelopmentMeasurement({...failed,renderedCapture:input.renderedCapture},expected)).toBe(false);
});

it('admits two independent rendered seals only for the runner-selected self-source full preflight',()=>{
 const input=developmentMeasurementInput();
 input.identity.controllerSha=input.identity.candidateSha;
 const expected={...input.identity,suite:input.suite,requireRenderedUnion:true};
 const legacy=buildDevelopmentMeasurement(input);
 const renderedUnion={sha256:'f'.repeat(64),bytes:4*1024**2};
 const full={...legacy,renderedUnion};
 expect(validateDevelopmentMeasurement(full,expected)).toBe(true);
 expect(validateDevelopmentMeasurement(legacy,expected)).toBe(false);
 expect(validateDevelopmentMeasurement(full,{...expected,requireRenderedUnion:false})).toBe(false);
 expect(validateDevelopmentMeasurement(legacy,{...expected,requireRenderedUnion:false})).toBe(true);
 expect(validateDevelopmentMeasurement(legacy,Object.assign({...expected},{requireRenderedUnion:'true'}))).toBe(false);
 for(const forged of [null,undefined,{...renderedUnion,bytes:0},{...renderedUnion,bytes:1.5},
  {...renderedUnion,bytes:renderedUnion.bytes+1},{...renderedUnion,sha256:'f'.repeat(63)+'\n'},
  {...renderedUnion,private:'refused'},{...renderedUnion,sha256:legacy.renderedCapture!.sha256}]){
  expect(validateDevelopmentMeasurement({...full,renderedUnion:forged},expected)).toBe(false);
 }
 expect(validateDevelopmentMeasurement({...full,renderedCapture:null},expected)).toBe(false);
 const controllerSha='b'.repeat(40);
 expect(validateDevelopmentMeasurement({...full,identity:{...full.identity,controllerSha}},{...expected,controllerSha})).toBe(false);
 const steady=buildDevelopmentMeasurement({...input,suite:'whole-system'});
 expect(validateDevelopmentMeasurement({...steady,renderedUnion:null},{...expected,suite:'whole-system'})).toBe(false);
});

it('keeps failed full preflight receipts unsealed and retains the original Busy and settlement gates',()=>{
 const input=developmentMeasurementInput();
 input.identity.controllerSha=input.identity.candidateSha;
 const expected={...input.identity,suite:input.suite,requireRenderedUnion:true};
 const renderedUnion={sha256:'f'.repeat(64),bytes:256};
 const completed=buildDevelopmentMeasurement(input);
 const failed={...buildDevelopmentMeasurement({...input,busyResponses:1}),renderedUnion:null};
 expect(failed).toMatchObject({complete:false,busyResponses:1,renderedCapture:null,renderedUnion:null});
 expect(validateDevelopmentMeasurement(failed,expected)).toBe(true);
 expect(validateDevelopmentMeasurement({...failed,renderedUnion},expected)).toBe(false);
 expect(validateDevelopmentMeasurement({...failed,renderedCapture:input.renderedCapture},expected)).toBe(false);
 expect(validateDevelopmentMeasurement({...failed,renderedUnion:undefined},expected)).toBe(false);
 expect(validateDevelopmentMeasurement({...completed,renderedUnion,busyResponses:1},expected)).toBe(false);
 expect(validateDevelopmentMeasurement({...completed,renderedUnion,settlement:{...completed.settlement,observerPool:'failed'}},expected)).toBe(false);
});

it('refuses an impossible Page census even in an explicitly incomplete development receipt',()=>{
 const input=developmentMeasurementInput(),expected={...input.identity,suite:input.suite};
 const receipt=buildDevelopmentMeasurement(input);
 expect(receipt.poolEvidence).toBe('postgres-js-end-api-acknowledgement');
 for(const state of ['failed','unknown','absent']){
  const forged=structuredClone(receipt);forged.complete=false;forged.settlement.browser=state;
  expect(validateDevelopmentMeasurement(forged,expected)).toBe(false);
 }
 for(const counts of [{observedPages:1,closedPages:2},{observedPages:null,closedPages:2}]){
  const forged=structuredClone(receipt);forged.complete=false;
  Object.assign(forged.pageEvents,counts,{censusComplete:false,qualifiedCrashes:null,observedCrashes:null,
   aborted:null,transport:null,http5xx:null,pageError:null,consoleError:null});
  expect(validateDevelopmentMeasurement(forged,expected)).toBe(false);
 }
 const incomplete=buildDevelopmentMeasurement({...input,shutdown:{...input.shutdown,browser:{close:'failed'}},
  pages:{...input.pages,crash:1}});
 expect(incomplete).toMatchObject({complete:false,pageEvents:{censusComplete:false,observedCrashes:1,qualifiedCrashes:null}});
 expect(validateDevelopmentMeasurement(incomplete,expected)).toBe(true);
 const inverted=buildDevelopmentMeasurement({...input,pages:{...input.pages,closedPages:3}});
 expect(inverted).toMatchObject({complete:false,pageEvents:{censusComplete:false,observedPages:2,closedPages:null,qualifiedCrashes:null}});
 expect(validateDevelopmentMeasurement(inverted,expected)).toBe(true);
});

it('binds development Docker to one fixed daemon and refuses config material or a name alias',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'aihr-dev-docker-model-'))),config=join(root,'docker-config');
 try{
  mkdirSync(config,{mode:0o700});
  expect(developmentDockerContext(root)).toEqual({
   args:['--config',config,'--host','unix:///var/run/docker.sock'],
   env:{PATH:'/usr/bin:/bin',HOME:root,LANG:'C',LC_ALL:'C',DOCKER_CONFIG:config,DOCKER_HOST:'unix:///var/run/docker.sock'},
  });
  writeFileSync(join(config,'config.json'),'{}');
  expect(()=>developmentDockerContext(root)).toThrow('configuration refused');
  rmSync(config,{recursive:true});
  const other=join(root,'other');mkdirSync(other,{mode:0o700});symlinkSync(other,config);
  expect(()=>developmentDockerContext(root)).toThrow('configuration refused');
 }finally{rmSync(root,{recursive:true,force:true});}
});

it('uses only a full creation receipt and separates reset, removal API and physical absence',()=>{
 const id='a'.repeat(64);
 expect(developmentPostgresBirthId(Buffer.from(id+'\n'))).toBe(id);
 for(const raw of [Buffer.from(id),Buffer.from(id+'\n'+id+'\n'),Buffer.from('f'.repeat(63)+'\n\n'),
  Buffer.from(id.toUpperCase()+'\n'),Buffer.from('aihr-ci-123-1-db-1\n')])
  expect(developmentPostgresBirthId(raw)).toBeNull();
 expect(developmentPostgresSettlement('unknown','settled',true)).toEqual({
  postgresReset:'unknown',postgresRemoveApi:'settled',postgresAbsent:null,postgres:'unknown',
 });
 expect(developmentPostgresSettlement('settled','settled',null)).toMatchObject({postgresAbsent:null,postgres:'unknown'});
 expect(developmentPostgresSettlement('settled','settled',false)).toMatchObject({postgresAbsent:false,postgres:'failed'});
 expect(developmentPostgresSettlement('failed','settled',true)).toMatchObject({postgresReset:'failed',postgresAbsent:true,postgres:'settled'});
 expect(developmentPostgresSettlement('settled','failed',true)).toMatchObject({postgresRemoveApi:'failed',postgresAbsent:null,postgres:'failed'});
});

it('requires the exact held stats observer identity and actual app visibility on every protected observation',()=>{
 const expected={pid:20,backendStart:'123.45',databaseOid:'54321'};
 const row={...expected,login:'ai_hr_workload_observer',role:'ai_hr_workload_observer',database:'ai_hr_test_w1',
  address:'127.0.0.1',port:5433,readOnly:'on',trackActivities:'on',canReadStats:true,invisibleAppSessions:0,
  appSessions:3,blockingAppSessions:1};
 expect(protectedLockObserverObservedCounts([row],expected)).toEqual({appSessions:3,blockingAppSessions:1});
 for(const change of [{pid:21},{backendStart:'124.45'},{databaseOid:'54322'},{database:'ai_hr_dev'},
  {role:'postgres'},{readOnly:'off'},{canReadStats:false},{trackActivities:'off'},{invisibleAppSessions:1}]){
  expect(()=>protectedLockObserverObservedCounts([{...row,...change}],expected)).toThrow('observer identity or visibility differed');
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
 expect(result.samples.map((row:{position:string})=>row.position)).toEqual(['opening','periodic','closing']);
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
  noteFailure:failures.notePrimary,noteSealFailure:(reason:unknown)=>failures.record('native-ingress-seal',reason)});
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
 const claims=createProtectedClaimCustody(vi.fn()),employmentId='00000000-0000-0000-0000-000000000001';
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
 const failures=createDriverFailures(),claims=createProtectedClaimCustody(vi.fn());
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

it('persists fixed private attempts and verification before effect and seals even with pending restoration',()=>{
 const employmentId='00000000-0000-0000-0000-000000000001',draft='00000000-0000-0000-0000-000000000002';
 const persist=vi.fn(),claims=createProtectedClaimCustody(persist);
 const claim=claims.register('http',{actorIndex:4,employmentId,marker:'PERF_HTTP_PREFLIGHT'});
 claim.begin('create');
 expect(persist).toHaveBeenNthCalledWith(1,{kind:'attempt',scope:'http',stage:'create',actorIndex:4,employmentId,
  marker:'PERF_HTTP_PREFLIGHT',draft:null,senderIndex:4});
 claim.verify('create',draft);
 expect(persist).toHaveBeenNthCalledWith(2,{kind:'verified',scope:'http',stage:'create',draft});
 claim.reserveRestore(draft);claim.begin('delete');
 expect(persist).toHaveBeenNthCalledWith(3,{kind:'attempt',scope:'http',stage:'delete',actorIndex:4,employmentId,
  marker:'PERF_HTTP_PREFLIGHT',draft,senderIndex:4});
 claims.seal();
 expect(persist).toHaveBeenNthCalledWith(4,{kind:'driver-sealed',entries:[{scope:'http',stage:'delete',disposition:'unconfirmed'}],ownerStopRequired:true});
 expect(()=>claim.verify('delete')).toThrow('mutation proof refused');
 expect(()=>claims.seal()).toThrow('already sealed');
 expect(claims.publicFacts()).toEqual([{scope:'http',stage:'delete',disposition:'unconfirmed'}]);
});

it('refuses Claims dispatch when private persistence fails and retains pending verification on write failure',()=>{
 const employmentId='00000000-0000-0000-0000-000000000001',draft='00000000-0000-0000-0000-000000000002';
 const failure=Error('private handoff failed'),persist=vi.fn(),dispatch=vi.fn();
 const claims=createProtectedClaimCustody(persist);
 const browser=claims.register('browser',{actorIndex:4,employmentId,marker:'PERF_BROWSER_DRAFT'});
 persist.mockImplementationOnce(()=>{throw failure;});
 expect(()=>{browser.begin('create');dispatch();}).toThrow(failure);
 expect(dispatch).not.toHaveBeenCalled();
 expect(browser.canRestore()).toBe(false);
 expect(()=>claims.seal()).toThrow('handoff already refused');
 expect(persist).toHaveBeenCalledTimes(1);
 expect(claims.publicFacts()).toEqual([{scope:'browser',stage:'create',disposition:'unconfirmed'}]);
 const otherWriter=vi.fn(),otherClaims=createProtectedClaimCustody(otherWriter);
 const http=otherClaims.register('http',{actorIndex:4,employmentId,marker:'PERF_HTTP_PREFLIGHT'});
 http.begin('create');
 otherWriter.mockImplementationOnce(()=>{throw failure;});
 expect(()=>http.verify('create',draft)).toThrow(failure);
 expect(http.canRestore()).toBe(false);
 expect(otherClaims.publicFacts()).toEqual([{scope:'http',stage:'create',disposition:'unconfirmed'}]);
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

it('withholds observer settlement when the dedicated measured lock pool cannot close',async()=>{
 const failures=createDriverFailures(),error=Error('measured lock pool refused');
 const audit={end:vi.fn()},observer={end:vi.fn()},measured={end:vi.fn().mockRejectedValue(error)};
 expect(await closePerformanceDbPools(audit,observer,failures,measured)).toEqual({audit:'settled',observer:'failed'});
 for(const pool of [audit,observer,measured])expect(pool.end).toHaveBeenCalledWith({timeout:5});
 expect(failures.privateFailures().secondary).toEqual([{stage:'measured-lock-pool-end',reason:error}]);
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
