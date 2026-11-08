/** BLOCKED until root's exact closed hosted route/source registration. Native
 * miniature fixture qualification only; never ordinary compiler or release. */
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect,it} from 'vitest';
it('checks genuine native composite emission/reference/declaration fixture semantics',async context=>{
 const child=spawn(process.execPath,['--max-old-space-size=12288','.github/ci/diagnostics/native-reference/fixture.mjs'],{detached:true,stdio:['ignore','pipe','pipe']});
 let bytes=0,failed:unknown,killed=false,exited=false;const output:Buffer[]=[];
 const stop=()=>{if(!child.pid||exited)return;try{process.kill(-child.pid,'SIGKILL');killed=true;}catch(error){if(!child.exitCode&&!child.signalCode)failed??=error;}};
 const deadline=setTimeout(stop,720000);context.signal.addEventListener('abort',stop,{once:true});if(context.signal.aborted)stop();
 const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>{child.once('error',error=>{failed=error;});child.once('close',(code,signal)=>{exited=true;resolve({code,signal});});});
 context.onTestFinished(async()=>{stop();await closed;});
 for(const stream of [child.stdout,child.stderr]){if(!stream){failed=Error('Owned native wrapper pipe missing');stop();continue;}stream.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes<=1024*1024)output.push(chunk);else{failed=Error('Native fixture wrapper output bound');stop();}});}
 try{const result=await closed;expect(failed).toBeUndefined();expect(killed).toBe(false);expect(result.signal).toBeNull();expect(result.code,Buffer.concat(output).toString('utf8')).toBe(0);
  const report=JSON.parse(readFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'compiler-native-reference/report.json'),'utf8'));expect(report.complete).toBe(true);expect(report.ordinaryCompilerQualified).toBe(false);expect(report.releaseAuthorized).toBe(false);expect(report.applicationInventoryComplete).toBe(false);expect(report.originalApplicationFiveNegativesQualified).toBe(false);expect(report.elapsedMs).toBeLessThanOrEqual(720000);
 }finally{clearTimeout(deadline);context.signal.removeEventListener('abort',stop);if(child.exitCode===null&&child.signalCode===null)stop();await closed;}
},720000);
