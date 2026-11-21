import {expect,it} from 'vitest';
import {once} from 'node:events';
import {Worker} from 'node:worker_threads';
import {developmentPostgresLockWindow,postgresLockFailures} from '../scripts/performance/lock-failure-log.mjs';
import {createMeasuredPreflightAttribution,createPreflightLockWorkload,firstAppLockWaitCategories,measuredPreflightAttribution,mergeAdvisoryEdges,observeSampledAdvisoryBlockers,originalAdvisoryAttribution} from '../scripts/performance/lock-sample-attribution.mjs';
import {lockSampleEvidence,qualifyLockSampleCadence} from '../scripts/performance/driver-shutdown.mjs';
import {measuredClockIdentity,measuredNativeBracket} from '../scripts/performance/measured-lock-clock.mjs';
import {createMeasuredPreflightObserver,observeMeasuredPreflightLockConnection,startMeasuredPreflightProbes} from '../scripts/performance/measured-lock-observer.mjs';

const fictionalWaiter={app_session:true,pid:22,classid:'11',objid:'12',objsubid:1,mode:'ExclusiveLock',blockers:[84]};
const fictionalBlocker={family:'access-configuration',waiterMode:'ExclusiveLock',blockerMode:'ShareLock',blockerState:'granted',
 waiterCategory:'advisory-exclusive',blockerCategory:'rewards-library'};

it('attributes only an unchanged closed workload during the two original probes',async()=>{
 const owner=createPreflightLockWorkload(),outside=owner.snapshot();
 expect(owner.stageAfter(outside)).toBeNull();
 let finish!:()=>void;
 const held=new Promise<void>(resolve=>{finish=resolve;});
 await owner.within('mixed-workflows',async()=>{
  const beforePair=owner.snapshot();
  const concurrent=owner.within('payroll-close-pair',()=>Promise.allSettled([held,held]));
  const withinPair=owner.snapshot();
  expect(owner.stageAfter(withinPair)).toBe('payroll-close-pair');
  expect(owner.stageAfter(beforePair)).toBe('transition');
  finish();
  await expect(concurrent).resolves.toEqual([{status:'fulfilled',value:undefined},{status:'fulfilled',value:undefined}]);
  expect(owner.stageAfter(owner.snapshot())).toBe('mixed-workflows');
  expect(owner.stageAfter(beforePair)).toBe('transition');
  await expect(owner.within('letter-draft',async()=>{throw Error('owned action failed');})).rejects.toThrow('owned action failed');
  expect(owner.stageAfter(owner.snapshot())).toBe('mixed-workflows');
  const stable=owner.snapshot();
  await owner.within('private actor or route',async()=>expect(owner.stageAfter(stable)).toBe('mixed-workflows'));
  expect(owner.stageAfter(stable)).toBe('mixed-workflows');
 });
 expect(owner.stageAfter(outside)).toBe('transition');
 expect(owner.stageAfter(owner.snapshot())).toBeNull();
});

it('preserves cross-thread workload boundaries even if a nested stage came and went',async()=>{
 const owner=createMeasuredPreflightAttribution();
 const workload=createPreflightLockWorkload(owner.setWorkload),stamp=()=>Atomics.load(owner.token,0);
 const pilot=stamp();
 owner.setPhase('browser-workflows');
 expect(measuredPreflightAttribution(pilot,stamp())).toEqual({phase:'transition',workloadStage:null});
 await workload.within('personnel-profile',async()=>{
  const initial=stamp();
  expect(measuredPreflightAttribution(initial,initial)).toEqual({phase:'browser-workflows',workloadStage:'personnel-profile'});
  await workload.within('letter-draft',async()=>undefined);
  expect(measuredPreflightAttribution(initial,stamp())).toEqual({phase:'browser-workflows',workloadStage:'transition'});
 });
 expect(measuredPreflightAttribution(stamp(),stamp())).toEqual({phase:'browser-workflows',workloadStage:null});
 expect(measuredPreflightAttribution(undefined,stamp())).toEqual({phase:'transition',workloadStage:null});
});

it('refuses a database other than the fixed fictional development observer before creating a Worker',()=>{
 const inputs={bootIdentity:"unused",accessLocks:[],categorized:true,token:createMeasuredPreflightAttribution().token,onProbe:()=>{},onFailure:()=>{}};
 for(const url of ['postgres://postgres@127.0.0.1:5433/ai_hr_test','postgres://postgres:secret@127.0.0.1:5433/ai_hr_dev',
  'postgres://postgres@localhost:5433/ai_hr_dev','postgres://postgres@127.0.0.1:5433/ai_hr_dev?application_name=other']){
  expect(()=>createMeasuredPreflightObserver({url,...inputs})).toThrow('Measured preflight lock observer database refused');
 }
});

it.each([false,true])('uses one actual worker round trip per sample when the probe itself is slow=%s',async slowProbe=>{
 const control=new Int32Array(new SharedArrayBuffer(3*Int32Array.BYTES_PER_ELEMENT));
 const token=createMeasuredPreflightAttribution().token;
 const moduleUrl=new URL('../scripts/performance/measured-lock-observer.mjs',import.meta.url).href;
 const source=`import {parentPort,workerData} from 'node:worker_threads';
  import {setTimeout as delay} from 'node:timers/promises';
  import {startMeasuredPreflightProbes} from ${JSON.stringify(moduleUrl)};
  const {control,token,slowProbe}=workerData;
  let attempts=0,sampler,probeOpen=false;
  const sql=(parts)=>{
   const query=parts.join(' ');
   if(query.includes('jsonb_build_object'))return 'categories';
   if(query.startsWith('concat(l.classid'))return 'audit-keys';
   if(query.includes('backends as materialized')&&query.includes('from pg_stat_activity where')
    &&query.includes('advisory as materialized')&&query.includes('from pg_locks')&&query.includes('limit 40')){
    if(probeOpen)throw Error('Concurrent native probe');
    probeOpen=true;
    return (async()=>{
     if(++attempts===2&&slowProbe){parentPort.postMessage({secondStarted:true});await delay(550);}
     probeOpen=false;
     return [{activity:[{state:'active',kind:'CPU-or-ready',connections:1,app_connections:1,
      app_lock_wait_kinds:{advisory:0,transactionid:0,tuple:0,relation:0,other:1}}],locks:[],opened:'1.00 0.00'+String.fromCharCode(10),closed:'1.00 0.00'+String.fromCharCode(10)}];
    })();
   }
   throw Error('Unexpected probe SQL');
  };
  parentPort.on('message',async command=>{
   if(command==='start')sampler=startMeasuredPreflightProbes({sql,backendPids:[1],readClockCs:()=>100,accessLocks:[],categorized:true,token,stopped:control,
    onProbe(probe){Atomics.add(control,1,1);parentPort.postMessage(probe);},onFailure(reason){throw reason;}});
   else{await sampler.stop();if(probeOpen||attempts!==sampler.samples())throw Error('Native probe was not drained once');parentPort.close();}
  });
  parentPort.postMessage({ready:true,timeOrigin:performance.timeOrigin});`;
 const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(source)),{execArgv:[],workerData:{control,token,slowProbe}});
 const exited=once(worker,'exit');void exited.catch(()=>{});
 const first=Promise.withResolvers<void>(),second=Promise.withResolvers<void>(),secondStarted=Promise.withResolvers<void>();
 const samples:{state:string;startedMs:number;completedMs:number;locks:number;blockingAppSessions:number}[]=[];
 const receipts:Record<string,unknown>[]=[];
 worker.on('message',probe=>{
  if(probe.ready)return;
  if(probe.secondStarted){secondStarted.resolve();return;}
  receipts.push(probe);
  samples.push({state:probe.failure?'failed':'complete',startedMs:probe.startedMs,completedMs:probe.coreCompletedMs,
   locks:probe.locks?.length??0,blockingAppSessions:0});
  if(probe.sequence===1)first.resolve();
  if(probe.sequence===2)second.resolve();
 });
 try{
  const [ready]=await once(worker,'message');
  expect(ready).toEqual({ready:true,timeOrigin:performance.timeOrigin});
  const startMs=performance.now();
  worker.postMessage('start');
  await first.promise;
  const stop=()=>{Atomics.store(control,0,1);worker.postMessage('stop');};
  if(slowProbe){await secondStarted.promise;stop();await second.promise;}
  else{
   expect(Atomics.wait(control,2,0,620)).toBe('timed-out');
   expect(samples).toHaveLength(1); // Native observations were made before their messages could run here.
   expect(Atomics.load(control,1)).toBeGreaterThanOrEqual(4);
  }
  const endMs=performance.now();
  if(!slowProbe)stop();
  await expect(exited).resolves.toEqual([0]);
  expect(samples.length).toBe(Atomics.load(control,1));
  expect(receipts.every(row=>row.probeMode==='combined-statement'&&!Object.hasOwn(row,'activityCompletedMs')
   &&!Object.hasOwn(row,'advisoryStartedMs'))).toBe(true);
  expect(qualifyLockSampleCadence('preflight',samples,{startMs,endMs})).toMatchObject({
   maxGapUs:500000,coveragePass:!slowProbe,pass:!slowProbe,reason:slowProbe?'coverage-gap':null,
  });
 }finally{await worker.terminate();}
});

it('executes the same combined probe once on each owned connection and drains a delayed primary',async()=>{
 const control=new Int32Array(new SharedArrayBuffer(3*Int32Array.BYTES_PER_ELEMENT));
 const token=createMeasuredPreflightAttribution().token;
 const moduleUrl=new URL('../scripts/performance/measured-lock-observer.mjs',import.meta.url).href;
 const source=`import {parentPort,workerData} from 'node:worker_threads';
  import {setTimeout as delay} from 'node:timers/promises';
  import {startMeasuredPreflightProbes} from ${JSON.stringify(moduleUrl)};
  const {control,token}=workerData;
  let sampler;
  const makeSql=lane=>parts=>{
   const query=parts.join(' ');
   if(query.includes('jsonb_build_object'))return 'categories';
   if(query.startsWith('concat(l.classid'))return 'audit-keys';
   if(!query.includes('backends as materialized')||!query.includes('from pg_locks'))throw Error('Unexpected native query');
   if(Atomics.add(control,lane,1)!==0)throw Error('Repeated native query after fixture settlement');
   return (async()=>{
    if(lane===1)await delay(400);
    return [{activity:[{state:'active',kind:'CPU-or-ready',connections:lane,app_connections:1,
     app_lock_wait_kinds:{advisory:0,transactionid:0,tuple:0,relation:0,other:1}}],locks:[],opened:'1.00 0.00'+String.fromCharCode(10),closed:'1.00 0.00'+String.fromCharCode(10)}];
   })();
  };
  parentPort.on('message',async command=>{
   if(command==='start')sampler=startMeasuredPreflightProbes({sql:makeSql(1),rescueSql:makeSql(2),backendPids:[1,2],readClockCs:()=>100,accessLocks:[],categorized:true,token,stopped:control,
    onProbe(probe){
     if(probe.activity?.[0]?.connections===2)Atomics.store(control,0,1);
     parentPort.postMessage(probe);
    },onFailure(reason){throw reason;}});
   else{
    await sampler.stop();
    if(sampler.samples()!==2)throw Error('Both native probes must drain');
    parentPort.close();
   }
  });
  parentPort.postMessage({ready:true});`;
 const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(source)),{execArgv:[],workerData:{control,token}});
 const exited=once(worker,'exit');void exited.catch(()=>{});
 try{
  const [ready]=await once(worker,'message');
  expect(ready).toEqual({ready:true});
  const receipts:{activity:{connections:number}[];sequence:number;startedMs:number;coreCompletedMs:number}[]=[];
  const first=Promise.withResolvers<void>();
  worker.on('message',probe=>{receipts.push(probe);first.resolve();});
  worker.postMessage('start');
  await first.promise;
  worker.postMessage('stop');
  await expect(exited).resolves.toEqual([0]);
  expect(receipts).toHaveLength(2);
  const [rescue,primary]=receipts;
  expect([rescue.activity[0].connections,primary.activity[0].connections]).toEqual([2,1]);
  expect([rescue.sequence,primary.sequence]).toEqual([1,2]);
  expect(primary.startedMs).toBeLessThan(rescue.startedMs);
  expect(rescue.coreCompletedMs).toBeLessThan(primary.coreCompletedMs);
  expect([Atomics.load(control,1),Atomics.load(control,2)]).toEqual([1,1]);
 }finally{await worker.terminate();}
});

it('fails closed on malformed native activity partitions or advisory rows',async()=>{
 const activity={state:'active',kind:'Lock',connections:1,app_connections:1,
  app_lock_wait_kinds:{advisory:1,transactionid:0,tuple:0,relation:0,other:0}};
 const waiter={...fictionalWaiter,granted:false,category:'unknown'};
 const inputs=[
  {activity:[{...activity,app_connections:0}],locks:[]},
  {activity:[activity],locks:[{...waiter,query:'never a projected field'}]},
  {activity:[],locks:[]},
  {activity:[activity],locks:[{...waiter,blockers:[-1]}]},
  {activity:[activity],locks:[{...fictionalWaiter,granted:false}]},
  {activity:[activity],locks:[{...waiter,category:'private query'}]},
  {activity:[activity],locks:[waiter]},
 ];
 const observed:Record<string,unknown>[]=[];
 const done=Promise.withResolvers<void>();
 let queries=0;
 const sampler=startMeasuredPreflightProbes({backendPids:[1],readClockCs:()=>100,accessLocks:[],categorized:true,
  token:createMeasuredPreflightAttribution().token,stopped:new Int32Array(new SharedArrayBuffer(4)),
  sql(parts:TemplateStringsArray){return parts.join('').includes('backends as materialized')?Promise.resolve([
   {...inputs[queries++],opened:'1.00 0.00\n',closed:'1.00 0.00\n'},
  ]):'categories';},
  onProbe(probe:Record<string,unknown>){observed.push(probe);if(observed.length===inputs.length)done.resolve();},onFailure:done.reject});
 try{await done.promise;}finally{await sampler.stop();}
 expect(queries).toBe(inputs.length);
 expect(observed.slice(0,-3).every(row=>Object.hasOwn(row,'failure')&&!Object.hasOwn(row,'activity')&&!Object.hasOwn(row,'locks'))).toBe(true);
 for(const probe of observed.slice(-3)){
  expect(probe).toMatchObject({probeMode:'combined-statement',activity:[activity],locks:[waiter]});
 }
});

it('refuses a different boot, nonzero clock offset, or replacement of the attested backend',async()=>{
 const boot='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\n';
 const offsets='monotonic 0 0\nboottime 0 0\n';
 const connection=(clock:{pid:number;boot:string;offsets:string})=>async(parts:TemplateStringsArray)=>
  parts.join('').includes('transaction_read_only')?[{readonly:true,bounded:true,pid:5}]:[clock];
 expect(measuredClockIdentity(boot,offsets)).toBe(boot);
 await expect(observeMeasuredPreflightLockConnection(connection({pid:5,boot,offsets}),boot)).resolves.toBe(5);
 await expect(observeMeasuredPreflightLockConnection(connection({pid:6,boot,offsets}),boot)).rejects.toThrow('backend refused');
 await expect(observeMeasuredPreflightLockConnection(connection({pid:5,boot:boot.replace('a','b'),offsets}),boot)).rejects.toThrow('backend refused');
 await expect(observeMeasuredPreflightLockConnection(connection({pid:5,boot,offsets:offsets.replace('boottime 0','boottime 37')}),boot))
  .rejects.toThrow('clock identity refused');
 expect(()=>measuredClockIdentity(boot+'\n',offsets)).toThrow('clock identity refused');
});

it('keeps the original positive on a malformed or causally impossible native clock bracket',async()=>{
 const activity=[{state:'active',kind:'Lock',connections:1,app_connections:1,
  app_lock_wait_kinds:{advisory:1,transactionid:0,tuple:0,relation:0,other:0}}];
 const read='1.00 0.00\n';
 expect(measuredNativeBracket(read,read,100,100)).toEqual({nativeOpenedCs:100,nativeClosedCs:100});
 expect(()=>measuredNativeBracket(read,read,101,101)).toThrow('clock bracket refused');
 expect(()=>measuredNativeBracket(read,read+'\n',100,100)).toThrow('clock reading refused');
 const done=Promise.withResolvers<Record<string,unknown>>();
 const stopped=new Int32Array(new SharedArrayBuffer(4));
 const sampler=startMeasuredPreflightProbes({backendPids:[5],readClockCs:()=>100,accessLocks:[],categorized:true,
  token:createMeasuredPreflightAttribution().token,stopped,
  sql(parts:TemplateStringsArray,...args:unknown[]){
   if(!parts.join('').includes('with opened as materialized'))return 'fragment';
   expect(args[0]).toBe(5);
   return Promise.resolve([{activity,locks:[],opened:read,closed:'0.99 0.00\n'}]);
  },
  onProbe(probe:Record<string,unknown>){Atomics.store(stopped,0,1);done.resolve(probe);},onFailure:done.reject});
 try{
  const observed=await done.promise;
  expect(observed).toMatchObject({probeMode:'combined-statement',activity,locks:[]});
  expect(observed).not.toHaveProperty('nativeOpenedCs');
  expect(observed).not.toHaveProperty('nativeClosedCs');
 }finally{await sampler.stop();}
});

it('partitions only the first probe and preserves an original positive on refused category evidence',()=>{
 const categories={advisory:1,transactionid:2,tuple:0,relation:1,other:1};
 const row={state:'active',kind:'Lock',app_connections:5,app_lock_wait_kinds:categories};
 const ignored={...row,state:'idle',app_connections:17};
 expect(firstAppLockWaitCategories([ignored,row],5)).toEqual(categories);
 const sample={state:'complete',startedMs:1,completedMs:2,locks:0,blockingAppSessions:5};
 const variants=[
  {...categories,rawWaitEvent:'fictional secret'}, {...categories,advisory:true},
  {...categories,other:0}, {...categories,other:6}, {...categories,other:-1},
  {...categories,tuple:0.5}, {advisory:1,transactionid:2,tuple:0,relation:1,unknown:1}, null,
 ];
 for(const malformed of variants){
  expect(firstAppLockWaitCategories([{...row,app_lock_wait_kinds:malformed}],5)).toBeNull();
  expect(lockSampleEvidence([sample],{startMs:0,endMs:3})).toMatchObject({blockingSamples:1,pass:false});
 }
 expect(firstAppLockWaitCategories([row,row],5)).toBeNull();
 expect(firstAppLockWaitCategories([ignored],5)).toBeNull();
 expect(firstAppLockWaitCategories([row],0)).toBeNull();
 expect(firstAppLockWaitCategories([row],1025)).toBeNull();
});

it('attributes only app waiters and emits closed blocker facts without native identities',async()=>{
 const inputs:unknown[][]=[];
 const query=async (_text:TemplateStringsArray,...values:unknown[])=>{
  inputs.push(values);
  return [{...fictionalBlocker,pid:84,key:'private-key',query:'private SQL'}];
 };
 const edges=await observeSampledAdvisoryBlockers(query,[fictionalWaiter,{...fictionalWaiter,app_session:false,pid:83}],new Map([['11:12:1','access-configuration:fixture-tenant-0']]));
 expect(inputs).toEqual([[JSON.stringify([{pid:22,key:'11:12:1',mode:'ExclusiveLock',family:'access-configuration',blockers:[84]}]),8]]);
 expect(edges).toEqual([{source:'recheck',...fictionalBlocker}]);
});

it('retains original app waiter and exclusive blocker facts after an expired recheck',async()=>{
 const waiter={...fictionalWaiter,granted:false,mode:'ShareLock'};
 const blocker={...waiter,app_session:false,pid:84,granted:true,mode:'ExclusiveLock',query:'private SQL'};
 const labels=new Map([['11:12:1','access-configuration:fixture-tenant-0']]);
 const snapshot=originalAdvisoryAttribution([waiter,{...blocker,objid:'wrong-lock'},blocker],labels);
 expect(snapshot).toEqual({waiters:[{family:'access-configuration',mode:'ShareLock'}],edges:[{
  source:'original-sample',family:'access-configuration',waiterMode:'ShareLock',blockerMode:'ExclusiveLock',blockerState:'granted',
  waiterCategory:'unknown',blockerCategory:'unknown',
 }]});
 const expired=await observeSampledAdvisoryBlockers(async()=>[],[waiter],labels);
 expect(mergeAdvisoryEdges(snapshot.edges,expired)).toEqual(snapshot.edges);
 const enriched=await observeSampledAdvisoryBlockers(async()=>[{...fictionalBlocker,waiterMode:'ShareLock',blockerMode:'ExclusiveLock'}],[waiter],labels);
 expect(mergeAdvisoryEdges(snapshot.edges,enriched)).toMatchObject([{source:'original-sample'},{source:'recheck'}]);
 expect(originalAdvisoryAttribution([waiter],labels)).toEqual({waiters:snapshot.waiters,edges:null});
});

it('attributes closed original audit statements only on the same observed advisory resource',()=>{
 const waiter={...fictionalWaiter,granted:false,category:'auth-audit-append'};
 const holder={...waiter,pid:84,granted:true,blockers:null,category:'rewards-access-observe',query:'private SQL'};
 const labels=new Map([['11:12:1','audit-chain:fixture-tenant-0']]);
 expect(originalAdvisoryAttribution([waiter,{...holder,objid:'wrong-key'},holder],labels)).toEqual({
  waiters:[{family:'audit-chain',mode:'ExclusiveLock',category:'auth-audit-append'}],
  edges:[{source:'original-sample',family:'audit-chain',waiterMode:'ExclusiveLock',blockerMode:'ExclusiveLock',blockerState:'granted',
   waiterCategory:'auth-audit-append',blockerCategory:'rewards-access-observe'}],
 });
 expect(originalAdvisoryAttribution([{...waiter,category:'private SQL'},{...holder,category:'audit-append'}],labels)).toMatchObject({
  waiters:[{family:'audit-chain',mode:'ExclusiveLock'}],
  edges:[{waiterCategory:'unknown',blockerCategory:'audit-append'}],
 });
 expect(originalAdvisoryAttribution([waiter,holder],new Map([['11:12:1','access-configuration:fixture-tenant-0']]))).toMatchObject({
  edges:[{waiterCategory:'unknown',blockerCategory:'unknown'}],
 });
 expect(originalAdvisoryAttribution([waiter,{...holder,objid:'wrong-key'}],labels).edges).toBeNull();
});

it('keeps the positive lock gate when attribution refuses, disappears or overruns its bound',async()=>{
 const sample={state:'complete',startedMs:1,completedMs:2,locks:1,blockingAppSessions:1};
 const window={startMs:0,endMs:3};
 const queries=[async()=>{throw Error('private diagnostic failure');},async()=>[],
  async()=>[{...fictionalBlocker,blockerCategory:'private category'}],async()=>Array(9).fill(fictionalBlocker)];
 for(const query of queries){
  expect(await observeSampledAdvisoryBlockers(query,[fictionalWaiter],new Map())).toBeNull();
  expect(lockSampleEvidence([sample],window)).toMatchObject({coveragePass:true,blockingSamples:1,pass:false});
 }
});
it('keeps bounded lock graphs and routine names while excluding SQL, values and unknown errors',()=>{
 const log=`2026-11-04 14:00:00.000 +08 [98] ERROR:  deadlock detected
2026-11-04 14:00:00.000 +08 [98] DETAIL:  Process 98 waits for ExclusiveLock on advisory lock [1, 2, 3, 1]; blocked by process 99.
 Process 99 waits for ShareLock on transaction 1234; blocked by process 98.
 CONTEXT: SQL statement "SELECT 'private-value@example.invalid', 'postgres://hidden-password@host/db'"
 PL/pgSQL function app.access_configuration_write_lock() line 5 at PERFORM
 STATEMENT: update person set full_name='Private fixture value';
2026-11-04 14:00:01.000 +08 [99] ERROR: canceling statement due to lock timeout
 CONTEXT: while locking tuple (1,2) in relation "private-row-value"
 PL/pgSQL function app.native_employee_draft_discard_delete(uuid) line 8 at SQL statement
 STATEMENT: SELECT 'private-token'
2026-11-04 14:00:02.000 +08 [100] ERROR: other error with private payload
`;
 const failures=postgresLockFailures(log);
 expect(failures).toEqual([
  {kind:'deadlock detected',pid:98,waits:[{pid:98,mode:'ExclusiveLock',lock:'advisory lock [1, 2, 3, 1]',blockedBy:99},{pid:99,mode:'ShareLock',lock:'transaction 1234',blockedBy:98}],routines:[{function:'app.access_configuration_write_lock()',line:5,operation:'PERFORM'}]},
  {kind:'canceling statement due to lock timeout',pid:99,waits:[],routines:[{function:'app.native_employee_draft_discard_delete(uuid)',line:8,operation:'SQL statement'}]},
 ]);
 expect(JSON.stringify(failures)).not.toMatch(/private|hidden-password|SELECT|update person/);
 expect(postgresLockFailures(Array.from({length:100},()=>log).join('\n'))).toHaveLength(64);
});

it('recognizes a still-blocked, acquired or failed heavyweight wait without retaining lock objects',()=>{
 const log=`2026-11-09 14:00:00.000 +08 [98] abcdef01.62 ai_hr_app@ai_hr_dev LOG:  process 98 still waiting for ShareLock on transaction 1234 after 1000.070 ms
2026-11-09 14:00:00.000 +08 [98] DETAIL:  Process holding the lock: 99. Wait queue: 98.
2026-11-09 14:00:00.250 +08 [98] abcdef01.62 ai_hr_app@ai_hr_dev LOG:  process 98 acquired ShareLock on transaction 1234 after 1250.070 ms
2026-11-09 14:00:01.000 +08 [99] LOG:  process 99 failed to acquire AccessExclusiveLock on relation 5000 of database 321 after 1000.115 ms
2026-11-09 14:00:01.000 +08 [100] STATEMENT:  process 100 acquired ShareLock on transaction 9999 after 1001.123 ms
2026-11-09 14:00:01.000 +08 [100] LOG:  process 999 acquired ShareLock on transaction 9999 after 1001.123 ms
2026-11-09 14:00:01.000 +08 [100] abcdef01.63 ai_hr_app@ai_hr_dev LOG:  process 100 acquired ShareLock on transaction 9999 after 1001.123 ms
2026-11-09 14:00:02.000 +08 [101] abcdef01.65 @ LOG:  process 101 avoided deadlock for ExclusiveLock on transaction 9999 by rearranging queue order after 1002.444 ms`;
 const failures=postgresLockFailures(log);
 expect(failures).toEqual([
  {kind:'observed heavyweight lock wait',pid:98,outcome:'still waiting for',mode:'ShareLock',waitMs:1000.07,waits:[],routines:[]},
  {kind:'observed heavyweight lock wait',pid:98,outcome:'acquired',mode:'ShareLock',waitMs:1250.07,waits:[],routines:[]},
  {kind:'observed heavyweight lock wait',pid:99,outcome:'failed to acquire',mode:'AccessExclusiveLock',waitMs:1000.115,waits:[],routines:[]},
  {kind:'observed heavyweight lock wait',pid:101,outcome:'avoided deadlock for',mode:'ExclusiveLock',waitMs:1002.444,waits:[],routines:[]},
 ]);
 expect(JSON.stringify(failures)).not.toMatch(/1234|5000|9999|ai_hr|abcdef01/);
});

it.each(['leave-dependency-configuration','leave-dependency-employment'])(
 'retains the exact %s family without exposing its key or SQL', family=>{
 const log='2026-11-09 14:00:00.000 +08 [98] abcdef01.62 ai_hr_app@ai_hr_dev LOG:  process 98 still waiting for ShareLock on advisory lock [90,42,77,1] after 100.070 ms';
 const [wait]=postgresLockFailures(log,{bracketed:true,advisoryKeys:new Map([['90:42:77:1',family]])});
 expect(wait).toMatchObject({kind:'observed heavyweight lock wait',diagnostic:{phase:'qualified-runtime',waitFamily:family}});
 expect(JSON.stringify(wait.diagnostic)).not.toContain('90:42:77:1');
 const sample=originalAdvisoryAttribution([{...fictionalWaiter,granted:false}],new Map([['11:12:1',family+':fixture']]));
 expect(sample.waiters).toEqual([{family,mode:'ExclusiveLock'}]);
});

it('qualifies only the exact bracketed PostgreSQL log window and retains blocking evidence',()=>{
 const nonce='0123456789abcdef0123456789abcdef';
 const marker=(phase:string,pid=98,sessionPid='62',actor='postgres@ai_hr_dev')=>
  '2026-11-09 14:00:00.000 +08 ['+pid+'] abcdef01.'+sessionPid+' '+actor+' LOG:  AIHR_LOCK_WINDOW_V1 '+nonce+' '+phase;
 const wait='2026-11-09 14:00:00.100 +08 [101] abcdef01.65 ai_hr_app@ai_hr_dev LOG:  process 101 still waiting for ShareLock on transaction 789 after 100.135 ms';
 const log=(...lines:string[])=>lines.join('\n');
 expect(developmentPostgresLockWindow(log(wait,marker('begin'),marker('end',99,'63'),wait),nonce))
  .toEqual({thresholdMs:100,failures:[]});
 expect(developmentPostgresLockWindow(log(marker('begin'),wait,marker('end',99,'63')),nonce))
  .toEqual({thresholdMs:100,failures:[{kind:'observed heavyweight lock wait',pid:101,outcome:'still waiting for',mode:'ShareLock',waitMs:100.135,waits:[],routines:[]}]});
 for(const rejected of [
  log(marker('begin'),wait),log(marker('end'),marker('begin')),log(marker('begin'),marker('end'),marker('end')),
  log(marker('begin'),marker('end',99,'62')),log(marker('begin'),marker('end',99,'63','ai_hr_app@ai_hr_dev')),
  log(marker('begin'),marker('end')+' unexpected'),log(marker('begin'),marker('end').replace(nonce,'0'.repeat(32))),
 ])expect(developmentPostgresLockWindow(rejected,nonce)).toBeNull();
});

it('projects only closed lock families, ordinal topology and explicit log phase',()=>{
 const log=`2026-11-09 14:00:00.000 +08 [98] abcdef01.62 ai_hr_app@ai_hr_dev ERROR:  deadlock detected
2026-11-09 14:00:00.000 +08 [98] abcdef01.62 ai_hr_app@ai_hr_dev DETAIL:  Process 98 waits for ExclusiveLock on advisory lock [90, 42, 77, 1]; blocked by process 99.
 Process 99 waits for ExclusiveLock on advisory lock [90, 42, 77, 1]; blocked by process 98.
 Process 98: select pg_advisory_xact_lock(hashtextextended('private-source',0));
 Process 99: select * from app.unknown_private_routine('private-value');
 CONTEXT: SQL statement "private-source"
 PL/pgSQL function app.ai_centre_assert_running(integer) line 8 at PERFORM
 PL/pgSQL function app.unknown_private_routine(text) line 9 at PERFORM`;
 const options={runtimeFrom:'2026-11-09T06:00:00.001Z',advisoryKeys:new Map([['90:42:77:1','access-configuration']])};
 const evidence=postgresLockFailures(log,options)[0].diagnostic;
 expect(evidence).toEqual({phase:'before-runtime-start',waitFamily:null,allParsedEdgesRetained:true,victimRoutines:['ai-centre-running'],edges:[
  {waiter:1,blocker:2,resource:1,mode:'ExclusiveLock',family:'access-configuration',waiterCall:'direct-advisory-exclusive',blockerCall:null},
  {waiter:2,blocker:1,resource:1,mode:'ExclusiveLock',family:'access-configuration',waiterCall:null,blockerCall:'direct-advisory-exclusive'},
 ]});
 expect(JSON.stringify(evidence)).not.toMatch(/private|\b(?:98|99|90|42|77)\b/);
 expect(postgresLockFailures(log,{runtimeFrom:'2026-11-09T06:00:00.000Z'})[0].diagnostic).toMatchObject({
  phase:'after-runtime-start',edges:[expect.objectContaining({family:'advisory-unclassified'}),expect.objectContaining({family:'advisory-unclassified'})],
 });
 expect(postgresLockFailures(log,{bracketed:true})[0].diagnostic?.phase).toBe('qualified-runtime');
 expect(postgresLockFailures(log,{runtimeFrom:'invalid'})[0].diagnostic?.phase).toBe('unknown');
 const long=log+'\n'+Array.from({length:16},(_,i)=>` Process ${100+i} waits for ShareLock on transaction ${i}; blocked by process 98.`).join('\n');
 const bounded=postgresLockFailures(long,options)[0].diagnostic;
 expect(bounded?.edges).toHaveLength(8);expect(bounded?.allParsedEdgesRetained).toBe(false);
});

it('identifies heavyweight wait families from the header even without graph edges',()=>{
 const lines=[
  'process 98 still waiting for ExclusiveLock on advisory lock [90,42,77,1] after 100.070 ms',
  'process 98 acquired ExclusiveLock on advisory lock [90,42,77,1] after 402.465 ms',
  'process 98 avoided deadlock for ShareLock on transaction 1234 by rearranging queue order after 100.100 ms',
  'process 98 acquired ShareLock on unexpected private-value after 101.000 ms',
 ];
 const log=lines.map(line=>'2026-11-09 14:00:00.000 +08 [98] abcdef01.62 ai_hr_app@ai_hr_dev LOG:  '+line).join('\n');
 const options={bracketed:true,advisoryKeys:new Map([['90:42:77:1','access-configuration']])};
 const rows=postgresLockFailures(log,options);
 expect(rows.map(row=>row.diagnostic?.waitFamily)).toEqual(['access-configuration','access-configuration','transaction',null]);
 expect(rows.map(row=>row.diagnostic?.edges)).toEqual([[],[],[],[]]);
 expect(JSON.stringify(rows.map(row=>row.diagnostic))).not.toMatch(/private-value|1234|\b(?:90|42|77|98)\b/);
});
