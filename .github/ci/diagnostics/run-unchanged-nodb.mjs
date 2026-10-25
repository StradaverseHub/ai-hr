/** DRAFT: isolated original files, normal config/timeout/assertions; no database. */
import {spawnSync,execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
if(process.env.GITHUB_ACTIONS!=='true'||process.platform!=='linux')throw Error('Disposable Linux CI only');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();const sha=git('rev-parse','HEAD');if(git('status','--porcelain'))throw Error('Dirty diagnostic source');
const instrumented=process.argv.includes('--instrumented');
const out=join(process.env.RUNNER_TEMP,instrumented?'diagnostic-nodb-instrumented':'diagnostic-nodb-original');mkdirSync(out,{recursive:true});
for(const name of ['personnel-import-exclusions.test.ts','employee-import-screen.dom.test.tsx','cost-center-allocations.dom.test.tsx']){
 const start=Date.now();const child=spawnSync('pnpm',['exec','vitest','run','--config',instrumented?'.vitest-attachments/diagnostic-nodb.config.mts':'vitest.nodb.config.ts',instrumented?'.vitest-attachments/diag-'+name:'test/'+name,'--reporter=default','--reporter=json','--outputFile.json='+join(out,name+'.json')],{encoding:'utf8',timeout:180000,maxBuffer:32*1024*1024,env:{...process.env,VITEST_MAX_WORKERS:'1',VITEST_MAX_WORKERS_NODB:'1',DATABASE_URL:'postgres://nobody:nothing@127.0.0.1:1/no_database',MIGRATION_DATABASE_URL:'postgres://nobody:nothing@127.0.0.1:1/no_database',TEST_DATABASE_URL:'postgres://nobody:nothing@127.0.0.1:1/no_database',TEST_MIGRATION_DATABASE_URL:'postgres://nobody:nothing@127.0.0.1:1/no_database'}});
 writeFileSync(join(out,name+'.log'),(child.stdout??'')+(child.stderr??''),{flag:'wx'});
 const result={kind:'DIAGNOSTIC_ONLY',sha,node:process.versions.node,platform:process.platform,workers:1,instrumented,file:name,exitCode:child.status,signal:child.signal,elapsedMs:Date.now()-start,error:String(child.error??'')};writeFileSync(join(out,name+'.execution.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
}

if(git('rev-parse','HEAD')!==sha||git('status','--porcelain'))throw Error('Diagnostic source changed');
