/** Full original unit load, replacing only the target by its labelled measurement copy. */
import {spawnSync,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {hostHealth} from '../host-health.mjs';
if(process.env.GITHUB_ACTIONS!=='true'||process.platform!=='linux')throw Error('Disposable Linux CI only');
const fixture=JSON.parse(readFileSync(new URL('./nodb-original-units.json',import.meta.url),'utf8'));
const unit=process.argv[2],original=fixture.units[unit];if(!original)throw Error('Unknown original unit');
const target=unit==='nodb-3'?'employee-import-screen.dom.test.tsx':'cost-center-allocations.dom.test.tsx';
const selected=original.map(f=>f==='test/'+target?'.vitest-attachments/diag-'+target:f);
if(selected.length!==original.length||selected.filter(f=>f.startsWith('.vitest-attachments/')).length!==1)throw Error('Invalid one-copy mapping');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();const sha=git('rev-parse','HEAD');if(sha!==fixture.source||git('status','--porcelain'))throw Error('Need clean original source');
const out=join(process.env.RUNNER_TEMP,'diagnostic-loaded-'+unit);mkdirSync(out,{recursive:true});
const config='.vitest-attachments/loaded-nodb.config.mts';
writeFileSync(config,`import base from '../vitest.nodb.config';\nexport default {...base,test:{...base.test,projects:base.test.projects.map(p=>({...p,test:{...p.test,globalSetup:[],maxWorkers:2,include:[...p.test.include,p.test.name==='node'?'.vitest-attachments/*.test.ts':'.vitest-attachments/*.dom.test.tsx']}}))}};\n`,{flag:'wx'});
const report={kind:'DIAGNOSTIC_LOADED_UNIT_NOT_RELEASE_EVIDENCE',sha,unit,original,selected,instrumentedTarget:target,workers:2,healthBefore:hostHealth(),started:new Date().toISOString()};
const start=Date.now();const resultFile=join(out,'vitest-result.json');
const child=spawnSync('pnpm',['exec','vitest','run','--config',config,...selected,'--reporter=default','--reporter=json','--outputFile.json='+resultFile],{encoding:'utf8',timeout:900000,maxBuffer:64*1024*1024,env:{...process.env,VITEST_MAX_WORKERS:'2',VITEST_MAX_WORKERS_NODB:'2'}});
writeFileSync(join(out,'vitest.log'),(child.stdout??'')+(child.stderr??''),{flag:'wx'});
Object.assign(report,{vitestExitCode:child.status,signal:child.signal,elapsedMs:Date.now()-start,childError:String(child.error??''),healthAfter:hostHealth()});
if(git('rev-parse','HEAD')!==sha||git('status','--porcelain'))throw Error('Source changed');
if(child.status!==null){const result=JSON.parse(readFileSync(resultFile,'utf8'));const actual=result.testResults.map(f=>f.name.replace(process.cwd()+'/','').replace('.vitest-attachments/diag-'+target,'test/'+target));report.reportedFiles=actual;if(actual.length!==original.length||new Set(actual).size!==original.length||actual.some(f=>!original.includes(f))){report.controllerError='Original unit coverage mismatch';process.exitCode=1;}}
writeFileSync(join(out,'execution.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report));
