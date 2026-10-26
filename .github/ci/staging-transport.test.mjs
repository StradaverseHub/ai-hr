/** Private config, exact canonical-filter and actual shell refusal probes; no real SSH. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync,chmodSync,rmSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {bindStaging,stagingTransport,strictPendingCommand,STAGING} from './staging-transport.mjs';
const source='a'.repeat(40);
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'staging-transport-')));
 mkdirSync(join(root,'.improve'),{mode:0o700});writeFileSync(join(root,'.improve/ssh_config'),'Host aihr-staging\n  HostName staging.invalid\n',{mode:0o600});
 return {root,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('one private config/alias supplies both SSH and rsync without literal address/user/port',()=>{
 const f=fixture();try{
  const env={},transport=stagingTransport(f.root,env),config=join(f.root,'.improve/ssh_config');
  const argv=transport.sshArgs('read-only-command');assert.deepEqual(argv.slice(0,2),['-F',config]);assert.equal(argv.at(-2),'aihr-staging');
  assert(argv.includes('StrictHostKeyChecking=yes'));assert(!argv.includes('-p'));assert(!argv.some(arg=>arg.includes('@')));
  const canonical=['-az','--delete','-e','old transport','--exclude','node_modules','--exclude','.next','--exclude','/.improve/',f.root+'/',STAGING.host+':'+STAGING.directory+'/'];
  const official={deploymentRsyncArgs:(candidate,destination)=>{assert.equal(candidate,f.root);assert.equal(destination,canonical.at(-1));return canonical.slice();}};
  const rsync=transport.rsyncArgs(official,f.root);
  assert.deepEqual(rsync.filter((value,index)=>index!==3),canonical.filter((value,index)=>index!==3));assert(rsync[3].includes(config));assert(rsync[3].includes('StrictHostKeyChecking=yes'));
  assert.equal(env.IMPROVE_SSH_HOST,'aihr-staging');
 }finally{f.close();}
});
test('foreign target, insecure/symlinked config and filter lacking private exclusion refuse',()=>{
 const f=fixture();try{
  assert.throws(()=>bindStaging({IMPROVE_SSH_HOST:'live.invalid'}));assert.throws(()=>bindStaging({IMPROVE_SSH_PORT:'22'}));
  const config=join(f.root,'.improve/ssh_config');chmodSync(config,0o644);assert.throws(()=>stagingTransport(f.root,{}),/0600/);chmodSync(config,0o600);
  const foreign=join(f.root,'foreign');writeFileSync(foreign,'fixture',{mode:0o600});rmSync(config);symlinkSync(foreign,config);assert.throws(()=>stagingTransport(f.root,{}),/canonical/);
  rmSync(config);writeFileSync(config,'fixture',{mode:0o600});const transport=stagingTransport(f.root,{});
  assert.throws(()=>transport.rsyncArgs({deploymentRsyncArgs:()=>['-e','ssh',f.root+'/',STAGING.host+':'+STAGING.directory+'/']},f.root),/protect private/);
 }finally{f.close();}
});
function pendingFixture(script){
 const f=fixture(),dir=join(f.root,'source'),state=join(f.root,'state');
 mkdirSync(dir,{mode:0o700});mkdirSync(join(dir,'deploy'),{mode:0o700});mkdirSync(state,{mode:0o700});
 if(script!==null)writeFileSync(join(dir,'deploy/deploy-state.sh'),'#!/bin/sh\n'+script+'\n',{mode:0o700});
 const execute=()=>spawnSync('/bin/bash',['-c',strictPendingCommand(source,dir,state)],{encoding:'utf8'});
 return {...f,dir,state,execute};
}
test('strict pending observes a genuine written ref before source transfer can proceed',()=>{
 const f=pendingFixture('printf "ref=%s\\nat=fixture\\n" "$2" > "$AIHR_DEPLOY_STATE_DIR/pending"');
 try{const result=f.execute();assert.equal(result.status,0,result.stderr);assert(readFileSync(join(f.state,'pending'),'utf8').includes(source));}finally{f.close();}
});
test('zero-exit no-op, wrong marker and missing helper all refuse instead of silently announcing success',()=>{
 for(const script of ['exit 0','printf "ref=wrong\\n" > "$AIHR_DEPLOY_STATE_DIR/pending"',null]){
  const f=pendingFixture(script);try{assert.notEqual(f.execute().status,0);}finally{f.close();}
 }
});
test('preexisting or symlinked pending marker refuses and preserves the existing bytes',()=>{
 const f=pendingFixture('printf "ref=%s\\n" "$2" > "$AIHR_DEPLOY_STATE_DIR/pending"');
 try{
  const path=join(f.state,'pending');writeFileSync(path,'ref=retained\n');assert.notEqual(f.execute().status,0);assert.equal(readFileSync(path,'utf8'),'ref=retained\n');
  rmSync(path);const outside=join(f.root,'outside');writeFileSync(outside,'keep');symlinkSync(outside,path);assert.notEqual(f.execute().status,0);assert.equal(readFileSync(outside,'utf8'),'keep');
 }finally{f.close();}
});
