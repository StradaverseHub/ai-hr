/** Authored UNRUN. Exact snapshot semantics plus an isolated own-group subprocess; no DB/app/lease/provider. */
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';
import {parseAiDeliveryProcessMembers,type AiDeliveryProcessScan} from '../scripts/ai-delivery-process-members';
const scan=(stdout:string):AiDeliveryProcessScan=>({pid:102,status:0,signal:null,stdout});
it('excludes only the actual inspector PID and worker, retaining every live same-group unknown descendant',()=>{
 expect(parseAiDeliveryProcessMembers(scan('100 100 Ss\n102 100 R+\n103 100 S\n104 100 Z\n105 999 S\n106 100 S<\n0 0 S'),100)).toEqual([103,106]);
 expect(parseAiDeliveryProcessMembers(scan('100 100 Ss\n102 100 R+'),100)).toEqual([]);
});
it('never identifies an unrelated process as the inspector by its transient status or command assumptions',()=>{
 expect(parseAiDeliveryProcessMembers(scan('100 100 Ss\n102 100 R\n103 100 R'),100)).toEqual([103]);
});
it('refuses nonnatural, missing, malformed, conflicting or unconfirmed inspection results',()=>{
 const base=scan('100 100 Ss\n102 100 R');
 const bad:AiDeliveryProcessScan[]=[{...base,pid:undefined},{...base,pid:0},{...base,pid:NaN},{...base,pid:100},{...base,status:null},{...base,status:1},{...base,signal:'SIGTERM'},{...base,error:Error('Synthetic timeout')},{...base,stdout:''},{...base,stdout:Buffer.from('100 100 S')},scan('100 100 Ss\n102 999 R'),scan('100 999 Ss\n102 100 R'),scan('100 100 Ss\n102 100 R\n102 100 S'),scan('100 100 Ss\n102 100 R\nunknown row'),scan('100 100 Ss\n102 100 R\n9007199254740992 100 S')];
 for(const input of bad)expect(()=>parseAiDeliveryProcessMembers(input,100)).toThrow('could not be confirmed');
 for(const worker of [0,1,-1,NaN,1.5])expect(()=>parseAiDeliveryProcessMembers(base,worker)).toThrow();
});
it('observes a real isolated own-group descendant, then confirms only its known runtime baseline remains after actual child exit',async()=>{
 const helper=fileURLToPath(new URL('../scripts/ai-delivery-process-members.ts',import.meta.url)),loader=createRequire(import.meta.url).resolve('tsx');
 const code=`import {spawn} from 'node:child_process';import {ownedAiDeliveryProcessMembers} from ${JSON.stringify(helper)};const baseline=ownedAiDeliveryProcessMembers(process.pid);const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:false});try{await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});const before=ownedAiDeliveryProcessMembers(process.pid);if(!before.includes(child.pid))throw Error('Actual descendant missing');await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);child.kill('SIGTERM');});const after=ownedAiDeliveryProcessMembers(process.pid);if(JSON.stringify(after)!==JSON.stringify(baseline))throw Error('Unexpected owned descendants remain');console.log(JSON.stringify({before,after,baseline,childPid:child.pid,workerPid:process.pid}));}finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}`;
 const child=spawn(process.execPath,['--import',loader,'--input-type=module','-e',code],{detached:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr+=data;});
 const timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null&&child.pid)try{process.kill(-child.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}},10000);
 try{const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});expect(result,'Isolated process probe stderr: '+stderr.slice(0,5000)).toEqual({code:0,signal:null});expect(stderr).toBe('');const actual=JSON.parse(stdout.trim());expect(actual.before).toContain(actual.childPid);expect(actual.after).toEqual(actual.baseline);expect(actual.after).not.toContain(actual.childPid);expect(actual.workerPid).toBe(child.pid);}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null&&child.pid)try{process.kill(-child.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}
});
