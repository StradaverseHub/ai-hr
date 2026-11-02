import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createDb} from '../db/client';
import type {TransactionTimingEvent} from '../db/transaction-profile';
import {withEntitlements} from '../lib/session';
import {adminCtx,closeAll,migrateTestDb,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(async()=>{await migrateTestDb();await resetDb();b=await seedBase();});
afterAll(closeAll);
it('observes actual single-connection admission separately from a held callback and preserves rollback',async()=>{
 const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('application_name','timing-'+randomUUID());
 const isolated=createDb(url.toString(),{max:1});
 const root=globalThis as typeof globalThis & {__aihrTransactionTiming?:(event:TransactionTimingEvent)=>void};
 const events:TransactionTimingEvent[]=[];root.__aihrTransactionTiming=event=>events.push(event);
 let release!:()=>void,ready!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{ready=resolve;});
 let first:Promise<unknown>|undefined,second:Promise<unknown>|undefined;
 try{
  first=isolated.withTenant(adminCtx(b),async tx=>{await tx.execute(sql`select 1`);ready();await held;return 'first';});
  await started;
  second=isolated.withTenant(adminCtx(b),async tx=>{await tx.execute(sql`select 2`);return 'second';});
  await pause(30);
  expect(events.filter(e=>e.phase==='start')).toHaveLength(2);
  expect(events.filter(e=>e.phase==='entered')).toHaveLength(1);
  expect(events.filter(e=>e.phase==='finished')).toHaveLength(0);
  release();expect(await first).toBe('first');expect(await second).toBe('second');
  expect(events.filter(e=>e.phase==='entered')[1].durationMs).toBeGreaterThanOrEqual(25);
  expect(events.filter(e=>e.phase==='left')).toHaveLength(2);
  const error=new Error('deliberate native rollback');
  await expect(isolated.withTenant(adminCtx(b),async tx=>{await tx.execute(sql`select 3`);throw error;})).rejects.toBe(error);
  expect(events.at(-1)).toMatchObject({phase:'finished',entered:true,failed:true});
  const session=await withEntitlements(adminCtx(b));expect(session.entitlements).toBeDefined();
  expect(events.filter(e=>e.scope==='entitlements').map(e=>e.phase)).toEqual(['start','entered','left','finished']);
 }finally{
  release();await Promise.allSettled([first,second]);delete root.__aihrTransactionTiming;await isolated.client.end();
 }
});
