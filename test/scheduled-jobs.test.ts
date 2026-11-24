/** The resident scheduler (scripts/lib/scheduled-jobs.ts) without a database: cadence, once-only admission through the
 * job lock, the cron-alert.sh contract per job (log block, heartbeat only on success, the three alert channels with the
 * status preserved), independence between jobs, output isolation, and drain on stop. The real advisory lock and the real
 * process are covered against PostgreSQL in test/scheduled-jobs-db.test.ts. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {
 cronAlertTimestamp,delayUntilNextStart,parseScheduledJobsArgs,pipeToCommand,reportScheduledRun,routeConsoleToJobs,runCaptured,
 startScheduler,type ScheduledJobSpec,type ScheduledRunOutcome,type SchedulerDeps,
} from '../scripts/lib/scheduled-jobs';
import type {ScheduledJobKey} from '../scripts/lib/scheduled-job-lock';

let dir:string;
beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'aihr-scheduled-jobs-'));});
afterEach(()=>{fs.rmSync(dir,{recursive:true,force:true});});

describe('arguments',()=>{
 it('reads the installed unit command line',()=>{
  expect(parseScheduledJobsArgs(['--log-dir','/home/u/aihr-cron-logs','--job','provision=every-minute','--job','notification-email=after-120s,alert-tail=0'],{})).toEqual({
   logDir:'/home/u/aihr-cron-logs',
   jobs:[{key:'provision',cadence:{kind:'every-minute'},alertTail:20},{key:'notification-email',cadence:{kind:'after',seconds:120},alertTail:0}],
  });
  expect(parseScheduledJobsArgs(['--log-dir','/l','--job','provision=every-minute'],{AIHR_ALERT_TAIL:'5'}).jobs[0].alertTail).toBe(5);
 });
 it.each([
  [['--job','provision=every-minute']],
  [['--log-dir','relative','--job','provision=every-minute']],
  [['--log-dir','/l']],
  [['--log-dir','/l','--job','payroll=every-minute']],
  [['--log-dir','/l','--job','provision=hourly']],
  [['--log-dir','/l','--job','provision=after-5s']],
  [['--log-dir','/l','--job','provision=every-minute','--job','provision=after-60s']],
  [['--log-dir','/l','--job','provision=every-minute,alert-tail=x']],
  [['--log-dir','/l','--job','provision=every-minute,retries=3']],
  [['--log-dir','/l','--log-dir','/m','--job','provision=every-minute']],
  [['--log-dir','/l','--job','provision=every-minute','--extra']],
 ])('refuses %j',argv=>{expect(()=>parseScheduledJobsArgs(argv,{})).toThrow();});
 it('refuses an invalid AIHR_ALERT_TAIL',()=>{expect(()=>parseScheduledJobsArgs(['--log-dir','/l','--job','provision=every-minute'],{AIHR_ALERT_TAIL:'-1'})).toThrow('AIHR_ALERT_TAIL');});
});

describe('cadence',()=>{
 it('every-minute waits for the next wall-clock minute and never starts twice in one',()=>{
  const minute=Date.UTC(2026,10,25,1,2,0);
  expect(delayUntilNextStart({kind:'every-minute'},minute)).toBe(60_000);
  expect(delayUntilNextStart({kind:'every-minute'},minute+59_999)).toBe(1);
  expect(delayUntilNextStart({kind:'every-minute'},minute+15_250)).toBe(44_750);
 });
 it('after-n waits n seconds after the previous run ended',()=>{expect(delayUntilNextStart({kind:'after',seconds:120},123)).toBe(120_000);});
});

/** A scheduler on a fake clock: every sleep advances the clock and yields to the event loop. */
function harness(jobs:ScheduledJobSpec[],opts:{held?:Set<ScheduledJobKey>;lockError?:ScheduledJobKey;releaseFails?:boolean;run:(job:ScheduledJobKey,n:number)=>Promise<number>}){
 let clock=Date.UTC(2026,10,25,1,0,30);
 const reports:ScheduledRunOutcome[]=[],journal:string[]=[],runs:ScheduledJobKey[]=[],released:ScheduledJobKey[]=[];
 const counts=new Map<ScheduledJobKey,number>();
 const deps:SchedulerDeps={
  now:()=>clock,
  sleep:async(ms,signal)=>{if(signal.aborted)return;clock+=ms;await new Promise(resolve=>setImmediate(resolve));},
  journal:text=>{journal.push(text);},
  report:async outcome=>{reports.push(outcome);},
  locks:{async tryLock(job){
   if(opts.lockError===job)throw new Error('connect ECONNREFUSED');
   if(opts.held?.has(job))return null;
   return {async release(){released.push(job);return !opts.releaseFails;}};
  }},
  run:job=>{runs.push(job);const n=(counts.get(job)??0)+1;counts.set(job,n);return opts.run(job,n);},
 };
 const scheduler=startScheduler(jobs,deps);
 return {scheduler,reports,journal,runs,released,clock:()=>clock};
}
async function until(check:()=>boolean){for(let i=0;i<10_000&&!check();i++)await new Promise(resolve=>setImmediate(resolve));expect(check()).toBe(true);}
const minute:ScheduledJobSpec={key:'provision',cadence:{kind:'every-minute'},alertTail:20};
const sweep:ScheduledJobSpec={key:'notification-email',cadence:{kind:'after',seconds:120},alertTail:0};

describe('scheduler',()=>{
 it('runs nothing while another process holds the job lock: no report, no heartbeat, a journal line only',async()=>{
  const h=harness([minute],{held:new Set(['provision']),run:async()=>0});
  await until(()=>h.journal.length>=3);
  await h.scheduler.stop();
  expect(h.runs).toEqual([]);expect(h.reports).toEqual([]);
  expect(h.journal[0]).toBe('Scheduled job provision: skipped, another process holds its lock.');
 });
 it('starts every-minute runs on whole minutes and releases the lock after each run',async()=>{
  const starts:number[]=[];
  const h=harness([minute],{run:async()=>{starts.push(h.clock());return 0;}});
  await until(()=>h.reports.length>=3);await h.scheduler.stop();
  expect(starts.slice(0,3).every(at=>at%60_000===0)).toBe(true);
  expect(new Set(starts).size).toBe(starts.length);
  expect(h.released.length).toBe(h.runs.length);
 });
 it('reports a failing job with its status and keeps scheduling it',async()=>{
  const h=harness([minute],{run:async n=>{console.log(`pass ${n}`);return 1;}});
  await until(()=>h.reports.length>=2);await h.scheduler.stop();
  expect(h.reports[0]).toMatchObject({job:'provision',status:1,alertTail:20});
 });
 it('turns a thrown job and an unreachable lock into a failed run, not a dead scheduler',async()=>{
  const h=harness([minute,sweep],{lockError:'provision',run:async()=>{throw new Error('relation does not exist');}});
  await until(()=>h.reports.some(r=>r.job==='provision')&&h.reports.some(r=>r.job==='notification-email'));await h.scheduler.stop();
  expect(h.reports.find(r=>r.job==='provision')).toMatchObject({status:1});
  expect(h.reports.find(r=>r.job==='provision')!.output).toContain('Could not take the provision lock: connect ECONNREFUSED');
  const thrown=h.reports.find(r=>r.job==='notification-email')!;
  expect(thrown.status).toBe(1);expect(thrown.output).toContain('Scheduled job threw: Error: relation does not exist');
 });
 it('never lets one failing or hanging job delay or mask the other job',async()=>{
  let releaseHang!:()=>void;const hang=new Promise<number>(resolve=>{releaseHang=()=>resolve(0);});
  const h=harness([minute,sweep],{run:(job,n)=>job==='notification-email'&&n===1?hang:Promise.resolve(job==='provision'?1:0)});
  // The sweep's first run hangs; provisioning keeps running and failing on its own minutes meanwhile.
  await until(()=>h.reports.filter(r=>r.job==='provision').length>=3);
  expect(h.reports.some(r=>r.job==='notification-email')).toBe(false);
  releaseHang();
  await until(()=>h.reports.filter(r=>r.job==='notification-email').length>=2);await h.scheduler.stop();
  expect(h.reports.filter(r=>r.job==='notification-email').every(r=>r.status===0)).toBe(true);
  expect(h.reports.filter(r=>r.job==='provision').every(r=>r.status===1)).toBe(true);
 });
 it('journals a lock connection lost during a run',async()=>{
  const h=harness([minute],{releaseFails:true,run:async()=>0});
  await until(()=>h.reports.length>=1);await h.scheduler.stop();
  expect(h.journal).toContain('Scheduled job provision: its lock connection was lost during the run.');
 });
 it('stop lets a run in flight finish, reports it, and starts nothing new',async()=>{
  let finish!:()=>void;let started=false;
  const h=harness([minute],{run:()=>{started=true;return new Promise<number>(resolve=>{finish=()=>resolve(0);});}});
  await until(()=>started);
  let stopped=false;const stopping=h.scheduler.stop().then(()=>{stopped=true;});
  await new Promise(resolve=>setImmediate(resolve));expect(stopped).toBe(false);
  finish();await stopping;
  expect(h.runs).toEqual(['provision']);expect(h.reports).toHaveLength(1);expect(h.reports[0].status).toBe(0);
 });
});

describe('output capture',()=>{
 it('keeps two concurrent jobs\' lines apart and away from the journal',async()=>{
  routeConsoleToJobs();
  const tick=()=>new Promise(resolve=>setImmediate(resolve));
  const [a,b]=await Promise.all([
   runCaptured(async()=>{console.log('a1');await tick();console.error('a2');await tick();console.log({a:3});return 0;}),
   runCaptured(async()=>{console.log('b1');await tick();console.warn('b2');return 1;}),
  ]);
  expect(a).toEqual({status:0,output:'a1\na2\n{ a: 3 }\n'});
  expect(b).toEqual({status:1,output:'b1\nb2\n'});
 });
 it('maps a non-status result to a failure',async()=>{expect((await runCaptured(async()=>Number.NaN)).status).toBe(1);});
});

describe('reporting: the cron-alert.sh contract',()=>{
 const outcome=(status:number,output='line 1\nline 2\nline 3\n',alertTail=2):ScheduledRunOutcome=>({
  job:'provision',status,output,alertTail,startedAt:new Date(2026,10,25,0,0,1),finishedAt:new Date(2026,10,25,0,0,6)});
 function deps(env:Record<string,string>={}){
  const piped:{command:string;args:readonly string[];input:string}[]=[],stdout:string[]=[],journal:string[]=[];
  return {piped,stdout,journal,deps:{logDir:path.join(dir,'logs'),env,host:'fixture-host',
   pipe:async(command:string,args:readonly string[],input:string)=>{piped.push({command,args,input});},
   stdout:(text:string)=>{stdout.push(text);},journal:(text:string)=>{journal.push(text);}}};
 }
 it('success: one dated block in the job log, the heartbeat touched, nobody alerted',async()=>{
  const d=deps();
  fs.mkdirSync(path.join(dir,'logs','heartbeat'),{recursive:true});
  const old=new Date(Date.now()-3_600_000);fs.writeFileSync(path.join(dir,'logs','heartbeat','provision'),'');fs.utimesSync(path.join(dir,'logs','heartbeat','provision'),old,old);
  await reportScheduledRun(outcome(0),d.deps);
  const log=fs.readFileSync(path.join(dir,'logs','provision.log'),'utf8');
  expect(log).toBe(`==== ${cronAlertTimestamp(new Date(2026,10,25,0,0,1))}  provision  start ====\nline 1\nline 2\nline 3\n==== ${cronAlertTimestamp(new Date(2026,10,25,0,0,6))}  provision  exit=0  5s ====\n`);
  expect(fs.statSync(path.join(dir,'logs','heartbeat','provision')).mtimeMs).toBeGreaterThan(Date.now()-60_000);
  expect(d.piped).toEqual([]);expect(d.stdout).toEqual([]);
 });
 it('failure: the status and output tail reach the journal at err, stdout and AIHR_ALERT_COMMAND; no heartbeat',async()=>{
  const d=deps({AIHR_ALERT_COMMAND:'cat >> /dev/null'});
  await reportScheduledRun(outcome(1),d.deps);
  const summary=`AI HR scheduled job FAILED: provision exit=1 after 5s on fixture-host at ${cronAlertTimestamp(new Date(2026,10,25,0,0,6))}. Full output: ${path.join(dir,'logs','provision.log')}\n--- last 2 lines ---\nline 2\nline 3\n`;
  expect(d.piped).toEqual([{command:'logger',args:['-t','aihr-cron','-p','user.err'],input:summary},{command:'sh',args:['-c','cat >> /dev/null'],input:summary}]);
  expect(d.stdout).toEqual([summary]);
  expect(fs.existsSync(path.join(dir,'logs','heartbeat','provision'))).toBe(false);
  expect(fs.readFileSync(path.join(dir,'logs','provision.log'),'utf8')).toContain('provision  exit=1  5s ====');
 });
 it('alert-tail 0 sends the status and the log path only, and AIHR_ALERT_TAG renames the journal tag',async()=>{
  const d=deps({AIHR_ALERT_TAG:'aihr-other'});
  await reportScheduledRun(outcome(3,'secret-ish output\n',0),d.deps);
  expect(d.piped).toHaveLength(1);expect(d.piped[0].args).toEqual(['-t','aihr-other','-p','user.err']);
  expect(d.piped[0].input).not.toContain('secret-ish');expect(d.piped[0].input).toContain('exit=3');
 });
 it('a log directory that cannot be written is journalled and every alert channel still fires',async()=>{
  const blocked=path.join(dir,'file');fs.writeFileSync(blocked,'');
  const d=deps();d.deps.logDir=path.join(blocked,'logs');
  await reportScheduledRun(outcome(1),d.deps);
  expect(d.journal[0]).toContain('its log block could not be written');
  expect(d.piped.map(p=>p.command)).toEqual(['logger']);expect(d.stdout).toHaveLength(1);
 });
 it('drives real commands: the alert command receives the summary and a broken one changes nothing',async()=>{
  const bin=path.join(dir,'bin'),sink=path.join(dir,'logger.txt'),alert=path.join(dir,'alert.txt');fs.mkdirSync(bin);
  // A fake `logger` that records its arguments and input, as test/cron-alert.test.ts does for the shell wrapper.
  fs.writeFileSync(path.join(bin,'logger'),`#!/bin/sh\necho "$@" >> ${JSON.stringify(sink)}\ncat >> ${JSON.stringify(sink)}\n`,{mode:0o755});
  const env={...process.env,PATH:`${bin}:${process.env.PATH}`};
  const real=deps({AIHR_ALERT_COMMAND:`cat >> ${JSON.stringify(alert)}`});
  real.deps.pipe=(command,args,input)=>pipeToCommand(command,args,input,env);
  await reportScheduledRun(outcome(7),real.deps);
  expect(fs.readFileSync(sink,'utf8')).toMatch(/^-t aihr-cron -p user\.err\nAI HR scheduled job FAILED: provision exit=7/);
  expect(fs.readFileSync(alert,'utf8')).toContain('AI HR scheduled job FAILED: provision exit=7');
  const broken=deps({AIHR_ALERT_COMMAND:'exit 9'});broken.deps.pipe=(command,args,input)=>pipeToCommand(command,args,input,{...env,PATH:'/nonexistent'});
  await expect(reportScheduledRun(outcome(1),broken.deps)).resolves.toBeUndefined();
  expect(broken.stdout).toHaveLength(1);
 });
});
