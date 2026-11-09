/** Sole owner of a read-only built-in-only proof session. No app data or DDL. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,lstatSync,mkdirSync,openSync,readSync,realpathSync,statSync,writeFileSync,fsyncSync} from 'node:fs';
import {basename,join,resolve} from 'node:path';
import {cpus,totalmem} from 'node:os';
import {performance} from 'node:perf_hooks';
import postgres from 'postgres';
import type {TestContext} from 'vitest';
import {workerDb} from '../db-names';
import {asciiProofInputs,asciiProofLimits,asciiProofRuntime,asciiProofSha,asciiProofSourceBytes} from './employee-choice-ascii-observation';
import {asciiProofLifetime} from './employee-choice-ascii-proof-lifetime';
const files=['test/fixtures/employee-choice-ascii-observation.ts','test/fixtures/employee-choice-ascii-proof-native.ts','test/fixtures/employee-choice-ascii-scalar-corpus.sql',
 'test/fixtures/employee-choice-ascii-proof-lifetime.ts','test/fixtures/employee-choice-ascii-vectors.sql','test/employee-choice-ascii-observation.test.ts','test/employee-choice-exact-ascii-proof.test.ts',
 'core/employee-choice-ascii.ts','package.json','pnpm-lock.yaml','test/fixtures/unicode-17.0.0/LICENSE.txt',...Object.values(asciiProofInputs).map(value=>value.file)];
export function asciiProofExecutable(){
 assert.equal(process.platform,'linux');const fd=openSync('/proc/self/exe',constants.O_RDONLY);
 try{
  const before=fstatSync(fd,{bigint:true}),path=statSync(process.execPath,{bigint:true});assert(before.isFile()&&before.size>BigInt(0)&&before.size<=BigInt(268435456));assert.equal(before.ino,path.ino);assert.equal(before.dev,path.dev);
  const hash=createHash('sha256'),block=Buffer.alloc(65536);let offset=0;
  while(offset<Number(before.size)){const count=readSync(fd,block,0,Math.min(block.length,Number(before.size)-offset),offset);assert(count>0,'Executable unexpectedly truncated');hash.update(block.subarray(0,count));offset+=count;}
  assert.equal(readSync(fd,block,0,1,offset),0,'Executable unexpectedly grew');const after=fstatSync(fd,{bigint:true}),current=statSync(process.execPath,{bigint:true});
  for(const key of ['dev','ino','size','mtimeNs','ctimeNs']as const){assert.equal(after[key],before[key]);assert.equal(current[key],before[key]);}
  return{sha256:hash.digest('hex'),bytes:offset,name:basename(process.execPath),device:before.dev.toString(),inode:before.ino.toString()};
 }finally{closeSync(fd);}
}
function binding(){
 assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.CI,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(process.env.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');
 assert.match(process.env.GITHUB_RUN_ID??'',/^\d+$/);assert.match(process.env.GITHUB_RUN_ATTEMPT??'',/^\d+$/);
 const pool=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;assert.match(pool??'',/^[1-9][0-9]*$/);assert.notEqual(process.env.WORKER_DB,'0');assert(pool);
 const database=workerDb(pool),raw=process.env.TEST_DATABASE_URL;assert(raw);const url=new URL(raw);
 assert(['postgres:','postgresql:'].includes(url.protocol));assert.equal(url.username,'ai_hr_app');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/'+database);assert.equal(url.search,'');assert.equal(url.hash,'');
 const source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',timeout:2000,maxBuffer:256}).trim();assert.match(source,/^[0-9a-f]{40}$/);assert.equal(source,process.env.AIHR_CI_HEAD);assert.match(process.env.AIHR_CI_CONTROL_HEAD??'',/^[0-9a-f]{40}$/);
 return{database,url,source,controller:process.env.AIHR_CI_CONTROL_HEAD!,run:process.env.GITHUB_RUN_ID!,attempt:process.env.GITHUB_RUN_ATTEMPT!};
}
function evidenceDirectory(){
 const temporary=process.env.RUNNER_TEMP;assert(temporary);const base=resolve(process.env.AIHR_FOCUSED_EVIDENCE_DIR??process.env.AIHR_CI_ROLE_EVIDENCE_DIR??join(temporary,'aihr-ci'));
 assert.equal(realpathSync(base),base);assert.equal(lstatSync(base).uid,process.getuid!());
 const output=join(base,'employee-choice-exact-ascii-proof');try{mkdirSync(output,{mode:0o700});}catch(error){if(!(error instanceof Error&&'code'in error&&error.code==='EEXIST'))throw error;}
 const info=lstatSync(output);assert(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===process.getuid!()&&(info.mode&0o077)===0);return output;
}
function publish(directory:string,name:string,bytes:Buffer,maximum:number){
 assert(bytes.length>0&&bytes.length<=maximum);assert.match(name,/^(?:scalars|contexts|queries)\.json$|^(?:native|node)-scalars\.bin$/);
 const path=join(directory,name),fd=openSync(path,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{
  writeFileSync(fd,bytes);fsyncSync(fd);const before=fstatSync(fd);assert(before.isFile()&&before.nlink===1&&before.uid===process.getuid!()&&before.size===bytes.length);
  const actual=Buffer.alloc(bytes.length+1);let count=0;
  while(count<actual.length){const size=readSync(fd,actual,count,actual.length-count,count);if(size===0)break;count+=size;}
  assert.equal(count,bytes.length,'Published proof size changed');assert(actual.subarray(0,count).equals(bytes),'Published proof bytes differ');
  const after=fstatSync(fd),current=lstatSync(path);for(const key of ['dev','ino','size','mtimeMs','ctimeMs']as const){assert.equal(after[key],before[key]);assert.equal(current[key],before[key]);}
 }finally{closeSync(fd);}return{name,bytes:bytes.length,sha256:asciiProofSha(bytes)};
}
type ProofControl={active:()=>void;publishCorpus:(name:'native-scalars.bin'|'node-scalars.bin',bytes:Buffer)=>{name:string;bytes:number;sha256:string}};
type ProofWork=(tx:postgres.TransactionSql,report:Record<string,unknown>,control:ProofControl)=>Promise<void>;
export function asciiNativeProofOwner(){
 const lifetime=asciiProofLifetime();
 return{
  beforeCase(){lifetime.beforeCase();},
  async drain(){await lifetime.drain();},
  run(context:TestContext,name:'scalars'|'contexts'|'queries',work:ProofWork){
   const deadline=performance.now()+30000;
   return lifetime.run(context,async()=>{
    const check=()=>{context.signal.throwIfAborted();assert(performance.now()<deadline,'Original 30-second proof deadline exceeded');};
    check();const config=binding(),executable=asciiProofExecutable(),directory=evidenceDirectory();check();
    const report:Record<string,unknown>={kind:'DEVELOPMENT_ASCII_OBSERVATION_NOT_RELEASE',name,database:config.database,source:config.source,controller:config.controller,run:config.run,attempt:config.attempt,versions:{...process.versions},executable,
     sourceFiles:Object.fromEntries(files.map(file=>[file,asciiProofSha(asciiProofSourceBytes(file))])),host:{logicalCpus:cpus().length,ramBytes:totalmem()},releaseAuthorized:false};
    const connection=postgres(config.url.href,{max:1,prepare:false,connect_timeout:2,connection:{statement_timeout:20000,lock_timeout:300,default_transaction_isolation:'repeatable read',default_transaction_read_only:true}});
    let closePromise:Promise<void>|undefined,failed=false,failure:unknown;
    const close=()=>closePromise??=connection.end({timeout:0});
    const abort=()=>{lifetime.poison(context.signal.reason);void close().catch(lifetime.poison);};context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort();
    try{
     check();assert(asciiProofRuntime(process.versions),'Unqualified Node/V8/ICU/Unicode profile');
     await connection.begin('isolation level repeatable read read only',async tx=>{
      const [identity]=await tx`select current_database()as database,session_user::text as session,current_user::text as current,current_setting('server_encoding')as encoding,txid_current_snapshot()::text as snapshot,
       current_setting('server_version_num')::int as version,pg_backend_pid()as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid())as start,
       current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')as readonly,current_setting('statement_timeout')as statement,current_setting('lock_timeout')as lock,
       inet_server_addr()='127.0.0.1'::inet as loopback`;
      assert(identity);report.native=identity;assert.equal(identity.database,config.database);assert.equal(identity.session,'ai_hr_app');assert.equal(identity.current,'ai_hr_app');assert.equal(identity.encoding,'UTF8');
      assert(identity.version>=160000&&identity.version<170000);assert.equal(identity.isolation,'repeatable read');assert.equal(identity.readonly,'on');assert.equal(identity.statement,'20s');assert.equal(identity.lock,'300ms');assert.equal(identity.loopback,true);assert(identity.pid>0&&identity.start);
      check();await work(tx,report,{active:check,publishCorpus:(member,bytes)=>{check();return publish(directory,member,bytes,asciiProofLimits.maximumBytes);}});check();
      const [after]=await tx`select pg_backend_pid()as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid())as start,
       txid_current_snapshot()::text as snapshot,session_user::text as session,current_user::text as current,current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')as readonly,current_setting('statement_timeout')as statement,current_setting('lock_timeout')as lock`;
      assert.deepEqual(after,{pid:identity.pid,start:identity.start,snapshot:identity.snapshot,session:identity.session,current:identity.current,isolation:identity.isolation,readonly:identity.readonly,statement:identity.statement,lock:identity.lock});check();
     });
     assert.deepEqual(asciiProofExecutable(),executable);assert.deepEqual({...process.versions},report.versions);assert.deepEqual(Object.fromEntries(files.map(file=>[file,asciiProofSha(asciiProofSourceBytes(file))])),report.sourceFiles);check();report.success=true;
    }catch(error){failed=true;failure=error;report.success=false;}
    finally{
     try{await close();report.ownedClientClosed=true;}catch(error){lifetime.poison(error);failure=failed?new AggregateError([failure,error],'ASCII proof and owned close failed'):error;failed=true;report.ownedClientClosed=false;}
     context.signal.removeEventListener('abort',abort);
    }
    if(!failed){try{check();}catch(error){failed=true;failure=error;}}
    if(context.signal.aborted){if(!failed)failure=context.signal.reason??Error('ASCII proof aborted');failed=true;report.success=false;}
    if(failed)report.success=false;
    try{publish(directory,name+'.json',Buffer.from(JSON.stringify(report,null,2)+'\n'),1048576);}catch(error){failure=failed?new AggregateError([failure,error],'ASCII proof and evidence publication failed'):error;failed=true;}
    if(failed)throw failure;
   });
  },
 };
}
