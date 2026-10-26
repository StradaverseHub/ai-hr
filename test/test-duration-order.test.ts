/** Actual Vitest sequencing controls; private two-file children, no application or database. */
import {it,expect} from 'vitest';
import {BaseSequencer,type TestSpecification} from 'vitest/node';
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync,copyFileSync,realpathSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import DurationSequencer from '../scripts/test-duration-sequencer.mjs';
const repo=realpathSync(fileURLToPath(new URL('..',import.meta.url)));
/** A synchronous spawn has no detached option: await an owned process group instead. */
function runChild(args:string[],env:NodeJS.ProcessEnv,timeoutMs=12000,maxBuffer=1024*1024){
 return new Promise<{status:number|null;signal:NodeJS.Signals|null;error?:Error;stdout:string;stderr:string;pid?:number}>((resolve)=>{
  const child=spawn(process.execPath,args,{cwd:repo,env,detached:true,stdio:['ignore','pipe','pipe']});
  const output:{stdout:Buffer[];stderr:Buffer[]}={stdout:[],stderr:[]},sizes={stdout:0,stderr:0};let failure:Error|undefined;
  const stop=()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')failure??=error as Error;}};
  const timer=setTimeout(()=>{failure??=new Error('Private child exceeded its time bound');stop();},timeoutMs);
  for(const stream of ['stdout','stderr'] as const)child[stream].on('data',(chunk:Buffer)=>{
   const remaining=Math.max(0,maxBuffer-sizes[stream]);output[stream].push(chunk.subarray(0,remaining));sizes[stream]+=chunk.length;
   if(sizes[stream]>maxBuffer){failure??=new Error('Private child exceeded its output bound');stop();}
  });
  child.on('error',error=>{failure??=error;});
  child.on('close',(status,signal)=>{clearTimeout(timer);stop();resolve({status,signal,error:failure,stdout:Buffer.concat(output.stdout).toString('utf8'),stderr:Buffer.concat(output.stderr).toString('utf8'),pid:child.pid});});
 });
}
function specification(file:string,name='node',groupOrder=0,isolate=true){return {moduleId:join(repo,file),project:{name,config:{sequence:{groupOrder},isolate}}} as unknown as TestSpecification;}
it('actual sequencer retains failure priority, project boundaries, all specifications and base sharding',async()=>{
 const specs=[specification('test/a-unknown.test.ts'),specification('test/r395-write-path-equivalence.test.ts'),specification('test/z-unknown.test.ts')];
 const context={config:{root:repo,shard:{index:1,count:2}},cache:{getFileTestResults:()=>undefined,getFileStats:()=>({size:1})}} as unknown as ConstructorParameters<typeof BaseSequencer>[0];
 const ordered=new DurationSequencer(context);expect((await ordered.sort(specs))[0]).toBe(specs[1]);expect(await ordered.shard(specs)).toEqual(await new BaseSequencer(context).shard(specs));
 const failed={...context,cache:{getFileTestResults:(key:string)=>key.endsWith('a-unknown.test.ts')?{failed:true,duration:1}:undefined,getFileStats:()=>({size:1})}} as unknown as ConstructorParameters<typeof BaseSequencer>[0];
 expect((await new DurationSequencer(failed).sort(specs))[0]).toBe(specs[0]);expect(specs.map(s=>s.moduleId)).toEqual(['a-unknown','r395-write-path-equivalence','z-unknown'].map(n=>join(repo,'test',n+'.test.ts')));
 const earlier=specification('test/a-new.test.ts','earlier'),group=specification('test/z-new.test.ts','z',-1);
 expect(await ordered.sort([specs[1],earlier,group])).toEqual([group,earlier,specs[1]]);
});
it('actual Vitest starts the known long file before a larger short source and runs both unchanged cases',async()=>{
 const scratch=join(repo,'scratchpad');mkdirSync(scratch,{recursive:true});const root=mkdtempSync(join(scratch,'duration-sequence-'));
 const proof:{kind:string;phases:Record<string,unknown>[];ownedFixtureRemoved?:boolean}={kind:'PRIVATE_REAL_VITEST_ORDERING_NOT_APPLICATION_OR_RELEASE',phases:[]};
 try{
  mkdirSync(join(root,'test'));
  const body=(label:string)=>["import {it,expect} from 'vitest';import {appendFileSync} from 'node:fs';",'it('+JSON.stringify(label)+',()=>{appendFileSync(process.env.ORDER_TRACE_FILE!,'+JSON.stringify(label+'\n')+');expect(2+2).toBe(4);});',''].join('\n');
  writeFileSync(join(root,'test/a-bulky-short.test.ts'),body('short')+'\n/*'+'.'.repeat(160000)+'*/\n');
  writeFileSync(join(root,'test/r395-write-path-equivalence.test.ts'),body('long'));
  for(const phase of ['baseline','duration']){
   const trace=join(root,phase+'.trace'),output=join(root,phase+'.json'),config=join(root,phase+'.config.mts');
   // Observe the installed base decision before asserting the fixture's assumed order.
   // The wrapper delegates unchanged sorting; it cannot choose or replace any specification.
   const details=join(root,phase+'.sequence.json');
   const chosen="import {writeFileSync} from 'node:fs';import {relative} from 'node:path';"+(phase==='baseline'?"import {BaseSequencer as Delegate} from 'vitest/node';":'import Delegate from '+JSON.stringify(join(repo,'scripts/test-duration-sequencer.mjs'))+';')+
    'class Sequencer extends Delegate{async sort(files){const out=await super.sort(files);writeFileSync('+JSON.stringify(details)+',JSON.stringify({root:this.ctx.config.root,maxWorkers:this.ctx.config.maxWorkers,input:files.map(s=>{const key=s.project.name+":"+relative(this.ctx.config.root,s.moduleId);return {file:s.moduleId,key,stats:this.ctx.cache.getFileStats(key),state:this.ctx.cache.getFileTestResults(key)}}),output:out.map(s=>s.moduleId)}));return out;}}';
   writeFileSync(config,"import {defineConfig} from 'vitest/config';"+chosen+'export default defineConfig({root:'+JSON.stringify(root)+',cacheDir:'+JSON.stringify(join(root,'cache-'+phase))+",test:{include:['test/*.test.ts'],globalSetup:[],setupFiles:[],maxWorkers:1,fileParallelism:false,sequence:{sequencer:Sequencer},testTimeout:5000,hookTimeout:5000}});");
   const result=await runChild([join(repo,'node_modules/vitest/vitest.mjs'),'run','--root',root,'--config',config,'--reporter=json','--outputFile='+output],{...process.env,VITEST_MAX_WORKERS:'1',VITEST_MAX_WORKERS_NODB:'1',ORDER_TRACE_FILE:trace});
   const record={phase,exit:result.status,signal:result.signal,error:result.error?.message};proof.phases.push(record);
   const destination=process.env.AIHR_FOCUSED_EVIDENCE_DIR;
   if(destination){const out=join(destination,'duration-sequence-smoke');mkdirSync(out,{recursive:true});if(existsSync(output))copyFileSync(output,join(out,phase+'.vitest.json'));if(existsSync(details))copyFileSync(details,join(out,phase+'.sequence.json'));writeFileSync(join(out,phase+'.log'),(result.stdout??'')+(result.stderr??''));}
   expect(result.error,result.stderr).toBeUndefined();expect(result.status,result.stderr).toBe(0);expect(result.signal).toBeNull();
   const report=JSON.parse(readFileSync(output,'utf8')),order=readFileSync(trace,'utf8').trim().split('\n');
   const sequencing=JSON.parse(readFileSync(details,'utf8'));expect(sequencing.maxWorkers).toBe(1);
   Object.assign(record,{order,effectiveWorkers:sequencing.maxWorkers,queued:sequencing.output,passed:report.numPassedTests,failed:report.numFailedTests,registered:report.numTotalTests});
   expect(report.success).toBe(true);expect(report.numTotalTests).toBe(2);expect(report.numPassedTests).toBe(2);expect(report.numFailedTests).toBe(0);expect(report.numPendingTests).toBe(0);
  }
  for(const record of proof.phases){
   expect(record.order).toEqual(record.phase==='baseline'?['short','long']:['long','short']);
  }
 }finally{
  rmSync(root,{recursive:true,force:true});proof.ownedFixtureRemoved=true;
  const destination=process.env.AIHR_FOCUSED_EVIDENCE_DIR;if(destination){const out=join(destination,'duration-sequence-smoke');mkdirSync(out,{recursive:true});writeFileSync(join(out,'proof.json'),JSON.stringify(proof,null,2)+'\n');}
  console.log('[duration-sequence-proof]',JSON.stringify(proof));
 }
});

it('private child timeout refuses success and removes its owned process group',async()=>{
 const result=await runChild(['-e','setInterval(()=>{},1000)'],process.env,100);
 expect(result.error?.message).toBe('Private child exceeded its time bound');expect(result.status).toBeNull();expect(result.signal).toBe('SIGKILL');expect(result.pid).toBeGreaterThan(0);
 let code:string|undefined;try{process.kill(-result.pid!,0);}catch(error){code=(error as NodeJS.ErrnoException).code;}expect(code).toBe('ESRCH');
});
