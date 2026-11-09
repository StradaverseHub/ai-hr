/** Controller-owned, disposable SCRAM cluster for the fixed native custody component. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,createHmac,pbkdf2Sync,randomBytes} from 'node:crypto';
import {closeSync,fstatSync,lstatSync,mkdtempSync,openSync,readFileSync,realpathSync,rmdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {actualSingletonHost} from './singleton-profiles.mjs';
import {capturePostgresEvidence,validatePostgresEvidence} from './postgres-evidence.mjs';
import {NATIVE_WORKLOAD_DATABASE_HBA,NATIVE_WORKLOAD_DATABASE_SETTINGS,NATIVE_WORKLOAD_OBSERVER,
 NATIVE_WORKLOAD_OBSERVER_URL,nativeWorkloadDatabaseUnit,validateNativeWorkloadDatabaseCustody,
 validateNativeWorkloadDatabaseUrls} from './singleton-protocol.mjs';

const hex=()=>randomBytes(32).toString('hex');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const roleUrl=(user,password,database)=>`postgres://${user}:${password}@127.0.0.1:5433/${database}`;
const fixedEnvironment=Object.freeze({PATH:'/usr/sbin:/usr/bin:/sbin:/bin',HOME:'/nonexistent',LANG:'C',LC_ALL:'C'});
const dockerSocket='unix:///var/run/docker.sock';
const inspectFormat='{"id":{{json .Id}},"name":{{json .Name}},"owner":{{json (index .Config.Labels "aihr-owner")}},"nonce":{{json (index .Config.Labels "aihr-workload-custody")}},"pid":{{json .State.Pid}},"started":{{json .State.StartedAt}},"running":{{json .State.Running}},"network":{{json .HostConfig.NetworkMode}},"memory":{{json .HostConfig.Memory}},"swap":{{json .HostConfig.MemorySwap}}}';

function invoke(command,args,input,timeout=10000,env=fixedEnvironment){
 const result=spawnSync(command,args,{input,timeout,env,encoding:'utf8',maxBuffer:65536,stdio:['pipe','pipe','pipe']});
 if(result.error||result.signal||result.status!==0)throw Error('Owned native workload PostgreSQL command refused');
 return result.stdout.trim();
}
const docker=(args,input)=>invoke('/usr/bin/docker',['--host',dockerSocket,...args],input);
const socketSql=(id,input,database='postgres')=>docker(['exec','-i',id,'psql','-X','--no-password','-v','ON_ERROR_STOP=1','-U','postgres','-p','5433','-d',database,'-Atq'],input);
function missing(path){
 try{lstatSync(path);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}
}

function scram(password){
 const salt=randomBytes(16),key=pbkdf2Sync(password,salt,4096,32,'sha256');
 const client=createHmac('sha256',key).update('Client Key').digest();
 const stored=createHash('sha256').update(client).digest('base64');
 const server=createHmac('sha256',key).update('Server Key').digest('base64');
 return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
}

function actualSocketFacts(id){
 const fields=Object.keys(NATIVE_WORKLOAD_DATABASE_SETTINGS).map(key=>`'${key}',current_setting('${key}')`).join(',');
 const row=JSON.parse(socketSql(id,`SELECT json_build_object(
  'settings',json_build_object(${fields}),
  'hba',pg_read_file(current_setting('hba_file'),0,2048),
  'hbaParsed',(SELECT count(*)=6 AND count(*) FILTER (WHERE error IS NOT NULL)=0 AND
    count(*) FILTER (WHERE type='host' AND auth_method='scram-sha-256')=3 AND
    count(*) FILTER (WHERE type='host' AND auth_method NOT IN ('scram-sha-256','reject'))=0 FROM pg_hba_file_rules),
  'systemId',(SELECT system_identifier::text FROM pg_control_system()),
  'role',current_user,'socket',inet_server_addr() IS NULL);
 `));
 assert(row.role==='postgres'&&row.socket===true&&row.hbaParsed===true,'Owned PostgreSQL socket or HBA refused');
 assert(typeof row.hba==='string'&&row.hba===NATIVE_WORKLOAD_DATABASE_HBA,'Owned PostgreSQL HBA differs');
 assert(/^[1-9][0-9]{0,19}$/.test(row.systemId),'Owned PostgreSQL system identity missing');
 return {settings:row.settings,hbaSha256:sha(row.hba),systemIdentifierSha256:sha(row.systemId)};
}

export function prepareNativeWorkloadPostgres(plan,unit,destination){
 assert(nativeWorkloadDatabaseUnit(unit),'Only the fixed native workload DB unit can own this cluster');
 const {automation,temp,source}=actualSingletonHost(plan,unit,destination);
 for(const path of ['.github/ci/native-workload-postgres.mjs','.github/ci/postgres.sh','.github/ci/singleton-protocol.mjs']){
  const expected=plan.singletonSources[unit.id][path];
  assert(sha(readFileSync(join(automation,path)))===expected&&sha(readFileSync(join(source,path)))===expected,
   'Native workload PostgreSQL source/controller binding differs');
 }
 assert.equal(docker(['info','--format','{{.CgroupDriver}} {{.CgroupVersion}}']),'systemd 2');
 const name=`aihr-ci-${process.env.GITHUB_RUN_ID}-1-${unit.id}`,nonce=hex();
 const listed=()=>docker(['container','ls','-aq','--no-trunc','--filter',`name=^/${name}$`]);
 assert(listed()==='','Native workload cluster name already exists');
 const [owner,app,observer]=[hex(),hex(),hex()];
 assert(new Set([owner,app,observer]).size===3,'Native workload credentials collided');
 const migrationUrls=Object.freeze({DATABASE_URL:roleUrl('ai_hr_app',app,'ai_hr_dev'),MIGRATION_DATABASE_URL:roleUrl('postgres',owner,'ai_hr_dev'),
  TEST_DATABASE_URL:roleUrl('ai_hr_app',app,'ai_hr_test'),TEST_MIGRATION_DATABASE_URL:roleUrl('postgres',owner,'ai_hr_test')});
 validateNativeWorkloadDatabaseUrls(migrationUrls,null);
 const observerUrl=roleUrl(NATIVE_WORKLOAD_OBSERVER,observer,'ai_hr_test_w1');
 const directory=mkdtempSync(join(temp,`aihr-native-workload-pg-${unit.id}.`));
 assert(realpathSync(directory)===directory,'Native workload private directory escaped the runner');
 const directoryIdentity=lstatSync(directory),files=new Map();
 const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.uid===b.uid;
 const privateDirectory=()=>{
  const state=lstatSync(directory);assert(state.isDirectory()&&same(state,directoryIdentity)&&state.uid===process.getuid()&&(state.mode&0o777)===0o700,
   'Native workload private directory changed');
 };
 const removePrivateFiles=()=>{
  privateDirectory();
  for(const [file,expected]of files){const found=lstatSync(file);assert(found.isFile()&&same(found,expected),'Native workload private file changed');unlinkSync(file);}
  rmdirSync(directory);
 };
 try{
  privateDirectory();
  for(const [basename,bytes,mode]of [['bootstrap-password',owner+'\n',0o400],['pg_hba.conf',NATIVE_WORKLOAD_DATABASE_HBA,0o444]]){
   const file=join(directory,basename),fd=openSync(file,'wx',mode);
   try{files.set(file,fstatSync(fd));writeFileSync(fd,bytes);}finally{closeSync(fd);}
  }
 }catch(error){removePrivateFiles();throw error;}

 let identity,socketFacts,started=false,completedStart=false,closed=false;
 function ownedContainer(id){
  assert(/^[a-f0-9]{64}$/.test(id),'Native workload container identity refused');
  const row=JSON.parse(docker(['inspect','--type','container','--format',inspectFormat,id]));
  assert(row.id===id&&row.name==='/'+name&&row.owner===name&&row.nonce===nonce&&row.network==='host'
   &&row.memory===2113929216&&row.swap===2113929216,'Native workload container identity refused');
  return row;
 }
 function live(){
  const id=listed(),row=ownedContainer(id);
  assert(row.running===true&&Number.isSafeInteger(row.pid)&&row.pid>1&&/^[0-9T:.+Z-]{20,40}$/.test(row.started),
   'Native workload PostgreSQL is not running');
  assert.equal(readFileSync(`/proc/${row.pid}/cgroup`,'utf8'),`0::/system.slice/docker-${row.id}.scope\n`,'Native workload PostgreSQL cgroup differs');
  if(identity)assert(row.id===identity.id&&row.pid===identity.pid&&row.started===identity.started,'Native workload PostgreSQL process changed');
  return row;
 }
 const profile=plan.execution.postgres;
 function evidence(){
  live();
  assert.deepEqual(actualSocketFacts(identity.id),socketFacts,'Native workload PostgreSQL settings drifted');
  const {serverLogTail,...value}=capturePostgresEvidence(unit.id,profile);
  validatePostgresEvidence(value,plan.execution);live();return value;
 }
 function start(){
  assert(!started&&!closed,'Native workload database start is single-use');
  started=true;
  const env={...fixedEnvironment,GITHUB_ACTIONS:'true',CI:'true',GITHUB_JOB:'native-test',GITHUB_RUN_ID:process.env.GITHUB_RUN_ID,
   GITHUB_RUN_ATTEMPT:'1',RUNNER_TEMP:temp,AIHR_CI_UNIT:unit.id,AIHR_CI_PG_PROFILE:'2',AIHR_CI_PG_CONFIGURED_CAP_BYTES:'2113929216',
   AIHR_CI_PG_PEAK_BUDGET_BYTES:'2147483648',AIHR_CI_PG_JIT:'on',DOCKER_HOST:dockerSocket};
  invoke('/usr/bin/timeout',['--kill-after=5s','90s','/usr/bin/bash',join(automation,'.github/ci/postgres.sh'),'reset-native-workload',directory,nonce],undefined,100000,env);
  completedStart=true;
  identity=live();
  socketSql(identity.id,`ALTER ROLE ai_hr_app PASSWORD '${scram(app)}';
   CREATE ROLE ${NATIVE_WORKLOAD_OBSERVER} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD '${scram(observer)}';
   GRANT pg_read_all_stats TO ${NATIVE_WORKLOAD_OBSERVER} WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
   ALTER ROLE ${NATIVE_WORKLOAD_OBSERVER} SET default_transaction_read_only=on;
  `);
  // The ordinary global setup builds its template from template1 and then clones the worker.
  socketSql(identity.id,'CREATE EXTENSION pg_stat_statements;', 'template1');
  socketFacts=actualSocketFacts(identity.id);
  const proof={kind:'OWNED_SCRAM_WORKLOAD_DATABASE_COMPONENT',containerIdentitySha256:sha(JSON.stringify([identity.id,identity.pid,identity.started])),
   ...socketFacts};
  validateNativeWorkloadDatabaseCustody(proof);evidence();return proof;
 }
 function close(){
  assert(!closed,'Native workload database closure is single-use');closed=true;
  let containerAbsent=false;
  const bound=()=>identity?docker(['container','ls','-aq','--no-trunc','--filter',`id=${identity.id}`]):'';
  try{
   if(started){
    const named=listed(),held=bound();
    assert(!identity||!named||named===identity.id,'Native workload cleanup found a different container');
    const id=identity?held:named;
    if(id){const row=ownedContainer(id);assert(!identity||row.id===identity.id,'Native workload cleanup found a different container');docker(['rm','-fv',row.id]);}
   }
   containerAbsent=listed()===''&&bound()==='';
   if(identity)containerAbsent&&=missing(`/sys/fs/cgroup/system.slice/docker-${identity.id}.scope`);
  }finally{removePrivateFiles();}
  return {containerAbsent,privateFilesRemoved:true,complete:completedStart&&containerAbsent};
 }
 return {start,evidence,close,migrationUrls,observerEnvironment:{[NATIVE_WORKLOAD_OBSERVER_URL]:observerUrl}};
}
