/** Actual Vitest sequencing controls; private two-file children, no application or database. */
import {it,expect} from 'vitest';
import {BaseSequencer,type TestSpecification} from 'vitest/node';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync,copyFileSync,realpathSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import DurationSequencer from '../scripts/test-duration-sequencer.mjs';
const repo=realpathSync(fileURLToPath(new URL('..',import.meta.url)));
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
it('actual Vitest starts the known long file before a larger short source and runs both unchanged cases',()=>{
 const scratch=join(repo,'scratchpad');mkdirSync(scratch,{recursive:true});const root=mkdtempSync(join(scratch,'duration-sequence-'));
 const proof:{kind:string;phases:Record<string,unknown>[];ownedFixtureRemoved?:boolean}={kind:'PRIVATE_REAL_VITEST_ORDERING_NOT_APPLICATION_OR_RELEASE',phases:[]};
 try{
  mkdirSync(join(root,'test'));
  const body=(label:string)=>["import {it,expect} from 'vitest';import {appendFileSync} from 'node:fs';",'it('+JSON.stringify(label)+',()=>{appendFileSync(process.env.ORDER_TRACE_FILE!,'+JSON.stringify(label+'\n')+');expect(2+2).toBe(4);});',''].join('\n');
  writeFileSync(join(root,'test/a-bulky-short.test.ts'),body('short')+'\n/*'+'.'.repeat(160000)+'*/\n');
  writeFileSync(join(root,'test/r395-write-path-equivalence.test.ts'),body('long'));
  for(const phase of ['baseline','duration']){
   const trace=join(root,phase+'.trace'),output=join(root,phase+'.json'),config=join(root,phase+'.config.mts');
   const chosen=phase==='baseline'?"import {BaseSequencer as Sequencer} from 'vitest/node';":'import Sequencer from '+JSON.stringify(join(repo,'scripts/test-duration-sequencer.mjs'))+';';
   writeFileSync(config,"import {defineConfig} from 'vitest/config';"+chosen+'export default defineConfig({root:'+JSON.stringify(root)+',cacheDir:'+JSON.stringify(join(root,'cache-'+phase))+",test:{include:['test/*.test.ts'],globalSetup:[],setupFiles:[],maxWorkers:1,fileParallelism:false,sequence:{sequencer:Sequencer},testTimeout:5000,hookTimeout:5000}});");
   const result=spawnSync(process.execPath,[join(repo,'node_modules/vitest/vitest.mjs'),'run','--root',root,'--config',config,'--reporter=json','--outputFile='+output],{cwd:repo,env:{...process.env,ORDER_TRACE_FILE:trace},encoding:'utf8',timeout:12000,maxBuffer:1024*1024,detached:true});
   if(result.error&&result.pid)try{process.kill(-result.pid,'SIGKILL');}catch{}
   const record={phase,exit:result.status,signal:result.signal,error:result.error?.message};proof.phases.push(record);
   const destination=process.env.AIHR_FOCUSED_EVIDENCE_DIR;
   if(destination){const out=join(destination,'duration-sequence-smoke');mkdirSync(out,{recursive:true});if(existsSync(output))copyFileSync(output,join(out,phase+'.vitest.json'));writeFileSync(join(out,phase+'.log'),(result.stdout??'')+(result.stderr??''));}
   expect(result.error,result.stderr).toBeUndefined();expect(result.status,result.stderr).toBe(0);expect(result.signal).toBeNull();
   const report=JSON.parse(readFileSync(output,'utf8')),order=readFileSync(trace,'utf8').trim().split('\n');
   Object.assign(record,{order,passed:report.numPassedTests,failed:report.numFailedTests,registered:report.numTotalTests});
   expect(report.success).toBe(true);expect(report.numTotalTests).toBe(2);expect(report.numPassedTests).toBe(2);expect(report.numFailedTests).toBe(0);expect(report.numPendingTests).toBe(0);
   expect(order).toEqual(phase==='baseline'?['short','long']:['long','short']);
  }
 }finally{
  rmSync(root,{recursive:true,force:true});proof.ownedFixtureRemoved=true;
  const destination=process.env.AIHR_FOCUSED_EVIDENCE_DIR;if(destination){const out=join(destination,'duration-sequence-smoke');mkdirSync(out,{recursive:true});writeFileSync(join(out,'proof.json'),JSON.stringify(proof,null,2)+'\n');}
  console.log('[duration-sequence-proof]',JSON.stringify(proof));
 }
});
