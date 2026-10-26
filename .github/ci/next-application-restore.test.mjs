/** Exercise actual cache lookup/extraction with private fake gh/git executables. No network or compiler. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {restoreManagedNextState} from './next-application-cache.mjs';
import {NEXT_APPLICATION_CODE,NEXT_APPLICATION_STATE} from './next-application-cache-protocol.mjs';
import {applicationStateFixture} from './next-application-test-fixtures.mjs';
import {fixtureHash} from './build-artifact-test-fixture.mjs';
function fixture(mode){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'next-state-transport-'))),bin=join(root,'bin'),out=join(root,'out'),source=join(root,'source');
 for(const path of [bin,out,source])mkdirSync(path,{mode:0o700});
 const f=applicationStateFixture({producerStartedAt:new Date(Date.now()-10000).toISOString(),producerCompletedAt:new Date(Date.now()-5000).toISOString()});
 const encoded=Object.fromEntries([...f.files].map(([name,bytes])=>[name,bytes.toString()]));
 const zip=execFileSync('python3',['-c','import io,json,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); [(z.writestr(k,v)) for k,v in json.load(sys.stdin).items()]; z.close(); sys.stdout.buffer.write(b.getvalue())'],{input:JSON.stringify(encoded)});
 const run={...f.run,run_attempt:1,event:'workflow_dispatch',head_branch:'main',path:'.github/workflows/alpha-staging.yml',
 repository:{full_name:'StradaverseHub/ai-hr',id:1333414856},head_repository:{id:1333414856},status:'completed',conclusion:'failure'};
 const job={...f.job,name:'build',run_id:run.id,run_attempt:1,head_sha:run.head_sha,status:'completed',conclusion:mode==='failed-job'?'failure':'success'};
 const artifact={id:999,name:NEXT_APPLICATION_STATE,expired:false,size_in_bytes:zip.length,digest:'sha256:'+fixtureHash(zip),created_at:job.completed_at,
 workflow_run:{id:run.id,head_sha:run.head_sha,repository_id:1333414856,head_repository_id:1333414856}};
 const tree={truncated:false,tree:NEXT_APPLICATION_CODE.map(path=>({path,type:'blob',sha:mode==='wrong-code'&&path===NEXT_APPLICATION_CODE[0]?'d'.repeat(40):'c'.repeat(40)}))};
 const routes={
  ['actions/workflows/alpha-staging.yml/runs?per_page=3']:{workflow_runs:[run]},
  ['actions/runs/'+run.id+'/attempts/1/jobs?per_page=100']:{total_count:1,jobs:[job]},
  ['actions/runs/'+run.id+'/artifacts?per_page=100']:{total_count:1,artifacts:[artifact]},
  ['git/trees/'+run.head_sha+'?recursive=1']:tree
 };
 const archive=join(root,'state.zip'),trace=join(root,'trace.jsonl');writeFileSync(archive,mode==='corrupt-zip'?Buffer.concat([zip,Buffer.from('changed')]):zip);
 writeFileSync(join(root,'routes.json'),JSON.stringify(routes));
 const gh='#!'+process.execPath+'\n'+
  'const fs=require("node:fs");const root='+JSON.stringify(root)+';const args=process.argv.slice(2);fs.appendFileSync(root+"/trace.jsonl",JSON.stringify(args)+"\\n");'+
  'if(args[0]!=="api")process.exit(2);const path=args[1].replace("repos/StradaverseHub/ai-hr/","");'+
  (mode==='outage'?'process.exit(1);':'if(path==="actions/artifacts/999/zip"){process.stdout.write(fs.readFileSync(root+"/state.zip"));}else{const routes=JSON.parse(fs.readFileSync(root+"/routes.json"));if(!routes[path])process.exit(1);process.stdout.write(JSON.stringify(routes[path]));}');
 const git='#!'+process.execPath+'\n'+
  'const args=process.argv.slice(2);const paths='+JSON.stringify(NEXT_APPLICATION_CODE)+';if(args.length!==paths.length+1||args[0]!=="rev-parse"||!args.slice(1).every(arg=>paths.includes(arg.replace("HEAD:",""))))process.exit(2);process.stdout.write(("'+('c'.repeat(40))+'\\n").repeat(paths.length));';
 writeFileSync(join(bin,'gh'),gh,{mode:0o700});writeFileSync(join(bin,'git'),git,{mode:0o700});
 return {root,bin,out,source,f,trace,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('actual authenticated transport returns graph bytes while failed whole run stays failed and source graph stays absent',()=>{
 const f=fixture('valid'),old=process.env.PATH;try{
  process.env.PATH=f.bin+':'+old;
  const report={lookup:[]},result=restoreManagedNextState({source:f.source,out:f.out,e:{AIHR_CI_HEAD:f.f.expected.candidate,GITHUB_RUN_ID:'456'},context:f.f.context,report});
  assert(result);assert(result.bytes.equals(f.f.files.get('state.json')));assert.equal(result.origin.runId,123);
  assert.equal(report.lookup[0].actualPublisherCodeVerified,true);assert.equal(report.lookup[0].accepted,true);
  assert(!existsSync(join(f.source,'.next')),'Lookup must not install graph or build output');
 }finally{process.env.PATH=old;f.close();}
});
test('actual transport refuses corrupt ZIP, failed producing job and changed actual controller; returns cold rather than PASS',()=>{
 for(const [mode,message]of [['corrupt-zip',/ZIP digest\/size/],['failed-job',/successful application build/],['wrong-code',/publisher code differs/]]){
  const f=fixture(mode),old=process.env.PATH;try{
   process.env.PATH=f.bin+':'+old;const report={lookup:[]};
   const result=restoreManagedNextState({source:f.source,out:f.out,e:{AIHR_CI_HEAD:f.f.expected.candidate,GITHUB_RUN_ID:'456'},context:f.f.context,report});
   assert.equal(result,null);assert.match(report.lookup.find(r=>r.kind==='normal').error,message);
   const requests=readFileSync(f.trace,'utf8');if(mode!=='corrupt-zip')assert(!requests.includes('actions/artifacts/999/zip'),'Refuse before binary download');
   assert(!existsSync(join(f.source,'.next')));
  }finally{process.env.PATH=old;f.close();}
 }
});
test('actual API outage returns no graph and leaves source untouched for mandatory cold compilation',()=>{
 const f=fixture('outage'),old=process.env.PATH;try{
  process.env.PATH=f.bin+':'+old;const report={lookup:[]};
  assert.equal(restoreManagedNextState({source:f.source,out:f.out,e:{AIHR_CI_HEAD:f.f.expected.candidate,GITHUB_RUN_ID:'456'},context:f.f.context,report}),null);
  assert(report.lookup.some(r=>r.discoveryError));assert(!existsSync(join(f.source,'.next')));
 }finally{process.env.PATH=old;f.close();}
});
