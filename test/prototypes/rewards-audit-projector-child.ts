/** UNINSTALLED/nonpackaged fictional process proof. No application/owner pool. */
import postgres from 'postgres';
import {z} from 'zod';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.env.GITHUB_REPOSITORY!=='StradaverseHub/ai-hr'||!process.send)throw Error('Owned hosted Rewards child required');
const allowed=new Set(['PATH','TZ','LANG','GITHUB_ACTIONS','RUNNER_ENVIRONMENT','GITHUB_REPOSITORY']);if(Object.keys(process.env).some(key=>!allowed.has(key)))throw Error('Unsealed Rewards child environment');
globalThis.fetch=async()=>{throw Error('Rewards child cannot call providers/network');};
const request=z.object({kind:z.literal('start'),database:z.string(),projectorUrl:z.string(),pauseAfterCommit:z.boolean()}).strict();
const send=(value:object)=>new Promise<void>((resolve,reject)=>{process.send!(value,error=>error?reject(error):resolve());});
let started=false,release:(()=>void)|undefined;
process.on('message',async raw=>{
 if(raw&&typeof raw==='object'&&'kind'in raw&&raw.kind==='continue'){release?.();return;}
 if(started){process.exitCode=1;return;}started=true;let connection:ReturnType<typeof postgres>|undefined;
 try{
  const input=request.parse(raw),url=new URL(input.projectorUrl);
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.username!=='ai_hr_reward_audit_projector'||!url.password||url.pathname!=='/'+input.database||!input.database.startsWith('ai_hr_test_w')||url.search||url.hash)throw Error('Exact owned projector LOGIN required');
  connection=postgres(url.toString(),{max:1,connect_timeout:5,connection:{statement_timeout:20000,lock_timeout:300}});
  // FIRST native query proves the real LOGIN/profile. Resolution is after its
  // actual autocommit, never a caller-reported receipt/count.
  const [result]=await connection`select reward_audit_projection.materialize(1)as projected`;
  const [identity]=await connection`select pg_backend_pid()as pid,backend_start::text as started from pg_stat_activity where pid=pg_backend_pid()`;
  const paused=input.pauseAfterCommit?new Promise<void>(resolve=>{release=resolve;}):undefined;
  await send({kind:'committed',projected:result.projected,...identity});await paused;process.exitCode=0;
 }catch{process.exitCode=1;await send({kind:'refused'});}
 finally{await connection?.end({timeout:0});process.disconnect();}
});
void send({kind:'ready'}).catch(()=>{process.exitCode=1;process.disconnect();});
