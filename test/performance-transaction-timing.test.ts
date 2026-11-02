import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';
import {profileDatabaseTransaction,type TransactionTimingEvent} from '../db/transaction-profile';
import {createTransactionTimingCollector} from '../scripts/performance/transaction-timing-collector.mjs';
type ProfileGlobal=typeof globalThis & {__aihrTransactionTiming?:(event:TransactionTimingEvent)=>void};
it('preserves result, error identity, callback count and transaction completion ordering',async()=>{
 const events:TransactionTimingEvent[]=[];const root=globalThis as ProfileGlobal;
 root.__aihrTransactionTiming=event=>events.push(event);
 try{
  let calls=0;const value={committed:true};
  expect(await profileDatabaseTransaction('tenant',async(entered,left)=>{calls++;entered();await Promise.resolve();left();return value;})).toBe(value);
  expect(calls).toBe(1);expect(events.map(e=>e.phase)).toEqual(['start','entered','left','finished']);
  expect(events.at(-1)?.failed).toBe(false);
  events.length=0;const error=new Error('native rollback');
  await expect(profileDatabaseTransaction('tenant',async(entered,left)=>{entered();try{throw error;}finally{left();}})).rejects.toBe(error);
  expect(events.at(-1)?.failed).toBe(true);
 }finally{delete root.__aihrTransactionTiming;}
});
it('does not retry or mask business success when telemetry fails',async()=>{
 const root=globalThis as ProfileGlobal;let calls=0;root.__aihrTransactionTiming=()=>{throw Error('probe failure');};
 try{expect(await profileDatabaseTransaction('entitlements',async(entered,left)=>{calls++;entered();left();return 42;})).toBe(42);expect(calls).toBe(1);}
 finally{delete root.__aihrTransactionTiming;}
});
it('accounts for pool admission, callback, settlement and refusal before callback separately',async()=>{
 const collector=createTransactionTimingCollector(()=>10000),root=globalThis as ProfileGlobal;
 root.__aihrTransactionTiming=collector.record;
 try{
  await profileDatabaseTransaction('tenant',async(entered,left)=>{entered();left();return 1;});
  const failure=new Error('before BEGIN');await expect(profileDatabaseTransaction('tenant',async()=>{throw failure;})).rejects.toBe(failure);
  const report=collector.snapshot(),row=report.windows[0];
  expect(report.gauges.tenant).toEqual({waiting:0,active:0,settling:0});
  expect(row.events).toEqual({start:2,entered:1,left:1,finished:2});expect(row.failed).toBe(1);
  expect(row.timings.entered.count).toBe(1);expect(row.timings.left.count).toBe(1);expect(row.timings.finished.count).toBe(1);expect(row.timings.refusedBeforeEntry.count).toBe(1);
 }finally{delete root.__aihrTransactionTiming;}
});

it('parses the actual hosted preloader and profiling controller without executing them',()=>{
 for(const file of ['transaction-profile-preload.mjs','system-runner.mjs'])expect(()=>execFileSync(process.execPath,['--check',fileURLToPath(new URL('../scripts/performance/'+file,import.meta.url))],{stdio:'pipe'})).not.toThrow();
});
