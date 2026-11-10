import {afterEach,describe,expect,it,vi} from 'vitest';
import {createDatabaseAdmission,DatabaseAdmissionError} from '../db/admission';
import {applicationDatabaseBudget,assertFleetFitsServer,databaseAdmissionShares,databaseFleetBudget} from '../db/capacity';
import {createBackgroundReadAdmission} from '../db/background-read-admission';
import {currentDatabaseWorkload,withBackgroundDatabaseWork} from '../db/workload';
const gate = (overrides = {}) => createDatabaseAdmission({capacity:4,backgroundCapacity:1,maxWaiting:8,waitMs:1000,...overrides});
afterEach(()=>vi.useRealTimers());
describe('database work admission',()=>{
 it('repays a long background unit with interactive connection time in a two-slot pool',async()=>{
  let now=0,cleanup=false,backgroundEntered=false;const entered:(()=>void)[]=[];
  const q=createDatabaseAdmission({capacity:2,backgroundCapacity:1,maxWaiting:16,waitMs:1000},()=>now);
  const background=await q.acquire('a','background'),interactive=await q.acquire('a','interactive');
  let nextBackground:(()=>void)|undefined;
  const waitingBackground=q.acquire('a','background').then(release=>{backgroundEntered=true;nextBackground=release;if(cleanup)release();});
  const pages=Array.from({length:8},()=>q.acquire('a','interactive').then(release=>{entered.push(release);if(cleanup)release();}));
  try{
   now=100;background();await vi.waitFor(()=>expect(entered).toHaveLength(1));
   expect(backgroundEntered).toBe(false);expect(q.snapshot().backgroundDebtMs).toBe(200);
   interactive();await vi.waitFor(()=>expect(entered).toHaveLength(2));
   expect(backgroundEntered).toBe(false);expect(q.snapshot().backgroundDebtMs).toBe(200);
   now=200;entered[0]();await vi.waitFor(()=>expect(backgroundEntered).toBe(true));
   entered[1]();
   expect(q.snapshot().backgroundDebtMs).toBe(0);
  }finally{cleanup=true;background();interactive();nextBackground?.();entered.forEach(release=>release());await Promise.all([...pages,waitingBackground]);}
  expect(q.snapshot()).toMatchObject({active:0,waiting:0});
 });
 it('reserves pending capacity for interactive work when background producers fill their lane',async()=>{
  const q=gate({capacity:1,backgroundCapacity:1,maxWaiting:4,maxBackgroundWaiting:1});
  const holder=await q.acquire('a','interactive');
  const background=q.acquire('a','background');
  await expect(q.acquire('b','background')).rejects.toMatchObject({code:'queue-full'});
  const foreground=q.acquire('b','interactive');
  expect(q.snapshot()).toMatchObject({waiting:2,backgroundWaiting:1});
  holder();(await foreground)();(await background)();
  expect(q.snapshot()).toMatchObject({waiting:0,backgroundWaiting:0,active:0});
 });
 it('reserves capacity for pages while heavy work waits without connections',async()=>{
  const q=gate(),first=await q.acquire('a','background');
  let secondEntered=false;
  const second=q.acquire('b','background').then(release=>{secondEntered=true;return release;});
  const pages=await Promise.all(['a','b','c'].map(id=>q.acquire(id,'interactive')));
  expect(q.snapshot()).toMatchObject({active:4,background:1,waiting:1});
  expect(secondEntered).toBe(false);
  pages.forEach(release=>release());
  expect(q.snapshot()).toMatchObject({active:1,background:1,waiting:1});
  first();(await second)();
  expect(q.snapshot()).toMatchObject({active:0,background:0,waiting:0});
 });
 it('bounds pending memory, rejects before starting work, and recovers',async()=>{
  const q=gate({capacity:1,backgroundCapacity:1,maxWaiting:1}),first=await q.acquire('a','interactive');
  const queued=q.acquire('b','interactive');
  await expect(q.acquire('c','interactive')).rejects.toMatchObject({code:'queue-full'});
  expect(q.snapshot().waiting).toBe(1);
  first();const release=await queued;release();release();
  const recovered=await q.acquire('c','interactive');recovered();
  expect(q.snapshot().active).toBe(0);
 });
 it('cancels queued reads promptly, removes listeners/timers, and never admits cancelled work',async()=>{
  const q=gate({capacity:1,backgroundCapacity:1}),first=await q.acquire('a','interactive'),abort=new AbortController();
  const reason=new Error('client left'),cancelled=q.acquire('b','interactive',abort.signal);
  const rejected=expect(cancelled).rejects.toBe(reason);
  abort.abort(reason);await rejected;
  expect(q.snapshot().waiting).toBe(0);first();
  await expect(q.acquire('b','interactive',abort.signal)).rejects.toBe(reason);
  expect(q.snapshot().active).toBe(0);
 });
 it('expires only waiting work, never revokes an admitted transaction',async()=>{
  vi.useFakeTimers();
  const q=gate({capacity:1,backgroundCapacity:1}),first=await q.acquire('a','interactive');
  const queued=q.acquire('b','background');
  const rejected=expect(queued).rejects.toMatchObject({name:'DatabaseAdmissionError',code:'queue-timeout'});
  await vi.advanceTimersByTimeAsync(1000);await rejected;
  expect(q.snapshot()).toMatchObject({active:1,waiting:0});first();
  expect(vi.getTimerCount()).toBe(0);
 });
 it('prefers a tenant without active work while preserving FIFO within that tenant',async()=>{
  const q=gate({capacity:2}),a1=await q.acquire('a','interactive'),a2=await q.acquire('a','interactive');
  const order:string[]=[];
  const pending=[['a','a3'],['b','b1'],['b','b2']].map(([tenant,label])=>q.acquire(tenant,'interactive').then(release=>{order.push(label);return release;}));
  a1();await vi.waitFor(()=>expect(order).toEqual(['b1']));
  a2();await vi.waitFor(()=>expect(order).toEqual(['b1','a3']));
  (await pending[0])();(await pending[1])();(await pending[2])();
  expect(order).toEqual(['b1','a3','b2']);
 });
 it('bounds a hot tenant without blocking another tenant that has available capacity',async()=>{
  const q=gate({perTenantCapacity:1}),first=await q.acquire('A','interactive');let hotEntered=false;
  const hot=q.acquire('a','interactive').then(release=>{hotEntered=true;return release;});
  const other=await q.acquire('b','interactive');
  expect(hotEntered).toBe(false);expect(q.snapshot()).toMatchObject({active:2,waiting:1});
  first();(await hot)();other();expect(q.snapshot().active).toBe(0);
 });
 it('gives background work bounded turns under a continuous interactive queue',async()=>{
  const q=gate({capacity:1}),first=await q.acquire('a','interactive'),order:string[]=[];
  const tasks=Array.from({length:6},(_,i)=>q.acquire('a','interactive').then(release=>{order.push('i'+i);release();}));
  tasks.push(q.acquire('b','background').then(release=>{order.push('background');release();}));
  first();await Promise.all(tasks);
  expect(order.indexOf('background')).toBe(2);
 });
 it('contains background classification across asynchronous work without leaking to another request',async()=>{
  const observed=await withBackgroundDatabaseWork(async()=>{await Promise.resolve();return currentDatabaseWorkload();});
  expect(observed).toBe('background');expect(currentDatabaseWorkload()).toBe('interactive');
 });
 it('rejects invalid budgets before accepting work',()=>{
  expect(()=>gate({capacity:0})).toThrow();expect(()=>gate({backgroundCapacity:5})).toThrow();
  expect(()=>gate({maxBackgroundWaiting:9})).toThrow();expect(()=>gate({maxBackgroundWaiting:-1})).toThrow();
  expect(new DatabaseAdmissionError('queue-full').message).not.toContain('tenant');
 });
});

describe('logical passive read admission',()=>{
 it('admits before fan-out, composes one tenant, and releases cancellation without borrowing a connection',async()=>{
  const gate=createBackgroundReadAdmission({capacity:1,maxWaiting:2,waitMs:1000});
  let finish!:()=>void,entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{finish=resolve;});
  const first=gate.run('A',async()=>{entered();await held;return gate.run('a',async()=>currentDatabaseWorkload());});
  await started;
  const controller=new AbortController(),reason=new Error('passive read abandoned');let ran=false;
  const cancelled=gate.run('b',async()=>{ran=true;},controller.signal),refusal=expect(cancelled).rejects.toBe(reason);
  const second=gate.run('b',async()=>currentDatabaseWorkload());
  await expect(gate.run('c',async()=>null)).rejects.toMatchObject({code:'queue-full'});
  controller.abort(reason);await refusal;expect(ran).toBe(false);expect(gate.snapshot().waiting).toBe(1);
  finish();expect(await first).toBe('background');expect(await second).toBe('background');
  expect(currentDatabaseWorkload()).toBe('interactive');expect(gate.snapshot()).toMatchObject({waiting:0,active:0});
  await expect(gate.run('a',()=>gate.run('b',async()=>null))).rejects.toThrow(/different tenant/);
  expect(gate.snapshot().active).toBe(0);
 });
});

describe('aggregate application capacity',()=>{
 it.each([2,4,8])('keeps total connections and waiting work bounded with %i workers',workers=>{
  const budget=applicationDatabaseBudget({AIHR_APP_WORKERS:String(workers),AIHR_DB_POOL_MAX:String(16/workers),AIHR_DB_TOTAL_CONNECTIONS:'16'});
  expect(budget.poolMax*workers).toBe(16);expect(budget.maxWaiting*workers).toBe(2048);
 });
 it('rejects multiplication, partial declarations and malformed values before startup',()=>{
  expect(()=>applicationDatabaseBudget({AIHR_APP_WORKERS:'8',AIHR_DB_POOL_MAX:'8',AIHR_DB_TOTAL_CONNECTIONS:'16'})).toThrow(/exceed/);
  expect(()=>applicationDatabaseBudget({AIHR_APP_WORKERS:'4'})).toThrow(/both/);
  expect(()=>applicationDatabaseBudget({AIHR_DB_POOL_MAX:'1e1'})).toThrow(/integer/);
  expect(applicationDatabaseBudget({}).poolMax).toBe(10);
 });
});

describe('fair capacity: one hot tenant cannot starve login or another tenant',()=>{
 const shared=()=>createDatabaseAdmission({capacity:8,backgroundCapacity:2,maxWaiting:64,waitMs:1000,...databaseAdmissionShares(8,64)});
 it('derives shares from pool size and worker count',()=>{
  // P = floor(C/W): the deployed 16-connection web fleet at 2, 4 and 8 workers, plus a larger pool.
  expect(databaseAdmissionShares(8,1024)).toMatchObject({authenticationReserve:1,tenantFairShare:5,otherTenantReserve:2,authenticationCapacity:4,maxWaitingPerTenant:768,maxAuthenticationWaiting:128});
  expect(databaseAdmissionShares(4,512)).toMatchObject({authenticationReserve:1,tenantFairShare:2,otherTenantReserve:1,authenticationCapacity:2});
  expect(databaseAdmissionShares(2,256)).toMatchObject({authenticationReserve:0,tenantFairShare:1,otherTenantReserve:1,authenticationCapacity:1});
  expect(databaseAdmissionShares(1,128)).toMatchObject({authenticationReserve:0,tenantFairShare:1,otherTenantReserve:0,authenticationCapacity:1});
  expect(databaseAdmissionShares(16,512)).toMatchObject({authenticationReserve:2,tenantFairShare:10,otherTenantReserve:4,authenticationCapacity:8});
  // Every pool of at least three keeps one permit from the hot tenant and one for login.
  for(let p=3;p<=50;p++){const s=databaseAdmissionShares(p,1024);expect(s.tenantFairShare+s.authenticationReserve).toBeLessThanOrEqual(p-1);expect(s.otherTenantReserve).toBeGreaterThanOrEqual(1);expect(s.authenticationReserve).toBeGreaterThanOrEqual(1);}
  // Workers get no reservation: one tenant at a time, no logins.
  expect(databaseAdmissionShares(3,64,'worker')).toMatchObject({authenticationReserve:0,tenantFairShare:3,otherTenantReserve:0});
 });
 it('lets a lone tenant use every permit except the login reserve',async()=>{
  const q=shared(),held=await Promise.all(Array.from({length:7},()=>q.acquire('solo','interactive')));
  expect(q.snapshot()).toMatchObject({active:7,waiting:0});
  let eighth=false;const queued=q.acquire('solo','interactive').then(r=>{eighth=true;return r;});
  await Promise.resolve();
  // The eighth permit is the login reserve, whichever tenant asks.
  expect(eighth).toBe(false);expect(q.snapshot()).toMatchObject({active:7,waiting:1});
  const login=await q.acquire('authentication','authentication');
  expect(q.snapshot()).toMatchObject({active:8,authentication:1});
  login();held.forEach(release=>release());(await queued)();
  expect(q.snapshot()).toMatchObject({active:0,waiting:0});
 });
 it('uses the two connections a lone tenant has at W=8',async()=>{
  const q=createDatabaseAdmission({capacity:2,backgroundCapacity:1,maxWaiting:32,waitMs:1000,...databaseAdmissionShares(2,32)});
  const held=await Promise.all([q.acquire('solo','interactive'),q.acquire('solo','interactive')]);
  expect(q.snapshot().active).toBe(2);held.forEach(release=>release());
 });
 it('gives a tenant that arrives during an over-share burst the next freed permits',async()=>{
  const q=shared(),hot=await Promise.all(Array.from({length:7},()=>q.acquire('hot','interactive')));
  const order:string[]=[];
  const hotQueued=q.acquire('hot','interactive').then(r=>{order.push('hot');return r;});
  const first=q.acquire('other','interactive').then(r=>{order.push('other-1');return r;});
  const second=q.acquire('other','interactive').then(r=>{order.push('other-2');return r;});
  expect(q.snapshot()).toMatchObject({active:7,waiting:3});
  hot[0]();await vi.waitFor(()=>expect(order).toEqual(['other-1']));
  hot[1]();await vi.waitFor(()=>expect(order).toEqual(['other-1','other-2']));
  expect(q.snapshot()).toMatchObject({active:7,waiting:1});
  // Below its share of five again: the hot tenant may run.
  hot[2]();await vi.waitFor(()=>expect(order).toEqual(['other-1','other-2','hot']));
  [...hot.slice(3),await first,await second,await hotQueued].forEach(release=>release());
  expect(q.snapshot()).toMatchObject({active:0,waiting:0});
 });
 it('holds an over-share tenant back while another tenant waits, then resumes using idle permits',async()=>{
  const q=createDatabaseAdmission({capacity:4,backgroundCapacity:1,maxWaiting:16,waitMs:1000,tenantFairShare:2,authenticationReserve:1});
  const hot=await Promise.all([q.acquire('hot','interactive'),q.acquire('hot','interactive'),q.acquire('hot','interactive')]);
  let hotEntered=false,otherEntered=false;
  const hotQueued=q.acquire('hot','interactive').then(r=>{hotEntered=true;return r;});
  const other=q.acquire('other','interactive').then(r=>{otherEntered=true;return r;});
  hot[0]();await vi.waitFor(()=>expect(otherEntered).toBe(true));
  // Hot is at its share while the other tenant runs, so the idle permit stays free for the other tenant.
  expect(hotEntered).toBe(false);expect(q.snapshot()).toMatchObject({active:3,waiting:1});
  (await other)();
  // The other tenant is gone: idle capacity goes back to the lone tenant, even above its share.
  await vi.waitFor(()=>expect(hotEntered).toBe(true));
  expect(q.snapshot()).toMatchObject({active:3,waiting:0});
  [hot[1],hot[2],await hotQueued].forEach(release=>release());
 });
 it('serves a login first even while tenants compete for freed permits',async()=>{
  const q=createDatabaseAdmission({capacity:3,backgroundCapacity:1,maxWaiting:16,waitMs:1000,tenantFairShare:1,authenticationReserve:1,authenticationCapacity:2});
  const hot=await Promise.all([q.acquire('hot','interactive'),q.acquire('hot','interactive')]);
  const login1=await q.acquire('authentication','authentication');
  const order:string[]=[];
  const page=q.acquire('other','interactive').then(r=>{order.push('page');return r;});
  const login2=q.acquire('authentication','authentication').then(r=>{order.push('login');return r;});
  await Promise.resolve();expect(order).toEqual([]);
  hot[0]();await vi.waitFor(()=>expect(order).toEqual(['login']));
  hot[1]();await vi.waitFor(()=>expect(order).toEqual(['login','page']));
  login1();(await login2)();(await page)();
  expect(q.snapshot()).toMatchObject({active:0,waiting:0});
 });
 it('never treats login work as another tenant competing for the share',async()=>{
  const q=createDatabaseAdmission({capacity:4,backgroundCapacity:1,maxWaiting:8,waitMs:1000,tenantFairShare:1,authenticationReserve:1,authenticationCapacity:2});
  const login=await q.acquire('authentication','authentication');
  const held=await Promise.all([q.acquire('solo','interactive'),q.acquire('solo','interactive')]);
  expect(q.snapshot()).toMatchObject({active:3,authentication:1});
  login();held.forEach(release=>release());
 });
 it('keeps a hard per-tenant ceiling hard even when the tenant is alone',async()=>{
  const q=createDatabaseAdmission({capacity:4,backgroundCapacity:1,maxWaiting:8,waitMs:1000,perTenantCapacity:1,tenantFairShare:1});
  const first=await q.acquire('solo','interactive');let entered=false;
  const second=q.acquire('solo','interactive').then(r=>{entered=true;return r;});
  await Promise.resolve();expect(entered).toBe(false);
  first();(await second)();
 });
 it('always keeps a permit for login that no tenant work can take',async()=>{
  const q=shared(),work=await Promise.all([...Array.from({length:5},()=>q.acquire('a','interactive')),q.acquire('b','interactive'),q.acquire('c','interactive')]);
  // Seven permits used across three tenants; the eighth is the authentication reserve.
  let page=false;const blocked=q.acquire('d','interactive').then(r=>{page=true;return r;});
  await Promise.resolve();expect(page).toBe(false);expect(q.snapshot()).toMatchObject({active:7,waiting:1});
  const login=await q.acquire('authentication','authentication');
  expect(q.snapshot()).toMatchObject({active:8,authentication:1,waiting:1});
  login();work.forEach(release=>release());(await blocked)();
  expect(q.snapshot()).toMatchObject({active:0,waiting:0});
 });
 it('serves queued login before queued page reads and never after them',async()=>{
  const q=createDatabaseAdmission({capacity:2,backgroundCapacity:1,maxWaiting:16,waitMs:1000,perTenantCapacity:2,authenticationCapacity:2});
  const held=await Promise.all([q.acquire('a','interactive'),q.acquire('a','interactive')]);
  const order:string[]=[];
  const page=q.acquire('b','interactive').then(r=>{order.push('page');return r;});
  const login=q.acquire('authentication','authentication').then(r=>{order.push('login');return r;});
  held[0]();await vi.waitFor(()=>expect(order).toEqual(['login']));
  held[1]();await vi.waitFor(()=>expect(order).toEqual(['login','page']));
  (await login)();(await page)();
 });
 it('caps a login flood so pages keep half the pool',async()=>{
  const q=shared(),logins=await Promise.all(Array.from({length:4},()=>q.acquire('authentication','authentication')));
  expect(q.snapshot().authentication).toBe(4);
  let fifth=false;const queued=q.acquire('authentication','authentication').then(r=>{fifth=true;return r;});
  const pages=await Promise.all(Array.from({length:3},(_, i)=>q.acquire('t'+i,'interactive')));
  expect(fifth).toBe(false);expect(q.snapshot()).toMatchObject({active:7,authentication:4,waiting:1});
  [...logins,...pages].forEach(release=>release());(await queued)();
  expect(q.snapshot()).toMatchObject({active:0,waiting:0});
 });
 it('stops one tenant from filling the whole queue while another can still wait',async()=>{
  const q=createDatabaseAdmission({capacity:1,backgroundCapacity:1,maxWaiting:8,waitMs:1000,maxWaitingPerTenant:2});
  const held=await q.acquire('a','interactive'),hot=[q.acquire('hot','interactive'),q.acquire('hot','interactive')];
  await expect(q.acquire('hot','interactive')).rejects.toMatchObject({code:'queue-full'});
  const other=q.acquire('other','interactive');
  expect(q.snapshot().waiting).toBe(3);
  held();for(const pending of [...hot,other])(await pending)();
 });
 it('never makes nested work wait on its own tenant share',async()=>{
  const q=createDatabaseAdmission({capacity:4,backgroundCapacity:1,maxWaiting:8,waitMs:1000,perTenantCapacity:1});
  const outer=await q.acquire('a','interactive');
  // Without the exemption this would deadlock against its own outer transaction.
  const nested=await q.acquire('a','interactive',undefined,{ignoreTenantCap:true});
  expect(q.snapshot().active).toBe(2);
  nested();outer();
  await expect(Promise.race([q.acquire('a','interactive').then(r=>{r();return 'ok';}),new Promise(r=>setTimeout(()=>r('timeout'),50))])).resolves.toBe('ok');
 });
 it('keeps authentication waiters apart from a full tenant queue',async()=>{
  const q=createDatabaseAdmission({capacity:1,backgroundCapacity:1,maxWaiting:1,waitMs:1000,authenticationReserve:0,maxAuthenticationWaiting:1,authenticationCapacity:1});
  const held=await q.acquire('a','interactive'),page=q.acquire('b','interactive');
  await expect(q.acquire('c','interactive')).rejects.toMatchObject({code:'queue-full'});
  const login=q.acquire('authentication','authentication');
  expect(q.snapshot()).toMatchObject({waiting:2,authenticationWaiting:1});
  held();const loginRelease=await login;loginRelease();(await page)();
 });
 it('rejects impossible authentication budgets',()=>{
  expect(()=>createDatabaseAdmission({capacity:2,backgroundCapacity:1,maxWaiting:1,waitMs:1,authenticationReserve:2})).toThrow(/authentication/);
  expect(()=>createDatabaseAdmission({capacity:2,backgroundCapacity:1,maxWaiting:1,waitMs:1,authenticationCapacity:3})).toThrow(/authentication/);
  expect(()=>createDatabaseAdmission({capacity:2,backgroundCapacity:1,maxWaiting:1,waitMs:1,maxWaitingPerTenant:2})).toThrow(/waiting/);
 });
});

describe('every process counts against the database connection limit',()=>{
 const shared={AIHR_APP_WORKERS:'2',AIHR_DB_POOL_MAX:'8',AIHR_DB_TOTAL_CONNECTIONS:'16'};
 it('declares small explicit pools for non-web processes',()=>{
  const worker=applicationDatabaseBudget({...shared,AIHR_DB_PROCESS_ROLE:'worker',AIHR_DB_POOL_MAX:'3'});
  expect(worker).toMatchObject({role:'worker',poolMax:3,maxWaiting:64});
  expect(applicationDatabaseBudget({AIHR_DB_PROCESS_ROLE:'worker'}).poolMax).toBe(2);
  expect(()=>applicationDatabaseBudget({AIHR_DB_PROCESS_ROLE:'worker',AIHR_DB_POOL_MAX:'50'})).toThrow(/AIHR_DB_POOL_MAX/);
  expect(()=>applicationDatabaseBudget({AIHR_DB_PROCESS_ROLE:'job'})).toThrow(/AIHR_DB_PROCESS_ROLE/);
 });
 it('adds web, background and reserved connections for the fleet',()=>{
  expect(databaseFleetBudget({...shared,AIHR_DB_BACKGROUND_CONNECTIONS:'14',AIHR_DB_RESERVED_CONNECTIONS:'6'})).toEqual({webConnections:16,backgroundConnections:14,reservedConnections:6,requiredConnections:36});
 });
 it('refuses to start when the fleet cannot fit the server limit',()=>{
  expect(assertFleetFitsServer(shared,{maxConnections:100,superuserReserved:3})).toMatchObject({requiredConnections:37,available:97});
  expect(()=>assertFleetFitsServer(shared,{maxConnections:30,superuserReserved:3})).toThrow(/37.*27 are available/);
 });
});
