import {afterEach,describe,expect,it,vi} from 'vitest';
import {createDatabaseAdmission,DatabaseAdmissionError} from '../db/admission';
import {applicationDatabaseBudget} from '../db/capacity';
import {currentDatabaseWorkload,withBackgroundDatabaseWork} from '../db/workload';
const gate = (overrides = {}) => createDatabaseAdmission({capacity:4,backgroundCapacity:1,maxWaiting:8,waitMs:1000,...overrides});
afterEach(()=>vi.useRealTimers());
describe('database work admission',()=>{
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
  expect(new DatabaseAdmissionError('queue-full').message).not.toContain('tenant');
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
