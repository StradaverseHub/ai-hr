/** In-memory host fixtures plus literal parsing; no real host, app, service or database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as vm from 'node:vm';
import path from 'node:path';
import {constants,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {customerEnvironmentErrors} from '../../deploy/check-customer-env.mjs';
import {proposeCustomerEnvironment,proposeCustomerUnit,summarizeCustomerProposal,parsePrivateEnvironment} from './customer-runtime-transition.mjs';
import {captureCustomerRuntimeSnapshot,customerRuntimeSnapshotCommand} from './customer-runtime-snapshot.mjs';
function fixture(){
 const source='/opt/ai-hr',baseline='a'.repeat(40),baselineBuildId='retained_fixture_build';
 const text='NODE_ENV=production\nAUTH_PROVIDER=internal\nALLOW_DEMO_SESSION=false\nAUTH_SESSION_KEY='+ 'b'.repeat(64)+'\nAUTH_PUBLIC_ORIGIN=https://hr.customer.org\nAI_CONFIG_SECRET=fixture-config-secret-value\nDATABASE_URL=postgres://ai_hr_app:fixture-app-password@127.0.0.1/hr\nMIGRATION_DATABASE_URL=postgres://ai_hr_owner:fixture-owner-password@127.0.0.1/hr\nDEV_TENANT_ID=fixture-tenant\nDEV_USER_ID=fixture-user\n';
 let inode=10,fd=100;const nodes=new Map(),opened=new Map(),calls=[];const put=(name,bytes,mode=0o600)=>nodes.set(name,{bytes:Buffer.from(bytes),mode,ino:inode++,mtimeMs:1,ctimeMs:1});
 nodes.set(source,{directory:true,mode:0o755,ino:inode++,mtimeMs:1,ctimeMs:1});nodes.set(source+'/.next',{directory:true,mode:0o755,ino:inode++,mtimeMs:1,ctimeMs:1});
 put('/var/tmp/aihr-deploy/current','ref='+baseline+'\nresult=ok\nbuild_id='+baselineBuildId+'\n');put('/var/tmp/aihr-deploy/last-ok','ref='+baseline+'\nbuild_id='+baselineBuildId+'\n');put(source+'/.next/BUILD_ID',baselineBuildId+'\n',0o644);put(source+'/.env.production',text);put('/etc/systemd/system/aihr.service','[Service]\nUser=fixture-user\n',0o644);put('/opt/node20/bin/node','retained fixture binary',0o755);
 const fields=Array(22).fill('0');fields[19]='123456';put('/proc/42/stat','42 (node) '+fields.join(' '),0o400);
 const env={...parsePrivateEnvironment(Buffer.from(text)),PATH:'/opt/node20/bin:/usr/bin:/bin'};put('/proc/42/environ',Object.entries(env).map(([k,v])=>k+'='+v).join('\0')+'\0',0o400);
 nodes.set('/proc/42/exe',{link:'/opt/node20/bin/node'});
 const error=code=>Object.assign(new Error('fixture path unavailable'),{code});
 const lookup=p=>{const n=nodes.get(p);if(!n)throw error('ENOENT');return n;};
 const stat=n=>({dev:1,ino:n.ino,size:n.bytes?.length??0,mode:n.mode,uid:1000,gid:1000,mtimeMs:n.mtimeMs,ctimeMs:n.ctimeMs,nlink:1,isFile:()=>!n.directory&&!n.link,isDirectory:()=>!!n.directory,isSymbolicLink:()=>!!n.link});
 const fs={constants,realpathSync:p=>lookup(p).link??p,openSync:(p,flags)=>{assert.equal(flags&constants.O_CREAT,0);assert.equal(flags&constants.O_WRONLY,0);const n=lookup(p);if(n.link)throw error('ELOOP');opened.set(++fd,n);return fd;},closeSync:d=>opened.delete(d),fstatSync:d=>stat(opened.get(d)),lstatSync:p=>stat(lookup(p)),statSync:p=>stat(lookup(lookup(p).link??p)),readlinkSync:p=>lookup(p).link,readFileSync:(p,encoding)=>{const n=typeof p==='number'?opened.get(p):lookup(p);return encoding? n.bytes.toString():Buffer.from(n.bytes);},accessSync:p=>{lookup(p);},writeFileSync:()=>{throw Error('Host writes forbidden');}};
 const args=['/opt/node20/bin/node',source+'/node_modules/next/dist/bin/next','start','-p','3000'];
 const props={User:'fixture-user',Group:'',WorkingDirectory:source,ExecStart:'{ path=/opt/node20/bin/node ; argv[]='+args.join(' ')+' ; ignore_errors=no ; }',ExecStartEx:'{ path=/opt/node20/bin/node ; flags= ; }',EnvironmentFiles:source+'/.env.production (ignore_errors=no)',UnsetEnvironment:'',FragmentPath:'/etc/systemd/system/aihr.service',DropInPaths:'',ActiveState:'active',MainPID:'42'};
 const typed={type:'a(sasasttttuii)',data:[[args[0],args,[],1,1,0,0,42,0,0]]};
 const cp={execFileSync:(command,argv)=>{calls.push({command,argv});if(command==='/usr/bin/systemctl')return props[argv[2].slice('--property='.length)];if(command==='/usr/bin/busctl')return JSON.stringify(argv.includes('GetUnit')?{type:'o',data:['/org/freedesktop/systemd1/unit/aihr_2eservice']}:typed);if(command==='/usr/bin/curl')return '200';throw Error('Unexpected external operation');}};
 const deps={fs,cp,path,crypto,vm,assert,process:{platform:'linux',arch:'x64',versions:{node:'20.20.2',modules:'115'},execPath:'/opt/node20/bin/node'},proposeEnvironment:proposeCustomerEnvironment,proposeUnit:proposeCustomerUnit,summarize:summarizeCustomerProposal,parseEnvironment:parsePrivateEnvironment,customerChecker:customerEnvironmentErrors};
 return {deps,expected:{baseline,baselineBuildId},nodes,props,typed,calls,source};
}
test('complete readonly fixture returns hashes only and labels simulated target config honestly',()=>{
 const f=fixture(),result=captureCustomerRuntimeSnapshot(f.deps,f.expected),json=JSON.stringify(result);
 assert.equal(result.kind,'READ_ONLY_CUSTOMER_RUNTIME_SNAPSHOT_NOT_APPROVAL');assert.equal(result.hostWrites,false);assert.equal(result.dataWrites,false);assert.equal(result.releaseAuthorized,false);assert.equal(result.maintenanceApprovalReady,false);assert.equal(result.preflight.originalErrors.length,4);assert.equal(result.preflight.proposedErrors.length,0);assert.equal(result.preflight.proposedValidation,'SIMULATED_CONFIGURATION_ONLY_ACTUAL_NODE22_PREFLIGHT_STILL_REQUIRED');
 for(const secret of ['fixture-app-password','fixture-owner-password','b'.repeat(64)])assert(!json.includes(secret));assert.equal(result.privateEnvironment,undefined);assert.equal(result.configuration.ordinaryExecutableFlags.length,0);assert(result.proposal.unit.migrationCredentialExcludedFromWebService);
 assert(f.calls.every(c=>!c.argv.some(v=>['restart','stop','daemon-reload','install'].includes(v))));
});
for(const [name,change,reason]of [
 ['PATH unset',f=>f.props.UnsetEnvironment='PATH',/UnsetEnvironment.*PATH/],
 ['audit flag unset',f=>f.props.UnsetEnvironment='AUDIT_HASH_CHAIN_ENABLED',/audit flag/],
 ['nonordinary flags',f=>f.typed.data[0][2]=['ignore-failure'],/executable flags/],
 ['typed schema drift',f=>f.typed.type='as',/ExecStartEx schema/],
 ['public env mode',f=>f.nodes.get(f.source+'/.env.production').mode=0o644,/permissions/],
 ['stale baseline',f=>f.expected.baseline='c'.repeat(40),/baseline differs/],
 ['active auth differs',f=>{const n=f.nodes.get('/proc/42/environ');n.bytes=Buffer.from(n.bytes.toString().replace('AUTH_PROVIDER=internal','AUTH_PROVIDER=workos'));},/authentication\/configuration/],
 ['preexisting target file',f=>f.nodes.set('/etc/systemd/system/aihr.service.d/40-customer-node22.conf',{bytes:Buffer.from('existing'),mode:0o644,ino:999,mtimeMs:1,ctimeMs:1}),/already exists/],
])test('refuse '+name,()=>{const f=fixture();change(f);assert.throws(()=>captureCustomerRuntimeSnapshot(f.deps,f.expected),reason);});
test('wrapped typed-array representation is unambiguous; an extra command refuses',()=>{const f=fixture();f.typed.data=[f.typed.data];assert.equal(captureCustomerRuntimeSnapshot(f.deps,f.expected).hostWrites,false);const g=fixture();g.typed.data.push(g.typed.data[0]);assert.throws(()=>captureCustomerRuntimeSnapshot(g.deps,g.expected),/Exactly one/);});
test('transport bundles the exact constructor and checker with no host-write mode',()=>{
 const constructorSource=readFileSync(new URL('./customer-runtime-transition.mjs',import.meta.url),'utf8'),command=customerRuntimeSnapshotCommand({constructorSource,customerCheckerSource:customerEnvironmentErrors.toString(),expected:fixture().expected});
 assert(command.includes('env -i PATH=/usr/bin:/bin LANG=C.UTF-8 /opt/node20/bin/node'));assert(!command.includes('sudo '));
 const marker="<<'AIHR_CUSTOMER_RUNTIME_SNAPSHOT'\n",body=command.split(marker)[1].split('\nAIHR_CUSTOMER_RUNTIME_SNAPSHOT')[0];assert(body.length>10000);
 const syntax=spawnSync(process.execPath,['--input-type=module','--check'],{input:body,encoding:'utf8'});assert.equal(syntax.status,0,syntax.stderr);
 assert.throws(()=>customerRuntimeSnapshotCommand({constructorSource:'AIHR_CUSTOMER_RUNTIME_SNAPSHOT',customerCheckerSource:'x',expected:{}}),/marker/);
});

for(const [name,mutate] of [
 ['retained build directory replaced',f=>{f.nodes.get(f.source+'/.next').ino++;}],
 ['active runtime binary replaced',f=>{f.nodes.get('/opt/node20/bin/node').ino++;}],
 ['target drop-in appeared',f=>{f.nodes.set('/etc/systemd/system/aihr.service.d/40-customer-node22.conf',{bytes:Buffer.from('unreviewed'),mode:0o644,ino:999,mtimeMs:1,ctimeMs:1});}],
])test('refuse snapshot race: '+name,()=>{
 const f=fixture(),original=f.deps.cp.execFileSync;
 f.deps.cp.execFileSync=(command,args)=>{const result=original(command,args);if(command==='/usr/bin/curl')mutate(f);return result;};
 assert.throws(()=>captureCustomerRuntimeSnapshot(f.deps,f.expected),/changed during snapshot|appeared during snapshot/);
});
