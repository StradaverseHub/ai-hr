/** UNINSTALLED, nonpackaged functional witness. Never an installed worker entrypoint. */
import postgres from 'postgres';
import {z} from 'zod';
import {runNotificationProcess,type NotificationProcessTransition} from '../../../lib/notification-worker/process';
const start=z.object({kind:z.literal('start'),database:z.string(),workerUrl:z.string(),pauseAfterCommit:z.boolean()}).strict();
if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.env.GITHUB_REPOSITORY!=='StradaverseHub/ai-hr'||!process.send)throw Error('Owned hosted process fixture required');
const permitted=new Set(['PATH','TZ','LANG','GITHUB_ACTIONS','RUNNER_ENVIRONMENT','GITHUB_REPOSITORY','MODULE_KILL','SETTING_KILL']);
if(Object.keys(process.env).some(key=>!permitted.has(key)))throw Error('Unsealed process fixture environment');
globalThis.fetch=async()=>{throw Error('Process fixture cannot call network/providers');};
const send=(message:NotificationProcessTransition|{kind:'ready'}|{kind:'refused'})=>new Promise<void>((resolve,reject)=>{
 process.send!(message,error=>error?reject(error):resolve());
});
let used=false,stopping=false,release:(()=>void)|undefined;
for(const signal of ['SIGTERM','SIGINT']as const)process.on(signal,()=>{stopping=true;release?.();});
process.on('message',async raw=>{
 if(raw&&typeof raw==='object'&&'kind'in raw&&raw.kind==='continue'){release?.();return;}
 if(used){process.exitCode=1;return;}used=true;
 let connection:ReturnType<typeof postgres>|undefined;
 try{
  const request=start.parse(raw),url=new URL(request.workerUrl);
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.username!=='ai_hr_notification_worker'
   ||!url.password||url.pathname!=='/'+request.database||!request.database.startsWith('ai_hr_test_w')||url.search||url.hash)throw Error('Exact owned worker LOGIN required');
  connection=postgres(url.toString(),{max:1,connect_timeout:5,connection:{statement_timeout:20000,lock_timeout:300}});
  const result=await runNotificationProcess(connection,{stopping:()=>stopping,observe:async transition=>{
   if(transition.kind==='opened'||transition.kind==='committed'&&request.pauseAfterCommit){
    const continued=new Promise<void>(resolve=>{release=resolve;});await send(transition);await continued;release=undefined;
   }else await send(transition);
  }});
  process.exitCode=result.state==='failed'?2:0;
 }catch{
  // Unknown commit/transport outcomes are not replayed, repaired, or logged with credentials.
  process.exitCode=1;await send({kind:'refused'});
 }finally{await connection?.end({timeout:0});process.disconnect();}
});
void send({kind:'ready'}).catch(()=>{process.exitCode=1;process.disconnect();});
