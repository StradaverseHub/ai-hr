/** Read-only transition snapshot. Proposal bytes and parsed private values never leave the host. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

/** Self-contained for execution over SSH with explicit standard-library/proposal dependencies. */
export function prepareCustomerRuntimeState(deps,expected){
 const {fs,cp,path,crypto,vm,assert,process,proposeEnvironment,proposeUnit,summarize,parseEnvironment,customerChecker}=deps;
 const source='/opt/ai-hr',state='/var/tmp/aihr-deploy',targetDropin='/etc/systemd/system/aihr.service.d/40-customer-node22.conf';
 assert(process.platform==='linux'&&process.arch==='x64'&&process.versions.node==='20.20.2'&&process.versions.modules==='115','Exact old staging planning runtime required');
 assert(/^[a-f0-9]{40}$/.test(expected.baseline??'')&&/^[A-Za-z0-9_-]{1,160}$/.test(expected.baselineBuildId??''),'Exact baseline identity required');
 assert(fs.realpathSync(source)===source&&fs.realpathSync(process.execPath)===fs.realpathSync('/opt/node20/bin/node'),'Canonical retained runtime/source required');
 const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),identity=s=>({device:s.dev,inode:s.ino,size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs,uid:s.uid,gid:s.gid,mode:s.mode&0o777});
 const records=[];
 function file(name,{optional=false,privateFile=false,max=1024**2}={}){
  assert(path.isAbsolute(name)&&path.normalize(name)===name,'Canonical snapshot file required');let fd;
  try{fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}catch(e){if(optional&&e.code==='ENOENT')return {bytes:null,record:{path:name,present:false}};throw Error('Required snapshot file unavailable');}
  try{
   const before=fs.fstatSync(fd);assert(before.isFile()&&before.nlink===1&&before.size>0&&before.size<=max&&fs.realpathSync(name)===name,'Bounded regular snapshot file required');
   if(privateFile)assert([0o600,0o640].includes(before.mode&0o777),'Private environment permissions require review');
   const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd),named=fs.lstatSync(name);
   assert(JSON.stringify(identity(before))===JSON.stringify(identity(after))&&JSON.stringify(identity(after))===JSON.stringify(identity(named)),'Snapshot file changed during read');
   const record={path:name,present:true,...identity(before),sha256:hash(bytes)};records.push(record);return {bytes,record};
  }finally{fs.closeSync(fd);}
 }
 function get(key){return cp.execFileSync('/usr/bin/systemctl',['show','aihr','--property='+key,'--value'],{encoding:'utf8',timeout:10000,maxBuffer:65536}).trim();}
 function unit(){return Object.fromEntries(['User','Group','WorkingDirectory','ExecStart','ExecStartEx','EnvironmentFiles','UnsetEnvironment','FragmentPath','DropInPaths','ActiveState','MainPID'].map(k=>[k,get(k)]));}
 function kv(bytes){return Object.fromEntries(bytes.toString().trim().split('\n').map(line=>{const at=line.indexOf('=');assert(at>0,'Invalid deployment instrumentation');return [line.slice(0,at),line.slice(at+1)];}));}
 const current=file(state+'/current'),last=file(state+'/last-ok'),build=file(source+'/.next/BUILD_ID',{max:512});
 const cur=kv(current.bytes),ok=kv(last.bytes),buildId=build.bytes.toString().trim();
 assert(cur.result==='ok'&&cur.ref===expected.baseline&&ok.ref===expected.baseline&&ok.build_id===expected.baselineBuildId&&buildId===expected.baselineBuildId,'Ready retained baseline differs');
 const before=unit();assert(before.ActiveState==='active'&&before.WorkingDirectory===source&&/^[1-9][0-9]*$/.test(before.MainPID),'Actual active baseline service required');
 const pid=before.MainPID,exe=fs.readlinkSync('/proc/'+pid+'/exe');assert(exe==='/opt/node20/bin/node','Active baseline executable differs');
 const processStat=()=>{const raw=fs.readFileSync('/proc/'+pid+'/stat','utf8'),at=raw.lastIndexOf(')');assert(at>0,'Invalid process identity');const start=raw.slice(at+1).trim().split(/\s+/)[19];assert(/^[1-9][0-9]*$/.test(start),'Invalid process start identity');return start;};
 const startedTicks=processStat(),activeDirectory=fs.lstatSync(source+'/.next');assert(activeDirectory.isDirectory()&&!activeDirectory.isSymbolicLink(),'Real retained build directory required');
 const nodeIdentity=identity(fs.statSync('/proc/'+pid+'/exe'));
 const processEnvBytes=fs.readFileSync('/proc/'+pid+'/environ');assert(processEnvBytes.length>0&&processEnvBytes.length<=2*1024**2,'Bounded active process environment required');
 const pairs=processEnvBytes.toString().split('\0').filter(Boolean).map(row=>{const at=row.indexOf('=');assert(at>0,'Invalid process environment record');return [row.slice(0,at),row.slice(at+1)];});assert(new Set(pairs.map(p=>p[0])).size===pairs.length,'Duplicate active environment key');const active=Object.fromEntries(pairs);
 const primary=file(source+'/.env.production',{privateFile:true}),original=parseEnvironment(primary.bytes);
 for(const key of ['AUTH_PROVIDER','AUTH_SESSION_KEY','AUTH_PUBLIC_ORIGIN','AI_CONFIG_SECRET'])assert(typeof original[key]==='string'&&original[key]===active[key],'Active authentication/configuration differs from the proposed source');
 assert([undefined,'','false'].includes(active.ALLOW_DEMO_SESSION),'Actual service demo access is not disabled');
 const unset=before.UnsetEnvironment.split(/\s+/).filter(Boolean);assert(unset.every(x=>/^[A-Za-z_][A-Za-z0-9_]*(?:=[^\s]*)?$/.test(x)),'Unsupported UnsetEnvironment syntax');
 assert(!unset.some(x=>x.split('=')[0]==='PATH'),'UnsetEnvironment removes or conditionally removes PATH');
 assert(!unset.some(x=>x.split('=')[0]==='AUDIT_HASH_CHAIN_ENABLED'),'UnsetEnvironment removes or conditionally removes the audit flag');
 const envFiles=[];let offset=0;const re=/([/A-Za-z0-9_.-]+) \(ignore_errors=(yes|no)\)(?: |$)/gy;
 while(offset<before.EnvironmentFiles.length){re.lastIndex=offset;const m=re.exec(before.EnvironmentFiles);assert(m&&envFiles.length<32,'Unreviewed EnvironmentFiles syntax');offset=re.lastIndex;envFiles.push(file(m[1],{optional:m[2]==='yes',privateFile:true}));}
 assert(envFiles.filter(x=>x.record.path===primary.record.path&&x.record.present).length===1,'Canonical private environment must be an actual service source');
 for(const entry of envFiles){if(!entry.bytes)continue;const values=parseEnvironment(entry.bytes);assert(!Object.hasOwn(values,'PATH'),'EnvironmentFile overrides target PATH');if(entry.record.path!==primary.record.path)assert(!['DEV_TENANT_ID','DEV_USER_ID','AUDIT_HASH_CHAIN_ENABLED'].some(k=>Object.hasOwn(values,k)),'Additional EnvironmentFile overrides a target setting');}
 const bus=args=>JSON.parse(cp.execFileSync('/usr/bin/busctl',['--system','--json=short',...args],{encoding:'utf8',timeout:10000,maxBuffer:65536}));
 const object=bus(['call','org.freedesktop.systemd1','/org/freedesktop/systemd1','org.freedesktop.systemd1.Manager','GetUnit','s','aihr.service']);assert(object.type==='o'&&object.data?.length===1&&/^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(object.data[0]),'Typed unit identity required');
 const typed=bus(['get-property','org.freedesktop.systemd1',object.data[0],'org.freedesktop.systemd1.Service','ExecStartEx']);assert(typed.type==='a(sasasttttuii)','Typed ExecStartEx schema differs');
 const possible=[typed.data,typed.data?.[0]].filter(rows=>Array.isArray(rows)&&rows.length===1&&Array.isArray(rows[0])&&rows[0].length===10&&typeof rows[0][0]==='string'&&Array.isArray(rows[0][1])&&Array.isArray(rows[0][2]));assert(possible.length===1,'Exactly one ordinary typed executable required');const entry=possible[0][0];assert(entry[0]==='/opt/node20/bin/node'&&entry[2].length===0,'Unreviewed executable flags');
 const argv=[...before.ExecStart.matchAll(/argv\[\]=([^;]+?)\s*;/g)];assert(argv.length===1&&entry[1].every(v=>typeof v==='string')&&entry[1].join(' ')===argv[0][1],'Typed/display executable arguments differ');
 const unitPaths=[before.FragmentPath,...before.DropInPaths.split(' ').filter(Boolean)];assert(unitPaths.length<=33&&unitPaths.every(p=>/^\/[A-Za-z0-9_./-]+$/.test(p)),'Bounded canonical unit paths required');const unitFiles=unitPaths.map(p=>file(p).record);
 try{fs.lstatSync(targetDropin);throw Error('Target runtime drop-in already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
 const environment=proposeEnvironment(primary.bytes),proposalUnit=proposeUnit({descriptor:before.ExecStart,runtimePath:active.PATH,environmentFilePathOverrideAbsent:true,ordinaryExecStartProved:true,pathUnsetAbsent:true,auditFlagUnsetAbsent:true});
 const afterEnv=parseEnvironment(environment.bytes),checkerSource=customerChecker.toString();assert(checkerSource.length>1000&&checkerSource.length<32000,'Complete actual candidate customer checker required');
 function check(env,node){const sandbox={env,source,path,URL,accessSync:fs.accessSync.bind(fs),constants:fs.constants,realpathSync:fs.realpathSync.bind(fs),process:{versions:{node},env,cwd:()=>source}};return vm.runInNewContext('('+checkerSource+')(env,source)',sandbox,{timeout:2000});}
 const oldErrors=check(original,process.versions.node),proposedErrors=check(afterEnv,'22.23.3');
 const allowed=['Customer deployments require Node.js 22.13+ or 24 LTS; install a supported customer toolchain.','DEV_TENANT_ID must be absent from a customer deployment.','DEV_USER_ID must be absent from a customer deployment.','AUDIT_HASH_CHAIN_ENABLED must be true before the first customer record is written.'];
 assert(Array.isArray(oldErrors)&&oldErrors.length>0&&oldErrors.every(x=>allowed.includes(x)),'An unrelated existing customer refusal requires review');assert(Array.isArray(proposedErrors)&&proposedErrors.length===0,'Proposed customer configuration still refuses');
 const health=cp.execFileSync('/usr/bin/curl',['--max-time','10','--fail','--silent','--output','/dev/null','--write-out','%{http_code}','http://127.0.0.1:3000/health'],{encoding:'utf8',timeout:12000,maxBuffer:1024});assert(health==='200','Actual retained baseline health differs');
 for(const record of records){const named=fs.lstatSync(record.path);assert(JSON.stringify(identity(named))===JSON.stringify(Object.fromEntries(Object.keys(identity(named)).map(k=>[k,record[k]])))&&hash(fs.readFileSync(record.path))===record.sha256,'Snapshot file changed before completion');}
 assert(JSON.stringify(identity(fs.lstatSync(source+'/.next')))===JSON.stringify(identity(activeDirectory))&&JSON.stringify(identity(fs.statSync('/proc/'+pid+'/exe')))===JSON.stringify(nodeIdentity),'Retained build/runtime identity changed during snapshot');
 try{fs.lstatSync(targetDropin);throw Error('Target drop-in appeared during snapshot');}catch(e){if(e.code!=='ENOENT')throw e;}
 for(const entry of envFiles.filter(x=>!x.record.present)){try{fs.lstatSync(entry.record.path);throw Error('Optional environment source appeared during snapshot');}catch(e){if(e.code!=='ENOENT')throw e;}}
 assert(JSON.stringify(unit())===JSON.stringify(before)&&processStat()===startedTicks&&fs.readlinkSync('/proc/'+pid+'/exe')===exe,'Baseline process/configuration changed during snapshot');
 const snapshot={format:1,kind:'READ_ONLY_CUSTOMER_RUNTIME_SNAPSHOT_NOT_APPROVAL',observedAt:new Date().toISOString(),baseline:{sourceRef:expected.baseline,buildId,pid,startedTicks,activeDirectory:identity(activeDirectory),runtimeBinary:nodeIdentity,runtime:{node:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch},health:200},configuration:{primary:primary.record,environmentFiles:envFiles.map(x=>x.record),unitFiles,unitPropertiesSha256:hash(JSON.stringify(before)),serviceUser:before.User,serviceGroup:before.Group,existingUnsetNames:unset,ordinaryExecutableFlags:[],environmentFilePathOverrideAbsent:true,activeAuthenticationMatchesConfig:true,targetDropin},proposal:summarize(environment,proposalUnit),preflight:{originalErrors:oldErrors,proposedErrors,checkerSha256:hash(checkerSource),proposedRuntimeVersion:'22.23.3',proposedValidation:'SIMULATED_CONFIGURATION_ONLY_ACTUAL_NODE22_PREFLIGHT_STILL_REQUIRED'},hostWrites:false,dataWrites:false,proposalBytesReturned:false,maintenanceApprovalReady:false,releaseAuthorized:false};
 return {snapshot,privateEnvironment:environment,privateUnit:proposalUnit};
}
export function captureCustomerRuntimeSnapshot(deps,expected){return prepareCustomerRuntimeState(deps,expected).snapshot;}

export function customerRuntimeSnapshotCommand({constructorSource,customerCheckerSource,expected}){
 assert(typeof constructorSource==='string'&&constructorSource.length<64*1024&&typeof customerCheckerSource==='string'&&customerCheckerSource.length<32000,'Bounded actual source required');
 const marker='AIHR_CUSTOMER_RUNTIME_SNAPSHOT';assert(!constructorSource.includes(marker)&&!customerCheckerSource.includes(marker),'Reserved transport marker in source');
 const body=constructorSource+"\nimport * as fs from 'node:fs';import * as cp from 'node:child_process';import * as crypto from 'node:crypto';import * as vm from 'node:vm';\n"+prepareCustomerRuntimeState.toString()+'\n'+captureCustomerRuntimeSnapshot.toString()+"\nconst customerChecker=("+customerCheckerSource+");\nconst result=captureCustomerRuntimeSnapshot({fs,cp,path,crypto,vm,assert,process,proposeEnvironment:proposeCustomerEnvironment,proposeUnit:proposeCustomerUnit,summarize:summarizeCustomerProposal,parseEnvironment:parsePrivateEnvironment,customerChecker},"+JSON.stringify(expected)+");console.log(JSON.stringify(result));\n";
 return "cd /opt/ai-hr && env -i PATH=/usr/bin:/bin LANG=C.UTF-8 /opt/node20/bin/node --input-type=module <<'"+marker+"'\n"+body+marker;
}
export function snapshotSourceDigest(){return createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');}
