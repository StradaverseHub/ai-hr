/** Once-only scheduled jobs against real PostgreSQL (scripts/lib/scheduled-job-lock.ts, scripts/scheduled-jobs.ts):
 *  - one holder per job lock, jobs independent, the lock freed by release or by the holder's connection ending;
 *  - the cron / timer commands (provision-runner.ts, notification-email-sweep.ts) skip with status 0 while the resident
 *    process holds their lock, so an installation can switch over in either order without a job running twice;
 *  - the real resident process skips a held job, runs it once the lock is free, writes the cron-alert.sh log block and
 *    heartbeat, keeps the same warm owner connections between runs instead of opening new ones, and stops with 0. */
import {afterAll,afterEach,beforeAll,expect,it} from 'vitest';
import {spawn,type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import {openScheduledJobLocks,withApplicationName,type ScheduledJobLocks} from '../scripts/lib/scheduled-job-lock';
import {closeAll,migrateTestDb} from './harness';

const url=()=>process.env.MIGRATION_DATABASE_URL!;
const opened:ScheduledJobLocks[]=[];const children:ChildProcess[]=[];let probe:postgres.Sql;let dir:string;
function locks(name:string){const l=openScheduledJobLocks(url(),name);opened.push(l);return l;}
beforeAll(async()=>{await migrateTestDb();probe=postgres(url(),{max:1,onnotice:()=>{}});},120_000);
afterEach(async()=>{
 for(const child of children.splice(0))if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
 for(const l of opened.splice(0))await l.end().catch(()=>undefined);
 if(dir)fs.rmSync(dir,{recursive:true,force:true});
});
afterAll(async()=>{await probe.end({timeout:5});await closeAll();});

type Run={child:ChildProcess;out:string[];err:string[];exit:Promise<number|null>};
function start(args:string[],env:Record<string,string>={}):Run{
 const child=spawn(process.execPath,['--import','tsx',...args],{cwd:process.cwd(),stdio:['ignore','pipe','pipe'],
  env:{...process.env,NODE_OPTIONS:'',AIHR_DB_PROCESS_ROLE:'worker',AIHR_DB_POOL_MAX:'4',...env}});
 children.push(child);const out:string[]=[],err:string[]=[];
 child.stdout!.on('data',chunk=>out.push(String(chunk)));child.stderr!.on('data',chunk=>err.push(String(chunk)));
 return {child,out,err,exit:new Promise(resolve=>child.once('exit',code=>resolve(code)))};
}
async function until<T>(what:string,fn:()=>T|undefined|false|Promise<T|undefined|false>,ms=120_000):Promise<T>{
 const deadline=Date.now()+ms;
 for(;;){const value=await fn();if(value)return value;if(Date.now()>deadline)throw new Error(`timed out waiting for ${what}`);await new Promise(r=>setTimeout(r,250));}
}

it('admits one holder per job, keeps jobs independent and frees the lock on release or a lost connection',async()=>{
 const a=locks('test-holder-a'),b=locks('test-holder-b');
 const held=await a.tryLock('provision');expect(held).not.toBeNull();
 expect(await b.tryLock('provision')).toBeNull();
 const other=await b.tryLock('notification-email');expect(other).not.toBeNull();
 expect(await held!.release()).toBe(true);
 const again=await b.tryLock('provision');expect(again).not.toBeNull();
 // The holder's backend ends (a network loss or a PostgreSQL restart): the server frees the lock, the release says so.
 await probe`select pg_terminate_backend(pid) from pg_stat_activity where application_name='test-holder-b' and datname=current_database()`;
 const c=locks('test-holder-c');
 expect(await until('the lock to be freed',async()=>(await c.tryLock('provision'))??false,20_000)).toBeTruthy();
 expect(await again!.release()).toBe(false);
},60_000);

it('keeps the application name the resident process uses to tell its connections apart',()=>{
 expect(new URL(withApplicationName('postgres://u:p%40ss@db.example:5432/ai_hr?sslmode=verify-full','aihr-scheduled-provision')).searchParams.get('application_name')).toBe('aihr-scheduled-provision');
 expect(withApplicationName('postgres://u:p%40ss@db.example:5432/ai_hr?sslmode=verify-full','x')).toContain('u:p%40ss@db.example:5432/ai_hr?sslmode=verify-full&');
});

it('the cron commands skip with status 0 while the resident process holds their job',async()=>{
 const holder=locks('test-resident');
 const provision=await holder.tryLock('provision'),sweep=await holder.tryLock('notification-email');
 expect(provision&&sweep).toBeTruthy();
 const runner=start(['scripts/provision-runner.ts']),email=start(['scripts/notification-email-sweep.ts']);
 expect(await runner.exit).toBe(0);
 expect(runner.out.join('')).toContain('· another provisioning runner holds the provisioning lock; skipped');
 expect(runner.out.join('')).not.toContain('no provisioning work');
 expect(await email.exit).toBe(0);
 expect(email.out.join('')).toContain('Workflow sweep skipped: another run holds the notification sweep lock.');
 // Neither command took or kept the lock: the resident holder still releases it cleanly.
 expect(await provision!.release()).toBe(true);expect(await sweep!.release()).toBe(true);
},180_000);

it('the resident process waits for a held job, then runs it on warm connections, reports it and stops cleanly',async()=>{
 dir=fs.mkdtempSync(path.join(os.tmpdir(),'aihr-scheduled-db-'));
 const holder=locks('test-cron-holder');const held=await holder.tryLock('provision');expect(held).toBeTruthy();
 const resident=start(['scripts/scheduled-jobs.ts','--log-dir',dir,'--job','provision=after-10s']);
 const stderr=()=>resident.err.join('');
 await until('the resident start',()=>stderr().includes('Scheduled jobs started'));
 await until('a skipped run while the lock is held',()=>stderr().includes('Scheduled job provision: skipped, another process holds its lock.'),60_000);
 const logFile=path.join(dir,'provision.log');
 expect(fs.existsSync(logFile)).toBe(false);
 expect(await held!.release()).toBe(true);
 const blocks=()=>fs.existsSync(logFile)?[...fs.readFileSync(logFile,'utf8').matchAll(/==== \S+ {2}provision {2}exit=(\d+) {2}\d+s ====/g)].map(m=>Number(m[1])):[];
 await until('the first run',()=>blocks().length>=1,60_000);
 const backends=async()=>(await probe<{pid:number}[]>`select pid from pg_stat_activity where datname=current_database() and application_name='aihr-scheduled-provision' order by pid`).map(r=>r.pid);
 const first=await backends();
 expect(first.length).toBeGreaterThanOrEqual(1);
 await until('two more runs',()=>blocks().length>=3,60_000);
 // Warm: later passes reuse the job's own owner connections (a pool of at most 2) instead of opening new sessions.
 const later=await backends();
 expect(later).toEqual(expect.arrayContaining(first));expect(later.length).toBeLessThanOrEqual(2);
 // The heartbeat follows cron-alert.sh: touched only by a run that exited 0.
 const heartbeat=path.join(dir,'heartbeat','provision');
 if(blocks().includes(0))await until('the heartbeat',()=>fs.existsSync(heartbeat),10_000);
 else expect(fs.existsSync(heartbeat)).toBe(false);
 resident.child.kill('SIGTERM');
 expect(await resident.exit).toBe(0);
 expect(stderr()).toContain('Scheduled jobs stopped.');
 // Its lock was released with it.
 const after=await holder.tryLock('provision');expect(after).toBeTruthy();await after!.release();
},240_000);

it('refuses bad arguments and a missing owner connection with status 2 before connecting',async()=>{
 const bad=start(['scripts/scheduled-jobs.ts','--log-dir','/tmp','--job','payroll=every-minute']);
 expect(await bad.exit).toBe(2);expect(bad.err.join('')).toContain('Unknown scheduled job: payroll');
 const missing=start(['scripts/scheduled-jobs.ts','--log-dir','/tmp','--job','provision=every-minute'],{MIGRATION_DATABASE_URL:''});
 expect(await missing.exit).toBe(2);expect(missing.err.join('')).toContain('scheduled-jobs needs MIGRATION_DATABASE_URL');
},60_000);
