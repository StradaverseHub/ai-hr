/** Lifetime helpers for the fixed development driver. Native handles stay with that driver. */
import {performance} from 'node:perf_hooks';
import {createGunzip} from 'node:zlib';

const knownCodes=new Set(['ERR_ASSERTION','ABORT_ERR','ECONNRESET','ETIMEDOUT','EPIPE','ERR_STREAM_PREMATURE_CLOSE',
 'Z_DATA_ERROR','Z_BUF_ERROR','57014','55P03','53300','08006','42501','23514','25P02','57P01']);
const knownNames=new Set(['Error','AssertionError','TimeoutError','AbortError','TypeError','AggregateError']);

export function driverErrorFact(reason){
 try{
  const {name,code}=reason??{};
  return {kind:knownNames.has(name)?name:'unclassified',code:knownCodes.has(code)?code:null};
 }catch{return {kind:'unclassified',code:null};}
}

export function createDriverFailures(){
 let primary={failed:false,reason:undefined};
 let signalFailure;
 const whenFailed=new Promise(resolve=>{signalFailure=resolve;});
 const secondary=[];
 const record=(stage,reason)=>{
  secondary.push({stage,reason});
  signalFailure();
  return {state:'failed',reason};
 };
 return {
  primary:()=>primary,
  whenFailed,
  notePrimary(reason){if(!primary.failed){primary={failed:true,reason};signalFailure();}},
  record,
  async attempt(stage,work){try{return {state:'settled',value:await work()};}catch(reason){return record(stage,reason);}},
  evidence(work){try{return {state:'settled',value:work()};}catch(reason){return record('evidence',reason);}},
  failed:()=>primary.failed||secondary.length>0,
  resourceFailed:()=>secondary.length>0,
  privateFailures:()=>({primary,secondary}),
  publicFailures:()=>({primary:primary.failed?driverErrorFact(primary.reason):null,
   secondary:secondary.map(({stage,reason})=>({stage,...driverErrorFact(reason)}))}),
 };
}

export function acquireDriverResource(states,name,make){
 try{const handle=make();states[name]='acquired';return handle;}
 catch(reason){states[name]='failed';throw reason;}
}

export function settleDriverResources(failures,{browser,https,database}){
 return Promise.all([
  failures.attempt('browser-settlement',browser),
  failures.attempt('https-settlement',https),
  failures.attempt('database-settlement',database),
 ]);
}

/** Register before a launch callback can start. Draining owns the real promises. */
export function createDriverWork(){
 const pending=new Set();
 let open=true;
 return {
  run(work){
   if(!open)throw Error('Driver work admission is closed');
   let resolve,reject;
   const running=new Promise((yes,no)=>{resolve=yes;reject=no;});
   pending.add(running);
   const settled=()=>pending.delete(running);
   void running.then(settled,settled);
   try{void Promise.resolve(work()).then(resolve,reject);}catch(reason){reject(reason);}
   return running;
  },
  seal(){open=false;},
  async drain(){while(pending.size)await Promise.allSettled([...pending]);},
 };
}

/** Preserve temporal failure order when replacing an early fail-fast join. */
export async function settleDriverLanes(values,run,failures){
 const results=await Promise.allSettled(values.map(async value=>{
  try{return await run(value);}catch(reason){failures.notePrimary(reason);throw reason;}
 }));
 if(results.some(result=>result.status==='rejected'))throw failures.primary().reason;
 return results;
}

export async function drainDriverLanes(lanes,requests){
 lanes.seal();
 await lanes.drain();
 requests.seal();
}

export function startDriverInterval(interval,run,recordFailure){
 let pending,stopped=false;
 const timer=setInterval(()=>{
  if(stopped||pending)return;
  pending=Promise.resolve().then(run).catch(recordFailure).finally(()=>{pending=undefined;});
 },interval);
 return {stop(){stopped=true;clearInterval(timer);return pending??Promise.resolve();}};
}

export function lockSampleEvidence(samples,window){
 const completed=samples.filter(sample=>sample.state==='complete');
 const qualified=window?completed.filter(sample=>sample.startedMs>=window.startMs&&sample.completedMs<=window.endMs):[];
 const failures=samples.length-completed.length;
 const observed=completed.filter(sample=>Number.isSafeInteger(sample.blockingAppSessions)&&sample.blockingAppSessions>=0);
 const invalidBlockingCounts=completed.length-observed.length;
 const blockingSamples=observed.filter(sample=>sample.blockingAppSessions>0).length;
 const coveragePass=qualified.length>0&&failures===0&&invalidBlockingCounts===0;
 return {window:window??null,completed:completed.length,qualified:qualified.length,failures,
  validEmpty:qualified.filter(sample=>sample.locks===0&&sample.blockingAppSessions===0).length,
  invalidBlockingCounts,blockingSamples,coveragePass,pass:coveragePass&&blockingSamples===0,samples};
}

const lockCadenceMs=Object.freeze({preflight:250,loaded:1000});
const maxProtectedLockSamples=4096;
const lockCount=value=>Number.isSafeInteger(value)&&value>=0;

export function protectedLockObserverCounts(row,expected){
 if(!row||!expected||!Number.isSafeInteger(expected.pid)||expected.pid<=1
  ||typeof expected.backendStart!=='string'||!/^\d+(?:\.\d+)?$/.test(expected.backendStart)
  ||typeof expected.databaseOid!=='string'||!/^[1-9]\d{0,9}$/.test(expected.databaseOid)
  ||row.pid!==expected.pid||row.backendStart!==expected.backendStart||row.databaseOid!==expected.databaseOid
  ||row.login!=='ai_hr_workload_observer'||row.role!==row.login||row.database!=='ai_hr_test_w1'
  ||row.address!=='127.0.0.1'||row.port!==5433||row.readOnly!=='on'||row.trackActivities!=='on'
  ||row.canReadStats!==true||row.invisibleAppSessions!==0){
  throw Error('Protected lock observer identity or visibility differed');
 }
 return {appSessions:row.appSessions,blockingAppSessions:row.blockingAppSessions};
}

export function createProtectedLockSampler({phase,deadline,observe,onFailure,now=()=>performance.now()}){
 const interval=Object.hasOwn(lockCadenceMs,phase)?lockCadenceMs[phase]:null;
 const origin=now(),cutoffUs=Math.floor((deadline-origin)*1000);
 if(interval===null||!Number.isSafeInteger(cutoffUs)||cutoffUs<=0)throw Error('Protected lock observation window refused');
 const sampleLimit=Math.min(maxProtectedLockSamples,Math.ceil(cutoffUs/(interval*1000))+2);
 const maxGapUs=interval*2000,stamp=()=>Math.floor((now()-origin)*1000);
 const samples=[];
 let state='not-started',startUs=null,endUs=null,timer,pending,closing,missedTicks=0,reason=null;

 function fail(code,error){
  if(reason!==null)return;
  reason=code;
  clearInterval(timer);
  onFailure(error);
 }
 function sample(position){
  if(samples.length>=sampleLimit){
   fail('sample-limit',Error('Protected lock sample bound exceeded'));
   return;
  }
  pending=Promise.resolve().then(async()=>{
   if((position==='opening'&&state!=='opening')||(position==='periodic'&&state!=='active'))return;
   const startedUs=stamp();
   if(!lockCount(startedUs)||startedUs>=cutoffUs){
    fail('deadline',Error('Protected lock observer deadline closed'));
    return;
   }
   let counts;
   try{
    counts=await observe();
   }catch(error){
    const completedUs=stamp();
    samples.push({position,startedUs,completedUs:lockCount(completedUs)&&completedUs>=startedUs?completedUs:null,state:'failed'});
    fail('observer-failed',error);
    return;
   }
   const completedUs=stamp();
   if(!lockCount(completedUs)||completedUs<startedUs||completedUs>=cutoffUs){
    samples.push({position,startedUs,completedUs:null,state:'failed'});
    fail('deadline',Error('Protected lock observer returned outside its window'));
    return;
   }
   const {appSessions,blockingAppSessions}=counts??{};
   if(!lockCount(appSessions)||!lockCount(blockingAppSessions)||blockingAppSessions>appSessions){
    samples.push({position,startedUs,completedUs,state:'failed'});
    fail('sample-invalid',Error('Protected lock observation counts refused'));
    return;
   }
   samples.push({position,startedUs,completedUs,state:'observed',appSessions,blockingAppSessions});
  }).finally(()=>{pending=undefined;});
  return pending;
 }

 function evidence(){
  const rows=Object.freeze(samples.map(row=>Object.freeze({...row}))),observed=rows.filter(row=>row.state==='observed');
  const observedBlockingSamples=observed.filter(row=>row.blockingAppSessions>0).length;
  const appObservedDuringWork=observed.some(row=>row.position==='periodic'&&row.appSessions>0
   &&row.startedUs>=startUs&&row.completedUs<=endUs);
  const ordered=observed.every((row,i)=>i===0||observed[i-1].completedUs<=row.startedUs);
  const observedGapUs=ordered&&observed.length>=2?Math.max(...observed.slice(1).map((row,i)=>row.completedUs-observed[i].startedUs)):null;
  const coveragePass=state==='sealed'&&reason===null&&ordered&&rows.length===observed.length&&appObservedDuringWork
   &&lockCount(startUs)&&lockCount(endUs)&&startUs<=endUs
   &&observed[0]?.position==='opening'&&observed[0].completedUs<=startUs
   &&observed.at(-1)?.position==='closing'&&endUs<=observed.at(-1).startedUs
   &&observedGapUs!==null&&observedGapUs<=maxGapUs;
  const coverageReason=state==='sealed'&&!coveragePass?(appObservedDuringWork?'coverage-gap':'app-unobserved'):null;
  return Object.freeze({phase,state:coveragePass?'complete':state==='not-started'?'not-started':'incomplete',reason:reason??coverageReason,
   intervalMs:interval,maxGapUs,observedGapUs,cutoffUs,sampleLimit,window:startUs===null?null:Object.freeze({startUs,endUs}),missedTicks,
   observedBlockingSamples,blockingSamples:coveragePass?observedBlockingSamples:null,coveragePass,
   pass:coveragePass&&observedBlockingSamples===0,samples:rows});
 }

 return {
  async start(){
   if(state!=='not-started')throw Error('Protected lock observation already started');
   state='opening';
   await sample('opening');
   if(reason!==null||state!=='opening')throw Error('Protected lock opening observation refused');
   if(samples[0].blockingAppSessions>0){
    const error=Error('Protected lock opening observation found blocking');
    fail('opening-blocking',error);
    throw error;
   }
   startUs=stamp();
   if(!lockCount(startUs)||startUs>=cutoffUs){
    const error=Error('Protected lock phase deadline closed before ingress');
    fail('deadline',error);
    throw error;
   }
   state='active';
   timer=setInterval(()=>{
    if(stamp()>=cutoffUs){fail('deadline',Error('Protected lock observer deadline closed'));return;}
    if(pending){missedTicks++;return;}
    void sample('periodic');
   },interval);
  },
  close(workSettled){
   if(closing)return closing;
   const active=state==='active';
   if(active)endUs=stamp();
   state='closing';
   clearInterval(timer);
   closing=(async()=>{
    await pending;
    if(active&&workSettled===true&&reason===null){
     await sample('closing');
     state='sealed';
    }else{
     reason??='work-incomplete';
     state='incomplete';
    }
    return evidence();
   })();
   return closing;
  },
  evidence,
 };
}

export function closedChromiumEnvironment(source,runnerHome){
 if(source.SELENIUM_REMOTE_URL)throw Error('Remote Chromium launch is outside the owned development driver');
 if(typeof runnerHome!=='string'||!runnerHome.startsWith('/'))throw Error('Runner account home is unavailable');
 const env={PATH:'/usr/bin:/bin',HOME:runnerHome,LANG:'C.UTF-8',LC_ALL:'C.UTF-8'};
 if(source.TZ!==undefined){
  if(source.TZ!=='UTC'&&source.TZ!=='Asia/Kuala_Lumpur')throw Error('Unsupported Chromium time zone');
  env.TZ=source.TZ;
 }
 return env;
}

export function createDriverContexts(failures){
 const entries=new Map();
 const register=context=>{
  if(!entries.has(context))entries.set(context,{state:'acquired',pending:null});
  return context;
 };
 const close=context=>{
  register(context);
  const entry=entries.get(context);
  if(!entry.pending){
   entry.state='attempted';
   let settle;
   entry.pending=new Promise(resolve=>{settle=resolve;});
   void failures.attempt('context-close',()=>context.close()).then(outcome=>{
    entry.state=outcome.state;
    settle(outcome);
   });
  }
  return entry.pending;
 };
 // A failed lifetime may release the lane's wait, while the registry still
 // owns the native close promise and the final browser sweep still awaits it.
 const waitForClose=context=>Promise.race([close(context),failures.whenFailed]);
 const withContext=async(context,work)=>{
  try{return await work();}
  catch(reason){failures.notePrimary(reason);throw reason;}
  finally{await waitForClose(context);}
 };
 return {register,close,waitForClose,withContext,
  hasPendingClose:()=>[...entries.values()].some(entry=>entry.state==='attempted'),
  closeAll:()=>Promise.all([...entries.keys()].map(close)),summary:()=>{
  const counts={acquired:entries.size,attempted:0,settled:0,failed:0};
  for(const entry of entries.values()){
   if(entry.pending)counts.attempted++;
   if(entry.state==='settled'||entry.state==='failed')counts[entry.state]++;
  }
  return counts;
 }};
}

export function observeDriverBrowser(browser,failures){
 let expectedClose=false,unexpectedDisconnect=false;
 const checkDisconnect=()=>{
  if(expectedClose||unexpectedDisconnect)return;
  unexpectedDisconnect=true;
  failures.record('browser-disconnected',Error('Owned Chromium disconnected before its close attempt'));
 };
 browser.once('disconnected',checkDisconnect);
 if(!browser.isConnected())checkDisconnect();
 return {unexpectedDisconnect:()=>unexpectedDisconnect,async close(){
  try{if(!browser.isConnected())checkDisconnect();}
  catch(reason){failures.record('browser-connection-state',reason);}
  expectedClose=true;
  return failures.attempt('browser-close',()=>browser.close());
 }};
}

export async function settleDriverBrowser(browser,owned,contexts,failures){
 try{for(const context of browser?.contexts()??[])contexts.register(context);}
 catch(reason){failures.record('context-inventory',reason);}
 // Initiate every outstanding context attempt before the browser close. The two
 // promises settle independently, even if a context close needs the browser to exit.
 const contextDrain=contexts.closeAll();
 const browserClose=owned?owned.close():browser?failures.attempt('browser-close',()=>browser.close()):Promise.resolve({state:'absent'});
 const [,result]=await Promise.all([contextDrain,browserClose]);
 return {close:result.state,unexpectedDisconnect:owned?.unexpectedDisconnect()??false,contexts:contexts.summary()};
}

/** Only the real sockets assigned to this driver's one agent, including keep-alive reuse. */
export function createDriverSockets(failures){
 const seen=new WeakSet(),live=new Map();
 let assigned=0,closed=0,closing=false;
 const bind=socket=>{
  if(seen.has(socket))return;
  seen.add(socket);assigned++;
  let finish;
  const pending=new Promise(resolve=>{finish=resolve;});
  live.set(socket,pending);
  socket.once('close',()=>{live.delete(socket);closed++;finish();});
 };
 const observe=socket=>{
  bind(socket);
  if(closing){
   failures.record('late-socket',Error('A socket was assigned after agent shutdown began'));
   failures.evidence(()=>socket.destroy());
  }
 };
 return {observe,summary:()=>({assigned,closed,pending:live.size}),async closeAgent(agent){
  closing=true;
  const queued=Object.values(agent.requests).flat();
  if(queued.length){
   failures.record('agent-queue',Error('Owned HTTPS requests were still queued at shutdown'));
   for(const request of queued)await failures.attempt('request-destroy',()=>request.destroy());
  }
  for(const socket of [...Object.values(agent.sockets).flat(),...Object.values(agent.freeSockets).flat()])bind(socket);
  const outcome=await failures.attempt('agent-destroy',()=>agent.destroy());
  if(outcome.state==='failed')await Promise.all([...live.keys()].map(socket=>failures.attempt('socket-destroy',()=>socket.destroy())));
  while(live.size)await Promise.all([...live.values()]);
  return {state:outcome.state,queued:queued.length,assigned,closed,pending:live.size};
 }};
}

/** Distinct body result and native terminal promises keep latency and teardown separate. */
export function openDriverResponse({start,body,startedMs,onHeaders,observeSocket,recordFailure}){
 let request,response,decoder,requestClosed=false,responseClosed=true,decoderClosed=true;
 let finished=false,failed=false,decodedEnded=false,resolveResult,rejectResult,resolveTerminal;
 const result=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
 const terminal=new Promise(resolve=>{resolveTerminal=resolve;});
 const settle=()=>{if(requestClosed&&responseClosed&&decoderClosed)resolveTerminal();};
 const premature=()=>Object.assign(Error('Owned HTTP transport closed before its response completed'),{code:'ERR_STREAM_PREMATURE_CLOSE'});
 const fail=reason=>{
  if(failed)return;
  failed=true;
  if(finished)recordFailure('http-late-failure',reason);
  else{finished=true;rejectResult(reason);}
  for(const handle of [decoder,response,request]){
   if(!handle)continue;
   try{handle.destroy();}catch(error){recordFailure('request-destroy',error);}
  }
 };
 const accept=res=>{
  response=res;responseClosed=false;
  res.on('error',fail);
  res.once('aborted',()=>fail(premature()));
  res.once('close',()=>{responseClosed=true;if(!res.complete)fail(premature());settle();});
  if(failed){
   try{res.destroy();}catch(error){recordFailure('request-destroy',error);}
   return;
  }
  try{
   let wireBytes=0,decodedBytes=0,content='';
   const ttfbMs=performance.now()-startedMs;
   onHeaders(res,ttfbMs);
   res.on('data',chunk=>{wireBytes+=chunk.length;});
   if(res.headers['content-encoding']==='gzip'){
    decoder=createGunzip();decoderClosed=false;
    decoder.on('error',fail);
    decoder.once('close',()=>{decoderClosed=true;if(!decodedEnded)fail(premature());settle();});
   }
   const stream=decoder??res;
   stream.on('data',chunk=>{
    if(failed)return;
    decodedBytes+=chunk.length;
    if(decodedBytes>12*1024*1024){fail(Error('Decoded response exceeded the 12MiB measurement ceiling'));return;}
    content+=chunk.toString();
   });
   stream.once('end',()=>{
    decodedEnded=true;
    if(finished)return;
    finished=true;
    resolveResult({status:res.statusCode,headers:res.headers,content,wireBytes,decodedBytes,ttfbMs});
   });
   if(decoder)res.pipe(decoder);
  }catch(reason){fail(reason);}
 };
 try{
  request=start();
  request.on('error',fail);
  request.once('response',accept);
  request.once('close',()=>{requestClosed=true;if(!response)fail(premature());settle();});
  request.once('socket',observeSocket);
  if(request.socket)observeSocket(request.socket);
  request.end(body);
 }catch(reason){
  if(!request)requestClosed=true;
  fail(reason);settle();
 }
 return {result,terminal};
}

/** Independent five-second API attempts after the exact driver DB work is drained. */
export async function closePerformanceDbPools(nativeAuditClient,driver,failures){
 const close=(client,stage)=>client?failures.attempt(stage,()=>client.end({timeout:5})):Promise.resolve({state:'absent'});
 const [audit,observer]=await Promise.all([close(nativeAuditClient,'audit-pool-end'),close(driver,'observer-pool-end')]);
 return {audit:audit.state,observer:observer.state};
}

/** tsx can expose destructured TS exports through CommonJS default on the hosted Node runtime. */
export function performanceNativeDbClient(module){
 const client=module.client??module.default?.client;
 if(!client||typeof client.end!=='function')throw Error('Canonical native database client export unavailable');
 return client;
}
