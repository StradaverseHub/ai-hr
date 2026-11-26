/** Resident scheduled maintenance jobs (ADR 0181; owner decision 25 Nov 2026, "B: app-side process").
 *
 *   node --env-file=.env.production --import tsx scripts/scheduled-jobs.ts \
 *     --log-dir /home/ubuntu/aihr-cron-logs --job provision=every-minute --job notification-email=after-120s,alert-tail=0
 *
 * One long-running process replaces the provisioning runner's crontab line and the notification sweep's user timer.
 * It runs as the same user, from the same checkout, with the same .env.production and the same MIGRATION_DATABASE_URL
 * login, so roles, privileges and the notification projection's SET ROLE edge are unchanged. What changes: the HR
 * module graph is loaded once instead of every minute, and each job keeps its owner pool open between passes, so
 * statements plan warm instead of on a new connection each minute. Installed as aihr-scheduled-jobs.service
 * (deploy/systemd/aihr-scheduled-jobs.service, deploy/DEPLOY.md); deploy.sh restarts it after a release.
 *
 * Exit status: 0 after SIGTERM/SIGINT once runs in flight have finished; 2 for invalid arguments or configuration;
 * 1 when the scheduler could not start. systemd restarts it on anything but a clean stop.
 *
 * Only node builtins are imported statically: the parent respawns under `--conditions=react-server` (the runtime the
 * notification sweep needs, test/react-server-entry-graphs.test.ts) and must not load the HR graph first. */
import {spawn} from 'node:child_process';

async function main(){
 const {parseScheduledJobsArgs,startScheduler,reportScheduledRun,pipeToCommand,routeConsoleToJobs}=await import('./lib/scheduled-jobs');
 const {openScheduledJobLocks,withApplicationName}=await import('./lib/scheduled-job-lock');
 const config=(()=>{
  try{return parseScheduledJobsArgs(process.argv.slice(2));}
  catch(error){console.error(`✗ ${(error as Error).message}`);return null;}
 })();
 if(!config){process.exitCode=2;return;}
 const url=process.env.MIGRATION_DATABASE_URL;
 if(!url){console.error('✗ scheduled-jobs needs MIGRATION_DATABASE_URL (run it from /opt/ai-hr with --env-file=.env.production).');process.exitCode=2;return;}
 const {createDb,client}=await import('../db/client');
 // Every job's code is loaded before the first run, so this process holds one release until it is restarted.
 const runners=new Map<string,()=>Promise<number>>();const owners:ReturnType<typeof createDb>[]=[];
 for(const job of config.jobs){
  // One owner pool per job, each the size its own process had (2), told apart in pg_stat_activity by name.
  const owner=createDb(withApplicationName(url,`aihr-scheduled-${job.key}`),{max:2});owners.push(owner);
  if(job.key==='provision'){
   const provision=await import('./provision-runner');await provision.preloadProvisionPass();
   runners.set(job.key,()=>provision.runProvisionPass(owner));
  }else{
   const sweep=await import('./notification-email-sweep');await sweep.loadNotificationSweepModules();
   runners.set(job.key,()=>sweep.runNotificationSweepPass(owner));
  }
 }
 const locks=openScheduledJobLocks(url,'aihr-scheduled-jobs-lock');
 const journal=(text:string)=>process.stderr.write(text+'\n');
 routeConsoleToJobs();
 const scheduler=startScheduler(config.jobs,{
  locks,run:job=>runners.get(job)!(),journal,
  report:outcome=>reportScheduledRun(outcome,{logDir:config.logDir,env:process.env,pipe:(command,args,input)=>pipeToCommand(command,args,input),
   stdout:text=>process.stdout.write(text),journal}),
 });
 // Type=notify (deploy/scheduled-jobs/aihr-scheduled-jobs.service): ready only now, after every job's code has loaded.
 if(process.env.NOTIFY_SOCKET)await pipeToCommand('systemd-notify',['--ready'],'');
 journal(`Scheduled jobs started (pid ${process.pid}):${config.jobs.map(job=>`${job.key} ${job.cadence.kind==='every-minute'?'every minute':`${job.cadence.seconds} s after each run`}`).join('; ')}. Logs: ${config.logDir}.`);
 let stopRequested=false;
 for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{
  if(stopRequested)return;stopRequested=true;
  journal(`Scheduled jobs stopping (${signal}): no new runs; waiting for runs in flight.`);
  void scheduler.stop();
 });
 await scheduler.done;
 await locks.end().catch(()=>undefined);
 for(const owner of owners)await owner.client.end({timeout:5}).catch(()=>undefined);
 await client.end({timeout:5}).catch(()=>undefined);
 journal('Scheduled jobs stopped.');
 // A job may leave an unref'd timer or a socket behind; the stop was clean, so say so explicitly.
 process.exit(0);
}

if(!process.execArgv.includes('--conditions=react-server')){
 const child=spawn(process.execPath,['--conditions=react-server',...process.execArgv,...process.argv.slice(1)],{stdio:'inherit',env:process.env});
 child.once('error',()=>{console.error('Scheduled jobs server runtime unavailable.');process.exitCode=1;});
 child.once('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
 for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>child.kill(signal));
}else main().catch(error=>{console.error(`Scheduled jobs could not start: ${error instanceof Error?error.message:String(error)}`);process.exitCode=1;});
