/** Actual frozen source filter + real local rsync protocol through a private fake SSH endpoint. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {stagingTransport} from './staging-transport.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const raw=await import(pathToFileURL(join(root,'scripts/improve/release.ts')).href),official={...(raw.default??{}),...raw};
test('actual canonical rsync uses private config/alias and protects source/recipient operator data',()=>{
 const temp=realpathSync(mkdtempSync(join(tmpdir(),'staging transfer '))),source=join(temp,'source'),target=join(temp,'target'),bin=join(temp,'bin');
 try{
  for(const path of [source,target,bin])mkdirSync(path,{mode:0o700});
  for(const path of [join(source,'.improve'),join(target,'.improve'),join(target,'.next'),join(target,'node_modules')])mkdirSync(path,{mode:0o700});
  writeFileSync(join(source,'.improve/ssh_config'),'Host aihr-staging\n  HostName staging.invalid\n',{mode:0o600});
  writeFileSync(join(source,'.improve/private-operator-key'),'synthetic source private bytes');
  writeFileSync(join(source,'visible.txt'),'authorized fixture source');
  writeFileSync(join(target,'.improve/retained'),'synthetic retained operator bytes');
  writeFileSync(join(target,'.next/BUILD_ID'),'retained-build');
  writeFileSync(join(target,'node_modules/retained'),'retained-dependencies');
  const trace=join(temp,'ssh-args.json');
  const code='#!'+process.execPath+'\n'+
   'const fs=require("node:fs"),cp=require("node:child_process");const args=process.argv.slice(2);'+
   'fs.writeFileSync('+JSON.stringify(trace)+',JSON.stringify(args));const index=args.indexOf("rsync");if(index<0||!args.includes("aihr-staging"))process.exit(97);'+
   'const server=args.slice(index+1);if(!server.includes("--server")||server.at(-1)!=="/opt/ai-hr/")process.exit(98);server[server.length-1]='+JSON.stringify(target+'/')+';'+
   'const result=cp.spawnSync("/usr/bin/rsync",server,{stdio:"inherit"});process.exit(result.status??99);';
  writeFileSync(join(bin,'ssh'),code,{mode:0o700});
  const transport=stagingTransport(source,{}),args=transport.rsyncArgs(official,source);
  const result=spawnSync('/usr/bin/rsync',args,{env:{...process.env,PATH:bin+':'+process.env.PATH},encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.equal(readFileSync(join(target,'visible.txt'),'utf8'),'authorized fixture source');
  assert.equal(readFileSync(join(target,'.improve/retained'),'utf8'),'synthetic retained operator bytes');
  assert(!existsSync(join(target,'.improve/ssh_config')));assert(!existsSync(join(target,'.improve/private-operator-key')));
  assert.equal(readFileSync(join(target,'.next/BUILD_ID'),'utf8'),'retained-build');
  assert.equal(readFileSync(join(target,'node_modules/retained'),'utf8'),'retained-dependencies');
  const used=JSON.parse(readFileSync(trace));assert(used.includes(join(source,'.improve/ssh_config')));assert(used.includes('StrictHostKeyChecking=yes'));assert(!used.slice(0,used.indexOf('rsync')).includes('-p'));
 }finally{rmSync(temp,{recursive:true,force:true});}
});

test('private build packet uses the same alias/config and real rsync without touching runtime source',()=>{
 const temp=realpathSync(mkdtempSync(join(tmpdir(),'staging-packet-'))),source=join(temp,'source'),packet=join(temp,'packet'),target=join(temp,'received'),bin=join(temp,'bin');
 const destination='/home/fixture/.aihr-ci-builds/00000000-0000-4000-8000-000000000002/packet';
 try{
  for(const p of [source,packet,target,bin])mkdirSync(p,{mode:0o700});
  mkdirSync(join(source,'.improve'),{mode:0o700});const config=join(source,'.improve/ssh_config');
  writeFileSync(config,'Host aihr-staging\n HostName fixture.invalid\n',{mode:0o600});mkdirSync(join(packet,'bytes'),{mode:0o700});
  writeFileSync(join(packet,'system-testing.json'),'original immutable fixture\n');writeFileSync(join(packet,'bytes/build-bundle.tar.gz'),'synthetic bundle fixture');
  writeFileSync(join(target,'existing-owned-evidence'),'preserve');
  const trace=join(temp,'ssh-args.json');
  const script='#!'+process.execPath+'\n'+
   'const fs=require("node:fs"),cp=require("node:child_process"),args=process.argv.slice(2);fs.writeFileSync('+JSON.stringify(trace)+',JSON.stringify(args));'+
   'const index=args.indexOf("rsync");if(index<0||!args.includes("aihr-staging"))process.exit(97);const server=args.slice(index+1);'+
   'if(!server.includes("--server")||server.at(-1)!=='+JSON.stringify(destination+'/')+')process.exit(98);server[server.length-1]='+JSON.stringify(target+'/')+';'+
   'const result=cp.spawnSync("/usr/bin/rsync",server,{stdio:"inherit"});process.exit(result.status??99);';
  writeFileSync(join(bin,'ssh'),script,{mode:0o700});
  const transport=stagingTransport(source,{}),args=transport.packetRsyncArgs(packet,destination);
  const result=spawnSync('/usr/bin/rsync',args,{env:{...process.env,PATH:bin+':'+process.env.PATH},encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(readFileSync(join(target,'system-testing.json'),'utf8'),'original immutable fixture\n');
  assert.equal(readFileSync(join(target,'bytes/build-bundle.tar.gz'),'utf8'),'synthetic bundle fixture');
  assert.equal(readFileSync(join(target,'existing-owned-evidence'),'utf8'),'preserve');
  const used=JSON.parse(readFileSync(trace));assert(used.includes(config));assert(used.includes('StrictHostKeyChecking=yes'));
  for(const bad of ['/opt/ai-hr/.next',destination.replace('/home/fixture','/home/../fixture'),destination.replace('packet','other')])assert.throws(()=>transport.packetRsyncArgs(packet,bad));
 }finally{rmSync(temp,{recursive:true,force:true});}
});
