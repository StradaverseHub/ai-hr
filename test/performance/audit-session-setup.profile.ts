/** Actual owned Node process/profile lifecycle only; no application, database, provider or installation. */
import {spawn} from 'node:child_process';
import {mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {setTimeout as pause} from 'node:timers/promises';
import {expect,it} from 'vitest';
it('retains real CPU samples on controlled shutdown while preserving refusal outside hosted profiling',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'aihr-profile-exit-'));
 const hook=resolve('scripts/performance/profile-exit.mjs');
 const program="function cpuFixtureHotLoop(){let n=0;for(let i=0;i<100000;i++)n+=Math.sqrt(i);return n;} setInterval(cpuFixtureHotLoop,1);process.stdout.write('ready\\n');";
 const results=[];
 try{
  for(const phase of ['signal-only','controlled-exit']){
   const out=join(directory,phase);const args=['--cpu-prof','--cpu-prof-dir='+directory,'--cpu-prof-name='+phase+'.cpuprofile',...(phase==='controlled-exit'?['--import',hook]:[]),'-e',program];
   const child=spawn(process.execPath,args,{env:{...process.env},stdio:['ignore','pipe','pipe']});
   let error='';child.stderr.on('data',data=>{error+=String(data);});const exited=once(child,'exit');
   try{
    await Promise.race([once(child.stdout,'data'),exited.then(()=>{throw Error('Profiler fixture exited before ready: '+error);}),pause(3000).then(()=>{throw Error('Profiler fixture startup timeout');})]);
    await pause(250);child.kill(phase==='controlled-exit'?'SIGUSR2':'SIGTERM');
    const [code,signal]=await Promise.race([exited,pause(3000).then(()=>{throw Error('Profiler fixture shutdown timeout');})]);
    const files=readdirSync(directory).filter(name=>name===phase+'.cpuprofile');
    if(phase==='signal-only'){expect(signal).toBe('SIGTERM');expect(files).toEqual([]);}
    else{
     expect(code,error).toBe(0);expect(signal).toBeNull();expect(files).toHaveLength(1);
     const profile=JSON.parse(readFileSync(join(directory,files[0]),'utf8'));expect(profile.samples.length).toBeGreaterThan(0);
     expect(profile.nodes.some((node:{callFrame:{functionName:string}})=>node.callFrame.functionName==='cpuFixtureHotLoop')).toBe(true);
    }
    results.push({phase,code,signal,profileFiles:files.length});
   }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
  }
  const refused=spawn(process.execPath,['--cpu-prof','--cpu-prof-dir='+directory,'--import',hook,'-e','process.exit(0)'],{env:{...process.env,GITHUB_ACTIONS:'false'},stdio:'ignore'});
  const [code]=await once(refused,'exit');expect(code).not.toBe(0);
  writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'cpu-shutdown-probe.json'),JSON.stringify({kind:'OWNED_NODE_CPU_SHUTDOWN_ONLY',releaseEligible:false,results,nonHostedRefused:true},null,2));
 }finally{rmSync(directory,{recursive:true,force:true});}
});
