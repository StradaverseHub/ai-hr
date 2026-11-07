/** Finite protected-owner entry; never arbitrary imports/commands or caller receipt hints. */
import assert from 'node:assert/strict';
import {constants,openSync,closeSync,fstatSync,readFileSync,lstatSync,realpathSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {candidateEnvironment} from './candidate-environment.mjs';

const kind='PROTECTED_NATIVE_CONTROLLER_BEFORE_PACKAGE_INVOCATION';
function protectedFile(file,maximum,mode){
 assert.equal(resolve(file),file);assert.equal(realpathSync(file),file);
 let parent=dirname(file);while(parent!=='/'){
  const info=lstatSync(parent);assert(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===0&&(info.mode&0o022)===0);parent=dirname(parent);
 }
 const before=lstatSync(file);assert(before.isFile()&&!before.isSymbolicLink()&&before.uid===0&&before.nlink===1&&(before.mode&0o777)===mode&&before.size>0&&before.size<=maximum);
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const actual=fstatSync(fd);for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(actual[key],before[key]);
  const raw=readFileSync(fd);assert.equal(raw.length,before.size);
  for(const current of [fstatSync(fd),lstatSync(file)])for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(current[key],before[key]);
  return raw;
 }finally{closeSync(fd);}
}
export function protectedOwnerContext(env=process.env,entry=fileURLToPath(import.meta.url)){
 assert.equal(process.platform,'linux');assert(process.getuid()>0);
 assert.equal(env.GITHUB_ACTIONS,'true');assert.equal(env.GITHUB_JOB,'native-test');
 assert(/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID??''));
 const root='/var/lib/aihr-native-controller/'+env.GITHUB_RUN_ID,automation=root+'/automation';
 assert.equal(realpathSync(entry),automation+'/.github/ci/native-controller-owner.mjs');
 assert.equal(realpathSync(process.execPath),root+'/node');
 const receipt=JSON.parse(protectedFile(root+'/bootstrap.json',128*1024,0o444).toString('utf8'));
 assert.equal(receipt.version,1);assert.equal(receipt.kind,kind);assert.equal(receipt.runId,env.GITHUB_RUN_ID);
 assert.equal(receipt.automation,automation);assert.equal(receipt.protectedNodePath,root+'/node');
 assert.equal(receipt.runnerUid,process.getuid());assert.equal(receipt.runnerGid,process.getgid());
 assert(/^[a-f0-9]{40}$/.test(receipt.candidate)&&/^[a-f0-9]{40}$/.test(receipt.controller));
 assert.equal(receipt.controller,env.GITHUB_SHA);assert.equal(receipt.context.GITHUB_JOB,'native-test');
 assert.equal(receipt.context.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');assert.equal(receipt.context.GITHUB_REPOSITORY_ID,'1333414856');
 assert.equal(receipt.context.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(receipt.context.GITHUB_RUN_ATTEMPT,'1');
 assert.equal(receipt.context.GITHUB_WORKSPACE,receipt.workspace);assert.equal(receipt.context.AIHR_CI_HEAD,receipt.candidate);
 assert.equal(receipt.context.AIHR_CI_CONTROL_HEAD,receipt.controller);
 assert.equal(receipt.workspace,realpathSync(env.GITHUB_WORKSPACE));assert.equal(realpathSync(process.cwd()),receipt.workspace+'/source');
 const actualNode=protectedFile(root+'/node',256*1024**2,0o555);assert.equal(actualNode.length,receipt.node.bytes);
 assert.equal(createHash('sha256').update(actualNode).digest('hex'),receipt.node.sha256);
 assert.equal(createHash('sha256').update(protectedFile(root+'/event.json',1024**2,0o444)).digest('hex'),receipt.eventSha256);
 assert(Array.isArray(receipt.toolBins)&&receipt.toolBins.length>0&&receipt.toolBins.length<=2);
 for(const directory of receipt.toolBins){assert.equal(realpathSync(directory),directory);assert(lstatSync(directory).isDirectory());assert(directory.startsWith('/home/runner/')||directory.startsWith('/opt/hostedtoolcache/'));}
 return{root,automation,receipt};
}
export function ownerEnvironment(context,inherited,operation){
 const {root,automation,receipt}=context;
 // Initial public GitHub/runner context was retained before hooks. Only the
 // current step's legitimate file-command outputs and explicit API token cross
 // this edge. Arbitrary GITHUB_ENV/PATH, loader, proxy, Git, DB/provider settings
 // never define owner code or metadata command execution.
 const next={...receipt.context,PATH:[root,'/usr/bin','/bin','/usr/sbin','/sbin',...receipt.toolBins].join(':'),
  HOME:'/nonexistent',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'Asia/Kuala_Lumpur',PYTHONDONTWRITEBYTECODE:'1',
  GITHUB_EVENT_PATH:root+'/event.json',GH_HOST:'github.com',GH_CONFIG_DIR:root+'/gh-empty',
  GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1',
  GIT_CONFIG_COUNT:'4',GIT_CONFIG_KEY_0:'safe.directory',GIT_CONFIG_VALUE_0:automation,
  GIT_CONFIG_KEY_1:'core.fsmonitor',GIT_CONFIG_VALUE_1:'false',GIT_CONFIG_KEY_2:'core.hooksPath',GIT_CONFIG_VALUE_2:'/dev/null',
  GIT_CONFIG_KEY_3:'core.pager',GIT_CONFIG_VALUE_3:'cat'};
 for(const key of ['GITHUB_PATH','GITHUB_ENV','GITHUB_OUTPUT','GITHUB_STATE','GITHUB_STEP_SUMMARY'])if(inherited[key]!==undefined)next[key]=inherited[key];
 if(operation==='run-unit'){assert(typeof inherited.GH_TOKEN==='string'&&inherited.GH_TOKEN.length>0);next.GH_TOKEN=inherited.GH_TOKEN;}
 return next;
}
function capacity(context,env){
 const output=execFileSync('/usr/bin/bash',[context.automation+'/.github/ci/prepare-runner.sh'],
  {env:{...env,AIHR_CI_CAPACITY_PROFILE:'bounded-suite-ready'},stdio:['ignore','pipe','inherit'],timeout:180000,maxBuffer:4*1024**2});
 process.stdout.write(output);appendFileSync(join(receiptTemp(context),'suite-capacity-preparation.log'),output);
}
export async function ownerMain(){
 const [operation,...args]=process.argv.slice(2),context=protectedOwnerContext();
 assert(['pdf-tools','run-unit','ensure-main','capacity','plan','role-plan','setup'].includes(operation));
 const inherited={...process.env},env=ownerEnvironment(context,inherited,operation);
 for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,env);
 if(operation==='role-plan'){
  assert.equal(args.length,0);
  const {createPlan}=await import(pathToFileURL(context.automation+'/.github/ci/plan.mjs').href);
  const {DB_BATCH_FILES}=await import(pathToFileURL(context.automation+'/.github/ci/manifest.mjs').href);
  process.stdout.write(JSON.stringify({plan:createPlan(),dbBatchFiles:DB_BATCH_FILES}));return;
 }
 if(operation==='setup'){
  assert(args.length===1&&['true','false'].includes(args[0]));
  const child=candidateEnvironment({...env,HOME:'/home/runner'});
  for(const key of ['GITHUB_ENV','GITHUB_PATH','GITHUB_OUTPUT','GITHUB_STATE','GITHUB_STEP_SUMMARY'])delete child[key];
  execFileSync('pnpm',['install','--frozen-lockfile'],{env:child,stdio:'inherit',timeout:900000});
  if(args[0]==='true')execFileSync('npm',['ci','--prefix','mobile','--no-audit','--no-fund'],{env:child,stdio:'inherit',timeout:900000});
  const bytes=execFileSync('/usr/bin/git',['show',context.receipt.candidate+':.env.example'],{env,encoding:null,timeout:10000,maxBuffer:1048576});
  assert(bytes.equals(readFileSync('.env.example')),'Candidate environment template differs from committed source');
  writeFileSync('.env.local',bytes,{flag:'wx',mode:0o600});
  execFileSync('pnpm',['exec','playwright','install','--with-deps','chromium'],{env:child,stdio:'inherit',timeout:900000});
  capacity(context,env);return;
 }
 if(operation==='ensure-main'){
  assert.equal(args.length,0);
  try{execFileSync('/usr/bin/git',['rev-parse','--verify','refs/heads/main'],{env,stdio:'pipe',timeout:10000});}
  catch(error){assert.equal(error.status,128);execFileSync('/usr/bin/git',['branch','main','origin/main'],{env,stdio:'pipe',timeout:10000});}
  return;
 }
 if(operation==='capacity'){
  assert.equal(args.length,0);capacity(context,env);return;
 }
 if(operation==='plan')assert.equal(args.length,0);
 else if(operation==='pdf-tools')assert(args.length===2&&args[0]==='--unit'&&/^(?:db|nodb)-[a-f0-9]{16}$/.test(args[1]));
 else assert(args.length===2&&/^(?:db|nodb)-[a-f0-9]{16}$/.test(args[0])&&args[1]===receiptTemp(context)+'/aihr-ci');
 const file=join(context.automation,'.github/ci',operation==='plan'?'plan.mjs':operation+'.mjs');
 process.argv=[process.execPath,file,...args];await import(pathToFileURL(file).href);
}
const receiptTemp=context=>context.receipt.context.RUNNER_TEMP;
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))ownerMain().catch(()=>{process.stderr.write('Protected native CI owner refused\n');process.exitCode=1;});
