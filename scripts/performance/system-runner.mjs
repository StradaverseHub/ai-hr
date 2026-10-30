/** Development-only production renderer and durable job-owned PostgreSQL. No target credentials. */
import assert from 'node:assert/strict';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,openSync,closeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import {setTimeout as pause} from 'node:timers/promises';
assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
assert.equal(process.env.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const sha=git('rev-parse','HEAD');assert.equal(sha,process.env.AIHR_CI_HEAD);assert.equal(git('status','--porcelain'),'');
const out=join(process.env.RUNNER_TEMP,'system-performance-evidence'),privateDir=join(process.env.RUNNER_TEMP,'system-performance-private');
mkdirSync(out,{recursive:true,mode:0o700});mkdirSync(privateDir,{recursive:true,mode:0o700});
const authKey=randomBytes(32).toString('hex');
const env={...process.env,AUTH_PROVIDER:'internal',AUTH_SESSION_KEY:authKey,AUTH_PUBLIC_ORIGIN:'https://localhost:3443',
 AUTH_DEFAULT_ORGANIZATION:'perf-a',ALLOW_DEMO_SESSION:'false',AUDIT_HASH_CHAIN_ENABLED:'true',
 AI_CONFIG_SECRET:randomBytes(32).toString('hex'),PERF_PRIVATE_DIR:privateDir,PERF_EVIDENCE_DIR:out,
 DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_system_perf',MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_system_perf',
 TEST_DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_system_perf',TEST_MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_system_perf'};
for(const key of Object.keys(env))if(key.startsWith('WORKOS_')||key==='SHARE_PASSWORD'||key==='DEV_USER_ID')delete env[key];
env.SHARE_PASSWORD='';env.DEV_USER_ID='';
const report={kind:'ISOLATED_HTTP_BROWSER_DEVELOPMENT_ONLY',releaseEligible:false,sha,controller:process.env.AIHR_CI_CONTROL_HEAD,
 run:process.env.GITHUB_RUN_ID,host:{cpus:os.availableParallelism(),memoryBytes:os.totalmem()},phases:[],exitCode:1};
const save=()=>writeFileSync(join(out,'runner.json'),JSON.stringify(report,null,2));
async function run(label,command,args,childEnv=env,timeout=900000){
 console.log('[system-perf] '+label+' started');const start=Date.now();
 const fd=openSync(join(privateDir,label+'.log'),'w',0o600);
 const child=spawn(command,args,{env:childEnv,stdio:['ignore',fd,fd]});
 const timer=setTimeout(()=>child.kill('SIGTERM'),timeout);let code;
 try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});}finally{clearTimeout(timer);closeSync(fd);}
 report.phases.push({label,elapsedMs:Date.now()-start,exitCode:code});save();
 console.log('[system-perf] '+JSON.stringify(report.phases.at(-1)));
 if(code!==0){const text=readFileSync(join(privateDir,label+'.log'),'utf8').slice(-12000).replace(/[A-Za-z0-9_-]{32,}/g,'<REDACTED>');writeFileSync(join(out,label+'-failure.txt'),text);}
 assert.equal(code,0,label+' failed; private process logs contain no published credentials');
}
let app,proxy,dbStarted=false,appFd;
const container=`aihr-ci-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-db-1`;
try{
 const buildEnv={...env,NODE_ENV:'production',NODE_OPTIONS:'--max-old-space-size=6144'};
 for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])buildEnv[key]='postgres://nobody:nothing@127.0.0.1:1/no_database';
 await run('build','pnpm',['build'],buildEnv);
 report.buildId=readFileSync('.next/BUILD_ID','utf8').trim();
 await run('postgres','bash',['.github/ci/postgres.sh','reset']);dbStarted=true;
 await run('database','docker',['exec',container,'psql','-U','postgres','-p','5433','-d','postgres','-v','ON_ERROR_STOP=1','-c','CREATE DATABASE ai_hr_system_perf OWNER ai_hr_app']);
 await run('migrate','pnpm',['db:migrate']);await run('catalogs',process.execPath,['--import','tsx','scripts/seed-catalogs.ts']);
 await run('fixture',process.execPath,['--import','tsx','scripts/performance/system-fixture.mjs'],{...env,NODE_ENV:'development'},600000);
 await run('certificate','openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(privateDir,'key.pem'),'-out',join(privateDir,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost']);
 appFd=openSync(join(privateDir,'server.log'),'w',0o600);
 app=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3174'],{env:{...env,NODE_ENV:'production',NODE_OPTIONS:'--max-old-space-size=4096'},stdio:['ignore',appFd,appFd]});
 const upstream=new http.Agent({keepAlive:true,maxSockets:600});
 proxy=https.createServer({key:readFileSync(join(privateDir,'key.pem')),cert:readFileSync(join(privateDir,'cert.pem'))},(req,res)=>{
  const request=http.request({host:'127.0.0.1',port:3174,path:req.url,method:req.method,agent:upstream,
   headers:{...req.headers,host:'localhost:3443','x-forwarded-host':'localhost:3443','x-forwarded-proto':'https'}},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
  request.on('error',()=>{res.writeHead(502);res.end();});req.pipe(request);
 });await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(3443,'127.0.0.1',resolve);});
 let ready=false;for(let i=0;i<120;i++){try{const response=await fetch('http://127.0.0.1:3174/login');if(response.status===200){ready=true;break;}}catch{}await pause(500);}
 assert(ready,'production server did not become ready');
 await run('http-and-browser',process.execPath,['--import','tsx','scripts/performance/system-load.mjs'],{...env,NODE_OPTIONS:'--max-old-space-size=2048'},600000);
 report.exitCode=0;
}catch(error){report.error=String(error.message).slice(0,350);console.error('[system-perf] '+report.error);}
finally{
 if(proxy)await new Promise(resolve=>{proxy.close(resolve);proxy.closeAllConnections();});
 if(app){app.kill('SIGTERM');await Promise.race([new Promise(resolve=>app.once('exit',resolve)),pause(5000)]);if(app.exitCode===null)app.kill('SIGKILL');}
 if(appFd!==undefined)closeSync(appFd);
 if(dbStarted){const stats=spawnSync('bash',['.github/ci/postgres.sh','stats'],{env,encoding:'utf8'});writeFileSync(join(out,'postgres-resources.txt'),stats.stdout??'');await run('cleanup','bash',['.github/ci/postgres.sh','stop']).catch(()=>{report.exitCode=1;});}
 save();
}
process.exitCode=report.exitCode;
