/** The protected import worker's stall watchdog (lib/import-worker-watchdog.ts) with an injected clock, timer and
 * exit: a phase that never returns ends the process with the phase in the log line, normal loops (including the
 * longest unit the kernel allows) never do, the timer never keeps a process alive, and the setting is validated.
 * The real runner and an interrupted bulk-job unit are covered in test/import-worker-watchdog-db.test.ts. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {spawnSync} from 'node:child_process';
import {
 IMPORT_WORKER_STALL_DEFAULT_SECONDS,IMPORT_WORKER_STALL_ENV,IMPORT_WORKER_STALL_EXIT_CODE,IMPORT_WORKER_STALL_MAX_SECONDS,
 IMPORT_WORKER_STALL_MIN_SECONDS,importWorkerStallSeconds,startImportWorkerWatchdog,type ImportWorkerPhase,
} from '../lib/import-worker-watchdog';

afterEach(()=>{vi.useRealTimers();});

/** The runner's loop shape with injectable phases; `rounds` bounds it so a test can end. */
async function loop(watchdog:{enter(phase:ImportWorkerPhase):void},phases:Record<'bank'|'individual'|'bulk'|'pause',()=>Promise<unknown>>,rounds:number){
 for(let i=0;i<rounds;i++){
  watchdog.enter('bank');await phases.bank();
  watchdog.enter('individual');await phases.individual();
  watchdog.enter('bulk');await phases.bulk();
  watchdog.enter('pause');await phases.pause();
 }
}
const sleep=(ms:number)=>()=>new Promise(resolve=>setTimeout(resolve,ms));
const never=()=>new Promise(()=>{});

describe('import worker stall watchdog',()=>{
 it.each(['bank','individual','bulk','pause'] as const)('exits once with status 70 when the %s phase never returns',async stalled=>{
  vi.useFakeTimers();
  const log=vi.fn(),exit=vi.fn();
  const watchdog=startImportWorkerWatchdog({limitSeconds:1200,log,exit});
  const phases={bank:sleep(5),individual:sleep(5),bulk:sleep(5),pause:sleep(1000),[stalled]:never};
  void loop(watchdog,phases,3);
  // Not yet: exactly the limit has passed (the timer checks every 30 s).
  await vi.advanceTimersByTimeAsync(1200_000);
  expect(exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000+1_000);
  expect(exit).toHaveBeenCalledTimes(1);expect(exit).toHaveBeenCalledWith(IMPORT_WORKER_STALL_EXIT_CODE);
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0][0]).toMatch(new RegExp(`^Import worker stalled in ${stalled} for 12[0-3][0-9] s; exiting so systemd restarts it\\.$`));
  // A later check (if exit were slow) never logs or exits twice.
  await vi.advanceTimersByTimeAsync(120_000);
  expect(exit).toHaveBeenCalledTimes(1);expect(log).toHaveBeenCalledTimes(1);
  watchdog.stop();
 });

 it('never fires for normal ticks, including idle polling and the longest unit the kernel allows',async()=>{
  vi.useFakeTimers();
  const log=vi.fn(),exit=vi.fn();
  const watchdog=startImportWorkerWatchdog({limitSeconds:IMPORT_WORKER_STALL_DEFAULT_SECONDS,log,exit});
  // Idle polling: fast ticks and the 1 s pause, for about three limits.
  const idle=loop(watchdog,{bank:sleep(20),individual:sleep(20),bulk:sleep(40),pause:sleep(1000)},3_000);
  await vi.advanceTimersByTimeAsync(3_600_000);await idle;
  // A bulk-job prepare that uses its whole 900 s lease, every round, and a long Bank phase just under the limit.
  const busy=loop(watchdog,{bank:sleep(1_100_000),individual:sleep(10),bulk:sleep(900_000),pause:sleep(25)},3);
  await vi.advanceTimersByTimeAsync(3*(1_100_000+900_000+10+25)+1_000);await busy;
  expect(exit).not.toHaveBeenCalled();expect(log).not.toHaveBeenCalled();
  watchdog.stop();
 });

 it('measures each phase from when it was entered, not from the start of the loop',()=>{
  let now=0;const log=vi.fn(),exit=vi.fn();let tick=()=>{};
  const watchdog=startImportWorkerWatchdog({limitSeconds:1000,now:()=>now,log,exit,setInterval:fn=>{tick=fn;return{unref:()=>undefined};},clearInterval:()=>undefined});
  watchdog.enter('bank');now=900_000;tick();
  watchdog.enter('bulk');now=1_800_000;tick();
  expect(exit).not.toHaveBeenCalled();expect(watchdog.phase).toBe('bulk');
  now=1_900_001;expect(watchdog.check()).toBe(true);
  expect(log).toHaveBeenCalledWith('Import worker stalled in bulk for 1000 s; exiting so systemd restarts it.');
  expect(exit).toHaveBeenCalledWith(70);
 });

 it('unrefs its timer and clears it on stop',()=>{
  const unref=vi.fn(),clear=vi.fn(),timer={unref};let every=0;
  const watchdog=startImportWorkerWatchdog({limitSeconds:1200,setInterval:(_fn,ms)=>{every=ms;return timer;},clearInterval:clear,exit:vi.fn(),log:vi.fn()});
  expect(unref).toHaveBeenCalledTimes(1);expect(every).toBe(30_000);
  watchdog.stop();expect(clear).toHaveBeenCalledWith(timer);
 });

 it('does not keep a real Node process alive',()=>{
  // A process whose only remaining handle is the watchdog's timer ends at once, with the default 30 s check interval.
  const started=Date.now();
  const result=spawnSync(process.execPath,['--import','tsx','test/helpers/import-worker-watchdog-idle.ts'],
   {cwd:process.cwd(),encoding:'utf8',timeout:25_000,env:{NODE_ENV:'test',PATH:process.env.PATH,HOME:process.env.HOME}});
  expect(result.status,result.stderr+String(result.error??'')).toBe(0);
  expect(result.stdout).toContain('watchdog armed');
  expect(Date.now()-started).toBeLessThan(25_000);
 },60_000);

 it('reads its limit from the environment within bounds and refuses anything else with a clear message',()=>{
  expect(importWorkerStallSeconds({})).toBe(1200);
  expect(IMPORT_WORKER_STALL_DEFAULT_SECONDS).toBe(1200);
  for(const ok of [String(IMPORT_WORKER_STALL_MIN_SECONDS),'1200','3600',String(IMPORT_WORKER_STALL_MAX_SECONDS)])expect(importWorkerStallSeconds({[IMPORT_WORKER_STALL_ENV]:ok})).toBe(Number(ok));
  // 960 keeps the limit above the 900 s bulk-job prepare lease (core/bulk-job-worker.ts PREPARE_LEASE_SECONDS).
  expect(IMPORT_WORKER_STALL_MIN_SECONDS).toBeGreaterThan(900);
  for(const bad of ['','0','30','959','21601','1200.5','1e3',' 1200','1200 ','01200','-1200','abc','99999999999999999999']){
   expect(()=>importWorkerStallSeconds({[IMPORT_WORKER_STALL_ENV]:bad}),JSON.stringify(bad))
    .toThrow('AIHR_IMPORT_WORKER_STALL_SECONDS must be a whole number of seconds from 960 to 21600 (default 1200).');
  }
 });
});
