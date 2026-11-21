import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';

it('isolates concurrent Home timing without retaining request or response secrets',()=>{
 const root=mkdtempSync(join(tmpdir(),'home-timing-')),path=join(root,'timing.json');
 try{
  const result=spawnSync(process.execPath,['--import','./scripts/performance/transaction-timing.mjs','test/fixtures/home-request-timing.mjs'],{
   encoding:'utf8',timeout:15000,env:{...process.env,GITHUB_ACTIONS:'true',PERF_TX_TIMING_PATH:path},
  });
  expect(result.status,result.stdout+result.stderr).toBe(0);
  const raw=readFileSync(path,'utf8'),report=JSON.parse(raw).homeRequests;
  expect(raw).not.toContain('PRIVATE_');
  expect(report.active).toBe(0);expect(report.dropped).toBe(0);
  expect(report.completed).toHaveLength(2);
  for(const span of report.completed){
   const card=span.path==='/'?'calendar':'tasks';
   expect(span.finished).toBe(true);expect(span.status).toBe(200);
   expect(span.stages.map((item:{stage:string;card?:string})=>[item.stage,item.card])).toEqual([
    ['handler',undefined],['session',undefined],['read-start',card],['read-finish',card],
   ]);
   const times:number[]=span.stages.map((item:{afterMs:number})=>item.afterMs);
   expect(times).toEqual([...times].sort((a,b)=>a-b));
   expect(span.elapsedMs).toBeGreaterThanOrEqual(times.at(-1)!);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
