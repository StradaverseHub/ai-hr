/** Parent fixture only. Only the dedicated projector URL crosses private IPC. */
import {spawn} from 'node:child_process';
import {expect} from 'vitest';
import type {RewardsAuditFixtureOwner} from './rewards-audited-read-owner';
type Message={kind:string;pid?:number;started?:string;projected?:number};
export async function rewardAuditProjectorProcess(fixture:RewardsAuditFixtureOwner,signal:AbortSignal){
 const child=spawn(process.execPath,['--import','tsx','test/prototypes/rewards-audit-projector-child.ts'],{cwd:process.cwd(),env:{PATH:process.env.PATH,TZ:'UTC',LANG:'en_US.UTF-8',GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr'},stdio:['ignore','pipe','pipe','ipc']});
 let output='';const messages:Message[]=[],wake=new Set<()=>void>();
 child.stdout?.on('data',value=>{output+=String(value);if(output.length>16384)child.kill('SIGKILL');});child.stderr?.on('data',value=>{output+=String(value);if(output.length>16384)child.kill('SIGKILL');});
 child.on('message',raw=>{if(raw&&typeof raw==='object'&&'kind'in raw&&typeof raw.kind==='string'){messages.push(raw as Message);for(const notify of wake)notify();}});
 const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{resolve({code,signal});for(const notify of wake)notify();});});void closed.catch(()=>{});
 const abort=()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 const wait=(kind:string)=>new Promise<Message>((resolve,reject)=>{
  const timer=setTimeout(()=>{wake.delete(check);reject(Error('Fixed Rewards process transition missing: '+kind));},10000);
  function check(){const message=messages.find(row=>row.kind===kind);if(message){clearTimeout(timer);wake.delete(check);resolve(message);}else if(child.exitCode!==null||child.signalCode!==null){clearTimeout(timer);wake.delete(check);reject(Error('Rewards child exited before '+kind));}}wake.add(check);check();
 });
 const stop=async()=>{abort();try{await closed;expect(output).not.toMatch(/postgres(?:ql)?:\/\/|password=/i);}finally{signal.removeEventListener('abort',abort);}};
 try{await wait('ready');}catch(error){await stop();throw error;}
 return{child,closed,wait,start(pauseAfterCommit:boolean){signal.throwIfAborted();child.send({kind:'start',database:fixture.database,projectorUrl:fixture.projectorUrl,pauseAfterCommit});},stop};
}
