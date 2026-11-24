/** The resident scheduler behind scripts/scheduled-jobs.ts (ADR 0181; owner decision 25 Nov 2026, "B: app-side process").
 *
 * The minute jobs used to cold-start `node --import tsx` every minute from cron or a user timer. Each start opened
 * fresh direct database connections that planned every statement cold under row security. This module runs the same
 * job passes in one long-running process, as the same OS user, from the same /opt/ai-hr checkout, with the same
 * .env.production. Each job keeps what cron and the timer gave it:
 *
 *   cadence   `every-minute` starts at each wall-clock minute (cron's `* * * * *`); a run still going at the next
 *             minute makes the scheduler skip to the first minute after it ends, as `flock -n` did.
 *             `after-<n>s` starts n seconds after the previous run ended, and n seconds after process start
 *             (the notification timer's OnUnitInactiveSec / OnBootSec).
 *   once-only a PostgreSQL session advisory lock per job (scripts/lib/scheduled-job-lock.ts). A busy lock skips
 *             the run silently: no log block, no heartbeat, no alert, as `flock -n` did.
 *   alerting  the deploy/cron-alert.sh contract, per job: a dated block in the job's own log file, the heartbeat
 *             file touched only on success, and on a non-zero status one summary to the journal at priority err
 *             (`logger -t aihr-cron -p user.err`), to stdout and to AIHR_ALERT_COMMAND on stdin. The existing
 *             staleness lines in the crontab keep reading the same heartbeat files.
 *
 * Jobs run independently: one job failing, hanging or throwing never delays, skips or masks another job's run,
 * heartbeat or alert. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {spawn,type ChildProcess} from 'node:child_process';
import {appendFile,mkdir,utimes,writeFile} from 'node:fs/promises';
import {hostname} from 'node:os';
import {join} from 'node:path';
import {format} from 'node:util';
import {SCHEDULED_JOB_KEYS,type HeldScheduledJobLock,type ScheduledJobKey,type ScheduledJobLocks} from './scheduled-job-lock';

export type ScheduledCadence={kind:'every-minute'}|{kind:'after';seconds:number};
export type ScheduledJobSpec={key:ScheduledJobKey;cadence:ScheduledCadence;alertTail:number};
export type ScheduledJobsConfig={logDir:string;jobs:ScheduledJobSpec[]};

/** cron-alert.sh's default tail; AIHR_ALERT_TAIL overrides it for every job, `alert-tail=` for one. */
export const DEFAULT_ALERT_TAIL=20;
/** A job's captured output kept for its log block; beyond it the block says how much was dropped. */
export const MAX_CAPTURED_OUTPUT_BYTES=4*1024*1024;

/** `--log-dir <dir> --job <key>=every-minute|after-<n>s[,alert-tail=<n>] ...`. Refuses anything else. */
export function parseScheduledJobsArgs(argv:readonly string[],env:Readonly<Record<string,string|undefined>>=process.env):ScheduledJobsConfig{
 let logDir:string|undefined;const jobs:ScheduledJobSpec[]=[];
 const envTail=env.AIHR_ALERT_TAIL===undefined||env.AIHR_ALERT_TAIL===''?DEFAULT_ALERT_TAIL:boundedInteger(env.AIHR_ALERT_TAIL,'AIHR_ALERT_TAIL',0,1000);
 for(let i=0;i<argv.length;i++){
  const flag=argv[i],value=argv[i+1];
  if(flag==='--log-dir'&&value&&!logDir){logDir=value;i++;continue;}
  if(flag==='--job'&&value){jobs.push(parseJob(value,envTail));i++;continue;}
  throw new Error(`Unknown or repeated scheduled-jobs argument: ${flag}`);
 }
 if(!logDir||!logDir.startsWith('/'))throw new Error('scheduled-jobs needs --log-dir with an absolute path.');
 if(!jobs.length)throw new Error('scheduled-jobs needs at least one --job.');
 if(new Set(jobs.map(job=>job.key)).size!==jobs.length)throw new Error('scheduled-jobs: each job may be listed once.');
 return {logDir,jobs};
}
function parseJob(value:string,envTail:number):ScheduledJobSpec{
 const [head,...options]=value.split(',');const [key,cadenceText]=head.split('=');
 if(!(SCHEDULED_JOB_KEYS as readonly string[]).includes(key))throw new Error(`Unknown scheduled job: ${key}`);
 let cadence:ScheduledCadence;
 if(cadenceText==='every-minute')cadence={kind:'every-minute'};
 else{const match=/^after-(\d+)s$/.exec(cadenceText??'');if(!match)throw new Error(`Unknown cadence for ${key}: ${cadenceText}`);cadence={kind:'after',seconds:boundedInteger(match[1],`${key} cadence`,10,86_400)};}
 let alertTail=envTail;
 for(const option of options){const [name,raw]=option.split('=');if(name!=='alert-tail'||raw===undefined)throw new Error(`Unknown option for ${key}: ${option}`);alertTail=boundedInteger(raw,`${key} alert-tail`,0,1000);}
 return {key:key as ScheduledJobKey,cadence,alertTail};
}
function boundedInteger(raw:string,name:string,min:number,max:number):number{
 if(!/^\d+$/.test(raw))throw new Error(`${name} must be an integer from ${min} to ${max}.`);
 const value=Number(raw);if(value<min||value>max)throw new Error(`${name} must be an integer from ${min} to ${max}.`);
 return value;
}

/** Milliseconds from `now` until the next start. every-minute: the next whole minute (never 0, so a run that ends in
 * the same second it started cannot start twice). after-n: n seconds. */
export function delayUntilNextStart(cadence:ScheduledCadence,now:number):number{
 if(cadence.kind==='after')return cadence.seconds*1000;
 return 60_000-(now%60_000);
}

// ── Output capture ──────────────────────────────────────────────────────────────────────────────────
// Both jobs write their progress with console.*. While a job runs, its lines go to that job's buffer (and from there to
// its own log file, as cron-alert.sh's redirect did); lines outside any job go to the journal unchanged. Two jobs
// running at once never mix their lines because each await chain carries its own store.
type Capture={lines:string[];bytes:number;dropped:number};
const capture=new AsyncLocalStorage<Capture>();
let consoleRouted=false;
export function routeConsoleToJobs():void{
 if(consoleRouted)return;consoleRouted=true;
 for(const method of ['log','info','warn','error','debug'] as const){
  const original=console[method].bind(console);
  console[method]=(...args:unknown[])=>{
   const store=capture.getStore();
   if(!store)return original(...args);
   const line=format(...args);const size=Buffer.byteLength(line)+1;
   if(store.bytes+size>MAX_CAPTURED_OUTPUT_BYTES){store.dropped++;return;}
   store.lines.push(line);store.bytes+=size;
  };
 }
}
/** Runs fn with console output captured; a thrown error becomes status 1 with its message in the output. */
export async function runCaptured(fn:()=>Promise<number>):Promise<{status:number;output:string}>{
 const store:Capture={lines:[],bytes:0,dropped:0};
 let status:number;
 try{status=await capture.run(store,fn);}
 catch(error){status=1;store.lines.push(`Scheduled job threw: ${error instanceof Error?`${error.name}: ${error.message}`:String(error)}`);}
 if(store.dropped)store.lines.push(`… ${store.dropped} further output line(s) dropped after ${MAX_CAPTURED_OUTPUT_BYTES} bytes.`);
 return {status:Number.isInteger(status)&&status>=0&&status<=255?status:1,output:store.lines.length?store.lines.join('\n')+'\n':''};
}

// ── Reporting: the deploy/cron-alert.sh contract ───────────────────────────────────────────────────
/** `date +%Y-%m-%dT%H:%M:%S%z` in the process time zone, as cron-alert.sh writes it. */
export function cronAlertTimestamp(at:Date):string{
 const pad=(n:number)=>String(Math.abs(n)).padStart(2,'0');
 const offset=-at.getTimezoneOffset();const sign=offset<0?'-':'+';
 return `${at.getFullYear()}-${pad(at.getMonth()+1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}${sign}${pad(Math.trunc(offset/60))}${pad(offset%60)}`;
}
export type ScheduledRunOutcome={job:ScheduledJobKey;startedAt:Date;finishedAt:Date;status:number;output:string;alertTail:number};
export type ReportDeps={
 logDir:string;
 env:Readonly<Record<string,string|undefined>>;
 /** Runs a command with text on stdin and resolves when it exits; never rejects. */
 pipe(command:string,args:readonly string[],input:string):Promise<void>;
 stdout(text:string):void;
 /** The process's own journal line when the report itself could not be written (a full disk, a removed directory). */
 journal(text:string):void;
 host?:string;
};
export function scheduledJobLogFile(logDir:string,job:ScheduledJobKey):string{return join(logDir,`${job}.log`);}

/** Never throws: a broken alert channel must not end the scheduler or change another channel. */
export async function reportScheduledRun(outcome:ScheduledRunOutcome,deps:ReportDeps):Promise<void>{
 const logFile=scheduledJobLogFile(deps.logDir,outcome.job);
 const heartbeatDir=deps.env.AIHR_HEARTBEAT_DIR||join(deps.logDir,'heartbeat');
 const elapsed=Math.max(0,Math.round((outcome.finishedAt.getTime()-outcome.startedAt.getTime())/1000));
 const finished=cronAlertTimestamp(outcome.finishedAt);
 try{
  await mkdir(deps.logDir,{recursive:true});
  await appendFile(logFile,`==== ${cronAlertTimestamp(outcome.startedAt)}  ${outcome.job}  start ====\n${outcome.output}==== ${finished}  ${outcome.job}  exit=${outcome.status}  ${elapsed}s ====\n`);
 }catch(error){deps.journal(`Scheduled job ${outcome.job}: its log block could not be written (${(error as NodeJS.ErrnoException).code??'error'}).`);}
 if(outcome.status===0){
  // Proof of life for the staleness checks, touched ONLY on success: a job failing every minute must not look alive.
  try{const file=join(heartbeatDir,outcome.job),at=new Date();await mkdir(heartbeatDir,{recursive:true});await writeFile(file,'');await utimes(file,at,at);}
  catch(error){deps.journal(`Scheduled job ${outcome.job}: its heartbeat could not be written (${(error as NodeJS.ErrnoException).code??'error'}).`);}
  return;
 }
 let summary=`AI HR scheduled job FAILED: ${outcome.job} exit=${outcome.status} after ${elapsed}s on ${deps.host??shortHost()} at ${finished}. Full output: ${logFile}`;
 if(outcome.alertTail>0)summary+=`\n--- last ${outcome.alertTail} lines ---\n${outcome.output.split('\n').filter((_,i,all)=>i<all.length-1||all[i]!=='').slice(-outcome.alertTail).join('\n')}`;
 // 1. The journal at priority err, under the tag the existing alert items watch.
 await deps.pipe('logger',['-t',deps.env.AIHR_ALERT_TAG||'aihr-cron','-p','user.err'],summary+'\n');
 // 2. stdout (the service's journal), where cron's mail path used to pick it up.
 deps.stdout(summary+'\n');
 // 3. Whatever the owner reads. Never allowed to change anything else.
 if(deps.env.AIHR_ALERT_COMMAND)await deps.pipe('sh',['-c',deps.env.AIHR_ALERT_COMMAND],summary+'\n');
}
function shortHost():string{try{return hostname().split('.')[0]||'unknown';}catch{return 'unknown';}}

/** Spawns a command, writes input to its stdin and waits for it; a missing binary or a failure resolves the same. */
export function pipeToCommand(command:string,args:readonly string[],input:string,env:NodeJS.ProcessEnv=process.env):Promise<void>{
 return new Promise(resolve=>{
  let child:ChildProcess;
  try{child=spawn(command,[...args],{stdio:['pipe','ignore','ignore'],env});}catch{resolve();return;}
  const running=child;
  const timer=setTimeout(()=>{running.kill('SIGKILL');},30_000);timer.unref();
  running.once('error',()=>{clearTimeout(timer);resolve();});
  running.once('close',()=>{clearTimeout(timer);resolve();});
  running.stdin?.on('error',()=>undefined);
  running.stdin?.end(input);
 });
}

// ── The scheduler ─────────────────────────────────────────────────────────────────────────────────
export type SchedulerDeps={
 locks:Pick<ScheduledJobLocks,'tryLock'>;
 run(job:ScheduledJobKey):Promise<number>;
 report(outcome:ScheduledRunOutcome):Promise<void>;
 journal(text:string):void;
 now?():number;
 /** Resolves after ms, or as soon as the signal aborts. */
 sleep?(ms:number,signal:AbortSignal):Promise<void>;
};
export type RunningScheduler={
 /** Stops starting runs, lets runs in flight finish, and resolves when every job loop has ended. */
 stop():Promise<void>;
 /** Resolves when every job loop has ended (only after stop()). */
 done:Promise<void>;
};

function abortableSleep(ms:number,signal:AbortSignal):Promise<void>{
 return new Promise(resolve=>{
  if(signal.aborted)return resolve();
  const timer=setTimeout(done,ms);
  function done(){clearTimeout(timer);signal.removeEventListener('abort',done);resolve();}
  signal.addEventListener('abort',done,{once:true});
 });
}

export function startScheduler(jobs:readonly ScheduledJobSpec[],deps:SchedulerDeps):RunningScheduler{
 const stopping=new AbortController();
 const now=deps.now??Date.now,sleep=deps.sleep??abortableSleep;
 async function attempt(spec:ScheduledJobSpec):Promise<void>{
  const startedAt=new Date(now());
  let held:HeldScheduledJobLock|null;
  try{held=await deps.locks.tryLock(spec.key);}
  catch(error){
   // The database is unreachable before the job even starts: cron would have run the job and seen it fail to connect.
   await deps.report({job:spec.key,startedAt,finishedAt:new Date(now()),status:1,alertTail:spec.alertTail,
    output:`Could not take the ${spec.key} lock: ${error instanceof Error?error.message:String(error)}\n`});
   return;
  }
  if(!held){deps.journal(`Scheduled job ${spec.key}: skipped, another process holds its lock.`);return;}
  let result:{status:number;output:string};
  try{result=await runCaptured(()=>deps.run(spec.key));}
  finally{
   const released=await held.release().catch(()=>false);
   if(!released)deps.journal(`Scheduled job ${spec.key}: its lock connection was lost during the run.`);
  }
  await deps.report({job:spec.key,startedAt,finishedAt:new Date(now()),status:result.status,output:result.output,alertTail:spec.alertTail});
 }
 async function loop(spec:ScheduledJobSpec):Promise<void>{
  while(!stopping.signal.aborted){
   await sleep(delayUntilNextStart(spec.cadence,now()),stopping.signal);
   if(stopping.signal.aborted)break;
   try{await attempt(spec);}
   catch(error){deps.journal(`Scheduled job ${spec.key}: the scheduler could not finish this run (${error instanceof Error?error.message:String(error)}).`);}
  }
 }
 const done=Promise.all(jobs.map(loop)).then(()=>undefined);
 return {done,stop(){stopping.abort();return done;}};
}
