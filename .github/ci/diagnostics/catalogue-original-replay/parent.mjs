/** Fixed read-only API owner. NEVER import original candidate/application code
 * while GH_TOKEN is present. Worker launch awaits the qualified shared kernel. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,realpathSync,lstatSync,readdirSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {downloadCiArchives,readCiArchive} from '../../archive-downloads.mjs';
import {CONTRACT,digest,validateOriginalMetadata,validatePublicComparison,publishPublicFailure} from './policy.mjs';
import {directChildren} from './direct-children.mjs';
const root=realpathSync(fileURLToPath(new URL('../../../../',import.meta.url)));
const children=directChildren();
let ghConfiguration;
const safe=()=>({PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC'});
function ghEnvironment(){assert(typeof process.env.GH_TOKEN==='string'&&process.env.GH_TOKEN.length>0&&typeof ghConfiguration==='string');return{...safe(),GH_CONFIG_DIR:ghConfiguration,GH_TOKEN:process.env.GH_TOKEN,GH_HOST:'github.com',GH_NO_UPDATE_NOTIFIER:'1',GH_PROMPT_DISABLED:'1'};}
function gh(args){return children.start(()=>spawn('/usr/bin/gh',['api','--hostname','github.com',...args],{env:ghEnvironment(),stdio:['ignore','pipe','pipe']}));}
async function bounded(child,{maximum=4*1024**2,timeout=30000}={}){
 let error,closed=false,overflow=false,timedOut=false,size=0;const chunks=[];
 const done=new Promise(resolve=>{child.once('error',value=>{error=value;});child.once('close',(code,signal)=>{closed=true;resolve({code,signal});});});
 const stop=()=>{if(!closed)child.kill('SIGKILL');};const timer=setTimeout(()=>{timedOut=true;stop();},timeout);
 try{child.stderr.on('data',()=>{});for await(const chunk of child.stdout){size+=chunk.length;if(size>maximum){overflow=true;stop();}else chunks.push(chunk);}const result=await done;assert(!error&&!overflow&&!timedOut&&result.code===0&&result.signal===null,'Bounded fixed subprocess refused');return Buffer.concat(chunks);}
 finally{clearTimeout(timer);if(!closed)stop();await done;}
}
async function apiMetadata(){
 const base=`repos/${CONTRACT.repository.full_name}`,run=CONTRACT.run.id;
 const endpoints=[`${base}/actions/runs/${run}`,`${base}/actions/runs/${run}/attempts/1/jobs?per_page=100&page=1`,`${base}/actions/runs/${run}/artifacts?per_page=100&page=1`,`${base}/actions/workflows/${CONTRACT.workflow.id}`];
 const settled=await Promise.allSettled(endpoints.map(path=>bounded(gh([path]))));assert(settled.every(row=>row.status==='fulfilled'),'Complete live API metadata required');
 const raw=settled.map(row=>row.value),[runData,jobs,artifacts,workflow]=raw.map(bytes=>JSON.parse(bytes.toString('utf8')));const metadata=validateOriginalMetadata({run:runData,jobs,artifacts,workflow});
 return{metadata,responseSha256:Object.fromEntries(['run','jobs','artifacts','workflow'].map((name,i)=>[name,digest(raw[i])]))};
}
async function compareWithSharedOwner({workspace,temp,privateRoot}){
 const adapter=join(root,'.github/ci/diagnostics/catalogue-original-replay/adapter.py'),kernel=join(root,'.github/ci/owned-process.py');
 assert(existsSync(adapter)&&existsSync(kernel),'Qualified shared process owner not integrated');
 // This fixed adapter will be implemented ONLY against the qualified extracted
 // shared kernel. It owns WNOWAIT/pidfd reservation and all descendant lifetime.
 // Node never signals a numeric process group, detaches, or kills this monitor.
 const env={...safe(),GITHUB_WORKSPACE:workspace,RUNNER_TEMP:temp,GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:CONTRACT.repository.full_name,GITHUB_REPOSITORY_ID:String(CONTRACT.repository.id),GITHUB_RUN_ID:process.env.GITHUB_RUN_ID,GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKFLOW_SHA:process.env.GITHUB_WORKFLOW_SHA,NODE_EXECUTABLE:process.execPath};
 const child=children.start(()=>spawn('/usr/bin/python3',['-I','-B',adapter],{cwd:root,env,stdio:['pipe','pipe','pipe']}),owned=>owned.stdin.end());let closed=false,error,expired=false,size=0;const chunks=[];
 const done=new Promise(resolve=>{child.once('error',value=>{error=value;});child.once('close',(code,signal)=>{closed=true;resolve({code,signal});});});
 const requestStop=()=>{if(!closed)child.stdin.end();};const interrupted=()=>requestStop();process.on('SIGTERM',interrupted);process.on('SIGINT',interrupted);
 const timer=setTimeout(()=>{expired=true;requestStop();},180000);
 try{child.stderr.on('data',()=>{});child.stdout.on('data',chunk=>{size+=chunk.length;if(size<=65536)chunks.push(chunk);else requestStop();});child.stdin.on('error',value=>{error??=value;});const exit=await done;assert(!error&&!expired&&size<=65536&&exit.code===0&&exit.signal===null,'Owned original comparison refused');
  const terminal=JSON.parse(Buffer.concat(chunks).toString('utf8'));assert.deepEqual(terminal,{kind:'ORIGINAL_CATALOGUE_SHARED_OWNER_TERMINAL',completed:true,familySettled:true});
  const result=JSON.parse(readFileSync(join(privateRoot,'comparison-result.json'),'utf8'));return validatePublicComparison(result);
 }finally{clearTimeout(timer);requestStop();await done;process.removeListener('SIGTERM',interrupted);process.removeListener('SIGINT',interrupted);}
}
export async function originalCatalogueReplay(){
 let phase='admission',publicRoot;
 const interrupted=()=>children.cancel();process.on('SIGTERM',interrupted);process.on('SIGINT',interrupted);
 const fail=()=>{if(publicRoot)publishPublicFailure(phase,bytes=>writeFileSync(join(publicRoot,'result.json'),bytes,{mode:0o600}));process.stderr.write('Original catalogue replay refused at '+phase+'\n');process.exitCode=1;};
 try{
  assert.equal(process.argv.length,2);assert.equal(process.platform,'linux');assert.equal(process.versions.node,'22.23.3');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.CI,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(process.env.GITHUB_REPOSITORY,CONTRACT.repository.full_name);assert.equal(process.env.GITHUB_REPOSITORY_ID,String(CONTRACT.repository.id));assert.equal(process.env.GITHUB_EVENT_NAME,'workflow_dispatch');assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1');assert.equal(process.env.GITHUB_JOB,'replay');assert.equal(process.env.GITHUB_WORKFLOW,'original-catalogue-replay-diagnostic');
  const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));assert.equal(event.repository.id,CONTRACT.repository.id);assert.equal(Object.keys(event.inputs??{}).length,0);
  const workspace=realpathSync(process.env.GITHUB_WORKSPACE),temp=realpathSync(process.env.RUNNER_TEMP);assert.equal(root,join(workspace,'controller'));assert.equal(realpathSync(root),root);const original=join(workspace,'original');assert.equal(realpathSync(original),original);
  const git=(cwd,...args)=>execFileSync('/usr/bin/git',['-c','safe.directory='+cwd,'-c','core.hooksPath=/dev/null',...args],{cwd,env:safe(),encoding:'utf8',timeout:10000,maxBuffer:4*1024**2}).trim();assert.equal(git(root,'rev-parse','HEAD'),process.env.GITHUB_WORKFLOW_SHA);assert.equal(git(root,'status','--porcelain'),'');assert.equal(git(original,'rev-parse','HEAD'),CONTRACT.originalCandidate);assert.equal(git(original,'status','--porcelain'),'');
  const privateRoot=join(temp,'original-catalogue-replay-private');publicRoot=join(temp,'original-catalogue-replay-public');mkdirSync(privateRoot,{mode:0o700});mkdirSync(publicRoot,{mode:0o700});ghConfiguration=join(privateRoot,'gh-config');mkdirSync(ghConfiguration,{mode:0o700});
  // A missing qualified kernel/adapter is an explicit commissioning blocker.
  assert(existsSync(join(root,'.github/ci/owned-process.py'))&&existsSync(join(root,'.github/ci/diagnostics/catalogue-original-replay/adapter.py')),'Shared kernel commissioning required');
  phase='api-before';const before=await apiMetadata();phase='download';const archives=join(privateRoot,'archives');mkdirSync(archives,{mode:0o700});await downloadCiArchives(CONTRACT.artifacts,archives,{concurrency:4,timeoutMs:120000,start:artifact=>gh([`repos/${CONTRACT.repository.full_name}/actions/artifacts/${artifact.id}/zip`])});
  phase='extract';const artifacts=[];for(const artifact of CONTRACT.artifacts){const path=join(archives,artifact.name+'.zip');readCiArchive(artifact,path);const directory=join(privateRoot,'artifact-'+artifact.id);await bounded(children.start(()=>spawn('/usr/bin/python3',['-I','-B',join(root,'.github/ci/extract-artifact.py'),path,directory],{env:safe(),stdio:['ignore','pipe','pipe']})),{maximum:65536,timeout:20000});assert.deepEqual(readdirSync(directory).sort(),artifact.members);artifacts.push({id:artifact.id,directory});}
  phase='api-after';const after=await apiMetadata();writeFileSync(join(privateRoot,'worker-input.json'),JSON.stringify({original,artifacts},null,2)+'\n',{flag:'wx',mode:0o600});
  phase='comparison';const comparison=await compareWithSharedOwner({workspace,temp,privateRoot});phase='api-final';const final=await apiMetadata();phase='publish';
  writeFileSync(join(publicRoot,'result.json'),JSON.stringify({kind:'AUTHENTICATED_ORIGINAL_CATALOGUE_REPLAY_DIAGNOSTIC',complete:true,consumerSource:process.env.GITHUB_WORKFLOW_SHA,consumerRun:process.env.GITHUB_RUN_ID,comparison,expectedProfileAuthorized:false,releaseAuthorized:false},null,2)+'\n',{flag:'wx',mode:0o600});
  writeFileSync(join(publicRoot,'api-proof.json'),JSON.stringify({kind:'LIVE_API_ORIGINAL_METADATA_NOT_RELEASE',contractSha256:digest(readFileSync(new URL('contract.json',import.meta.url))),original:final.metadata,apiResponseSha256:{before:before.responseSha256,after:after.responseSha256,final:final.responseSha256},rawCapturesReuploaded:false,expectedProfileAuthorized:false,releaseAuthorized:false},null,2)+'\n',{flag:'wx',mode:0o600});
 }catch{children.cancel();fail();}
 finally{const ended=await children.finish();process.removeListener('SIGTERM',interrupted);process.removeListener('SIGINT',interrupted);if((ended.cancelled||ended.stopFailed)&&process.exitCode!==1)fail();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await originalCatalogueReplay();
