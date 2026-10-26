/** Digest private staging configuration without exporting any credential or environment value. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
/** Self-contained body also runs in the pre-transfer probe on the existing server. */
export function fingerprintStagingEnvironment(source,{systemctl=argv=>{
 try{return cp.execFileSync('/usr/bin/systemctl',argv,{encoding:'utf8',timeout:10000,maxBuffer:1024**2});}
 catch{throw Error('Unable to inspect bounded staging service configuration');}
},busctl=argv=>{
 try{return JSON.parse(cp.execFileSync('/usr/bin/busctl',['--system','--json=short',...argv],{encoding:'utf8',timeout:10000,maxBuffer:1024**2}));}
 catch{throw Error('Unable to inspect typed staging credential configuration');}
}}={}){
 assert(path.isAbsolute(source)&&fs.realpathSync(source)===source,'Canonical environment source required');
 const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
 const keys=['Environment','EnvironmentFiles','PassEnvironment','UnsetEnvironment','PAMName','RootDirectory','RootImage','DynamicUser','User','Group','WorkingDirectory','ExecStart','FragmentPath','DropInPaths','LoadCredential','LoadCredentialEncrypted','SetCredential','SetCredentialEncrypted','ImportCredential'];
 const identity=st=>[st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs,st.mode,st.uid,st.gid];
 function file(name,optional=false){
  assert(path.isAbsolute(name)&&path.normalize(name)===name&&!name.split('/').some(p=>p==='.'||p==='..'),'Canonical configured file path required');
  let fd;
  try{
   fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
   const before=fs.fstatSync(fd);
   assert(before.isFile()&&before.nlink===1&&before.size<=1024**2&&fs.realpathSync(name)===name,'Bounded regular non-symlink environment/configuration file required');
   const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd),named=fs.lstatSync(name);
   assert(JSON.stringify(identity(before))===JSON.stringify(identity(after))&&JSON.stringify(identity(after))===JSON.stringify(identity(named)),'Environment/configuration file changed while reading');
   return {path:name,present:true,mode:before.mode&0o777,uid:before.uid,gid:before.gid,sha256:hash(bytes),text:bytes.toString('utf8')};
  }catch(error){if(optional&&error.code==='ENOENT')return {path:name,present:false};throw error;}
  finally{if(fd!==undefined)fs.closeSync(fd);}
 }
 function noCompileKeys(text){
  assert(!/(?:^|[\s"'])\s*(?:export\s+)?(?:NEXT_PUBLIC_[A-Za-z0-9_]*|NEXT_SERVER_ACTIONS_ENCRYPTION_KEY)\s*=/m.test(text),'Unreviewed compile-affecting staging configuration key');
 }
 function service(){
  const output=systemctl(['show','aihr','--no-pager',...keys.map(k=>'--property='+k)]);
  assert(typeof output==='string'&&Buffer.byteLength(output)<=1024**2,'Bounded service configuration required');
  const values={};
  for(const line of output.trimEnd().split('\n')){
   const match=/^([A-Za-z]+)=(.*)$/.exec(line);
   assert(match&&keys.includes(match[1])&&!(match[1] in values),'Exact service configuration properties required');values[match[1]]=match[2];
  }
  assert(keys.every(k=>Object.hasOwn(values,k)),'Incomplete systemd configuration properties');
  assert(values.WorkingDirectory===source&&values.DynamicUser==='no','Fixed service directory/principal required');
  for(const key of ['PAMName','RootDirectory','RootImage','ImportCredential'])
   assert(values[key]==='','Unreviewed dynamic service environment or credential source');
  const unit=busctl(['call','org.freedesktop.systemd1','/org/freedesktop/systemd1','org.freedesktop.systemd1.Manager','GetUnit','s','aihr.service']);
  assert(unit?.type==='o'&&Array.isArray(unit.data)&&unit.data.length===1&&/^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(unit.data[0]),'Exact loaded unit object required');
  for(const [key,type]of Object.entries({LoadCredential:'a(ss)',LoadCredentialEncrypted:'a(ss)',SetCredential:'a(say)',SetCredentialEncrypted:'a(say)'})){
   const value=busctl(['get-property','org.freedesktop.systemd1',unit.data[0],'org.freedesktop.systemd1.Service',key]);
   assert(value?.type===type&&Array.isArray(value.data)&&value.data.length===0,'Unreviewed nonempty typed service credential source');
   values[key]={type,data:[]}; // Display placeholders alone can never prove absence.
  }
  noCompileKeys(values.Environment);
  assert(values.PassEnvironment===''||/^[A-Za-z_][A-Za-z0-9_]*(?: [A-Za-z_][A-Za-z0-9_]*)*$/.test(values.PassEnvironment),'Unsupported inherited environment syntax');
  const starts=[...values.ExecStart.matchAll(/(?:^|[;{])\s*path=([^;]+?)\s*;/g)],argv=[...values.ExecStart.matchAll(/argv\[\]=([^;]+?)\s*;/g)];
  assert(starts.length===1&&argv.length===1&&starts[0][1]==='/opt/node20/bin/node'
   &&argv[0][1].startsWith('/opt/node20/bin/node '+source+'/node_modules/next/dist/bin/next start '),'Pinned configured service command required');
  // systemd adds PID/start-time/status fields after execution; only configuration belongs in this digest.
  values.ExecStart={path:starts[0][1],argv:argv[0][1]};
  const files=[];
  if(values.EnvironmentFiles){
   let offset=0;const re=/([/A-Za-z0-9_.-]+) \(ignore_errors=(yes|no)\)(?: |$)/gy;
   while(offset<values.EnvironmentFiles.length){
    re.lastIndex=offset;const match=re.exec(values.EnvironmentFiles);
    assert(match&&match[1].startsWith('/')&&files.length<32,'Unreviewed EnvironmentFiles expansion/path syntax');
    files.push(file(match[1],match[2]==='yes'));offset=re.lastIndex;
   }
  }
  const unitPaths=[values.FragmentPath,...(values.DropInPaths?values.DropInPaths.split(' '):[])];
  assert(unitPaths.length<=33&&unitPaths.every(p=>/^\/[A-Za-z0-9_./-]+$/.test(p)),'Canonical bounded service unit/drop-in paths required');
  const unitFiles=unitPaths.map(p=>file(p));
  for(const row of files)if(row.present)noCompileKeys(row.text);
  // The raw manager environment remains local; all values are reduced to a digest.
  const manager=systemctl(['show-environment']);
  assert(typeof manager==='string'&&Buffer.byteLength(manager)<=1024**2,'Bounded manager environment required');noCompileKeys(manager);
  const managerLines=manager.trimEnd().split('\n').filter(Boolean);
  assert(managerLines.every(line=>/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)),'Unreviewed manager environment syntax');
  const publicRows=rows=>rows.map(({text,...row})=>row);
  return {objectPath:unit.data[0],service:Object.fromEntries(keys.map(k=>[k,values[k]])),files:publicRows(files),unitFiles:publicRows(unitFiles),managerSha256:hash(managerLines.sort().join('\n'))};
 }
 const dotenv=['.env.production.local','.env.local','.env.production','.env'].map(name=>file(path.join(source,name),name!=='.env.production'));
 for(const row of dotenv)if(row.present)noCompileKeys(row.text);
 const before=service();
 const publicDotenv=dotenv.map(({text,...row})=>row);
 const afterDotenv=['.env.production.local','.env.local','.env.production','.env'].map(name=>file(path.join(source,name),name!=='.env.production')).map(({text,...row})=>row);
 assert(JSON.stringify(publicDotenv)===JSON.stringify(afterDotenv)&&JSON.stringify(before)===JSON.stringify(service()),'Private environment/service changed during fingerprint');
 return hash(JSON.stringify({format:1,kind:'STAGING_CONFIGURED_ENVIRONMENT_V1',dotenv:publicDotenv,...before}));
}
/** The exact shared implementation runs before source transfer; no new server helper is assumed. */
export function stagingEnvironmentProbeCommand(){
 const imports="import assert from 'node:assert/strict';import * as fs from 'node:fs';import * as cp from 'node:child_process';import * as crypto from 'node:crypto';import * as path from 'node:path';\n";
 const code=imports+fingerprintStagingEnvironment.toString()+"\nconst source='/opt/ai-hr';console.log(JSON.stringify({baselineBuildId:fs.readFileSync(path.join(source,'.next/BUILD_ID'),'utf8').trim(),environmentSha256:fingerprintStagingEnvironment(source)}));\n";
 return "cd /opt/ai-hr && /opt/node20/bin/node --input-type=module <<'AIHR_STAGING_ENV_NODE'\n"+code+'AIHR_STAGING_ENV_NODE';
}
